// History-tail normalization for the internal OpenAI-shaped message list.
//
// The upstream only needs the tail it can still pair. Three operations:
//   1. strip a leading tool result (and the assistant turn it belonged to);
//   2. fold orphan tool results into text instead of dropping their content;
//   3. optionally synthesize interrupted results for a non-trailing call.
// A truncation placeholder is prepended only when something was stripped.
//
// Request-scoped: no global mutable state.

import { foldOrphanToolResults, synthesizeMissingResults } from './tool-ids.js';

export const TRUNCATION_PLACEHOLDER = '[Earlier conversation history was truncated to fit the model\'s input limit. Older messages and tool activity have been omitted.]';

export function normalizeHistoryTail(messages, {
  placeholder = '',
  fold = true,
  synthesizeMissing = false,
} = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const head = [];
  let start = 0;
  while (start < messages.length && messages[start]?.role === 'system') {
    head.push(messages[start]);
    start += 1;
  }
  let stripped = false;
  while (start < messages.length && messages[start]?.role === 'tool') {
    start += 1;
    stripped = true;
  }
  // Do NOT strip the assistant after a leading tool result: in OpenAI order the
  // assistant that issued those calls is BEFORE them (already truncated away),
  // so a following assistant is a legitimate new turn.

  let out = start > 0 ? messages.slice(start) : messages;
  if (fold) out = foldOrphanToolResults(out);
  if (synthesizeMissing) out = synthesizeMissingResults(out);

  if (stripped && placeholder) {
    out = [...head, { role: 'user', content: placeholder }, { role: 'assistant', content: 'Understood.' }, ...out];
  } else if (head.length) {
    out = [...head, ...out];
  }
  return out === messages ? messages : out;
}
