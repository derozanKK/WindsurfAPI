// Shared SSE framer: one line-terminator rule for the three translators and the
// downstream commit gate. No dependencies.
//
// The canonical producer (chat.js) writes whole `data: <json>\n\n` strings, so the
// happy path is byte-identical. The framer hardens the seam against CRLF, split
// UTF-8, multi-line data, EOF without a blank line, and an unbounded buffer.
//
// The cap bounds retained logical frame bytes (event + data), not the wire
// prefix, so a network chunk boundary cannot change whether a legal frame is
// accepted. Data and the current event have separate budgets; the combined
// frame payload is checked when the frame dispatches, so a later event may
// shrink a frame that temporarily exceeded the cap. An event value over the cap
// fails at its completed or partial line even if a later event would replace
// it. Comment/unknown lines and id/retry values are bounded on their own and
// never enter either payload budget. A partial line is charged by its value
// bytes as soon as its field prefix is decidable; the first
// MAX_FIELD_PREFIX_BYTES bytes of an undecided line are free.
//
// The partial line is kept as a list of chunks plus an 8-char head, never as a
// growing rope: classification and byte accounting stay O(1) per push and the
// whole line is joined once when its terminator arrives.

import { StringDecoder } from 'node:string_decoder';

export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024;

const TERMINATOR_RE = /(\r\n\r\n|\r\n\n|\r\n\r|\n\r\n|\n\n|\n\r|\r\r)/g;
const NEWLINE_RE = /[\r\n]/g;
const FIELD_RE = /^(event|data|id|retry)(?::(.*))?$/;
const FIELDS = ['event', 'data', 'id', 'retry'];
const MAX_FIELD_PREFIX_BYTES = 7; // 'event: ' / 'retry: '
const HEAD_CHARS = MAX_FIELD_PREFIX_BYTES + 1;

export function findFrameEnd(text, from = 0) {
  TERMINATOR_RE.lastIndex = from;
  const match = TERMINATOR_RE.exec(text);
  if (!match) return null;
  return { frameEnd: match.index, next: match.index + match[0].length };
}

// One line rule for the framer and the deferred commit gate. SSE consumes at
// most one ASCII space after the colon; a tab stays in the value. A recognized
// field with no colon is a field with an empty value; other colon-less lines
// name no field and are ignored.
export function parseSseLine(line) {
  const match = FIELD_RE.exec(line);
  if (!match) return null;
  const raw = match[2] ?? '';
  return { field: match[1], value: raw.startsWith(' ') ? raw.slice(1) : raw };
}

function classifyHead(head) {
  if (head.charCodeAt(0) === 58) return { comment: true, prefixBytes: 0 };
  for (const field of FIELDS) {
    if (head.length <= field.length) continue;
    if (!head.startsWith(field) || head.charCodeAt(field.length) !== 58) continue;
    // Wait for the next character before deciding whether a space belongs to
    // the prefix; the choice changes the charged value bytes by one.
    if (head.length === field.length + 1) return undefined;
    const prefixBytes = field.length + 1 + (head.charCodeAt(field.length + 1) === 32 ? 1 : 0);
    return { field, prefixBytes };
  }
  return undefined;
}

export class SseFramer {
  constructor({
    maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    onFrame,
    onComment,
    onOverflow,
  } = {}) {
    this.maxFrameBytes = maxFrameBytes;
    this.onFrame = onFrame;
    this.onComment = onComment;
    this.onOverflow = onOverflow;
    this.decoder = new StringDecoder('utf8');
    // A UTF-8 BOM is transport decoration for the first field, not payload;
    // it is dropped once, before the first line is classified.
    this.atStart = true;
    this.parts = [];
    this.partialBytes = 0;
    this.lineHead = '';
    this.partialClass = undefined;
    this.pendingCr = false;
    this.event = null;
    this.data = [];
    this.payloadBytes = 0;
    this.dataBytes = 0;
    this.eventBytes = 0;
    this.failed = false;
    this.ended = false;
  }

  get bufferedBytes() {
    return this.payloadBytes + this.partialBytes;
  }

