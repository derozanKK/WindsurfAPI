// REGMAP-TESTS — interception tests for the 9 "no test interception" rows of
// .agent/selfaudit-20261015/CORPUS-REGRESSION-MAP (RM-MAP.tsv / RM-SUMMARY §2).
// Each describe() pins one historically regressed behaviour that previously had
// no test able to go red:
//
//   #98  "<workspace>" must never be passed to shell tools (preamble rule)
//   #30  vision-only requests use DEFAULT planner mode WITHOUT the native bridge config
//   #212 Happy Eyeballs stays disabled + local LS connections dial literal 127.0.0.1
//   #19  ENOEXEC platform diagnosis text (macOS binaries / WSL2 / arch fallback)
//   #35  language-following directive rides the field-13 communication section
//   #49  LS exit-1 diagnostics include the glibc `ldd` hint via log.error (stderr)
//   #52  dashboard reuse hint's "default on/off" claim matches runtime-config default
//   #60  config.js import integrity (missing named-import class, e.g. `join`)
//   #200 install-ls.sh prints each fallback URL before downloading
//
// The diagnosis-text surfaces (ENOEXEC / exit-1 hints, install-ls.sh output) are
// pinned as source-text assertions because the messages ARE the product and they
// have no callable seam; everything else asserts produced bytes / real behaviour
// (proto fields, child-process exits, captured connect targets).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import http2 from 'node:http2';

import {
  buildToolPreamble,
  buildToolPreambleForProto,
  buildSchemaCompactToolPreambleForProto,
  buildSkinnyToolPreambleForProto,
  buildCompactToolPreambleForProto,
} from '../src/handlers/tool-emulation.js';
import { applyToolPreambleBudget } from '../src/handlers/chat.js';
import { buildSendCascadeMessageRequest } from '../src/windsurf.js';
import { parseFields, getField, getAllFields } from '../src/proto.js';
import { config, log } from '../src/config.js';
import { probeLanguageServerPort } from '../src/langserver.js';
import { grpcUnary } from '../src/grpc.js';
import { getExperimental, _resetRuntimeConfigForTests, resetSystemPrompt } from '../src/runtime-config.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_URL = 'file://' + REPO.replace(/\\/g, '/');
const srcText = (rel) => readFileSync(join(REPO, rel), 'utf8');
const LANGSERVER_SRC = srcText('src/langserver.js');
const fnTool = (name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } });

// Request → cascade_config (field 5) → planner (field 1) → conversational (field 2).
function cascadeParts(proto) {
  const top = parseFields(proto);
  const cfg = parseFields(getField(top, 5, 2).value);
  const planner = parseFields(getField(cfg, 1, 2).value);
  const conv = parseFields(getField(planner, 2, 2).value);
  return { top, planner, conv };
}

// SectionOverrideConfig { 1: mode, 2: text } → its text payload.
function sectionText(conv, field) {
  const f = getField(conv, field, 2);
  return f ? getField(parseFields(f.value), 2, 2).value.toString('utf8') : null;
}

// Child-process helper: clean NODE_OPTIONS, dotenv skipped, patch wins over inherited env.
// A patch value of `undefined` deletes the variable.
function spawnChild(script, patch = {}) {
  const env = { ...process.env, NODE_OPTIONS: '', WINDSURFAPI_SKIP_DOTENV: '1' };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: REPO, encoding: 'utf8', env });
}

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('#98 — "<workspace>" is a redaction marker, never a shell path', () => {
  it('all five preamble builders carry the NOT-a-path / never-pass-to-shell rule', () => {
    const builders = [
      ['user-message fallback', buildToolPreamble],
      ['proto full', buildToolPreambleForProto],
      ['proto schema-compact', buildSchemaCompactToolPreambleForProto],
      ['proto skinny', buildSkinnyToolPreambleForProto],
      ['proto names-only', buildCompactToolPreambleForProto],
    ];
    for (const [name, build] of builders) {
      const out = build([fnTool('Bash')], 'auto', '');
      assert.ok(out.length > 0, `${name}: expected a non-empty preamble`);
      assert.match(out, /NOT a path/, `${name}: must state "<workspace>" is NOT a path (#98)`);
      assert.match(out, /never pass it to shell tools/, `${name}: must forbid passing it to shell tools (#98)`);
    }
  });

  it('the rule survives the chat pipeline into proto field 12', () => {
    const r = applyToolPreambleBudget([fnTool('Bash')], 'auto', '');
    assert.equal(r.ok, true, 'a single small tool must fit the preamble budget');
    const proto = buildSendCascadeMessageRequest('k', 'cid', 'hi', 12345, 'MODEL_TEST', 'sess', {
      toolPreamble: r.preamble,
    });
    const { conv } = cascadeParts(proto);
    const text = sectionText(conv, 12);
    assert.ok(text, 'field 12 (additional_instructions_section) must be present');
    assert.match(text, /NOT a path/, 'field 12 must carry the rule end-to-end');
    assert.match(text, /never pass it to shell tools/, 'field 12 must forbid shell use end-to-end');
  });
});

