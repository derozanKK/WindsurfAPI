import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getActiveServer, registerServer } from '../src/server-registry.js';

// The dashboard's restart/self-update paths drain the server handle registered
// by index.js. The slot is single-writer, so an unregister closure left over
// from a previous server must not clear a newer one: identity, not "whatever
// occupies the slot now". The same lesson as the credential-lock reclaim path.
describe('server-registry identity', () => {
  it('is empty before any server is registered', () => {
    assert.equal(getActiveServer(), null);
  });

  it('a stale unregister closure does not clear the newer server', () => {
    const first = { name: 'first' };
    const second = { name: 'second' };

    const unregisterFirst = registerServer(first);
    assert.equal(getActiveServer(), first);

    const unregisterSecond = registerServer(second);
    assert.equal(getActiveServer(), second);

    // The first server's closure fires late (drain callback from the old
    // instance). It must be a no-op against the current slot.
    unregisterFirst();
    assert.equal(getActiveServer(), second,
      'unregistering a replaced server must not clear its replacement');

    // The matching closure does clear the slot.
    unregisterSecond();
    assert.equal(getActiveServer(), null);
  });

  it('the matching closure is idempotent and never clears a later registration', () => {
    const first = { name: 'first' };
    const unregisterFirst = registerServer(first);

    unregisterFirst();
    unregisterFirst();
    assert.equal(getActiveServer(), null);

    const second = { name: 'second' };
    const unregisterSecond = registerServer(second);
    unregisterFirst(); // stale call after the slot was reused
    assert.equal(getActiveServer(), second);

    unregisterSecond();
    assert.equal(getActiveServer(), null);
  });

  it('registerServer(null) clears the slot and returns a safe closure', () => {
    registerServer({ name: 'live' });
    const unregisterNull = registerServer(null);
    assert.equal(getActiveServer(), null);
    assert.doesNotThrow(() => unregisterNull());
    assert.equal(getActiveServer(), null);
  });
});
