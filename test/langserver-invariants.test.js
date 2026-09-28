// Invariant pin for src/langserver.js — process/port/resource boundaries.
//
// WHY THIS FILE IS ONE PLACE
//
// src/langserver.js is ~65 KB of pool management whose assertions live scattered across
// langserver-resource, langserver-redact, langserver-binary-update, platform-ls-paths and
// four v*-issue-fixes files. test/mutations/langserver-invariants.json pins the invariants
// below through THIS file only, so a mutation verdict never depends on cross-file
// aggregation.
//
// WHY THESE ASSERTIONS
//
//   - probeLanguageServerPort. This is the only readiness probe in the module that checks
//     the gRPC signature instead of merely "something accepted a TCP connection". The
//     audit recorded the consequence of a gate that accepts any listener: the account API
//     key and the CSRF token are then sent to whatever is squatting on the port.
//   - buildLanguageServerEnv. The child LS is a binary we do not control; forwarding the
//     parent environment hands it every credential the proxy process holds.
//   - redactProxyUrl. Its output goes into logs and the dashboard; three separate shapes
//     (object, parseable URL, unparseable string) each have their own way to leak the
//     proxy password.
//   - classifyLanguageServerStderr. A "connection refused" line classified as info is an
//     LS that never started and never appears in anyone's log filter.
//   - detectMemoryLimitBytes / estimateDefaultMaxLsInstances. These two decide how many
//     600-700 MB LS processes the host is allowed to spawn (#174).
//   - shouldPrewarmDefaultLs. A kill switch that no longer reads its env var is a switch
//     nobody can pull.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import net from 'node:net';
import {
  buildLanguageServerEnv,
  classifyLanguageServerStderr,
  detectMemoryLimitBytes,
  detectHostMemAvailableBytes,
  estimateDefaultMaxLsInstances,
  getLsStatus,
  hasLsPoolCapacityForStart,
  probeLanguageServerPort,
  redactProxyUrl,
  shouldPrewarmDefaultLs,
} from '../src/langserver.js';

const MB = 1024 * 1024;