describe('#30 — vision requests use DEFAULT planner mode without the bridge config', () => {
  const image = { base64_data: 'aGVsbG8=', mime_type: 'image/png' };

  it('images-only request → planner_mode DEFAULT (1), no tool_config, images on field 6', () => {
    const proto = buildSendCascadeMessageRequest('k', 'cid', 'hi', 12345, 'MODEL_TEST', 'sess', {
      images: [image],
    });
    const { top, planner, conv } = cascadeParts(proto);
    assert.equal(getField(conv, 4, 0)?.value, 1, 'vision must force planner_mode DEFAULT (1)');
    assert.equal(getField(planner, 13, 2), null, 'vision must NOT carry the native bridge tool_config');
    assert.equal(getAllFields(top, 6).length, 1, 'image must ride field 6');
  });

  it('images + client tools → NO_TOOL (3) with the emulation preamble preserved', () => {
    const proto = buildSendCascadeMessageRequest('k', 'cid', 'hi', 12345, 'MODEL_TEST', 'sess', {
      images: [image],
      toolPreamble: 'Tools available this turn: Bash.',
    });
    const { top, conv } = cascadeParts(proto);
    assert.equal(
      getField(conv, 4, 0)?.value,
      3,
      'images + tools must stay NO_TOOL so DEFAULT built-ins cannot collide with tool emulation',
    );
    assert.match(sectionText(conv, 12), /Tools available this turn/, 'emulation preamble must survive on field 12');
    assert.equal(getAllFields(top, 6).length, 1, 'image must still ride field 6');
  });
});

describe('#32 — no-tools requests override the tool_calling_section', () => {
  it('emits "No tools are available." on field 10 and omits it when a tool preamble is present', () => {
    const noTools = buildSendCascadeMessageRequest('k', 'cid', 'hi', 12345, 'MODEL_TEST', 'sess');
    const noToolsParts = cascadeParts(noTools);
    assert.equal(getField(noToolsParts.conv, 4, 0)?.value, 3, 'no-tools must use NO_TOOL (3)');
    assert.equal(sectionText(noToolsParts.conv, 10), 'No tools are available.',
      '#32: the model must be told it has no tools, not left to infer it from silence');
    assert.ok(sectionText(noToolsParts.conv, 12), 'the no-tools additional-instructions override must ride field 12');

    const withTools = buildSendCascadeMessageRequest('k', 'cid', 'hi', 12345, 'MODEL_TEST', 'sess', {
      toolPreamble: 'Tools available this turn: Bash.',
    });
    const withToolsParts = cascadeParts(withTools);
    assert.equal(getField(withToolsParts.conv, 10, 2), null,
      '#32: a tool preamble must replace the no-tools section, not stack on top of it');
    assert.match(sectionText(withToolsParts.conv, 12), /Tools available this turn/);
  });
});

describe('#212 — Happy Eyeballs disabled + local LS connections dial 127.0.0.1', () => {
  it('importing config.js sets net.getDefaultAutoSelectFamily() === false', () => {
    assert.equal(typeof net.getDefaultAutoSelectFamily, 'function');
    // config.js is in this file's import graph — its module init must have run.
    assert.equal(
      net.getDefaultAutoSelectFamily(),
      false,
      'config.js must call net.setDefaultAutoSelectFamily(false) at module init',
    );

    const script = `
      import net from 'node:net';
      const before = net.getDefaultAutoSelectFamily();
      await import('${REPO_URL}/src/config.js');
      const after = net.getDefaultAutoSelectFamily();
      process.stdout.write(JSON.stringify({ before, after }));
    `;
    const r = spawnChild(script);
    assert.equal(r.status, 0, `child crashed: ${r.stderr || r.stdout}`);
    const { before, after } = JSON.parse(r.stdout);
    assert.equal(before, true, 'Node 20+ ships autoSelectFamily=true — the precondition of the ETIMEDOUT bug');
    assert.equal(after, false, 'a fresh process importing config.js must end with the flag off');
  });

  it('probe + grpc sessions dial literal http://127.0.0.1:<port>', async () => {
    const orig = http2.connect;
    let captured = null;
    http2.connect = (url) => {
      captured = String(url);
      throw new Error('__regmap_capture__');
    };
    try {
      await assert.rejects(() => probeLanguageServerPort(45991, 50), /__regmap_capture__/);
      assert.equal(captured, 'http://127.0.0.1:45991', 'probeLanguageServerPort must dial literal 127.0.0.1');

      captured = null;
      await assert.rejects(
        () => grpcUnary(45992, 'csrf', '/exa.language_server_pb.LanguageServerService/GetUserStatus', Buffer.alloc(0), 50),
        /__regmap_capture__/,
      );
      assert.equal(captured, 'http://127.0.0.1:45992', 'grpc getSession must dial literal 127.0.0.1');
    } finally {
      http2.connect = orig;
    }
  });

  it('source scan: no "localhost" targets remain in local HTTP/2 call sites', () => {
    for (const rel of ['src/grpc.js', 'src/langserver.js']) {
      const src = srcText(rel);
      assert.doesNotMatch(src, /http:\/\/localhost[:\/]/, `${rel}: must not dial http://localhost (::1-first on macOS)`);
      assert.doesNotMatch(src, /localhost:\$\{port\}/, `${rel}: must not build "localhost:\${port}" keys`);
      assert.ok((src.match(/127\.0\.0\.1:\$\{port\}/g) || []).length >= 1, `${rel}: must dial literal 127.0.0.1`);
    }
  });
});

