// workspace_trusted lives at field 3 on older language servers and moved to
// field 4 on newer ones. The builder dual-writes both numbers so either
// generation reads the value — each parser ignores the number it does not know.
// These assertions inspect the produced wire bytes directly via src/proto.js.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildInitializePanelStateRequest } from '../src/windsurf.js';
import { getField, parseFields } from '../src/proto.js';

describe('buildInitializePanelStateRequest — workspace_trusted dual-write (#3 + #4)', () => {
  it('carries metadata on field 1', () => {
    const fields = parseFields(buildInitializePanelStateRequest('apikey', 'sess'));
    assert.ok(getField(fields, 1, 2), 'field 1 (metadata) must be present');
  });

  it('dual-writes workspace_trusted on fields 3 and 4 as varint 1 when trusted=true', () => {
    const fields = parseFields(buildInitializePanelStateRequest('apikey', 'sess', true));
    const older = getField(fields, 3, 0);
    const newer = getField(fields, 4, 0);
    assert.ok(older, 'field 3 (workspace_trusted) must be present');
    assert.ok(newer, 'field 4 (is_workspace_trusted) must be present');
    assert.equal(older.value, 1);
    assert.equal(newer.value, 1);
  });

  it('still carries both fields as varint 0 when trusted=false', () => {
    const fields = parseFields(buildInitializePanelStateRequest('apikey', 'sess', false));
    const older = getField(fields, 3, 0);
    const newer = getField(fields, 4, 0);
    assert.ok(older, 'field 3 must be carried even when trusted=false');
    assert.ok(newer, 'field 4 must be carried even when trusted=false');
    assert.equal(older.value, 0);
    assert.equal(newer.value, 0);
  });
});
