// The cascadeConversationReuse copy drifted from the code twice:
//   - 2026-04 (#52): the dashboard hint said 默认关闭 while the default had been
//     true since v2.0 — a user read the panel and reported the toggle as broken.
//   - 2026-10-15: the runtime-config.js comment and the en.json experimental
//     block still said "off / Disabled by default" after 16c1cda flipped the value.
//
// The value is default-ON. Every copy claim about its default must agree with it,
// and the comment directly above the field must not contradict the literal below
// it. This is the one-switch version of the semantic-copy test the dashboard
// audit asked for — extend the table when the next default flips.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isExperimentalEnabled } from '../src/runtime-config.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('cascadeConversationReuse default-on copy consistency', () => {
  it('the real default is ON', () => {
    assert.equal(isExperimentalEnabled('cascadeConversationReuse'), true,
      'runtime-config.js must default cascadeConversationReuse to true');
  });

  it('the runtime-config.js comment above the field does not claim off-by-default', () => {
    const src = read('../src/runtime-config.js');
    const m = src.match(/((?:\s*\/\/[^\n]*\n)+)\s*cascadeConversationReuse\s*:/);
    assert.ok(m, 'a comment block above cascadeConversationReuse must exist');
    assert.doesNotMatch(m[1], /off by default|default off/i);
    assert.match(m[1], /on by default|default on/i);
  });

  it('en/zh dashboard copy and index.html agree that the switch defaults on', () => {
    const en = JSON.parse(read('../src/dashboard/i18n/en.json'));
    const zh = JSON.parse(read('../src/dashboard/i18n/zh-CN.json'));
    const html = read('../src/dashboard/index.html');

    const claims = [
      ['en.json experimental.cascadeReuse.desc', en.experimental.cascadeReuse.desc],
      ['en.json experimental.cascadeReuse.hint', en.experimental.cascadeReuse.hint],
      ['en.json section.cascadeReuse.hint', en.section.cascadeReuse.hint],
      ['zh-CN.json experimental.cascadeReuse.hint', zh.experimental.cascadeReuse.hint],
      ['zh-CN.json section.cascadeReuse.hint', zh.section.cascadeReuse.hint],
    ];
    for (const [label, text] of claims) {
      assert.doesNotMatch(text, /disabled by default|off by default|默认关闭/i, `${label} contradicts the default`);
      assert.match(text, /(enabled|on) by default|默认开启/i, `${label} must state the default`);
    }

    const line = html.split('\n').find((l) => l.includes('data-i18n="section.cascadeReuse.hint"'));
    assert.ok(line, 'index.html must carry the section.cascadeReuse.hint element');
    assert.doesNotMatch(line, /默认关闭/);
    assert.match(line, /默认开启/);
  });
});
