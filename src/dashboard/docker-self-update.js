/**
 * In-container docker self-update via /var/run/docker.sock.
 *
 * Strategy: instead of installing the docker CLI inside our image (extra
 * ~80MB) we talk to the docker daemon directly over the unix socket using
 * node's built-in http client. The actual recreate-self-with-new-image
 * step is handled by a one-shot deployer container we spawn — running
 * `docker compose up -d` on the project; it sees the freshly-pulled
 * image vs. our running container's image, stops us, and brings up a new
 * container with the same name + config + new image.
 *
 * Security: this requires the user to mount /var/run/docker.sock into
 * our container, which effectively grants host root (anyone with access
 * to docker.sock can spawn privileged containers). That's why this code
 * path is opt-in — if the socket isn't mounted we just report
 * { available: false, reason: 'no-docker-sock' } and the dashboard
 * falls back to the existing "run `docker compose pull && up -d` on the
 * host" message.
 *
 * Compose label dependency: we need to know the compose project name and
 * working_dir on the host to spawn the deployer with the right binds.
 * Both come from the labels compose attaches to every container it
 * creates: `com.docker.compose.project` and
 * `com.docker.compose.project.working_dir`. If they're missing (e.g. user
 * ran `docker run` directly without compose) we abort with a clear error
 * — recreating a hand-managed container without losing its config is a
 * separate problem we don't want to solve here.
 */

import { existsSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { config, log } from '../config.js';
import { writeJsonAtomic } from '../fs-atomic.js';

const DOCKER_SOCK = '/var/run/docker.sock';
// Policy T (D9 §5.1 B4): the deployer runs with the host docker.sock, so it
// must never float on a mutable tag. Digest read from Docker Hub's
// `library/docker:24-cli` index (24.0.9-cli) on 2026-10-26; change it only by
// a reviewed commit, never at runtime.
export const DEPLOYER_IMAGE = 'docker:24-cli@sha256:2b62f89aaab9e4df0ff843f0d9a7bbd17340a9ba7c660ba6f40b1f00b38c2a4d';
const IMAGE_DIGEST_FILENAME = 'image-digest.txt';
const DOCKER_CONTAINER_ID_RE = /^[0-9a-f]{64}$/i;
const COMPOSE_CONFIG_FILES_LABEL = 'com.docker.compose.project.config_files';
const MAX_COMPOSE_CONFIG_FILES = 32;
const MAX_COMPOSE_CONFIG_FILES_LABEL_BYTES = 16 * 1024;
// D6: the deployer is now health-gated. These bound how long it can take
// before it either exits 0 (new image healthy), 1 (rolled back and healthy),
// 2 (rollback failed/unhealthy) or 3 (recreate failed).
const DEPLOYER_HEALTH_TIMEOUT_SECONDS = 120;
const DEPLOYER_HEALTH_INTERVAL_SECONDS = 3;
// Durable evidence survives the container recreate: the journal lives in the
// app's data dir (a host bind in the compose deployment), the deployer
// container is left behind with its exit code until the next reconcile.
const DOCKER_STATE_FILENAME = 'self-update-docker.json';
const DEPLOYER_ROLE_LABEL = 'com.windsurf-api.role';
const DEPLOYER_ROLE = 'self-update-deployer';
const DEPLOYER_PROJECT_LABEL = 'com.windsurf-api.project';
const DEPLOYER_OLD_IMAGE_LABEL = 'com.windsurf-api.rollback-image';
const DOCKER_PENDING_STATES = new Set(['pending-recreate', 'deployer-running']);
// A daemon error should fail the request rather than allowing an unbounded
// response to retain memory until the dashboard mutation timeout.  Pull
// progress is noisier than the small inspect/create responses, so it gets a
// separate (still finite) ceiling below.
const DOCKER_API_BODY_LIMIT = 4 * 1024 * 1024;
const DOCKER_PULL_BODY_LIMIT = 16 * 1024 * 1024;
// Wait long enough for the dashboard's HTTP response to flush back to the
// browser before the deployer tears us down. 8s is enough for the toast +
// auto-refresh JS to land; longer waits just confuse the UX.
const DEPLOYER_DELAY_SECONDS = 8;

// Upper bound on the whole out-of-band deployer lifecycle (flush delay + two
// health gates). api.js holds the in-process mutation lock for this long so a
// retry cannot start while a deployer is still recreating/rolling back.
export const DOCKER_DEPLOYER_WINDOW_MS = (
  DEPLOYER_DELAY_SECONDS + DEPLOYER_HEALTH_TIMEOUT_SECONDS * 2 + 60
) * 1000;

// Defence-in-depth (audit #2): compose labels come from the container
// runtime and the file's own contract says not to trust them blindly.
// shellQuote() already makes them shell-safe; these validators reject
// malformed/hostile shapes so they can't reach the deployer command at all.
export function isSafeComposeProject(name) {
  return typeof name === 'string' && name.length <= 256 && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name);
}
export function isSafeComposeWorkingDir(dir) {
  if (typeof dir !== 'string' || dir.length === 0 || dir.length > 4096) return false;
  if (!/^\/[^\0\r\n:]*$/.test(dir)) return false;
  return !dir.split('/').includes('..');
}

