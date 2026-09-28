/**
 * Zero-dependency PDF text extraction.
 *
 * Handles PDF 1.x text streams: decompress FlateDecode streams with
 * Node.js built-in zlib, then extract text from Tj/TJ operators.
 * Not a full PDF parser — designed for text-layer PDFs (reports, docs).
 * Scanned PDFs (image-only) return empty text.
 */

import { inflateSync } from 'zlib';
import { log } from './config.js';

const MAX_STREAMS = 200;
const MAX_STREAM_DECODED = 5 * 1024 * 1024;
const MAX_TOTAL_DECODED = 25 * 1024 * 1024;

/**
 * Extract text from a PDF buffer.
 * @param {Buffer} buf - Raw PDF bytes
 * @returns {string} Extracted text, or empty string if no text layer
 */
export function extractPdfText(buf) {
  const pages = [];
  let streamCount = 0;
  let totalDecoded = 0;
  // Token state for pairing a stream with the dictionary in front of it. Only the
  // bytes BETWEEN stream bodies are tokenized (stream bodies are binary), and each
  // byte is visited once, so the scan stays linear in the input size.
  const dictScan = { stack: [], last: null };
  let codeStart = 0;

  // Find all stream...endstream blocks
  let pos = 0;
  while (pos < buf.length) {
    const streamStart = buf.indexOf('stream\n', pos);
    if (streamStart === -1) break;

    const dataStart = streamStart + 7; // skip "stream\n"
    // Handle \r\n after "stream"
    const actualStart = buf[streamStart + 6] === 0x0d ? dataStart + 1 : dataStart;

    const endStream = buf.indexOf('\nendstream', actualStart);
    if (endStream === -1) break;

    const streamData = buf.subarray(actualStart, endStream);
    streamCount++;
    if (streamCount > MAX_STREAMS) throw new Error('PDF stream count exceeds safety limit');

    // A stream is Flate when the dictionary IMMEDIATELY in front of it carries a
    // direct /Filter /FlateDecode. The old version matched the bare substring
    // "FlateDecode" anywhere in the preceding 500 bytes: a legitimate filter entry
    // padded further back was missed, and a previous object's dictionary — or a
    // string/comment inside this one — could classify a plain stream as Flate and
    // (via the inflate error below) drop its text. Structure, not distance, decides.
    scanPdfTokens(buf, codeStart, streamStart, dictScan);
    const dict = dictScan.last;
    const isFlate = !!dict
      && onlyWhitespaceAndComments(buf, dict.end, streamStart)
      && dictHasFlateFilter(buf, dict.start, dict.end);

    let decoded;
    try {
      if (isFlate) {
        const inflated = inflateSync(streamData, { maxOutputLength: MAX_STREAM_DECODED });
        if (inflated.length > MAX_STREAM_DECODED) throw new Error('PDF decoded content exceeds safety limit');
        totalDecoded += inflated.length;
        if (totalDecoded > MAX_TOTAL_DECODED) throw new Error('PDF decoded content exceeds safety limit');
        decoded = inflated.toString('latin1');
      } else {
        totalDecoded += streamData.length;
        if (streamData.length > MAX_STREAM_DECODED || totalDecoded > MAX_TOTAL_DECODED) throw new Error('PDF decoded content exceeds safety limit');
        decoded = streamData.toString('latin1');
      }
    } catch (e) {
      if (/limit|exceed|maxOutputLength|Buffer larger/i.test(e.message) || e.code === 'ERR_BUFFER_TOO_LARGE') throw e;
      codeStart = endStream + 10;
      pos = endStream + 10;
      continue;
    }

    // Extract text from PDF operators
    const text = extractTextOps(decoded);
    if (text.trim()) pages.push(text.trim());

    codeStart = endStream + 10;
    pos = endStream + 10;
  }

  return pages.join('\n\n');
}

// ─── Stream-dictionary association (structure, not a fixed lookback) ──────────
//
// PDF lexical basics only: PDF whitespace, %-comments, literal (…) and hex <…>
// strings, and << … >> nesting. Enough to find the dictionary that belongs to a
// stream; deliberately not an object model, xref reader, indirect-filter
// resolver, or codec table.

function isPdfWhitespace(byte) {
  return byte === 0x00 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20;
}

// PDF delimiters: ( ) < > [ ] { } / % — a name ends at whitespace or one of these.
function isPdfDelimiter(byte) {
  return byte === 0x28 || byte === 0x29 || byte === 0x3c || byte === 0x3e
    || byte === 0x5b || byte === 0x5d || byte === 0x7b || byte === 0x7d
    || byte === 0x2f || byte === 0x25;
}

