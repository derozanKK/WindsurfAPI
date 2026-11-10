// P2-2 (Kimi wave review): `supports_images` is an ACCOUNT-specific forwarding
// policy, but the request gate read the pool-wide live catalog union, which is
// first-writer-wins. With two accounts that disagree for the same selector, one
// account's bit controlled every request: A=true then B=false forwarded an image
// to B, and B=false then A=true stripped A's valid image. Both outcomes depend
// only on catalog sync order.
//
// These tests drive the real per-account sync (fetchCatalog seam -> per-account
// rows -> union) and the real handler with a mocked upstream, then pin the
// SERVING account's bit via the sticky binding. The union is asserted to be the
// opposite of the serving account in each direction, so a regression to the
// union cannot pass.
//
// ⚠️ sticky-session.js reads STICKY_SESSION_ENABLED into a module-load const, so
// the env must be set before the first product import. node:test gives each file
// its own process; the dynamic imports below run after this assignment.

process.env.STICKY_SESSION_ENABLED = '1';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const auth = await import('../src/auth.js');
const chat = await import('../src/handlers/chat.js');
const models = await import('../src/devin-connect-models.js');
const sticky = await import('../src/account/sticky-session.js');
const { cacheClear } = await import('../src/cache.js');

const SELECTOR = 'p2-image-account-model';
const CALLER = 'api:p2-image-account:user:one';
const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const IMAGE_MESSAGES = [{
  role: 'user',
  content: [
    { type: 'text', text: 'what is in this image?' },
    { type: 'image_url', image_url: { url: DATA_URL } },
  ],
}];

const ENV_KEYS = ['DEVIN_CONNECT', 'DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY', 'WINDSURFAPI_STRICT_MODEL'];
const SAVED_ENV = {};
for (const key of ENV_KEYS) SAVED_ENV[key] = process.env[key];

const created = [];
const rowsByToken = new Map();
const upstream = { hits: 0, lastParams: null };