function normalizeDockerContainerId(value) {
  if (typeof value !== 'string' || !DOCKER_CONTAINER_ID_RE.test(value)) return null;
  return value.toLowerCase();
}

const DOCKER_IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/i;
function normalizeDockerImageId(value) {
  if (typeof value !== 'string' || !DOCKER_IMAGE_ID_RE.test(value)) return null;
  return value.toLowerCase();
}

const IMAGE_DIGEST_RE = /^sha256:[0-9a-f]{64}$/i;
function normalizeImageDigest(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return IMAGE_DIGEST_RE.test(trimmed) ? trimmed.toLowerCase() : null;
}

/**
 * Split a Docker image reference into repository, tag and digest.
 *
 * `repo[:tag][@sha256:<64hex>]`: when a digest is present it is the only
 * execution target; a tag is metadata. Returns null for references that
 * cannot be expressed to the daemon without quoting ambiguity (whitespace,
 * control characters, an empty repository or an invalid tag).
 */
export function parseImageReference(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || /[\0\r\n\t ]/.test(raw)) return null;
  // A bare image ID is content-addressed but not a repository reference:
  // Compose cannot recreate a service from it, so it is not an OTA target.
  if (IMAGE_DIGEST_RE.test(raw)) return null;
  const at = raw.indexOf('@');
  if (at !== -1) {
    const repository = raw.slice(0, at);
    const digest = normalizeImageDigest(raw.slice(at + 1));
    if (!repository || !digest) return null;
    return { repository, tag: null, digest };
  }
  const slash = raw.lastIndexOf('/');
  const colon = raw.lastIndexOf(':');
  if (colon > slash) {
    const repository = raw.slice(0, colon);
    const tag = raw.slice(colon + 1);
    if (!repository || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) return null;
    return { repository, tag, digest: null };
  }
  return { repository: raw, tag: 'latest', digest: null };
}

/**
 * Read the first non-empty line of an image-digest file. Accepts either the
 * bare `sha256:<64hex>` form the release workflow writes or a full
 * `repo@sha256:<64hex>` reference. Anything else is not a digest.
 */
export function parseImageDigest(text) {
  const first = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!first) return null;
  const match = /(?:^|[@\s])(sha256:[0-9a-f]{64})(?=$|[\s])/i.exec(first);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Policy T (D9 §5.1 B2): the only digest a mutable tag may resolve to is the
 * one recorded in the signed `image-digest.txt` release asset. Missing or
 * malformed material is a refusal, never a fallback.
 */
export function readImageDigestFile({
  file = join(config.dataDir, IMAGE_DIGEST_FILENAME),
  readFile = readFileSync,
} = {}) {
  let text;
  try {
    text = readFile(file, 'utf8');
  } catch (e) {
    return {
      ok: false,
      reason: 'image-mutable-ref',
      cause: 'image-digest-missing',
      detail: `no ${IMAGE_DIGEST_FILENAME} at ${file} (${e?.code || e?.message || 'unreadable'}); refusing a mutable image target`,
    };
  }
  const digest = parseImageDigest(text);
  if (!digest) {
    return {
      ok: false,
      reason: 'image-mutable-ref',
      cause: 'image-digest-missing',
      detail: `${file} does not contain a sha256 image digest; refusing a mutable image target`,
    };
  }
  return { ok: true, digest, file };
}

function dockerIdFromCgroup(cgroup) {
  if (typeof cgroup !== 'string') return null;
  const ids = new Set();
  for (const line of cgroup.split(/\r?\n/)) {
    if (!line) continue;
    const firstColon = line.indexOf(':');
    const secondColon = firstColon < 0 ? -1 : line.indexOf(':', firstColon + 1);
    if (firstColon < 0 || secondColon < 0) continue;
    const path = line.slice(secondColon + 1);
    // Docker cgroupfs and systemd use distinct, fully-qualified forms. Do not
    // search arbitrary cgroup text: a sibling service name may contain hex.
    const match = /^\/docker\/([0-9a-f]{64})$/i.exec(path)
      || /^\/(?:[^/\0\r\n]+\/)*docker-([0-9a-f]{64})\.scope$/i.exec(path);
    if (match) ids.add(match[1].toLowerCase());
  }
  return ids.size === 1 ? [...ids][0] : null;
}

function isPrivateCgroupV2(cgroup) {
  if (typeof cgroup !== 'string') return false;
  const lines = cgroup.split(/\r?\n/).filter(Boolean);
  return lines.length === 1 && lines[0] === '0::/';
}

function dockerIdFromMountInfo(mountInfo) {
  if (typeof mountInfo !== 'string') return null;
  const expectedTargets = new Set(['/etc/hostname', '/etc/hosts', '/etc/resolv.conf']);
  const matchedTargets = new Set();
  const ids = new Set();
  for (const line of mountInfo.split(/\r?\n/)) {
    const fields = line.split(' ');
    // mountinfo's root and mount-point fields are fields 4 and 5. The
    // runtime-managed Docker files expose the container ID in the root path;
    // require at least two independent files to agree before accepting it.
    if (fields.length < 6 || !expectedTargets.has(fields[4])) continue;
    const root = fields[3];
    const match = /(?:^|\/)containers\/([0-9a-f]{64})\/(hostname|hosts|resolv\.conf)$/i.exec(root);
    if (!match) continue;
    const file = '/etc/' + match[2];
    if (file !== fields[4]) continue;
    matchedTargets.add(fields[4]);
    ids.add(match[1].toLowerCase());
  }
  return matchedTargets.size >= 2 && ids.size === 1 ? [...ids][0] : null;
}

function isSafeAbsoluteComposePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096) return false;
  if (!/^\/[^\0\r\n:]*$/.test(path) || path.endsWith('/')) return false;
  const segments = path.split('/');
  return segments.slice(1).every(segment => segment && segment !== '.' && segment !== '..');
}

export function isSafeComposeConfigFile(path, workingDir) {
  if (!isSafeComposeWorkingDir(workingDir) || !isSafeAbsoluteComposePath(path)) return false;
  const prefix = workingDir.endsWith('/') ? workingDir : workingDir + '/';
  return path.startsWith(prefix) && path.length > prefix.length;
}

function parseComposeConfigFiles(value, workingDir) {
  if (typeof value !== 'string' || value.length === 0
      || Buffer.byteLength(value, 'utf8') > MAX_COMPOSE_CONFIG_FILES_LABEL_BYTES) return null;
  const files = value.split(',');
  if (files.length === 0 || files.length > MAX_COMPOSE_CONFIG_FILES) return null;
  const seen = new Set();
  for (const file of files) {
    if (!isSafeComposeConfigFile(file, workingDir) || seen.has(file)) return null;
    seen.add(file);
  }
  return files;
}

function validateComposeConfigFiles(files, workingDir) {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_COMPOSE_CONFIG_FILES) return null;
  const seen = new Set();
  for (const file of files) {
    if (!isSafeComposeConfigFile(file, workingDir) || seen.has(file)) return null;
    seen.add(file);
  }
  return files;
}

/**
 * Resolve our own container ID from a Docker-owned cgroup path, or from
 * corroborating Docker runtime mounts when a private cgroup-v2 namespace
 * intentionally hides it. A container hostname is operator-controlled
 * (--hostname / Compose hostname:), so it is never an identity source.
 */
export function readSelfContainerId({ readFile = readFileSync } = {}) {
  let cgroup;
  try {
    cgroup = readFile('/proc/self/cgroup', 'utf8');
  } catch {}
  const cgroupId = dockerIdFromCgroup(cgroup);
  if (cgroupId) return cgroupId;

  // With a private cgroup namespace Docker intentionally presents 0::/.
  // Do not fall back to /etc/hostname: hostname is operator-controlled and
  // can name a different container. Docker's own bind mounts for at least two
  // of hostname/hosts/resolv.conf carry the real ID in mountinfo instead.
  if (isPrivateCgroupV2(cgroup)) {
    try {
      const mountInfo = readFile('/proc/self/mountinfo', 'utf8');
      return dockerIdFromMountInfo(mountInfo);
    } catch {}
  }
  return null;
}

function collectDockerResponse(res, { maxBytes, label }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;

    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const settleResolve = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    };
    const destroy = () => {
      if (typeof res.destroy === 'function') {
        try { res.destroy(); } catch { /* the original failure is authoritative */ }
      }
    };

    res.on('data', (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buf.length;
      if (bytes > maxBytes) {
        settleReject(new Error(`${label} response body exceeds ${maxBytes} bytes`));
        destroy();
        return;
      }
      chunks.push(buf);
    });
    // IncomingMessage emits `error` for transport failures.  `aborted` is a
    // distinct signal for a peer that truncates the body, while `close` can
    // arrive without `end` when the socket disappears.  All paths are
    // single-settle so a late close/error cannot turn a prior success into a
    // second resolution or leave the caller pending forever.
    res.once('error', (error) => settleReject(error));
    res.once('aborted', () => settleReject(new Error(`${label} response aborted`)));
    res.once('close', () => {
      if (!settled) settleReject(new Error(`${label} response closed before end`));
    });
    res.once('end', settleResolve);
  });
}

function dockerRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = httpRequest(
      {
        socketPath: DOCKER_SOCK,
        method,
        path,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
        timeout: 60000,
      },
      (res) => {
        collectDockerResponse(res, {
          maxBytes: DOCKER_API_BODY_LIMIT,
          label: `docker API ${method} ${path}`,
        }).then((raw) => {
          const buf = raw.toString('utf8');
          let parsed;
          try { parsed = buf ? JSON.parse(buf) : null; } catch { parsed = buf; }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, body: parsed });
          } else {
            reject(new Error(`docker API ${method} ${path} -> ${res.statusCode}: ${buf.slice(0, 400)}`));
          }
        }, reject);
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('docker API timeout')));
    if (data) req.write(data);
    req.end();
  });
}

/**
 * Resolve a tag to the manifest digest the registry currently serves, through
 * the daemon's registry-metadata endpoint (no layer download). The tag is a
 * lookup key only; the returned digest is the only thing that may be pulled.
 */
