// deploy/update.sh — one-click Docker update smoke test.
//
// Runs the real shell script against a fake `docker` and `curl` on PATH, so the
// pull → recreate → /health → rollback state machine is exercised without a
// Docker daemon and without touching this checkout's containers or data.
//
// The script is executed on Linux/macOS only: Windows cannot exec shebang
// shims from PATH, so the integration cases skip there while the static
// contract checks (no `compose down`, no `-v`, rollback command shape) still
// run everywhere.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { after, describe, it as nodeIt } from 'node:test';
import assert from 'node:assert/strict';
import { buildDockerDeployerScript } from '../src/dashboard/docker-self-update.js';

const ROOT = resolve(process.cwd());
const SCRIPT = join(ROOT, 'deploy', 'update.sh');
const SCRIPT_SOURCE = readFileSync(SCRIPT, 'utf8');
const COMPOSE_SOURCE = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
const DOCS_SOURCE = readFileSync(join(ROOT, 'docs', 'DOCKER-UPDATE.md'), 'utf8');

function findBash() {
  if (process.platform !== 'win32') return 'bash';
  const candidates = [
    process.env.WINDSURFAPI_TEST_BASH,
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    'C:\\Program Files\\Git\\bin\\bash.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return 'bash';
}

const BASH = findBash();
// Windows CreateProcess cannot exec a `#!/usr/bin/env bash` file, so a fake
// docker on PATH would fall through to the real daemon. Skip integration there.
const RUN_INTEGRATION = process.platform !== 'win32';
const INTEGRATION_SKIP = 'deploy/update.sh integration fixtures require a POSIX host (Linux/macOS)';
const it = (name, fn) => nodeIt(name, { skip: RUN_INTEGRATION ? false : INTEGRATION_SKIP }, fn);

const OLD_ID = `sha256:${'1'.repeat(64)}`;
const NEW_ID = `sha256:${'2'.repeat(64)}`;
const ROLLBACK_ID = `sha256:${'3'.repeat(64)}`;
const CID = 'a'.repeat(64);

const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${FAKE_DOCKER_LOG:?}"
cmd="\${1:-}"
if [ "$cmd" = "info" ]; then exit 0; fi
if [ "$cmd" = "tag" ]; then exit 0; fi
if [ "$cmd" = "image" ]; then
  printf '%s\\n' "\${FAKE_NEW_ID:-${NEW_ID}}"
  exit 0
fi
if [ "$cmd" = "inspect" ]; then
  fmt="\${3:-}"
  case "$fmt" in
    *".Config.Image"*) printf '%s\\n' "\${FAKE_OLD_REF:-ghcr.io/dwgx/windsurf-api:latest}" ;;
    *".Image"*) printf '%s\\n' "\${FAKE_OLD_ID:-${OLD_ID}}" ;;
    *".State.Status"*) printf '%s\\n' "\${FAKE_STATE_STATUS:-running healthy}" ;;
    *) printf '\\n' ;;
  esac
  exit 0
fi
if [ "$cmd" = "compose" ]; then
  joined="$*"
  case "$joined" in
    *" version"*) exit 0 ;;
    *" config --quiet"*) exit 0 ;;
    *" config --images"*) printf 'ghcr.io/dwgx/windsurf-api:latest\\nnginx:alpine\\n'; exit 0 ;;
    *" config"*) printf 'services:\\n  windsurf-api:\\n    image: ghcr.io/dwgx/windsurf-api:latest\\n  nginx:\\n    image: nginx:alpine\\n'; exit 0 ;;
    *" ps -q "*) printf '%s\\n' "\${FAKE_CID:-}" ; exit 0 ;;
    *" port "*) if [ "\${FAKE_NO_PORT:-0}" = "1" ]; then exit 0; fi; printf '0.0.0.0:3999\\n'; exit 0 ;;
    *" pull "*) if [ "\${FAKE_PULL_FAIL:-0}" = "1" ]; then echo "pull denied" >&2; exit 1; fi; exit 0 ;;
    *" build "*) if [ "\${FAKE_BUILD_FAIL:-0}" = "1" ]; then echo "build denied" >&2; exit 1; fi; exit 0 ;;
    *" up "*) if [ "\${FAKE_UP_FAIL:-0}" = "1" ]; then echo "up denied" >&2; exit 1; fi; exit 0 ;;
    *" exec "*)
      # First exec hangs like a wedged container; the rollback probe succeeds.
      if [ "\${FAKE_EXEC_HANG:-0}" = "1" ] && [ ! -f "\${FAKE_EXEC_HANG_FILE:?}" ]; then
        : > "\${FAKE_EXEC_HANG_FILE}"
        sleep 60
      fi
      printf '%s\\n' '{"status":"ok","version":"3.9.53","commit":"deadbeef"}'; exit 0 ;;
  esac
  exit 0