  push(chunk) {
    if (this.failed || this.ended) return;
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(Buffer.from(chunk));
    if (text) this.#feed(text);
    if (!this.failed && this.#overCap()) this.#overflow();
  }

  end() {
    if (this.failed || this.ended) return;
    this.ended = true;
    const tail = this.decoder.end();
    if (tail) this.#feed(tail);
    if (!this.failed && this.pendingCr) {
      this.pendingCr = false;
      this.#completeLine();
    }
    if (!this.failed && this.parts.length) this.#completeLine();
    if (!this.failed) this.#dispatch();
    if (!this.failed && this.#overCap()) this.#overflow();
  }

  #feed(text) {
    if (this.atStart) {
      this.atStart = false;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      if (!text) return;
    }
    let i = 0;
    const n = text.length;
    if (this.pendingCr) {
      // The previous chunk ended with CR. LF makes it one CRLF terminator;
      // anything else makes the CR a lone terminator.
      if (text.charCodeAt(0) === 10) i = 1;
      this.pendingCr = false;
      this.#completeLine();
      if (this.failed) return;
    }
    while (i < n) {
      NEWLINE_RE.lastIndex = i;
      const match = NEWLINE_RE.exec(text);
      if (!match) {
        this.#appendSegment(text.slice(i));
        return;
      }
      const idx = match.index;
      if (idx > i) this.#appendSegment(text.slice(i, idx));
      if (text.charCodeAt(idx) === 13) {
        if (idx + 1 === n) {
          this.pendingCr = true;
          return;
        }
        this.#completeLine();
        i = idx + (text.charCodeAt(idx + 1) === 10 ? 2 : 1);
      } else {
        this.#completeLine();
        i = idx + 1;
      }
      if (this.failed) return;
    }
  }

  #appendSegment(segment) {
    if (!segment) return;
    this.parts.push(segment);
    this.partialBytes += Buffer.byteLength(segment, 'utf8');
    if (this.lineHead.length < HEAD_CHARS) {
      this.lineHead += segment.slice(0, HEAD_CHARS - this.lineHead.length);
    }
  }

  #partialInfo() {
    if (this.partialClass !== undefined) return this.partialClass;
    const info = classifyHead(this.lineHead);
    if (info !== undefined) {
      this.partialClass = info;
      return info;
    }
    if (this.partialBytes > MAX_FIELD_PREFIX_BYTES) {
      this.partialClass = null;
      return null;
    }
    return undefined;
  }

  // Data is append-only and has its own budget; the event value has its own
  // budget so a later event can replace it. The combined frame payload is
  // checked when the frame dispatches. Comment/unknown lines and id/retry
  // values are bounded separately and never enter either budget.
  #overCap() {
    if (this.dataBytes > this.maxFrameBytes) return true;
    if (this.partialBytes === 0) return false;
    const info = this.#partialInfo();
    if (info === undefined) return false;
    if (info === null || info.comment) return this.partialBytes > this.maxFrameBytes;
    const valueBytes = Math.max(0, this.partialBytes - info.prefixBytes);
    if (info.field === 'data') return this.dataBytes + valueBytes > this.maxFrameBytes;
    return valueBytes > this.maxFrameBytes;
  }

  #completeLine() {
    const line = this.parts.length === 1 ? this.parts[0] : this.parts.join('');
    this.parts = [];
    this.partialBytes = 0;
    this.lineHead = '';
    this.partialClass = undefined;
    this.#line(line);
  }

  #overflow() {
    if (this.failed) return;
    this.failed = true;
    this.parts = [];
    this.partialBytes = 0;
    this.lineHead = '';
    this.partialClass = undefined;
    this.pendingCr = false;
    this.event = null;
    this.data = [];
    this.payloadBytes = 0;
    this.dataBytes = 0;
    this.eventBytes = 0;
    this.onOverflow?.(Object.assign(new Error('SSE frame exceeds cap'), { code: 'SSE_FRAME_TOO_LARGE' }));
  }

  #line(line) {
    if (line === '') {
      this.#dispatch();
      return;
    }
    if (line.charCodeAt(0) === 58) {
      if (Buffer.byteLength(line, 'utf8') > this.maxFrameBytes) {
        this.#overflow();
        return;
      }
      this.onComment?.(line);
      return;
    }
    const parsed = parseSseLine(line);
    if (!parsed) {
      if (Buffer.byteLength(line, 'utf8') > this.maxFrameBytes) this.#overflow();
      return;
    }
    if (parsed.field === 'event') {
      const bytes = Buffer.byteLength(parsed.value, 'utf8');
      this.eventBytes = bytes;
      this.payloadBytes = this.dataBytes + this.eventBytes;
      this.event = parsed.value;
      if (this.eventBytes > this.maxFrameBytes) this.#overflow();
      return;
    }
    if (parsed.field === 'data') {
      const bytes = Buffer.byteLength(parsed.value, 'utf8');
      this.dataBytes += (this.data.length ? 1 : 0) + bytes;
      this.payloadBytes = this.dataBytes + this.eventBytes;
      this.data.push(parsed.value);
      if (this.dataBytes > this.maxFrameBytes) this.#overflow();
      return;
    }
    // id/retry are not part of the emitted frame; bound the value so a partial
    // field cannot retain unbounded wire data.
    if (Buffer.byteLength(parsed.value, 'utf8') > this.maxFrameBytes) this.#overflow();
  }

  #dispatch() {
    if (this.failed) return;
    if (this.event !== null || this.data.length) {
      if (this.payloadBytes > this.maxFrameBytes) {
        this.#overflow();
        return;
      }
      this.onFrame?.({ event: this.event, data: this.data.join('\n') });
    }
    this.event = null;
    this.data = [];
    this.payloadBytes = 0;
    this.dataBytes = 0;
    this.eventBytes = 0;
  }
}