export async function resolveImageDigest(image, { request = dockerRequest } = {}) {
  const ref = parseImageReference(image);
  if (!ref) {
    return {
      ok: false,
      reason: 'invalid-image-ref',
      detail: `cannot parse image reference: ${String(image).slice(0, 200)}`,
    };
  }
  if (ref.digest) {
    return {
      ok: true,
      digest: ref.digest,
      image: `${ref.repository}@${ref.digest}`,
      repository: ref.repository,
      tag: null,
      operatorPinned: true,
    };
  }
  let res;
  try {
    // Moby's DistributionInspect puts the whole reference in the path and
    // sends no query parameters: the tag belongs in the path segment.
    res = await request('GET', `/distribution/${ref.repository}:${ref.tag}/json`);
  } catch (e) {
    return { ok: false, reason: 'image-digest-resolve-failed', detail: e?.message || String(e) };
  }
  const digest = normalizeImageDigest(
    res?.body?.Descriptor?.digest
    ?? res?.body?.descriptor?.digest
    ?? res?.body?.digest,
  );
  if (!digest) {
    return {
      ok: false,
      reason: 'image-digest-resolve-failed',
      detail: `docker distribution inspect for ${ref.repository}:${ref.tag} did not return a sha256 digest`,
    };
  }
  return {
    ok: true,
    digest,
    image: `${ref.repository}@${digest}`,
    repository: ref.repository,
    tag: ref.tag,
    operatorPinned: false,
  };
}

/**
 * The /images/create endpoint streams a JSONL pull progress feed and
 * doesn't terminate until the pull completes. Wait for the response body
 * to drain before returning.
 */
export function dockerPull(image, { request = httpRequest } = {}) {
  const ref = parseImageReference(image);
  // Moby's client sends a digest pull as fromImage=<repo>&tag=sha256:<hex>;
  // `fromImage=repo@sha256:…` is not the daemon API shape.
  const fromImage = ref?.digest ? ref.repository : image;
  const digestTag = ref?.digest ? `&tag=${encodeURIComponent(ref.digest)}` : '';
  const pullPath = `/images/create?fromImage=${encodeURIComponent(fromImage)}${digestTag}`;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: DOCKER_SOCK,
        method: 'POST',
        path: pullPath,
        headers: { 'Content-Type': 'application/json' },
        timeout: 600000,
      },
      (res) => {
        collectDockerResponse(res, {
          maxBytes: DOCKER_PULL_BODY_LIMIT,
          label: `docker pull ${image}`,
        }).then((raw) => {
          const buf = raw.toString('utf8');
          if (!(res.statusCode >= 200 && res.statusCode < 300)) {
            reject(new Error(`docker pull ${image} -> ${res.statusCode}: ${buf.slice(0, 400)}`));
            return;
          }
          let sawRecord = false;
          let lastRecordCompleted = false;
          // audit #11: /images/create streams JSONL and returns HTTP 200 EVEN
          // WHEN THE PULL FAILS (unknown tag, auth/registry error) — the failure
          // is an {"error":...} / {"errorDetail":...} line in the body, not the
          // status. Treating 200 as success left the deployer silently on the
          // OLD image. Scan the stream and reject if any line reports an error.
          for (const line of buf.split('\n')) {
            const s = line.trim();
            if (!s) continue;
            let obj;
            try { obj = JSON.parse(s); } catch {
              reject(new Error(`docker pull ${image} returned malformed JSONL`));
              return;
            }
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
              reject(new Error(`docker pull ${image} returned an invalid JSONL record`));
              return;
            }
            sawRecord = true;
            if (Object.prototype.hasOwnProperty.call(obj, 'error')
                || Object.prototype.hasOwnProperty.call(obj, 'errorDetail')) {
              const detail = obj.errorDetail;
              const msg = (detail && typeof detail === 'object' && detail.message)
                || detail || obj.error || 'unknown docker pull error';
              reject(new Error(`docker pull ${image} failed: ${String(msg).slice(0, 400)}`));
              return;
            }
            const status = typeof obj.status === 'string' ? obj.status.trim() : '';
            const aux = obj.aux && typeof obj.aux === 'object' && !Array.isArray(obj.aux)
              ? obj.aux
              : null;
            const auxDigest = aux && (aux.Digest || aux.digest || aux.ID || aux.id);
            const hasAuxDigest = typeof auxDigest === 'string'
              && /^sha256:[0-9a-f]{64}$/i.test(auxDigest.trim());
            // Docker's pull stream is progress-only until a terminal status (or
            // explicit auxiliary digest) arrives. HTTP 200 plus a clean EOF is
            // not proof that the requested image was pulled: registries and
            // daemon proxies can truncate the stream without an error record.
            lastRecordCompleted = hasAuxDigest
              || /^(?:status:\s*)?(?:downloaded newer image|image is up to date)(?:\s+for\b.*)?$/i.test(status);
          }
          if (!sawRecord) {
            reject(new Error(`docker pull ${image} returned an empty JSONL stream`));
            return;
          }
          if (!lastRecordCompleted) {
            reject(new Error(`docker pull ${image} returned no terminal success record`));
            return;
          }
          resolve(buf);
        }, reject);
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('docker pull timeout (10min)')));
    req.end();
  });
}

/**
 * Detect whether docker self-update is feasible.
 * Returns { available, reason, ...detail } so the dashboard can show
 * the right hint when it's not.
 */
