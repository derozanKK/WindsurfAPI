/**
 * Smoke-matrix families: engines · docker.
 *
 * engines: the declared runtime floor (Node 22.13+, 3.9.52) must agree across
 * every place that ships it — package.json, the Docker base image and the two
 * installers — and the process running the suite must satisfy it. A floor that
 * only exists in package.json is decoration: npm warns, it does not stop.
 *
 * docker: the image's HEALTHCHECK is the only liveness contract a container
 * orchestrator gets, so the suite extracts the real command and EXECUTES it
 * against the live smoke server (positive: exit 0; negative: exit 1). Compose
 * is validated with the docker CLI when it is installed; a missing CLI/daemon
 * is reported, never faked.
 */

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PACKAGE_JSON = fileURLToPath(new URL('../../package.json', import.meta.url));
const DOCKERFILE = fileURLToPath(new URL('../../Dockerfile', import.meta.url));
const COMPOSE_FILE = fileURLToPath(new URL('../../docker-compose.yml', import.meta.url));
const SETUP_SH = fileURLToPath(new URL('../../setup.sh', import.meta.url));
const START_PS1 = fileURLToPath(new URL('../../deploy/windows/start.ps1', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const ENGINE_FLOOR = Object.freeze({ major: 22, minor: 13, patch: 0 });

function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text || '').trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

function atLeast(version, floor) {
  if (!version) return false;
  if (version.major !== floor.major) return version.major > floor.major;
  if (version.minor !== floor.minor) return version.minor > floor.minor;
  return version.patch >= floor.patch;
}

function fmt(version) {
  return version ? `${version.major}.${version.minor}.${version.patch}` : '?';
}

/** Run a local binary with the suite's own env hygiene (no test preloads). */
function run(command, args, opts = {}) {
  const { env: extraEnv, ...rest } = opts;
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  delete env.FORCE_COLOR;
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    ...rest,
    env: { ...env, ...(extraEnv || {}) },
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error || null,
  };
}

/**
 * Async variant. `spawnSync` blocks THIS process's event loop, and the child
 * healthcheck fetches the smoke server that lives in this same process — a
 * synchronous wait can never see the response, so the probe must be awaited.
 */
function runAsync(command, args, opts = {}) {
  const { env: extraEnv, timeout = 15_000, ...rest } = opts;
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  delete env.FORCE_COLOR;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      ...rest,
      env: { ...env, ...(extraEnv || {}) },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (status, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, error });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* best-effort */ }
      finish(null, 'SIGKILL', Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish(null, null, error));
    child.on('close', (status, signal) => finish(status, signal, null));
  });
}

