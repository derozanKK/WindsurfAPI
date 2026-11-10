import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const templateDir = join(root, '.github', 'ISSUE_TEMPLATE');

// The point is that every form here is one somebody maintains and that asks for the routing
// evidence triage needs — NOT that the count stays at three. Adding a form is fine; adding one
// with no assertion behind it is what this list prevents, so each entry except config.yml has a
// dedicated test below and the last test in this file enforces that pairing mechanically.
const FORMS = ['bug.yml', 'config.yml', 'feature.yml', 'model-availability.yml'];

test('issue templates use the maintained bilingual forms only', () => {
  const files = readdirSync(templateDir).filter(name => name.endsWith('.yml')).sort();
  assert.deepEqual(files, FORMS);
});

test('bug template requests current routing and diagnostic evidence', () => {
  const body = readFileSync(join(templateDir, 'bug.yml'), 'utf8');
  for (const expected of [
    'needs-triage',
    '/v1/chat/completions',
    '/v1/messages',
    '/v1/responses',
    'Probe[...]',
    'ToolRoute[...]',
    'BridgeResult[...]',
    'WINDSURFAPI_NATIVE_TOOL_BRIDGE',
    'WINDSURFAPI_LS_VERSION',
  ]) {
    assert.match(body, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('feature template asks for acceptance criteria and starts in triage', () => {
  const body = readFileSync(join(templateDir, 'feature.yml'), 'utf8');
  assert.match(body, /needs-triage/);
  assert.match(body, /Minimum acceptance criteria/);
  assert.match(body, /模型名|model names/);
});

test('model-availability template makes the reporter self-triage entitlement first', () => {
  const body = readFileSync(join(templateDir, 'model-availability.yml'), 'utf8');
  assert.match(body, /needs-triage/);
  // "A model is missing" is usually upstream entitlement, not a gateway bug. The form only
  // earns its place if it collects the three things that tell those apart, so pin them:
  // the model list endpoint, the entitlement error, and the per-account pool field.
  for (const expected of ['/v1/models', 'model_not_entitled', 'available_in_pool']) {
    assert.match(body, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `model-availability.yml must ask for ${expected}`);
  }
});

test('every label a form applies actually exists in the repo', () => {
  // GitHub SILENTLY DROPS a label that does not exist: the form still works, the issue still
  // files, and the triage label you were counting on is simply absent. Nothing surfaces it.
  // Caught for real — model-availability.yml shipped with a `model-availability` label that
  // this repo never had, so the form looked correct and classified nothing.
  //
  // The allow-list is a snapshot rather than a live `gh label list` call: tests must not need
  // network or auth. Adding a label to the repo means adding it here, which is the point —
  // the pairing is what makes the drop visible.
  const REPO_LABELS = new Set([
    'bug', 'documentation', 'duplicate', 'enhancement', 'good first issue', 'help wanted',
    'invalid', 'question', 'wontfix', 'fixed', 'not a bug', 'upstream', 'idk', 'needs-triage',
    'security', 'privacy', 'maintenance', 'release',
  ]);
  const problems = [];
  for (const form of FORMS) {
    const body = readFileSync(join(templateDir, form), 'utf8');
    const block = body.match(/^labels:\s*\[([^\]]*)\]/m);
    if (!block) continue;
    for (const raw of block[1].split(',')) {
      const label = raw.trim().replace(/^["']|["']$/g, '');
      if (label && !REPO_LABELS.has(label)) problems.push(`${form}: "${label}"`);
    }
  }
  assert.deepEqual(problems, [],
    `labels that do not exist in this repo (GitHub will drop them):\n  ${problems.join('\n  ')}`);
});

test('every maintained form has a test asserting its content', () => {
  // Without this, FORMS could grow and the new entry would be governed by nothing — exactly
  // the hole the list above is supposed to close. Reads this file's own source, so adding a
  // form without adding a test fails here rather than silently passing.
  const selfSource = readFileSync(new URL(import.meta.url), 'utf8');
  const unasserted = FORMS
    .filter((f) => f !== 'config.yml')
    .filter((f) => !selfSource.includes(`join(templateDir, '${f}')`));
  assert.deepEqual(unasserted, [], `forms with no content assertion: ${unasserted.join(', ')}`);
});