describe('#19 — ENOEXEC platform diagnosis text', () => {
  it('the spawn-error branch names the macOS binaries / WSL2 / arch fallback', () => {
    assert.match(LANGSERVER_SRC, /if \(err\.code === 'ENOEXEC'\) \{/, 'ENOEXEC branch must exist');
    assert.match(
      LANGSERVER_SRC,
      /proc\.on\('error'[\s\S]{0,120}err\.code === 'ENOEXEC'/,
      'the branch must ride the spawn-error handler',
    );
    assert.match(LANGSERVER_SRC, /LS binary is not executable on this platform/, 'diagnosis must name the failure');
    assert.match(
      LANGSERVER_SRC,
      /You need the macOS build: copy language_server_macos_arm \(Apple Silicon\) or language_server_macos_x64 \(Intel\)/,
      'macOS branch must name both binaries (#19: Linux binary run on a Mac)',
    );
    assert.match(LANGSERVER_SRC, /LS binary only runs on Linux\. Use WSL2 or a Linux VM\./, 'win32 branch must suggest WSL2');
    assert.match(LANGSERVER_SRC, /Ensure the binary matches your arch/, 'default branch must point at an arch mismatch');
  });
});

describe('#35 — language-following directive rides the field-13 communication section', () => {
  it('field 13 carries "same language the user used" on both paths; no-tools field 12 keeps the language rule', () => {
    resetSystemPrompt(); // pin the shipped defaults, not any operator override

    // No-tools path: field 13 = communicationNoTools.
    const noTools = buildSendCascadeMessageRequest('k', 'cid', 'hi', 12345, 'MODEL_TEST', 'sess', {});
    const convA = cascadeParts(noTools).conv;
    const commA = sectionText(convA, 13);
    assert.ok(commA, 'no-tools field 13 (communication_section) must be present');
    assert.match(commA, /same language the user used/, 'no-tools field 13 must carry the language directive');
    assert.match(commA, /never switch mid-conversation/, 'and must forbid mid-conversation switching');
    assert.match(sectionText(convA, 12), /Match the user's language/, 'no-tools field 12 must keep the language rule (windsurf.js)');

    // Tools path: field 13 = communicationWithTools.
    const withTools = buildSendCascadeMessageRequest('k', 'cid', 'hi', 12345, 'MODEL_TEST', 'sess', {
      toolPreamble: 'Tools available this turn: Bash.',
    });
    const commB = sectionText(cascadeParts(withTools).conv, 13);
    assert.ok(commB, 'tools field 13 (communication_section) must be present');
    assert.match(commB, /same language the user used/, 'tools field 13 must carry the language directive');
  });
});

describe('#49 — LS exit-1 diagnostics include the ldd hint (stderr)', () => {
  it('exit code 1 logs the glibc/ldd hint via log.error', () => {
    assert.match(LANGSERVER_SRC, /if \(code === 1\) \{/, 'exit-1 branch must exist');
    assert.match(LANGSERVER_SRC, /code === 1\) \{[\s\S]{0,600}Missing glibc/, 'the glibc hint must ride the exit-1 branch');
    assert.match(LANGSERVER_SRC, /LS crashed on startup\. Common causes:/, 'must label the diagnosis');
    assert.match(LANGSERVER_SRC, /log\.error\('  2\. Missing glibc\/libstdc\+\+/, 'the hint must go through log.error (stderr)');
    assert.match(LANGSERVER_SRC, /run: ldd /, 'must tell the operator to run ldd');
    assert.match(LANGSERVER_SRC, /grep "not found"/, 'must filter for "not found"');
  });
});

describe('#52 — dashboard reuse hint matches the runtime-config default', () => {
  it('the "default on/off" claim in zh-CN / en / index.html matches cascadeConversationReuse', () => {
    _resetRuntimeConfigForTests(); // read the SHIPPED default, not a persisted override
    const enabled = getExperimental().cascadeConversationReuse;
    assert.equal(typeof enabled, 'boolean', 'cascadeConversationReuse must be a boolean default');

    const zhHint = JSON.parse(srcText('src/dashboard/i18n/zh-CN.json')).section.cascadeReuse.hint;
    const enHint = JSON.parse(srcText('src/dashboard/i18n/en.json')).section.cascadeReuse.hint;
    const htmlMatch = srcText('src/dashboard/index.html').match(/data-i18n="section\.cascadeReuse\.hint"[^>]*>([^<]*)</);
    assert.ok(htmlMatch, 'index.html must carry a section.cascadeReuse.hint fallback');
    const htmlHint = htmlMatch[1];

    const zhWant = enabled ? '默认开启' : '默认关闭';
    const zhForbid = enabled ? '默认关闭' : '默认开启';
    for (const [name, hint] of [['zh-CN.json', zhHint], ['index.html fallback', htmlHint]]) {
      assert.ok(hint.includes(zhWant), `${name}: must say "${zhWant}" to match cascadeConversationReuse=${enabled} (#52)`);
      assert.ok(!hint.includes(zhForbid), `${name}: must not say "${zhForbid}" while the default is ${enabled}`);
    }

    const enWant = enabled ? /enabled by default/i : /disabled by default/i;
    const enForbid = enabled ? /disabled by default/i : /enabled by default/i;
    assert.match(enHint, enWant, `en.json: hint must match cascadeConversationReuse=${enabled}`);
    assert.doesNotMatch(enHint, enForbid, 'en.json: hint must not claim the opposite default');
  });
});

describe('#60 — config.js import integrity smoke', () => {
  it('the module loads and exposes its surface (in-process)', () => {
    assert.equal(typeof config.dataDir, 'string');
    assert.ok(config.dataDir.length > 0, 'dataDir must resolve');
    assert.equal(typeof config.port, 'number');
    assert.equal(typeof log.info, 'function');
  });

  it('loads cleanly under REPLICA_ISOLATE (docker-compose replica layout — the #60 crash path)', () => {
    const script = `
      const mod = await import('${REPO_URL}/src/config.js');
      process.stdout.write(JSON.stringify({ ok: true, dataDir: mod.config.dataDir }));
    `;
    const r = spawnChild(script, { REPLICA_ISOLATE: '1', HOSTNAME: 'test-replica' });
    assert.equal(r.status, 0, `child crashed: ${r.stderr || r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(basename(out.dataDir), 'replica-test-replica', 'replica branch must resolve join() cleanly');
  });

  it('loads cleanly under process.pkg (packaged-exe layout)', () => {
    const dir = tmpDir('wa-regmap-pkg-');
    try {
      const fakeExe = join(dir, process.platform === 'win32' ? 'windsurfapi.exe' : 'windsurfapi');
      writeFileSync(fakeExe, '');
      const script = `
        process.pkg = {};
        Object.defineProperty(process, 'execPath', { value: ${JSON.stringify(fakeExe)}, configurable: true });
        const mod = await import('${REPO_URL}/src/config.js');
        process.stdout.write(JSON.stringify({ ok: true, dataDir: mod.config.dataDir }));
      `;
      const r = spawnChild(script, { DATA_DIR: undefined, REPLICA_ISOLATE: undefined });
      assert.equal(r.status, 0, `child crashed: ${r.stderr || r.stdout}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true);
      assert.equal(basename(out.dataDir), 'Windsurf_data', 'packaged branch must resolve join(EXE_DIR, ...) cleanly');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('#200 — install-ls.sh prints the download URL before downloading', () => {
  const SCRIPT = srcText('install-ls.sh');

  it('announces every URL it downloads', () => {
    assert.match(SCRIPT, /log "Fetching manifest: \$LS_MANIFEST"/);
    assert.match(SCRIPT, /log "Downloading: \$URL"/);
    assert.match(SCRIPT, /log "Downloading from: \$INPUT_URL"/);
    assert.match(SCRIPT, /--progress-bar/);
  });

  it('prints each URL immediately before its download call', () => {
    assert.match(
      SCRIPT,
      /log "Downloading: \$URL"\s*\n\s*download "\$URL" "\$TMP_ARCHIVE"/,
    );
    assert.match(
      SCRIPT,
      /log "Downloading from: \$INPUT_URL"\s*\n\s*download "\$INPUT_URL" "\$TMP_TARGET"/,
    );
    assert.match(
      SCRIPT,
      /log "Fetching manifest: \$LS_MANIFEST"\s*\n\s*if ! curl -fsSL[^\n]*\n\s*-o "\$TMP_MANIFEST" "\$LS_MANIFEST"/,
    );
  });
});
