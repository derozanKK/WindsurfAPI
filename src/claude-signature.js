// Transport-shape validation for replaying Claude thinking signatures.
// This checks only the outer envelope; upstream still authenticates the bytes.
import { getField, parseFields } from './proto.js';

const MAX_SIGNATURE_BYTES = 32 * 1024 * 1024;

function decodeBase64(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_SIGNATURE_BYTES) return null;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length && decoded.toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '') ? decoded : null;
}

function envelopeStructure(decoded, marker) {
  try {
    if (!decoded.length || decoded[0] !== marker) return false;
    const container = getField(parseFields(decoded), 2, 2)?.value;
    if (!container?.length) return false;
    const channel = getField(parseFields(container), 1, 2)?.value;
    return !!(channel?.length && getField(parseFields(channel), 1, 0));
  } catch {
    return false;
  }
}

/** True only for the supported Claude E/R/C/Q transport envelopes. */
export function isClaudeThinkingSignature(value) {
  const decoded = decodeBase64(value);
  if (!decoded) return false;
  if (value[0] === 'E') return envelopeStructure(decoded, 0x12);
  if (value[0] === 'C') return envelopeStructure(decoded, 0x08);
  if (value[0] === 'R' || value[0] === 'Q') {
    const inner = decoded.toString('ascii');
    return (value[0] === 'R' && inner[0] === 'E') || (value[0] === 'Q' && inner[0] === 'C')
      ? isClaudeThinkingSignature(inner)
      : false;
  }
  return false;
}
