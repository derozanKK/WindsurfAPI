import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const dockerfile = readFileSync('Dockerfile', 'utf8');
const dockerignore = readFileSync('.dockerignore', 'utf8');
const compose = readFileSync('docker-compose.yml', 'utf8');

describe('Docker image script packaging', () => {
  it('enables Devin Connect for direct image runs by default', () => {
    assert.match(dockerfile, /^\s+DEVIN_CONNECT=1 \\$/m);
  });

  it('copies npm smoke/probe scripts that are expected to run inside the container', () => {
    for (const name of ['smoke:native-bridge', 'smoke:lsp-matrix', 'probe:web-search']) {
      const command = pkg.scripts?.[name] || '';
      const script = command.match(/\bnode\s+(\S+)/)?.[1];
      assert.ok(script, `${name} should run a node script`);
      assert.match(dockerfile, new RegExp(`COPY\\s+${script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(dockerignore, new RegExp(`!${script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    }
  });
});

// Kit section G, item G-8 asked for "the Dockerfile contains a USER instruction other
// than root". That property is deliberately FALSE: the audit adjudicated the root
// posture as an accepted privilege posture, not a defect — it broadens the impact of a
// hypothetical RCE but establishes no exploit on its own, and the image needs to write
// its bind mounts.
//
// A test asserting a non-root USER could therefore never be green, and would be a lie
// in the suite. This is the honest alternative: it states the accepted posture
// positively, so changing it is a deliberate act that has to come through this file.
describe('Docker container privilege posture (G-8)', () => {
  it('runs as the image user (root) by an accepted ruling, not by accident', () => {
    assert.doesNotMatch(
      dockerfile,
      /^\s*USER\s+(?!root\b)\S+/mi,
      'the image is expected to run as root; dropping to a non-root USER is a posture change that must update this test and the audit ruling with it',
    );
    assert.doesNotMatch(
      compose,
      /^\s*user:\s*\S+/m,
      'docker-compose must not silently drop the container to another user either',
    );
  });

  it('does not mount the host docker socket by default (control)', () => {
    // The posture above is only acceptable while the container cannot reach the host
    // daemon; that mount is commented out in the compose file with a root warning.
    assert.doesNotMatch(compose, /^\s*-\s*\/var\/run\/docker\.sock:/m);
  });
});
