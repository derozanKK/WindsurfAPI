/**
 * Make a fake HTTP/2 language server terminate every RPC the way a real gRPC
 * server does: a trailing HEADERS block carrying `grpc-status`.
 *
 * src/grpc.js refuses to report a response as successful when the server never
 * said how the RPC ended ("gRPC response ended without grpc-status"), because a
 * missing status is indistinguishable from a truncated reply. A fixture that
 * only calls `stream.end(body)` is modelling exactly that truncated RPC, so the
 * fakes opt in here instead of silently losing their success path.
 *
 * Call it FIRST in `server.on('stream', …)`, before the handler responds. The
 * response itself is unchanged: the handler still calls `stream.respond(...)`
 * and `stream.end(...)` as before.
 *
 * `additionalHeaders()` is how the existing fakes publish a non-OK status
 * (errorBody()'s trailers). Those responses already carry their terminal
 * status, so the synthetic END_STREAM frame is sent empty rather than stamped
 * with a contradictory `grpc-status: 0`.
 */
/**
 * Does this request belong to the Connect transport?
 *
 * Connect unary RPCs use `application/proto`, streaming RPCs use
 * `application/connect+proto`, and only legacy gRPC uses `application/grpc`.
 * The fakes branch on the request content-type to pick their response shape, so
 * they must treat both Connect content-types the same way — a fixture that only
 * recognised the streaming one answered every Connect unary call as if it were
 * gRPC.
 */
export function isConnectContentType(contentType) {
  return !String(contentType || '').includes('application/grpc');
}

export function terminateRpcWithStatus(stream, status = '0') {
  let statusSent = false;
  const respond = stream.respond.bind(stream);
  stream.respond = (headers, options) => respond(headers, { ...options, waitForTrailers: true });
  const additionalHeaders = stream.additionalHeaders.bind(stream);
  stream.additionalHeaders = (headers) => { statusSent = true; return additionalHeaders(headers); };
  stream.on('wantTrailers', () => {
    // The client may already have cancelled (abort/backpressure tests).
    try { stream.sendTrailers(statusSent ? {} : { 'grpc-status': status }); } catch {}
  });
}