async function withHttp2Server(handler, fn) {
  const server = http2.createServer();
  const sessions = new Set();
  server.on('session', (session) => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  server.on('stream', handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(port);
  } finally {
    // server.close() waits for every session to end, and probeLanguageServerPort closes
    // its client GRACEFULLY, so the two can end up waiting on each other: nothing ends
    // the session and this file hangs until node:test's watchdog interrupts it (seen on
    // CI as a ~90s hang in shard 3, "Promise resolution is still pending but the event
    // loop has already resolved"). Destroy the server-side sessions first — every
    // assertion has already been made by the time this runs. (closeAllConnections()
    // would be the usual tool, but http2's server does not expose it.)
    for (const session of sessions) { try { session.destroy(); } catch { /* gone */ } }
    await new Promise((resolve) => server.close(resolve));
  }
}

/** A port that was bound and then released, so nothing is listening on it. */
async function closedLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** readFile stub over a fixed map; every other path throws ENOENT. */
function filesOnly(map) {
  return (path) => {
    if (!map.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return map.get(path);
  };
}

describe('LS readiness probe requires the gRPC signature', () => {
  it('accepts a listener that answers with a gRPC-shaped response', async () => {
    await withHttp2Server((stream) => {
      stream.respond({ ':status': 405, 'content-type': 'application/grpc', 'grpc-status': '12' });
      stream.end();
    }, async (port) => {
      assert.equal(await probeLanguageServerPort(port), true);
    });
  });

  it('rejects an unrelated HTTP/2 service on the port', async () => {
    await withHttp2Server((stream) => {
      stream.respond({ ':status': 200, 'content-type': 'text/plain', server: 'not-ls' });
      stream.end('ok');
    }, async (port) => {
      assert.equal(await probeLanguageServerPort(port), false);
    });
  });

  it('rejects a port where nothing is listening', async () => {
    const port = await closedLoopbackPort();
    assert.equal(await probeLanguageServerPort(port), false);
  });
});

describe('LS child environment is an allowlist, not a copy', () => {
  it('drops credentials the LS binary has no business reading', () => {
    const env = buildLanguageServerEnv({
      HOME: '/home/dev',
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      SSL_CERT_FILE: '/etc/ssl/certs/ca-bundle.crt',
      AWS_SECRET_ACCESS_KEY: 'leak-me',
      GITHUB_TOKEN: 'leak-me-too',
      DASHBOARD_PASSWORD: 'leak-me-three',
      WINDSURFAPI_API_KEY: 'leak-me-four',
    });
    assert.equal(env.HOME, '/home/dev');
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.SSL_CERT_FILE, '/etc/ssl/certs/ca-bundle.crt');
    for (const leaked of ['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'DASHBOARD_PASSWORD', 'WINDSURFAPI_API_KEY']) {
      assert.ok(!(leaked in env), `${leaked} was forwarded to the LS child env`);
    }
  });

  it('still supplies HOME when the parent has none', () => {
    assert.equal(buildLanguageServerEnv({ PATH: '/usr/bin' }).HOME, '/root');
  });
});

describe('proxy credential redaction holds for every input shape', () => {
  it('redacts a proxy object and a parseable proxy URL', () => {
    const asObject = redactProxyUrl({
      host: 'proxy.example.com', port: 1080, username: 'acct', password: 's3cretpw',
    });
    assert.equal(asObject, 'proxy.example.com:1080 (auth=true)');
    assert.ok(!asObject.includes('s3cretpw'));

    const asUrl = redactProxyUrl('http://acct:s3cretpw@proxy.example.com:8080');
    assert.equal(asUrl, 'proxy.example.com:8080 (auth=true)');
    assert.ok(!asUrl.includes('s3cretpw'));
  });

  it('redacts credentials in a proxy string it cannot parse as a URL', () => {
    const raw = 'http://acct:s3cretpw@pro xy.example.com:8080';
    const out = redactProxyUrl(raw);
    assert.ok(!out.includes('s3cretpw'), `proxy password survived redaction: ${out}`);
    assert.ok(out.includes('***'));
  });
});

describe('LS stderr classification keeps real failures out of the info tier', () => {
  it('classifies error, warning and failure lines above info', () => {
    assert.equal(classifyLanguageServerStderr('E0605 00:00:00.000000 failed to bind'), 'error');
    assert.equal(classifyLanguageServerStderr('FATAL: cannot start'), 'error');
    assert.equal(classifyLanguageServerStderr('W0605 00:00:00.000000 slow startup'), 'warn');
    assert.equal(classifyLanguageServerStderr('connection refused by upstream'), 'warn');
    assert.equal(classifyLanguageServerStderr('request timed out'), 'warn');
    assert.equal(classifyLanguageServerStderr('segmentation fault'), 'warn');
  });

  it('leaves ordinary startup chatter at info', () => {
    assert.equal(classifyLanguageServerStderr('I0605 00:00:00.000000 server started'), 'info');
    assert.equal(classifyLanguageServerStderr('listening on 42100'), 'info');
    assert.equal(classifyLanguageServerStderr(''), 'debug');
  });
});

describe('LS memory policy stays bounded by the host', () => {
  it('ignores cgroup sentinels and any limit above host memory', () => {
    const sentinel = filesOnly(new Map([
      ['/sys/fs/cgroup/memory.max', 'max'],
      ['/sys/fs/cgroup/memory/memory.limit_in_bytes', '9223372036854771712'],
    ]));
    assert.equal(detectMemoryLimitBytes(sentinel, 4 * 1024 * MB), 4 * 1024 * MB);

    // A cgroup that claims more memory than the host has must not raise the cap: the LS
    // processes still have to fit on this machine.
    const overHost = filesOnly(new Map([
      ['/sys/fs/cgroup/memory.max', String(4 * 1024 * MB)],
    ]));
    assert.equal(detectMemoryLimitBytes(overHost, 2 * 1024 * MB), 2 * 1024 * MB);

    const realLimit = filesOnly(new Map([
      ['/sys/fs/cgroup/memory.max', String(1536 * MB)],
    ]));
    assert.equal(detectMemoryLimitBytes(realLimit, 8 * 1024 * MB), 1536 * MB);
  });

  it('reads available host memory from /proc/meminfo in bytes', () => {
    assert.equal(
      detectHostMemAvailableBytes(() => 'MemTotal: 2048000 kB\nMemAvailable: 512000 kB\n', 1),
      512000 * 1024,
    );
  });

  it('caps the LS instance count at both ends', () => {
    assert.equal(estimateDefaultMaxLsInstances(512 * MB, 700 * MB), 2);
    assert.equal(estimateDefaultMaxLsInstances(0, 700 * MB), 2);
    assert.equal(estimateDefaultMaxLsInstances(16 * 1024 * MB, 700 * MB), 20);
    assert.equal(estimateDefaultMaxLsInstances(64 * 1024 * MB, 700 * MB), 20);
  });

  it('admits a start when a slot can be evicted', () => {
    assert.equal(hasLsPoolCapacityForStart(1, 2, 0), true);
    assert.equal(hasLsPoolCapacityForStart(2, 2, 0), false);
    assert.equal(hasLsPoolCapacityForStart(2, 2, 1), true);
  });
});

describe('default LS prewarm kill switch', () => {
  it('reports OFF when LS_PREWARM_DEFAULT is 0', () => {
    const saved = process.env.LS_PREWARM_DEFAULT;
    process.env.LS_PREWARM_DEFAULT = '0';
    try {
      assert.equal(shouldPrewarmDefaultLs(), false);
    } finally {
      if (saved === undefined) delete process.env.LS_PREWARM_DEFAULT;
      else process.env.LS_PREWARM_DEFAULT = saved;
    }
  });

  it('reports ON only while the pool can hold more than the default instance', () => {
    const saved = process.env.LS_PREWARM_DEFAULT;
    delete process.env.LS_PREWARM_DEFAULT;
    try {
      // Both halves of the gate are asserted: the env default AND the pool-size floor.
      // A single-instance pool has no proxy slot to prewarm (#174), so prewarm must be
      // off there even though the env var is unset.
      assert.equal(shouldPrewarmDefaultLs(), getLsStatus().maxInstances > 1);
    } finally {
      if (saved !== undefined) process.env.LS_PREWARM_DEFAULT = saved;
    }
  });
});