export async function detectDockerSelfUpdate({
  exists = existsSync,
  readSelfId = readSelfContainerId,
  request = dockerRequest,
} = {}) {
  if (!exists(DOCKER_SOCK)) {
    return { available: false, reason: 'no-docker-sock', detail: `${DOCKER_SOCK} not mounted` };
  }
  let selfId;
  try { selfId = normalizeDockerContainerId(readSelfId()); } catch {}
  if (!selfId) {
    return {
      available: false,
      reason: 'no-self-id',
      detail: 'cannot prove own full container id from a Docker cgroup or corroborated runtime mounts',
    };
  }
  let inspect;
  try {
    inspect = await request('GET', `/containers/${selfId}/json`);
 } catch (e) {
   return { available: false, reason: 'docker-api-unreachable', detail: e.message };
 }
  const inspectedId = normalizeDockerContainerId(inspect?.body?.Id);
  if (inspectedId !== selfId) {
    return {
      available: false,
      reason: 'self-id-mismatch',
      detail: 'docker inspect did not return the exact container id proven by local runtime evidence',
    };
  }
  const labels = inspect.body?.Config?.Labels || {};
  const project = labels['com.docker.compose.project'];
  const workingDir = labels['com.docker.compose.project.working_dir'];
  const configFilesLabel = labels[COMPOSE_CONFIG_FILES_LABEL];
  const image = inspect.body?.Config?.Image;
  const service = labels['com.docker.compose.service'];
  // The running image ID is the docker rollback point. Without it the deployer
  // cannot restore a known-good image, so treat its absence as unavailable
  // rather than starting a mutation with no way back.
  const imageId = normalizeDockerImageId(inspect.body?.Image);
  if (!project || !workingDir) {
    return {
      available: false,
      reason: 'no-compose-labels',
      detail: 'container has no com.docker.compose.* labels — was it started via `docker run` instead of `docker compose up`?',
      image, selfId,
    };
  }
  if (typeof configFilesLabel !== 'string' || configFilesLabel.length === 0) {
    return {
      available: false,
      reason: 'no-compose-config-files',
      detail: 'container has no Compose config_files label; the exact deployment configuration cannot be replayed safely',
      image, selfId,
    };
  }
  if (!isSafeComposeProject(project) || !isSafeComposeWorkingDir(workingDir)) {
    return {
      available: false,
      reason: 'unsafe-compose-labels',
      detail: 'compose project / working_dir label failed safety validation',
      image, selfId,
    };
  }
  const configFiles = parseComposeConfigFiles(configFilesLabel, workingDir);
  if (!configFiles) {
    return {
      available: false,
      reason: 'unsafe-compose-config-files',
      detail: 'Compose config_files must be unique absolute files contained by the validated project working_dir',
      image, selfId,
    };
  }
  if (!service || !isSafeComposeProject(service)) {
    return {
      available: false,
      reason: 'no-compose-service',
      detail: 'container has no valid com.docker.compose.service label; the app service to recreate/roll back cannot be identified',
      image, selfId,
    };
  }
  if (!imageId) {
    return {
      available: false,
      reason: 'no-image-id',
      detail: 'docker inspect did not return the running image id; a rollback point cannot be recorded',
      image, selfId,
    };
  }
  return {
    available: true,
    selfId,
    image,
    imageId,
    service,
    project,
    workingDir,
    configFiles,
  };
}

/**
 * Run the full self-update flow. Returns after the deployer sidecar is
 * started; the recreate happens out-of-band ~8s later and is health-gated by
 * the deployer. `state:'pending-recreate'` + `verified:false` is deliberate:
 * success is only confirmed by a later /self-update/check after the deployer
 * exits, never by this response.
 */