// Index after the comment that starts at `at` (the EOL belongs to the comment).
function skipComment(buf, at, limit) {
  let i = at + 1;
  while (i < limit && buf[i] !== 0x0a && buf[i] !== 0x0d) i++;
  return i;
}

// Index after the literal (…) string starting at `at`. PDF literal strings may hold
// BALANCED nested parentheses — `(outer (nested) still)` is one string — and a
// backslash escapes the next byte, so only the ')' that closes the group opened here
// ends the string. Closing at the first ')' instead lets a '>>' inside the string be
// read as the dictionary end, which loses the stream's dictionary association and
// silently drops the text. An unterminated string runs to `limit`: nothing after it
// can be trusted, so the caller degrades to "no dictionary found" rather than guessing.
function skipLiteralString(buf, at, limit) {
  let i = at + 1;
  let depth = 1;
  while (i < limit) {
    const c = buf[i];
    if (c === 0x5c) { i += 2; continue; }        // backslash escapes the next byte
    if (c === 0x28) { depth++; i++; continue; }  // (
    if (c === 0x29) {                            // )
      depth--;
      if (depth === 0) return i + 1;
      i++;
      continue;
    }
    i++;
  }
  return i;
}

// Index after the hex <…> string starting at `at`.
function skipHexString(buf, at, limit) {
  let i = at + 1;
  while (i < limit) {
    if (buf[i] === 0x3e) return i + 1;
    i++;
  }
  return i;
}

// Read a /Name token at `at`. Returns [name without the slash, index after it].
function readPdfName(buf, at, limit) {
  if (buf[at] !== 0x2f) return [null, at];
  let i = at + 1;
  while (i < limit && !isPdfWhitespace(buf[i]) && !isPdfDelimiter(buf[i])) i++;
  return [buf.toString('latin1', at + 1, i), i];
}

function skipWhitespaceAndComments(buf, from, limit) {
  let i = from;
  while (i < limit) {
    if (buf[i] === 0x25) { i = skipComment(buf, i, limit); continue; }
    if (isPdfWhitespace(buf[i])) { i++; continue; }
    break;
  }
  return i;
}

// Walk a code region (the bytes between stream bodies) and remember the most
// recently CLOSED outermost dictionary. Strings and comments are skipped, so a
// `<<` inside a string never opens a dictionary and a `>>` inside a comment never
// closes one; nested dictionaries do not overwrite the outermost entry.
function scanPdfTokens(buf, from, to, state) {
  let i = from;
  while (i < to) {
    const c = buf[i];
    if (c === 0x25) { i = skipComment(buf, i, to); continue; }            // %
    if (c === 0x28) { i = skipLiteralString(buf, i, to); continue; }      // (
    if (c === 0x3c) {                                                     // <
      if (buf[i + 1] === 0x3c) { state.stack.push(i); i += 2; continue; } // <<
      i = skipHexString(buf, i, to);
      continue;
    }
    if (c === 0x3e && buf[i + 1] === 0x3e) {                              // >>
      const start = state.stack.pop();
      if (start !== undefined && state.stack.length === 0) state.last = { start, end: i + 2 };
      i += 2;
      continue;
    }
    i++;
  }
  return state;
}

// True when nothing but whitespace/comments separates a closed dictionary from the
// `stream` keyword — i.e. that dictionary IS this stream's dictionary. Any token in
// between (endobj, another object's number, …) means the dictionary belongs to
// something else and must not classify this stream.
function onlyWhitespaceAndComments(buf, from, to) {
  let i = from;
  while (i < to) {
    if (buf[i] === 0x25) { i = skipComment(buf, i, to); continue; }
    if (!isPdfWhitespace(buf[i])) return false;
    i++;
  }
  return true;
}

// A dictionary's own /Filter entry, read at nesting depth 0 (a nested dictionary's
// /Filter does not describe this stream's bytes). Only the direct name form
// `/Filter /FlateDecode` counts — no array form, no indirect reference.
function dictHasFlateFilter(buf, start, end) {
  let i = start + 2; // past "<<"
  const stop = end - 2; // before ">>"
  let depth = 0;
  while (i < stop) {
    const c = buf[i];
    if (c === 0x25) { i = skipComment(buf, i, stop); continue; }          // %
    if (c === 0x28) { i = skipLiteralString(buf, i, stop); continue; }    // (
    if (c === 0x3c) {                                                     // <
      if (buf[i + 1] === 0x3c) { depth++; i += 2; continue; }             // <<
      i = skipHexString(buf, i, stop);
      continue;
    }
    if (c === 0x3e && buf[i + 1] === 0x3e) {                              // >>
      if (depth > 0) depth--;
      i += 2;
      continue;
    }
    if (c === 0x2f && depth === 0) {                                      // /
      const [name, afterName] = readPdfName(buf, i, stop);
      if (name === 'Filter') {
        const [value] = readPdfName(buf, skipWhitespaceAndComments(buf, afterName, stop), stop);
        if (value === 'FlateDecode') return true;
      }
      i = afterName > i ? afterName : i + 1;
      continue;
    }
    i++;
  }
  return false;
}

