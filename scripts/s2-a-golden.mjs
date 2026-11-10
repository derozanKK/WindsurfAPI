import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BASE, makeCases, installDeterministicCrypto } from '../test/helpers/s2-a-fixtures.mjs';

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i++) {
  assert.ok(['--root', '--write', '--check'].includes(args[i]) && args[i + 1], `Unknown or incomplete option: ${args[i]}`);
  assert.equal(options[args[i]], undefined, `Duplicate option: ${args[i]}`);
  options[args[i]] = args[++i];
}
assert.ok(!(options['--write'] && options['--check']), 'Choose --write OR --check');
const root = resolve(options['--root'] || resolve(dirname(fileURLToPath(import.meta.url)), '..'));
if (options['--write']) {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(head, BASE, 'Only the pinned pre-change commit may create the golden baseline');
  execFileSync('git', ['-C', root, 'diff', '--exit-code', BASE, '--', 'src', 'package.json', 'package-lock.json'], { stdio: 'pipe' });
}
const entropy = installDeterministicCrypto();
const previousCap = process.env.DEVIN_CONNECT_WIRE_MAX_TOKENS;
process.env.DEVIN_CONNECT_WIRE_MAX_TOKENS = '8192';
try {
  const { buildGetChatMessageRequest } = await import(pathToFileURL(resolve(root, 'src/devin-connect.js')).href);
  const { wrapEnvelope } = await import(pathToFileURL(resolve(root, 'src/connect.js')).href);
  const cases = makeCases().map(({ name, args: input }) => {
    entropy.reset();
    const proto = buildGetChatMessageRequest(structuredClone(input));
    const frame = wrapEnvelope(proto, { compress: false });
    const sha256 = createHash('sha256').update(frame).digest('hex');
    console.log(`${name}\t${sha256}\t${frame.length}`);
    return { name, sha256, bytes: frame.length, entropy: entropy.calls(), frameBase64: frame.toString('base64') };
  });
  const record = { format: 's2-a-frame-sha256-v1', base: BASE, node: process.version, cases };
  if (options['--write']) {
    // Never overwrite a baseline with candidate output, even accidentally.
    writeFileSync(resolve(options['--write']), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  }
  if (options['--check']) {
    const golden = JSON.parse(readFileSync(resolve(options['--check']), 'utf8'));
    assert.equal(golden.format, record.format);
    assert.equal(golden.base, BASE);
    // Version guard. It used to require the SAME Node major as the capture, which made the
    // fixture a Node-24-only test and failed the suite on every other supported runtime for a
    // reason that has nothing to do with the wire: the writers under test are pure JS, and the
    // actual golden check is the 12 byte/hash/entropy comparisons below. What the guard is
    // really for is provenance — the fixture must have been captured on a runtime this package
    // supports, and it must be checked on one — so assert both majors against engines.node.
    // Verified byte-identical on 20.20.2 / 22.23.4 / 24.21.0.
    const minMajor = (() => {
      const engines = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).engines?.node;
      const m = /^>=\s*(\d+)/.exec(String(engines || ''));
      assert.ok(m, `package.json engines.node is not a ">=N" range: ${JSON.stringify(engines)}`);
      return Number(m[1]);
    })();
    const majorOf = (version, label) => {
      const m = /^v(\d+)\.\d+\.\d+/.exec(String(version || ''));
      assert.ok(m, `${label} is not a full Node version: ${JSON.stringify(version)}`);
      return Number(m[1]);
    };
    const capturedMajor = majorOf(golden.node, 'golden.node');
    const runningMajor = majorOf(process.version, 'process.version');
    assert.ok(capturedMajor >= minMajor, `golden captured on unsupported Node ${golden.node} (engines.node needs >=${minMajor})`);
    assert.ok(runningMajor >= minMajor, `checked on unsupported Node ${process.version} (engines.node needs >=${minMajor})`);
    assert.deepEqual(golden.cases.map(c => c.name), cases.map(c => c.name));
    for (let i = 0; i < cases.length; i++) {
      const expected = golden.cases[i], actual = cases[i];
      assert.match(expected.sha256, /^[0-9a-f]{64}$/, `${actual.name}: unfilled golden hash`);
      const expectedFrame = Buffer.from(expected.frameBase64, 'base64');
      assert.equal(createHash('sha256').update(expectedFrame).digest('hex'), expected.sha256, `${actual.name}: corrupt golden bytes`);
      assert.equal(actual.sha256, expected.sha256, `${actual.name}: frame hash changed`);
      assert.equal(actual.bytes, expected.bytes, `${actual.name}: frame length changed`);
      assert.deepEqual(actual.entropy, expected.entropy, `${actual.name}: random-source call order changed`);
      assert.ok(Buffer.from(actual.frameBase64, 'base64').equals(expectedFrame), `${actual.name}: frame bytes changed`);
    }
    console.log(`PASS: ${cases.length} complete frames match the pre-change baseline byte-for-byte`);
  }
} finally {
  entropy.restore();
  if (previousCap === undefined) delete process.env.DEVIN_CONNECT_WIRE_MAX_TOKENS;
  else process.env.DEVIN_CONNECT_WIRE_MAX_TOKENS = previousCap;
}