fi
exit 0
`;

const FAKE_CURL = `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >> "\${FAKE_DOCKER_LOG:?}"
seq="\${FAKE_HEALTH_SEQ:-200}"
counter="\${FAKE_HEALTH_COUNTER:?}"
n=$(cat "$counter" 2>/dev/null || echo 0)
n=$((n + 1))
printf '%s\\n' "$n" > "$counter"
code=$(printf '%s' "$seq" | cut -d, -f"$n")
if [ -z "$code" ]; then
  code=$(printf '%s' "$seq" | awk -F, '{print $NF}')
fi
if [ "$code" = "200" ]; then
  printf '{"status":"ok","version":"3.9.53","commit":"deadbeef"}\\n'
  exit 0
fi
printf 'unhealthy\\n' >&2
exit 22
`;

function writeExecutable(path, source) {
  writeFileSync(path, source, 'utf8');
  chmodSync(path, 0o755);
}

const FIXTURES = [];

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'wa-docker-oneclick-'));
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  const state = join(root, 'state');
  mkdirSync(join(repo, 'deploy'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  copyFileSync(SCRIPT, join(repo, 'deploy', 'update.sh'));
  writeFileSync(
    join(repo, 'docker-compose.yml'),
    'services:\n  windsurf-api:\n    image: ${WINDSURFAPI_IMAGE:-ghcr.io/dwgx/windsurf-api:latest}\n',
    'utf8',
  );
  writeExecutable(join(bin, 'docker'), FAKE_DOCKER);
  writeExecutable(join(bin, 'curl'), FAKE_CURL);
  const fixture = {
    root,
    repo,
    bin,
    state,
    script: join(repo, 'deploy', 'update.sh'),
    log: join(root, 'docker.log'),
    counter: join(root, 'health.counter'),
  };
  FIXTURES.push(root);
  return fixture;
}

after(() => {
  for (const root of FIXTURES) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function run(fixture, args = [], overrides = {}) {
  const env = {
    ...process.env,
    PATH: [fixture.bin, dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter),
    FAKE_DOCKER_LOG: fixture.log,
    FAKE_EXEC_HANG_FILE: join(fixture.root, 'exec.hang'),
    FAKE_HEALTH_COUNTER: fixture.counter,
    FAKE_HEALTH_SEQ: '200',
    FAKE_CID: CID,
    FAKE_OLD_ID: OLD_ID,
    FAKE_OLD_REF: 'ghcr.io/dwgx/windsurf-api:latest',
    FAKE_NEW_ID: NEW_ID,
    WINDSURFAPI_UPDATE_STATE_DIR: fixture.state,
    WINDSURFAPI_COMPOSE_FILE: join(fixture.repo, 'docker-compose.yml'),
    WINDSURFAPI_PROJECT_DIR: fixture.repo,
    WINDSURFAPI_SERVICE: 'windsurf-api',
    WINDSURFAPI_LB_SERVICE: 'nginx',
    WINDSURFAPI_HEALTH_TIMEOUT: '0',
    WINDSURFAPI_HEALTH_INTERVAL: '0.01',
    WINDSURFAPI_PROBE_TIMEOUT: '2',
    WINDSURFAPI_IMAGE: '',
    ...overrides,
  };
  return spawnSync(BASH, [fixture.script, ...args], {
    cwd: fixture.repo,
    encoding: 'utf8',
    timeout: 30_000,
    env,
  });
}

function logLines(fixture) {
  if (!existsSync(fixture.log)) return [];
  return readFileSync(fixture.log, 'utf8').split('\n').filter(Boolean);
}

function assertNoDestructiveDockerCalls(fixture) {
  for (const line of logLines(fixture)) {
    assert.doesNotMatch(line, /\bcompose\b.*\bdown\b/, `update must never run compose down: ${line}`);
    assert.doesNotMatch(line, /\bcompose\b.*\s(?:-v|--volumes)\b/, `update must never drop volumes: ${line}`);
    assert.doesNotMatch(line, /\bvolume\s+rm\b/, `update must never remove volumes: ${line}`);
    assert.doesNotMatch(line, /^\s*rm\b/, `update must never remove containers/files: ${line}`);
  }
}

describe('deploy/update.sh static contract', () => {
  nodeIt('is a POSIX bash script with strict unset handling', () => {
    assert.match(SCRIPT_SOURCE, /^#!\/usr\/bin\/env bash\n/);
    assert.match(SCRIPT_SOURCE, /^set -uo pipefail$/m);
  });

  nodeIt('never tears down the stack or its volumes', () => {
    assert.doesNotMatch(SCRIPT_SOURCE, /^[^#\n]*\bcompose\s+down\b/m);
    assert.doesNotMatch(SCRIPT_SOURCE, /^[^#\n]*\bcompose\b[^\n]*\s(?:-v|--volumes)\b/m);
    assert.doesNotMatch(SCRIPT_SOURCE, /^[^#\n]*\bvolume\s+rm\b/m);
    assert.doesNotMatch(SCRIPT_SOURCE, /^[^#\n]*\brm\s+-rf\b/m);
  });

  nodeIt('pulls or builds, then recreates only the app, then rolls back', () => {
    assert.match(SCRIPT_SOURCE, /compose pull "\$SERVICE"/);
    assert.match(SCRIPT_SOURCE, /compose build "\$SERVICE"/);
    assert.match(SCRIPT_SOURCE, /up -d --no-deps --no-build/);
    assert.match(SCRIPT_SOURCE, /up -d --no-deps --no-build --force-recreate "\$SERVICE"/);
    assert.match(SCRIPT_SOURCE, /resolve_health_url/);
    assert.match(SCRIPT_SOURCE, /\/health/);
  });

  nodeIt('keeps a rollback point and supports an explicit --rollback', () => {
    assert.match(SCRIPT_SOURCE, /rollback-point\.env/);
    assert.match(SCRIPT_SOURCE, /--rollback\)/);
    assert.match(SCRIPT_SOURCE, /ROLLBACK_ID/);
  });

  nodeIt('exposes a dry-run that prints the plan', () => {
    assert.match(SCRIPT_SOURCE, /--dry-run\)/);
    assert.match(SCRIPT_SOURCE, /dry run/);
  });

  nodeIt('compose pins the app image through WINDSURFAPI_IMAGE', () => {
    assert.match(
      COMPOSE_SOURCE,
      /image:\s*\$\{WINDSURFAPI_IMAGE:-ghcr\.io\/dwgx\/windsurf-api:latest\}/,
    );
  });

  nodeIt('documents the exact one-command path and the safety properties', () => {
    assert.match(DOCS_SOURCE, /bash deploy\/update\.sh/);
    assert.match(DOCS_SOURCE, /--dry-run/);
    assert.match(DOCS_SOURCE, /--rollback/);
    assert.match(DOCS_SOURCE, /rollback/i);
    assert.match(DOCS_SOURCE, /data volume/i);
  });
});

describe('deploy/update.sh pull → health → rollback', () => {
  it('pulls, recreates the app, and passes the health gate', () => {
    const fixture = makeFixture();
    const result = run(fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /UPDATE OK/);
    const lines = logLines(fixture);
    const pull = lines.findIndex(line => /(^| )compose .* pull windsurf-api$/.test(line));
    const up = lines.findIndex(line => /(^| )compose .* up -d --no-deps --no-build windsurf-api$/.test(line));
    const probe = lines.findIndex(line => line.startsWith('curl '));
    assert.ok(pull >= 0, 'pull must run');
    assert.ok(up > pull, 'recreate must follow the pull');
    assert.ok(probe > up, 'health probe must follow the recreate');
    assert.ok(lines.some(line => line.startsWith(`tag ${OLD_ID} `)), 'previous image must be tagged as the rollback point');
    assert.ok(!lines.some(line => line.includes('--force-recreate')), 'successful update must not roll back');
    assertNoDestructiveDockerCalls(fixture);
  });

  it('starts the whole stack when no app container exists yet', () => {
    const fixture = makeFixture();
    const result = run(fixture, [], { FAKE_CID: '' });

    assert.equal(result.status, 0, result.stderr);
    const lines = logLines(fixture);
    assert.ok(lines.some(line => /(^| )compose .* up -d --no-build$/.test(line)));
    assert.ok(!lines.some(line => line.includes('--no-deps')));
    assertNoDestructiveDockerCalls(fixture);
  });

  it('rolls back automatically when /health fails, preserving the data volume', () => {
    const fixture = makeFixture();
    const result = run(fixture, [], { FAKE_HEALTH_SEQ: '500,200' });

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /ROLLED BACK/);
    const lines = logLines(fixture);
    assert.ok(
      lines.some(line => / up -d --no-deps --no-build --force-recreate windsurf-api$/.test(line)),
      'rollback must force-recreate the app service',
    );
    assert.ok(
      lines.some(line => line === `tag ${OLD_ID} ghcr.io/dwgx/windsurf-api:latest`),
      'rollback must retag the previous image back to the deployment ref',
    );
    assertNoDestructiveDockerCalls(fixture);
  });

  it('bounds a hanging in-container health probe and still rolls back', () => {
    const fixture = makeFixture();
    const started = Date.now();
    // No published port forces the `compose exec` fallback. Its first call
    // hangs like a container that is `running` but wedged — the exact failure
    // the health gate exists for. Without a bound the script never reaches the
    // rollback; the fixture's later probes succeed so the rollback gate can
    // prove the old image healthy.
    const result = run(fixture, [], {
      FAKE_NO_PORT: '1',
      FAKE_EXEC_HANG: '1',
      WINDSURFAPI_PROBE_TIMEOUT: '1',
    });
    const elapsed = Date.now() - started;

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /UPDATE FAILED/);
    assert.match(result.stdout, /ROLLED BACK/);
    assert.ok(elapsed < 15_000, `a wedged health probe must be bounded (took ${elapsed}ms)`);
    assertNoDestructiveDockerCalls(fixture);
  });

  it('exits 2 when the rollback is also unhealthy', () => {
    const fixture = makeFixture();
    const result = run(fixture, [], { FAKE_HEALTH_SEQ: '500,500' });

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /manual intervention/i);
    assertNoDestructiveDockerCalls(fixture);
  });

  it('leaves the running container untouched when the pull fails', () => {
    const fixture = makeFixture();
    const result = run(fixture, [], { FAKE_PULL_FAIL: '1' });

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /pull failed/);
    const lines = logLines(fixture);
    assert.ok(lines.some(line => /(^| )compose .* pull windsurf-api$/.test(line)));
    assert.ok(!lines.some(line => /(^| )compose .* up /.test(line)), 'a failed pull must not recreate');
    assertNoDestructiveDockerCalls(fixture);
  });

  it('builds locally with --build instead of pulling', () => {
    const fixture = makeFixture();
    const result = run(fixture, ['--build']);

    assert.equal(result.status, 0, result.stderr);
    const lines = logLines(fixture);
    assert.ok(lines.some(line => /(^| )compose .* build windsurf-api$/.test(line)));
    assert.ok(!lines.some(line => /(^| )compose .* pull /.test(line)));
    assertNoDestructiveDockerCalls(fixture);
  });

  it('pins a release tag with --tag and pulls that exact reference', () => {
    const fixture = makeFixture();
    const result = run(fixture, ['--tag', 'v3.9.52']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Pulling ghcr\.io\/dwgx\/windsurf-api:3\.9\.52/);
    assert.ok(logLines(fixture).some(line => /(^| )compose .* pull windsurf-api$/.test(line)));
  });

  it('does not mutate anything in --dry-run', () => {
    const fixture = makeFixture();
    const result = run(fixture, ['--dry-run']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /dry run/);
    const lines = logLines(fixture);
    assert.ok(lines.some(line => /(^| )compose .* ps -q windsurf-api$/.test(line)));
    for (const line of lines) {
      assert.doesNotMatch(line, / (?:pull|build|up) /, `dry-run must not mutate: ${line}`);
      assert.doesNotMatch(line, /^tag /, `dry-run must not tag: ${line}`);
    }
  });

  it('refuses to run while another update holds the lock', () => {
    const fixture = makeFixture();
    mkdirSync(join(fixture.state, 'lock'), { recursive: true });
    writeFileSync(join(fixture.state, 'lock', 'pid'), `${process.pid}\n`, 'utf8');

    const result = run(fixture);

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /another update is already running/);
    assert.ok(!logLines(fixture).some(line => /(^| )compose .* pull /.test(line)));
  });

  it('fails closed when the lock has no owner pid', () => {
    const fixture = makeFixture();
    mkdirSync(join(fixture.state, 'lock'), { recursive: true });

    const result = run(fixture);

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /without an owner pid/);
    assert.ok(!logLines(fixture).some(line => /(^| )compose .* pull /.test(line)));
  });

  it('recovers a lock whose owner pid is provably dead', () => {
    const fixture = makeFixture();
    mkdirSync(join(fixture.state, 'lock'), { recursive: true });
    writeFileSync(join(fixture.state, 'lock', 'pid'), '2147483646\n', 'utf8');

    const result = run(fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.ok(logLines(fixture).some(line => /(^| )compose .* pull windsurf-api$/.test(line)));
  });

  it('restores the saved rollback point with --rollback', () => {
    const fixture = makeFixture();
    mkdirSync(fixture.state, { recursive: true });
    writeFileSync(
      join(fixture.state, 'rollback-point.env'),
      `image_id=${ROLLBACK_ID}\nimage_ref=ghcr.io/dwgx/windsurf-api:3.9.52\nsaved_at=2026-10-23T00:00:00Z\n`,
      'utf8',
    );

    const result = run(fixture, ['--rollback']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ROLLED BACK/);
    const lines = logLines(fixture);
    assert.ok(lines.some(line => line === `tag ${ROLLBACK_ID} ghcr.io/dwgx/windsurf-api:3.9.52`));
    assert.ok(lines.some(line => / up -d --no-deps --no-build --force-recreate windsurf-api$/.test(line)));
    assertNoDestructiveDockerCalls(fixture);
  });
});

// D6 (audit2/Update.md P2-3): the dashboard docker path used to return
// {ok:true} right after starting a deployer that ran a bare `compose up -d`.
// No rollback point was recorded, the deployer was auto-removed (so a failure
// left no evidence), and a crash-looping container was indistinguishable from
// a successful update. The deployer script now health-gates the recreate and
// restores the previous image on failure, and its exit code is durable.
//
// These arms execute the real generated script against a fake docker CLI.
// Exit codes: 0 healthy · 1 rolled back healthy · 2 rollback failed · 3 recreate failed.
const DEPLOYER_OLD_ID = `sha256:${'1'.repeat(64)}`;
const DEPLOYER_ROLLBACK_REF = 'ghcr.io/dwgx/windsurf-api:rollback';
const DEPLOYER_TARGET = `ghcr.io/dwgx/windsurf-api@sha256:${'4'.repeat(64)}`;

const FAKE_DEPLOYER_DOCKER = `#!/usr/bin/env bash
printf '%s|IMAGE=%s\\n' "$*" "\${WINDSURFAPI_IMAGE:-}" >> "\${FAKE_DOCKER_LOG:?}"
cmd="\${1:-}"
if [ "$cmd" = "tag" ]; then exit 0; fi
if [ "$cmd" = "compose" ]; then
  joined="$*"
  case "$joined" in
    *" exec "*)
      counter="\${FAKE_HEALTH_COUNTER:?}"
      n=$(cat "$counter" 2>/dev/null || echo 0)
      n=$((n + 1))
      printf '%s\\n' "$n" > "$counter"
      code=$(printf '%s' "\${FAKE_HEALTH_SEQ:-200}" | cut -d, -f"$n")
      if [ -z "$code" ]; then
        code=$(printf '%s' "\${FAKE_HEALTH_SEQ:-200}" | awk -F, '{print $NF}')
      fi
      if [ "$code" = "200" ]; then printf '{"status":"ok"}\\n'; exit 0; fi
      exit 1
      ;;
    *" up "*)
      if [ "\${FAKE_UP_FAIL_FIRST:-0}" = "1" ] && [ ! -f "\${FAKE_UP_MARKER:?}" ]; then
        : > "\$FAKE_UP_MARKER"
        exit 1
      fi
      if [ "\${FAKE_UP_FAIL:-0}" = "1" ]; then exit 1; fi
      exit 0
      ;;
  esac
  exit 0
