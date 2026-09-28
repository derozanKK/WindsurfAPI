// Stand-in for src/vendor/jpeg-js/decoder.js. It records the bytes and decoder
// options src/image.js passes and throws BEFORE any pixel buffer is allocated,
// so the deep-SOF regression can prove "the codec was reached" without ever
// performing a 50-megapixel decode.
export const calls = [];

export default function jpegDecode(buf, opts = {}) {
  calls.push({
    bytes: buf?.length ?? null,
    maxResolutionInMP: opts?.maxResolutionInMP ?? null,
    maxMemoryUsageInMB: opts?.maxMemoryUsageInMB ?? null,
    useTArray: opts?.useTArray ?? null,
  });
  const error = new Error(`JPEG_DECODE_STUB intercepted before allocation (${buf?.length ?? 0} bytes)`);
  error.code = 'JPEG_DECODE_STUB';
  throw error;
}

export function takeCalls() {
  return calls.splice(0, calls.length);
}