export async function runDockerSelfUpdate({
  detect = detectDockerSelfUpdate,
  pull = dockerPull,
  request = dockerRequest,
  stateDir = config.dataDir,
  digestFile,
  readDigest = readImageDigestFile,
  resolveDigest = resolveImageDigest,
} = {}) {
  const ctx = await detect();
  if (!ctx.available) return { ok: false, ...ctx };
  const selfId = normalizeDockerContainerId(ctx.selfId);
  const configFiles = validateComposeConfigFiles(ctx.configFiles, ctx.workingDir);
  if (!selfId) {
    return { ok: false, reason: 'no-self-id', detail: 'self-update context did not contain a full Docker container id' };
  }
  if (!isSafeComposeProject(ctx.project) || !isSafeComposeWorkingDir(ctx.workingDir)) {
    return { ok: false, reason: 'unsafe-compose-labels', detail: 'self-update context contained unsafe Compose labels' };
  }
  if (!configFiles) {
    const reason = Array.isArray(ctx.configFiles) ? 'unsafe-compose-config-files' : 'no-compose-config-files';
    return { ok: false, reason, detail: 'self-update context did not prove the exact Compose config files to replay' };
  }
  if (typeof ctx.image !== 'string' || ctx.image.length === 0 || /[\0\r\n]/.test(ctx.image)) {
    return { ok: false, reason: 'unsafe-image', detail: 'self-update context contained an invalid image reference' };
  }
  const imageId = normalizeDockerImageId(ctx.imageId);
  if (!imageId) {
    return { ok: false, reason: 'no-image-id', detail: 'self-update context did not contain the running image id; refusing a mutation with no rollback point' };
  }
  if (!ctx.service || !isSafeComposeProject(ctx.service)) {
    return { ok: false, reason: 'no-compose-service', detail: 'self-update context did not contain a valid Compose service name' };
  }
  const rollbackRef = rollbackImageRef(ctx.image);
  if (!rollbackRef) {
    return { ok: false, reason: 'unsafe-rollback-ref', detail: 'could not derive a rollback tag from the running image reference' };
  }

  const deployerRef = parseImageReference(DEPLOYER_IMAGE);
  if (!deployerRef?.digest) {
    return {
      ok: false,
      reason: 'deployer-unpinned',
      detail: 'the deployer helper image is not digest-pinned; refusing to run it with docker.sock',
    };
  }

  // Policy T (D9 §5.1 B1/B2): a tag is only a lookup key. Resolve it through
  // the daemon's registry-metadata endpoint and require the result to equal
  // the digest recorded in the signed image-digest.txt release asset. A
  // digest-pinned reference is an operator pin and is used verbatim.
  const sourceRef = parseImageReference(ctx.image);
  if (!sourceRef) {
    return { ok: false, reason: 'unsafe-image', detail: 'self-update context contained an image reference that cannot be parsed' };
  }
  let targetImage;
  let targetDigest;
  if (sourceRef.digest) {
    targetDigest = sourceRef.digest;
    targetImage = `${sourceRef.repository}@${targetDigest}`;
  } else {
    let attested;
    try {
      attested = readDigest({ file: digestFile ?? join(stateDir, IMAGE_DIGEST_FILENAME) });
    } catch (e) {
      return { ok: false, reason: 'image-mutable-ref', cause: 'image-digest-missing', detail: e?.message || String(e) };
    }
    if (!attested.ok) return attested;
    let resolved;
    try {
      resolved = await resolveDigest(ctx.image, { request });
    } catch (e) {
      return { ok: false, reason: 'image-digest-resolve-failed', detail: e?.message || String(e) };
    }
    if (!resolved.ok) return resolved;
    if (resolved.digest !== attested.digest) {
      log.warn(`self-update: image digest mismatch for ${ctx.image}: registry ${resolved.digest}, signed ${attested.digest}`);
      return {
        ok: false,
        reason: 'image-digest-mismatch',
        detail: `registry resolved ${ctx.image} to ${resolved.digest}, but the signed ${IMAGE_DIGEST_FILENAME} names ${attested.digest}; refusing to pull or deploy`,
      };
    }
    targetDigest = resolved.digest;
    targetImage = resolved.image;
  }

  // D6: durable rollback point + pending state BEFORE any mutation. This file
  // lives in the app's data dir (a host bind in the compose deployment), so it
  // survives the recreate and is what /self-update/check reconciles.
  const journal = {
    version: 1,
    mode: 'docker',
    state: 'pending-recreate',
    oldImageId: imageId,
    oldImageRef: ctx.image,
    rollbackRef,
    targetImage,
    project: ctx.project,
    service: ctx.service,
    selfId,
    requestedAt: Date.now(),
  };
  try {
    writeDockerSelfUpdateState(journal, { stateDir });
  } catch (e) {
    return {
      ok: false,
      reason: 'rollback-point-write-failed',
      detail: `Could not durably record the previous image; update was not attempted: ${e.message}`,
    };
  }
  const fail = (reason, detail) => {
    try {
      updateDockerSelfUpdateState({ state: 'failed', reason, error: detail }, { stateDir });
    } catch (err) {
      log.warn(`self-update: could not record docker update failure (${reason}): ${err.message}`);
    }
    return { ok: false, reason, detail };
  };

  // Pull the new image by digest. This blocks until the pull finishes — could
  // be 30s-2min for a fresh layer set, but the user is staring at the
  // dashboard and a fast progress signal beats a confusing async
  // "started, check back later" UX.
  try {
    await pull(targetImage);
  } catch (e) {
    return fail('pull-failed', e.message);
  }

  // B3: when the daemon reports RepoDigests, require the pulled image to be
  // addressable by the exact digest we are about to deploy. (A daemon that
  // omits the field is not treated as proof of a different image: the pull
  // itself was content-addressed. A present list that lacks the digest is a
  // hard failure.)
  try {
    const inspected = await request('GET', `/images/${targetImage}/json`);
    const repoDigests = inspected?.body?.RepoDigests;
    if (Array.isArray(repoDigests)
        && !repoDigests.some((entry) => String(entry).toLowerCase().endsWith(`@${targetDigest}`))) {
      return fail('image-digest-unconfirmed', `docker pull ${targetImage} completed but RepoDigests does not contain ${targetDigest}`);
    }
  } catch (e) {
    return fail('image-digest-unconfirmed', e.message);
  }

  // Also ensure the deployer sidecar image is local. First-time users on
  // a host that has never pulled `docker:24-cli` will otherwise hit
  //   POST /containers/create -> 404: No such image: docker:24-cli
  // (reported as the dashboard "一键更新并重启" failure path). Pull it
  // explicitly. It's tiny (~30 MB) and only runs the one-shot
  // `docker compose up -d`, so this is a one-time cost per host.
  try {
    await pull(DEPLOYER_IMAGE);
  } catch (e) {
    return fail('deployer-pull-failed', e.message);
  }

  // Spawn the deployer sidecar. It recreates the app, then health-gates the
  // result and automatically restores the previous image when the new one is
  // unhealthy (the same pattern as deploy/update.sh health_gate/restore_image).
  // AutoRemove stays off so the exit code — 0 healthy, 1 rolled back healthy,
  // 2 rollback failed, 3 recreate failed — survives as durable evidence until
  // the next /self-update/check reconciles it.
  //
  // The sleep at the start gives the dashboard's HTTP response time to
  // flush back to the browser before our container gets killed.
  let createRes;
  try {
    createRes = await request('POST', `/containers/create`, {
      Image: DEPLOYER_IMAGE,
      Cmd: [
        'sh', '-c',
        buildDockerDeployerScript({
          project: ctx.project,
          workingDir: ctx.workingDir,
          configFiles,
          service: ctx.service,
          oldImageId: imageId,
          rollbackRef,
          targetImage,
        }),
      ],
      Labels: {
        [DEPLOYER_ROLE_LABEL]: DEPLOYER_ROLE,
        [DEPLOYER_PROJECT_LABEL]: ctx.project,
        [DEPLOYER_OLD_IMAGE_LABEL]: imageId,
        'com.windsurf-api.parent': selfId,
      },
      HostConfig: {
        AutoRemove: false,
        Binds: [
          `${DOCKER_SOCK}:${DOCKER_SOCK}`,
          `${ctx.workingDir}:${ctx.workingDir}:ro`,
        ],
      },
    });
  } catch (e) {
    return fail('deployer-create-failed', e.message);
  }

  const deployerId = normalizeDockerContainerId(createRes.body?.Id);
  if (!deployerId) {
    return fail('deployer-create-no-id', JSON.stringify(createRes.body).slice(0, 400));
  }

  try {
    await request('POST', `/containers/${deployerId}/start`, null);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    try {
      await request('DELETE', `/containers/${deployerId}?force=1`, null);
    } catch {
      // Cleanup is best-effort; the start error remains the authoritative result.
    }
    return fail('deployer-start-failed', detail);
  }

  try {
    updateDockerSelfUpdateState({ deployerId, state: 'pending-recreate' }, { stateDir });
  } catch (err) {
    log.warn(`self-update: could not record the started deployer: ${err.message}`);
  }

  return {
    ok: true,
    state: 'pending-recreate',
    verified: false,
    image: targetImage,
    sourceImage: ctx.image,
    project: ctx.project,
    workingDir: ctx.workingDir,
    deployerId: deployerId.slice(0, 12),
    delaySeconds: DEPLOYER_DELAY_SECONDS,
    rollbackPoint: { imageId, imageRef: ctx.image, rollbackRef },
    message: `Pulled ${targetImage}; the deployer sidecar will recreate the container in ~${DEPLOYER_DELAY_SECONDS}s and health-gate it. Success is confirmed only after /self-update/check reports state:confirmed.`,
  };
}