export function registerRuntimeFlows(ctx) {
  const { http, requireThat, addFlow } = ctx;

  // ─── engines ─────────────────────────────────────────────────────────
  addFlow('engines', 'engines.declared-floor-agrees-with-runtime', async () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
    const declared = String(pkg.engines?.node || '');
    requireThat(declared === `>=${ENGINE_FLOOR.major}.${ENGINE_FLOOR.minor}.${ENGINE_FLOOR.patch}`,
      `package.json engines.node is ${JSON.stringify(declared)}, expected >=${ENGINE_FLOOR.major}.${ENGINE_FLOOR.minor}.${ENGINE_FLOOR.patch}`);

    const running = parseVersion(process.versions.node);
    requireThat(!!running, `unreadable process.versions.node ${process.versions.node}`);
    requireThat(atLeast(running, ENGINE_FLOOR), `this suite runs on Node ${fmt(running)}, below the declared floor`);

    const dockerfile = readFileSync(DOCKERFILE, 'utf8');
    const base = /^FROM\s+node:(\d+)/m.exec(dockerfile);
    requireThat(!!base, 'Dockerfile does not pin a node base image');
    const baseMajor = Number(base[1]);
    requireThat(baseMajor >= ENGINE_FLOOR.major, `Docker base node:${baseMajor} is below the Node ${ENGINE_FLOOR.major} floor`);

    // Installers: the string is the operator-facing promise, and setup.sh's
    // gate is an executable predicate, so run the predicate itself.
    const setup = readFileSync(SETUP_SH, 'utf8');
    requireThat(setup.includes(`>= ${ENGINE_FLOOR.major}.${ENGINE_FLOOR.minor}`), 'setup.sh does not state the 22.13 floor');
    const predicate = /node -e '([^']+)'/.exec(setup);
    requireThat(!!predicate, 'setup.sh no longer gates Node with an executable predicate');
    requireThat(predicate[1].includes(`a===${ENGINE_FLOOR.major}&&b>=${ENGINE_FLOOR.minor}`), `setup.sh predicate drifted: ${predicate[1]}`);
    const gate = run(process.execPath, ['-e', predicate[1]]);
    requireThat(gate.status === 0, `setup.sh Node gate rejects this runtime (exit ${gate.status})`);

    const startPs1 = readFileSync(START_PS1, 'utf8');
    requireThat(startPs1.includes(`[version]'${ENGINE_FLOOR.major}.${ENGINE_FLOOR.minor}.${ENGINE_FLOOR.patch}'`),
      'deploy/windows/start.ps1 does not compare against the 22.13.0 floor');

    return `Node ${fmt(running)} ≥ ${ENGINE_FLOOR.major}.${ENGINE_FLOOR.minor}.${ENGINE_FLOOR.patch}; package.json, Docker base (${baseMajor}) and both installers agree`;
  });

  // ─── docker ──────────────────────────────────────────────────────────
  addFlow('docker', 'docker.healthcheck-runs-against-live-server', async () => {
    const dockerfile = readFileSync(DOCKERFILE, 'utf8');
    const health = /HEALTHCHECK\s+([^\n\\]*)\\\s*\n\s*CMD\s+node -e "([^"]+)"/.exec(dockerfile);
    requireThat(!!health, 'Dockerfile has no HEALTHCHECK ... CMD node -e "<expr>" block');
    const flags = health[1];
    const expression = health[2];
    for (const flag of ['--interval=30s', '--timeout=5s', '--start-period=20s', '--retries=3']) {
      requireThat(flags.includes(flag), `HEALTHCHECK is missing ${flag}`);
    }
    requireThat(expression.includes('/health'), 'healthcheck does not probe /health');
    requireThat(expression.includes('process.env.PORT || 3003'), 'healthcheck does not fall back to PORT 3003');
    requireThat(/EXPOSE\s+3003/.test(dockerfile), 'Dockerfile no longer EXPOSEs 3003');
    requireThat(/CMD\s+\["node",\s*"src\/index\.js"\]/.test(dockerfile), 'Dockerfile entrypoint drifted');

    requireThat(typeof ctx.base === 'string' && ctx.base, 'smoke server base URL is not known');
    const port = Number(new URL(ctx.base).port);
    requireThat(Number.isInteger(port) && port > 0, `unreadable smoke port ${ctx.base}`);

    // Execute the exact command the container runtime executes. This MUST be
    // async: the target server runs in this process, and spawnSync would block
    // the event loop that has to answer the probe.
    const healthy = await runAsync(process.execPath, ['-e', expression], { env: { PORT: String(port) } });
    requireThat(healthy.status === 0, `healthcheck against the live server exited ${healthy.status}: ${healthy.stderr.trim().slice(0, 200)}`);
    const dead = await runAsync(process.execPath, ['-e', expression], { env: { PORT: '1' } });
    requireThat(dead.status !== 0, 'healthcheck reported healthy against a closed port');

    // Compose inherits the image HEALTHCHECK; a disabled check would silently
    // remove it, so assert the file does not opt out and maps the documented
    // host port.
    const compose = readFileSync(COMPOSE_FILE, 'utf8');
    requireThat(/dockerfile:\s*Dockerfile/.test(compose), 'compose no longer builds from the Dockerfile');
    requireThat(compose.includes('${PORT:-3003}:80'), 'compose does not publish ${PORT:-3003}:80');
    requireThat(/depends_on:\s*\n\s*-\s*windsurf-api/.test(compose), 'nginx does not depend on windsurf-api');
    requireThat(!/healthcheck:\s*\n\s*disable:\s*true/.test(compose), 'compose disables the image healthcheck');

    let detail = `healthcheck exits 0 on :${port}, non-zero on a closed port`;
    const cli = run('docker', ['--version'], { timeout: 10_000 });
    if (cli.error || cli.status !== 0) {
      return `${detail}; docker CLI unavailable → compose validation skipped [UNVERIFIED]`;
    }
    const composeCli = run('docker', ['compose', 'version'], { timeout: 15_000 });
    if (composeCli.error || composeCli.status !== 0) {
      return `${detail}; compose plugin unavailable → compose validation skipped [UNVERIFIED]`;
    }
    const config = run('docker', ['compose', 'config', '--quiet'], { cwd: ROOT, timeout: 30_000 });
    requireThat(config.status === 0, `docker compose config failed: ${config.stderr.trim().slice(0, 300)}`);
    detail += '; compose config valid';
    const info = run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 8_000 });
    if (!info.error && info.status === 0 && info.stdout.trim()) {
      detail += `; daemon ${info.stdout.trim()} (container health not exercised: image not built here)`;
    } else {
      detail += '; daemon down (container health not exercised)';
    }
    return detail;
  });

  // A second docker flow so the family proves the panel-facing read is not the
  // only consumer: the health endpoint the container probes must answer the
  // same shape the orchestrator parses.
  addFlow('docker', 'docker.health-endpoint-contract', async () => {
    const r = await http('GET', '/health', { auth: 'none' });
    requireThat(r.status === 200, `health status ${r.status}`);
    requireThat(r.json?.status === 'ok', `health status field ${r.json?.status}`);
    requireThat(/^\d+\.\d+\.\d+/.test(String(r.json?.version)), `health version ${r.json?.version}`);
    requireThat(typeof r.json?.pid === 'number', 'health pid missing');
    requireThat(typeof r.json?.uptime === 'number', 'health uptime missing');
    requireThat(r.json?.accounts?.total >= 0, 'health accounts census missing');
    return 'the endpoint the HEALTHCHECK probes reports ok + version';
  });
}
