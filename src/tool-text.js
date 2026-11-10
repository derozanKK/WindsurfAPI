// Tool-marker neutralization shared by the emulation path and history folding.
// Tool results are untrusted text: a literal `<tool_call>` or Kimi sentinel in a
// result must not become a tool call on the next turn.

const KIMI_SENTINELS = [
  '<|tool_calls_section_begin|>',
  '<|tool_calls_section_end|>',
  '<|tool_call_begin|>',
  '<|tool_call_argument_begin|>',
  '<|tool_call_end|>',
];

export function neutralizeToolResultBody(text) {
  let out = String(text ?? '')
    .replaceAll('</tool_result>', '<\\/tool_result>')
    .replaceAll('<tool_result', '<\\tool_result')
    .replaceAll('</tool_call>', '<\\/tool_call>')
    .replaceAll('<tool_call>', '<\\tool_call>');
  for (const s of KIMI_SENTINELS) {
    out = out.replaceAll(s, `<\\|${s.slice(2)}`);
  }
  return out;
}
