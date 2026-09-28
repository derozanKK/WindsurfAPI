// Deterministic stand-in for node:http / node:https, substituted at the import
// boundary (see test/image-fetch-deadline.test.js) so src/image.js runs
// unmodified against a fake transport: no socket is opened and no host is
// resolved. Only the surface image.js uses is implemented — get() plus
// 'error'/'timeout' on the request and statusCode/headers/resume/destroy plus
// 'data'/'end'/'error' on the response — with the test deciding exactly when a
// hop answers.
import { FakeEmitter } from './fake-emitter.mjs';

export const hops = [];

export class FakeRequest extends FakeEmitter {
  constructor(hop) {
    super();
    this.hop = hop;
    this.destroyed = false;
    this.destroyCalls = 0;
  }

  destroy() {
    this.destroyCalls++;
    this.destroyed = true;
    return this;
  }
}

export class FakeResponse extends FakeEmitter {
  constructor(hop) {
    super();
    this.hop = hop;
    this.statusCode = 200;
    this.headers = {};
    this.destroyed = false;
    this.destroyCalls = 0;
    this.resumed = false;
  }

  resume() {
    this.resumed = true;
    return this;
  }

  destroy() {
    this.destroyCalls++;
    this.destroyed = true;
    return this;
  }

  // Test-facing delivery. Events reach only the listeners still attached, so a
  // late chunk/end/error after settlement is observable as "nothing happened".
  chunk(data) {
    return this.emit('data', Buffer.from(data));
  }

  end() {
    return this.emit('end');
  }

  fail(error) {
    return this.emit('error', error);
  }
}

export function get(url, options, callback) {
  const hop = { index: hops.length, url, options, callback, req: null, res: null };
  hop.req = new FakeRequest(hop);
  hops.push(hop);
  return hop.req;
}

export function respond(hop, { status = 200, headers = {}, location = null } = {}) {
  const res = new FakeResponse(hop);
  res.statusCode = status;
  res.headers = location ? { location, ...headers } : headers;
  hop.res = res;
  hop.callback(res);
  return res;
}

export function lastHop() {
  return hops[hops.length - 1];
}

export function reset() {
  hops.length = 0;
}

export default { get, request: get };