function chatBody(model) {
  return {
    id: 'chatcmpl-p2-image', object: 'chat.completion', created: 0, model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function wireImages(messages) {
  const out = [];
  for (const msg of messages || []) {
    if (!Array.isArray(msg?.content)) continue;
    for (const part of msg.content) {
      if (part?.type === 'image_url' || part?.type === 'image' || part?.type === 'input_image') out.push(part);
    }
  }
  return out;
}

function mk(key, row) {
  rowsByToken.set(key, row
    ? [{ selector: SELECTOR, label: `p2-${key.slice(-1)}`, provider: 'test', ...row }]
    : []);
  const { id } = auth.addAccountByKey(key, `p2-account-${key.slice(-1)}`);
  const acct = auth.getAccountInternal(id);
  // A paid selector so the per-account catalog membership is what admits it;
  // free-tier selectors take a different (permissive) branch.
  acct.status = 'active';
  acct.tier = 'pro';
  created.push(id);
  return acct;
}

/** Create the two accounts in the given sync order. */
async function seedOrder(firstRow, secondRow) {
  const first = mk('devin-session-token$p2-image-a', firstRow);
  await auth.__waitForModelCatalogSync();
  const second = mk('devin-session-token$p2-image-b', secondRow);
  await auth.__waitForModelCatalogSync();
  return { first, second };
}

/** Force the serving account through the connect sticky slot. */
async function askAs(account) {
  // A distinct caller per account: the response cache is keyed by body+caller,
  // and a cached answer from one account's capability must not hide the other
  // account's gate (the cache is not account-aware).
  const caller = `${CALLER}:${account.id}`;
  sticky.setStickyBinding(caller, null, account.id, account.apiKey, SELECTOR);
  upstream.hits = 0;
  upstream.lastParams = null;
  const result = await chat.handleChatCompletions(
    { model: SELECTOR, stream: false, messages: IMAGE_MESSAGES },
    { callerKey: caller },
  );
  return result;
}

beforeEach(() => {
  process.env.DEVIN_CONNECT = '1';
  delete process.env.DEVIN_CONNECT_TOKEN;
  delete process.env.WINDSURF_API_KEY;
  delete process.env.WINDSURFAPI_STRICT_MODEL;
  auth.__resetModelCatalogState();
  sticky.resetAllBindings();
  cacheClear();
  rowsByToken.clear();
  auth.__setModelCatalogDeps({
    getCascadeModelConfigs: async () => ({ configs: [] }),
    scheduleCatalogRetry: () => () => {},
    fetchConnectCatalog: async ({ token }) => rowsByToken.get(token) || [],
  });
  chat.__setConnectDeps({
    toChatCompletion: async (params) => {
      upstream.hits++;
      upstream.lastParams = params;
      return { status: 200, body: chatBody(params.model) };
    },
  });
});

afterEach(() => {
  while (created.length) auth.removeAccount(created.pop());
  chat.__resetConnectDeps();
  auth.__setModelCatalogDeps(null);
  auth.__resetModelCatalogState();
  models.clearLiveCatalogSelectors();
  sticky.resetAllBindings();
  cacheClear();
  for (const key of ENV_KEYS) {
    if (SAVED_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED_ENV[key];
  }
});

describe('per-account supports_images (P2-2)', () => {
  it('order A(true) then B(false): the union says true, B is still stripped', async () => {
    const { first: a, second: b } = await seedOrder(
      { supportsImages: true }, { supportsImages: false },
    );

    assert.equal(models.getConnectSelectorImageCapability(SELECTOR), true,
      'precondition: the first-writer union carries A\'s true');

    const toB = await askAs(b);
    assert.equal(toB.status, 200, JSON.stringify(toB.body));
    assert.equal(upstream.hits, 1);
    assert.equal(wireImages(upstream.lastParams.messages).length, 0,
      'B declared supports_images=false; A\'s union true must not forward an image to B');

    const toA = await askAs(a);
    assert.equal(toA.status, 200, JSON.stringify(toA.body));
    assert.equal(wireImages(upstream.lastParams.messages).length, 1,
      'A declared supports_images=true and keeps its image');

    assert.equal(auth.getConnectSelectorImageCapabilityForAccount(a.id, SELECTOR), true);
    assert.equal(auth.getConnectSelectorImageCapabilityForAccount(b.id, SELECTOR), false);
  });

  it('order B(false) then A(true): the union says false, A is still forwarded', async () => {
    const { first: b, second: a } = await seedOrder(
      { supportsImages: false }, { supportsImages: true },
    );

    assert.equal(models.getConnectSelectorImageCapability(SELECTOR), false,
      'precondition: the first-writer union carries B\'s false');

    const toA = await askAs(a);
    assert.equal(toA.status, 200, JSON.stringify(toA.body));
    assert.equal(upstream.hits, 1);
    assert.equal(wireImages(upstream.lastParams.messages).length, 1,
      'A declared supports_images=true; B\'s union false must not strip A\'s image');

    const toB = await askAs(b);
    assert.equal(toB.status, 200, JSON.stringify(toB.body));
    assert.equal(wireImages(upstream.lastParams.messages).length, 0,
      'B declared supports_images=false and is stripped');

    assert.equal(auth.getConnectSelectorImageCapabilityForAccount(a.id, SELECTOR), true);
    assert.equal(auth.getConnectSelectorImageCapabilityForAccount(b.id, SELECTOR), false);
  });

  it('an account whose row is silent is unknown and forwards', async () => {
    const a = mk('devin-session-token$p2-image-a', {});
    await auth.__waitForModelCatalogSync();

    assert.equal(auth.getConnectSelectorImageCapabilityForAccount(a.id, SELECTOR), null);
    const result = await askAs(a);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(wireImages(upstream.lastParams.messages).length, 1,
      'an absent bit is not "no"');
  });

  it('an account with no synced rows is unknown and forwards, not union-false', async () => {
    // B contributes an explicit false and keeps the selector known to the
    // resolver. A's sync returns an empty catalog, so A has no rows at all.
    const b = mk('devin-session-token$p2-image-b', { supportsImages: false });
    await auth.__waitForModelCatalogSync();
    const a = mk('devin-session-token$p2-image-a', null);
    await auth.__waitForModelCatalogSync();

    assert.equal(auth.getConnectSelectorImageCapabilityForAccount(a.id, SELECTOR), null);
    assert.equal(models.getConnectSelectorImageCapability(SELECTOR), false,
      'precondition: the union carries B\'s false');
    const result = await askAs(a);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(wireImages(upstream.lastParams.messages).length, 1,
      'unknown for the serving account must forward, never read the union as "no"');
  });
});