/**
 * Extract text from PDF content stream operators.
 * Handles: (text) Tj, [(text)] TJ, Td/Tm for positioning
 */
function extractTextOps(stream) {
  const lines = [];
  let currentLine = '';

  // Find BT...ET text-object blocks with a linear, forward-only indexOf scan.
  // The old /BT[\s\S]*?ET/g regex degraded to O(n^2) on a "many BT, no ET"
  // stream: each of N 'BT' starts re-scanned the entire tail looking for an 'ET'
  // that never comes (5MB of 'BT' blocked the event loop ~26 min). indexOf pairs
  // each BT with the next ET after it and stops the instant no ET remains, so the
  // whole pass is O(n) regardless of how the input is crafted.
  const blocks = [];
  let scan = 0;
  while (scan < stream.length) {
    const bt = stream.indexOf('BT', scan);
    if (bt === -1) break;
    const et = stream.indexOf('ET', bt + 2);
    if (et === -1) break; // no closing ET anywhere ahead -> done (forward-only)
    blocks.push(stream.slice(bt, et + 2));
    scan = et + 2;
  }
  if (blocks.length === 0) return '';

  for (const block of blocks) {
    // (string) Tj — show string
    const tjMatches = block.matchAll(/\(([^)]*)\)\s*Tj/g);
    for (const m of tjMatches) {
      currentLine += decodePdfString(m[1]);
    }

    // [...] TJ — show strings with spacing.
    // Linear regex (single negated class, no nested quantifier) — the old
    // /\[((?:[^[\]]*|\([^)]*\))*)\]\s*TJ/ form was catastrophic-backtracking
    // ReDoS: an unclosed '[' in attacker PDF content hung the event loop for
    // tens of seconds (single-request DoS, proxy ingests untrusted PDFs). The
    // tradeoff is a TJ array containing a literal ']' inside a (...) string is
    // skipped — rare, and text extraction is best-effort anyway.
    const tjArrayMatches = block.matchAll(/\[([^\]]*)\]\s*TJ/gi);
    for (const m of tjArrayMatches) {
      const inner = m[1];
      const parts = inner.matchAll(/\(([^)]*)\)|(-?\d+(?:\.\d+)?)/g);
      for (const p of parts) {
        if (p[1] !== undefined) {
          currentLine += decodePdfString(p[1]);
        } else if (p[2] !== undefined) {
          const kern = parseFloat(p[2]);
          if (kern < -100) currentLine += ' ';
        }
      }
    }

    // Td/TD/Tm — text positioning (new line heuristic)
    if (/\d+\s+(?:-?\d+(?:\.\d+)?)\s+T[dD]/g.test(block)) {
      if (currentLine.trim()) {
        lines.push(currentLine.trim());
        currentLine = '';
      }
    }
  }

  if (currentLine.trim()) lines.push(currentLine.trim());
  return lines.join('\n');
}

/**
 * Decode PDF string escapes: \n, \r, \t, \\, \(, \), octal
 */
function decodePdfString(s) {
  return s.replace(/\\([nrtbf()\\]|\d{1,3})/g, (_, c) => {
    if (c === 'n') return '\n';
    if (c === 'r') return '\r';
    if (c === 't') return '\t';
    if (c === 'b') return '\b';
    if (c === 'f') return '\f';
    if (c === '(' || c === ')' || c === '\\') return c;
    return String.fromCharCode(parseInt(c, 8));
  });
}

/**
 * Try to extract text from base64-encoded PDF.
 * @param {string} base64Data - Base64 encoded PDF
 * @returns {{ text: string, pageCount: number } | null}
 */
export function tryExtractPdf(base64Data) {
  try {
    const buf = Buffer.from(base64Data, 'base64');
    if (buf.length < 5 || buf.subarray(0, 5).toString() !== '%PDF-') return null;

    const text = extractPdfText(buf);
    if (!text.trim()) {
      log.warn('PDF has no extractable text layer (scanned/image-only PDF)');
      return { text: '', pageCount: 0 };
    }

    const pageCount = (buf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
    return { text, pageCount };
  } catch (e) {
    log.warn(`PDF extraction failed: ${e.message}`);
    if (/exceeds safety limit|maxOutputLength|too large|Buffer larger/i.test(e.message) || e.code === 'ERR_BUFFER_TOO_LARGE') {
      return { text: 'PDF 内容无法提取', pageCount: 0 };
    }
    return null;
  }
}