// ─── Durable docker update state (D6) ─────────────────────
function dockerStatePath(stateDir) {
  return join(stateDir, DOCKER_STATE_FILENAME);
}

export function readDockerSelfUpdateState({ stateDir = config.dataDir } = {}) {
  try {
    const value = JSON.parse(readFileSync(dockerStatePath(stateDir), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function writeDockerSelfUpdateState(record, { stateDir = config.dataDir } = {}) {
  writeJsonAtomic(dockerStatePath(stateDir), record);
  return record;
}

function updateDockerSelfUpdateState(patch, opts) {
  const next = { ...(readDockerSelfUpdateState(opts) || {}), ...patch, updatedAt: Date.now() };
  return writeDockerSelfUpdateState(next, opts);
}

// Mirror deploy/update.sh's rollback_target_ref(): keep the repository, swap
// the tag for a stable :rollback name so the previous image stays addressable.
function rollbackImageRef(image) {
  const raw = String(image || '').trim();
  if (!raw || /[\0\r\n\s]/.test(raw)) return '';
  const withoutDigest = raw.split('@')[0];
  const slash = withoutDigest.lastIndexOf('/');
  const colon = withoutDigest.lastIndexOf(':');
  const repo = colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
  if (!repo) return '';
  return `${repo}:rollback`;
}

/**
 * Build the deployer's POSIX sh script. Exported for the hermetic test that
 * executes it against a fake docker CLI.
 *
 * Exit codes: 0 = new image healthy, 1 = previous image restored and healthy,
 * 2 = rollback failed or the restored image is unhealthy, 3 = recreate failed.
 */
export function buildDockerDeployerScript({
  project,
  workingDir,
  configFiles,
  service,
  oldImageId,
  rollbackRef,
  targetImage = '',
  // Overridable for the hermetic script test; production uses the constants.
  delaySeconds = DEPLOYER_DELAY_SECONDS,
  healthTimeoutSeconds = DEPLOYER_HEALTH_TIMEOUT_SECONDS,
  healthIntervalSeconds = DEPLOYER_HEALTH_INTERVAL_SECONDS,
}) {
  if (targetImage && !parseImageReference(targetImage)?.digest) {
    throw new Error('targetImage must be a digest-pinned reference');
  }
  const compose = 'docker compose -p ' + shellQuote(project)
    + ' --project-directory ' + shellQuote(workingDir)
    + ' ' + configFiles.map(file => '-f ' + shellQuote(file)).join(' ');
  // Run the probe inside the app container: the deployer image has no HTTP
  // client and must not rely on host networking.
  const probe = 'node -e ' + shellQuote(
    "fetch('http://127.0.0.1:'+(process.env.PORT||3003)+'/health')"
    + '.then(async r=>{if(!r.ok)process.exit(1);const t=await r.text();process.stdout.write(t)})'
    + '.catch(()=>process.exit(1))',
  );
  const tries = Math.max(1, Math.ceil(healthTimeoutSeconds / healthIntervalSeconds));
  return [
    'set -e',
    `sleep ${delaySeconds}`,
    'health_gate() {',
    '  i=0',
    `  while [ "$i" -lt ${tries} ]; do`,
    `    if ${compose} exec -T ${shellQuote(service)} ${probe} >/dev/null 2>&1; then`,
    '      return 0',
    '    fi',
    '    i=$((i + 1))',
    `    sleep ${healthIntervalSeconds}`,
    '  done',
    '  return 1',
    '}',
    // Policy T (D9 §5.1 B4): --no-build is mandatory. docker-compose.yml
    // defines build: for the app service, so a bare `up` can build from the
    // on-disk checkout — code no trust policy has looked at.
    `${targetImage ? `WINDSURFAPI_IMAGE=${shellQuote(targetImage)} ` : ''}${compose} up -d --no-build || exit 3`,
    'if health_gate; then exit 0; fi',
    `docker tag ${shellQuote(oldImageId)} ${shellQuote(rollbackRef)} || exit 2`,
    `WINDSURFAPI_IMAGE=${shellQuote(rollbackRef)} ${compose} up -d --no-deps --no-build --force-recreate ${shellQuote(service)} || exit 2`,
    'if health_gate; then exit 1; fi',
    'exit 2',
  ].join('\n');
}

/**
 * Read the deployer's durable outcome after a restart.
 *
 * The journal is the app-side record; the deployer container's exit code is
 * the out-of-band evidence. Terminal mapping:
 *   0 confirmed · 1 rolled-back · 2 rollback-failed · 3 recreate-failed
 * Anything still running (or absent) is reported honestly instead of being
 * rounded up to success.
 */
export async function reconcileDockerSelfUpdateState({
  stateDir = config.dataDir,
  request = dockerRequest,
  readSelfId = readSelfContainerId,
} = {}) {
  const journal = readDockerSelfUpdateState({ stateDir });
  if (!journal) return null;
  if (!DOCKER_PENDING_STATES.has(journal.state)) return journal;

  const filters = encodeURIComponent(JSON.stringify({
    label: [`${DEPLOYER_ROLE_LABEL}=${DEPLOYER_ROLE}`],
  }));
  let containers;
  try {
    const listed = await request('GET', `/containers/json?all=1&filters=${filters}`);
    containers = Array.isArray(listed?.body) ? listed.body : [];
  } catch (err) {
    return { ...journal, deployerStatus: 'unreachable', deployerError: err.message };
  }
  const match = containers.find((entry) => {
    const labels = entry?.Labels || {};
    if (journal.deployerId && !String(entry?.Id || '').startsWith(journal.deployerId)) return false;
    if (journal.project && labels[DEPLOYER_PROJECT_LABEL] !== journal.project) return false;
    return true;
  });

  if (!match) {
    // No deployer container left to read. Report what the running image
    // proves; never claim a health-gated success without the exit code.
    let runningImageId = '';
    try {
      const selfId = normalizeDockerContainerId(readSelfId());
      if (selfId) {
        const inspected = await request('GET', `/containers/${selfId}/json`);
        runningImageId = normalizeDockerImageId(inspected?.body?.Image) || '';
      }
    } catch { /* the missing evidence is the answer */ }
    const next = {
      ...journal,
      state: 'unverified',
      reason: 'deployer-evidence-missing',
      runningImageId: runningImageId || undefined,
    };
    try { writeDockerSelfUpdateState(next, { stateDir }); } catch (err) {
      log.warn(`self-update: could not record the missing deployer evidence: ${err.message}`);
    }
    return next;
  }

  const status = String(match.State || '');
  if (status !== 'exited' && status !== 'dead') {
    return { ...journal, state: 'deployer-running', deployerStatus: status || 'unknown' };
  }

  const exitCode = Number(match.ExitCode);
  const state = exitCode === 0
    ? 'confirmed'
    : exitCode === 1
      ? 'rolled-back'
      : exitCode === 2
        ? 'rollback-failed'
        : exitCode === 3
          ? 'recreate-failed'
          : 'deployer-failed';
  const next = {
    ...journal,
    state,
    deployerExitCode: Number.isFinite(exitCode) ? exitCode : null,
    deployerStatus: status,
    finishedAt: Date.now(),
  };
  try {
    writeDockerSelfUpdateState(next, { stateDir });
  } catch (err) {
    log.warn(`self-update: could not record the docker deployer outcome: ${err.message}`);
    return { ...journal, state: 'deployer-running', deployerStatus: status };
  }
  // The exit code is durable in the journal now; the container is not needed.
  try { await request('DELETE', `/containers/${match.Id}?force=1`, null); } catch { /* best effort */ }
  return next;
}

// Single-quote-wrap a value for safe injection into a `sh -c "..."`
// payload. Single quotes inside the value get terminated, escaped,
// re-opened: `'foo'` -> `'foo'\''bar'`. The compose project name and
// working_dir come from container labels which we don't fully control,
// so don't trust them blindly.
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}
