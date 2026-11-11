// Every `this.method(...)` call inside the dashboard App object must resolve to a
// member that is actually defined in index.html.
//
// Why: the account drawer rendered "加载中…" forever because renderAccountDetail
// called this.escAttr(), which exists nowhere in the file. The exception was thrown
// inside an async open handler, so the user saw a stuck spinner and no error. Unit
// tests that render the drawer with an account that has no tier models never reach
// that template, so nothing caught it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');

function appScript() {
  const scripts = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const code = scripts.find((s) => s.includes('const App = {'));
  assert.ok(code, 'the App script block must be present');
  return code;
}

function stripComments(src) {
  return src.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
}

describe('dashboard App method references', () => {
  it('has a definition for every this.<method>() call', () => {
    const code = stripComments(appScript());
    const defined = new Set();
    // Members: `name(`, `async name(`, `get name(`, `name:`, `name =` at object-literal depth,
    // plus `this.name =` assignments made at runtime.
    for (const m of code.matchAll(/^\s{2}(?:async\s+|get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(?:\(|:)/gm)) defined.add(m[1]);
    for (const m of code.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*(?:\|\|=|\?\?=|=(?!=))/g)) defined.add(m[1]);
    for (const m of code.matchAll(/\bApp\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) defined.add(m[1]);

    const called = new Map();
    for (const m of code.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (!called.has(m[1])) called.set(m[1], code.slice(0, m.index).split('\n').length);
    }
    // Built-ins reached through `this` on plain objects / DOM-ish receivers.
    // `closest` is Element.prototype.closest, used on `this` inside inline event handlers.
    const ignore = new Set(['constructor', 'hasOwnProperty', 'toString', 'closest']);
    const missing = [...called]
      .filter(([name]) => !defined.has(name) && !ignore.has(name))
      .map(([name, line]) => `${name} (first call near script line ${line})`);

    assert.ok(defined.size > 300, `probe check: only ${defined.size} members parsed, the extraction is broken`);
    assert.deepEqual(missing, [],
      'these methods are called on `this` but defined nowhere in index.html:\n  ' + missing.join('\n  '));
  });
});