fi
exit 0
`;

function makeDeployerFixture() {
  const root = mkdtempSync(join(tmpdir(), 'wa-docker-deployer-'));
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeExecutable(join(bin, 'docker'), FAKE_DEPLOYER_DOCKER);
  const fixture = {
    root,
    bin,
    log: join(root, 'docker.log'),
    counter: join(root, 'health.counter'),
    upMarker: join(root, 'up.marker'),
    composeFile: join(root, 'docker-compose.yml'),
  };
  writeFileSync(fixture.composeFile, 'services:\n  windsurf-api:\n    image: test\n', 'utf8');
  FIXTURES.push(root);
  return fixture;
}

function runDeployerScript(fixture, overrides = {}) {
  const script = buildDockerDeployerScript({
    project: 'windsurf',
    workingDir: fixture.root,
    configFiles: [fixture.composeFile],
    service: 'windsurf-api',
    oldImageId: DEPLOYER_OLD_ID,
    rollbackRef: DEPLOYER_ROLLBACK_REF,
    targetImage: DEPLOYER_TARGET,
    delaySeconds: 0,
    // Two probes per gate: the sequences below are deterministic.
    healthTimeoutSeconds: 0.1,
    healthIntervalSeconds: 0.05,
  });
  return spawnSync(BASH, ['-c', script], {
    cwd: fixture.root,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: [fixture.bin, dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter),
      FAKE_DOCKER_LOG: fixture.log,
      FAKE_HEALTH_COUNTER: fixture.counter,
      FAKE_HEALTH_SEQ: '200',
      FAKE_UP_MARKER: fixture.upMarker,
      ...overrides,
    },
  });
}

describe('docker self-update deployer: health gate and rollback (D6)', () => {
  nodeIt('exits 0 without rolling back when the recreated container is healthy', { skip: false }, () => {
    const fixture = makeDeployerFixture();
    const result = runDeployerScript(fixture);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const lines = logLines(fixture);
    const firstUp = lines.find(line => /\bcompose\b.*\bup -d\b/.test(line));
    assert.ok(firstUp, 'must recreate the stack');
    assert.match(firstUp, /--no-build/, 'the first compose up must never build from the checkout');
    assert.ok(firstUp.includes(`IMAGE=${DEPLOYER_TARGET}`),
      'the first compose up must select the verified digest target');
    assert.equal(lines.some(line => line.startsWith('tag ')), false,
      'a healthy update must not tag a rollback image');
    assert.equal(lines.some(line => line.includes('--force-recreate')), false,
      'a healthy update must not recreate the previous image');
  });

  nodeIt('restores the previous image when the first health gate fails', { skip: false }, () => {
    const fixture = makeDeployerFixture();
    const result = runDeployerScript(fixture, { FAKE_HEALTH_SEQ: '500,500,200' });
    assert.equal(result.status, 1,
      `a healthy rollback must exit 1 (not success): ${result.stdout}\n${result.stderr}`);
    const lines = logLines(fixture);
    assert.ok(
      lines.some(line => line.startsWith(`tag ${DEPLOYER_OLD_ID} ${DEPLOYER_ROLLBACK_REF}`)),
      `must tag the previous image for rollback: ${lines.join('\n')}`,
    );
    const rollbackUp = lines.find(line => line.includes('up -d --no-deps --no-build --force-recreate'));
    assert.ok(rollbackUp, 'must recreate the app service from the previous image');
    assert.match(rollbackUp, new RegExp(`IMAGE=${DEPLOYER_ROLLBACK_REF.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      'the rollback recreate must select the previous image');
  });

  nodeIt('exits 2 when the rollback container is also unhealthy', { skip: false }, () => {
    const fixture = makeDeployerFixture();
    const result = runDeployerScript(fixture, { FAKE_HEALTH_SEQ: '500,500,500,500' });
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  });

  nodeIt('exits 3 when the recreate itself fails', { skip: false }, () => {
    const fixture = makeDeployerFixture();
    const result = runDeployerScript(fixture, { FAKE_UP_FAIL_FIRST: '1' });
    assert.equal(result.status, 3, `${result.stdout}\n${result.stderr}`);
    assert.equal(logLines(fixture).some(line => line.startsWith('tag ')), false,
      'a recreate that never started needs no image rollback');
  });
});
