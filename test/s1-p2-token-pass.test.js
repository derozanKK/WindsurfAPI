import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const readSource = path => readFileSync(new URL(path, ROOT), 'utf8').replace(/\r\n/g, '\n');

function functionText(source, name, optional = false) {
  const start = new RegExp('^(?:export )?(?:async )?function ' + name + '\\(', 'm').exec(source);
  if (!start) {
    if (optional) return '';
    throw new Error('Missing function: ' + name);
  }
  const tail = source.slice(start.index);
  const end = /^\}/m.exec(tail);
  if (!end) throw new Error('Missing function end: ' + name);
  return tail.slice(0, end.index + 1).replace(/^export /, '') + '\n';
}

function withoutModuleSyntax(source) {
  return source
    .replace(/^import\s[\s\S]*?;\n/gm, '')
    .replace(/^export\s*\{[\s\S]*?;\n/gm, '')
    .replace(/^export (?=(?:async )?function|class|const|let)/gm, '');
}

function evaluate(source, names, globals = {}) {
  return runInNewContext(
    withoutModuleSyntax(source) + '\n;({ ' + names.join(', ') + ' });',
    { Buffer, console, process: { env: {} }, log: quietLog, ...globals },
    { timeout: 10000 },
  );
}
const plain = value => JSON.parse(JSON.stringify(value));

const MESSAGES_014204F_FUNCTIONS = "function cacheToolTokens(t) {\n  if (!t || typeof t !== 'object') return 0;\n  let n = estimateTextTokens(t.name || '') + estimateTextTokens(t.description || '');\n  if (t.input_schema) n += estimateTextTokens(JSON.stringify(t.input_schema));\n  return n;\n}\nfunction extractCachePolicy(body) {\n  let breakpointCount = 0;\n  let has1h = false;\n  // Anthropic prompt caching is PREFIX-CUMULATIVE: a cache_control breakpoint\n  // caches everything ordered before it (tools → system → messages) up to and\n  // including the marked block. Cascade reports real cache tokens that flow\n  // through chat.js, but DEVIN_CONNECT (free tier especially) returns none —\n  // leaving Claude Code unable to tell whether caching engaged or to budget\n  // its context window. We walk the prefix in cache order, accumulate a\n  // CJK-aware token estimate (reusing estimateTextTokens / anthropicBlockTokens\n  // so the weighting matches count_tokens), and snapshot the cumulative total\n  // at the DEEPEST breakpoint — that prefix is what gets written to cache on a\n  // first-seen turn. buildAnthropicUsage emits it as cache_creation_input_tokens\n  // ONLY when upstream supplied no real cache numbers.\n  // (unverified: this is a local estimate — true cache tokens need a paid\n  //  account to calibrate against; see PAID ledger task E. We attribute the\n  //  whole prefix to creation and leave cache_read to genuine upstream values,\n  //  since detecting a real cross-turn hit needs a stateful tracker we\n  //  deliberately don't build here.)\n  let runningTokens = 0;\n  let estCacheCreationTokens = 0;\n  // C6: split the cumulative prefix per TTL instead of collapsing everything to\n  // a single has1h bit. Each breakpoint OWNS the incremental prefix accumulated\n  // since the previous breakpoint, tagged with its own ttl. Because we walk in\n  // prefix order (tools → system → messages) runningTokens is monotonic, so the\n  // buckets stay mutually exclusive and est5mTokens + est1hTokens ==\n  // estCacheCreationTokens (the deepest breakpoint's cumulative prefix).\n  let est5mTokens = 0;\n  let est1hTokens = 0;\n  let lastBreakpointTokens = 0;\n  const visit = (block, tokens) => {\n    if (!block || typeof block !== 'object') return;\n    runningTokens += tokens;\n    const cc = block.cache_control;\n    if (cc && typeof cc === 'object' && cc.type === 'ephemeral') {\n      breakpointCount++;\n      const is1h = cc.ttl === '1h';\n      if (is1h) has1h = true;\n      // Deepest breakpoint wins for the flat total — its prefix subsumes all\n      // earlier ones. The incremental segment since the last breakpoint is\n      // attributed to THIS breakpoint's ttl bucket (C6 mixed-TTL split).\n      const increment = Math.max(0, runningTokens - lastBreakpointTokens);\n      if (is1h) est1hTokens += increment;\n      else est5mTokens += increment;\n      lastBreakpointTokens = runningTokens;\n      estCacheCreationTokens = runningTokens;\n      delete block.cache_control;\n    }\n  };\n  if (Array.isArray(body.tools)) for (const t of body.tools) visit(t, cacheToolTokens(t));\n  if (typeof body.system === 'string') {\n    // A string system prompt carries no marker but is still part of any\n    // cached prefix a later breakpoint forms.\n    runningTokens += estimateTextTokens(body.system);\n  } else if (Array.isArray(body.system)) {\n    for (const s of body.system) visit(s, estimateTextTokens(s?.text || ''));\n  }\n  if (Array.isArray(body.messages)) {\n    for (const m of body.messages) {\n      if (Array.isArray(m.content)) for (const c of m.content) visit(c, anthropicBlockTokens(c));\n      else if (typeof m.content === 'string') runningTokens += estimateTextTokens(m.content);\n    }\n  }\n  // C5: a top-level `cache_control` is NOT part of the official Anthropic\n  // Messages schema (breakpoints live on tools[]/system[]/content[] blocks).\n  // We deliberately ignore any unknown top-level cache_control rather than\n  // treat it as a whole-request breakpoint — the old auto-cache extension\n  // attributed the entire request (including the tail-turn delta) to\n  // cache_creation, which over-reported creation on every follow-up turn.\n  // It cannot leak downstream: anthropicToOpenAI builds an explicit request\n  // object and never spreads the raw body.\n  //\n  // C2: expose the model's minimum cacheable prefix so buildAnthropicUsage can\n  // floor the EMITTED cache_creation to 0 when the estimated prefix is below it\n  // (Anthropic writes no cache entry under the minimum). We keep the raw prefix\n  // estimate here — the floor is a billing/emission concern applied at output.\n  const minCacheablePrefix = minCacheablePrefixTokens(body?.model);\n  return { has1h, breakpointCount, estCacheCreationTokens, est5mTokens, est1hTokens, minCacheablePrefix };\n}\nfunction minCacheablePrefixTokens(model) {\n  return /haiku/i.test(String(model || '')) ? MIN_CACHEABLE_PREFIX_HAIKU : MIN_CACHEABLE_PREFIX_DEFAULT;\n}\nfunction anthropicToOpenAI(body, ccActive = false) {\n  const cachePolicy = extractCachePolicy(body);\n  const mapAnthropicToolChoice = (toolChoice) => {\n    if (!toolChoice || typeof toolChoice !== 'object') return toolChoice;\n    if (toolChoice.type === 'auto') return 'auto';\n    if (toolChoice.type === 'any') return 'required';\n    if (toolChoice.type === 'none') return 'none';\n    if (toolChoice.type === 'tool' && toolChoice.name) {\n      return { type: 'function', function: { name: toolChoice.name } };\n    }\n    return toolChoice;\n  };\n  const pruneToolChoice = (toolChoice, forwardedTools) => {\n    if (!toolChoice || !forwardedTools.length) return undefined;\n    if (toolChoice.type === 'function') {\n      const names = new Set(forwardedTools.map(t => t.function?.name).filter(Boolean));\n      return names.has(toolChoice.function?.name) ? toolChoice : undefined;\n    }\n    return toolChoice;\n  };\n  const messages = [];\n  const toolNameById = new Map();\n  // T2 (Thinking-core): capture the LAST assistant turn's incoming thinking before\n  // the drop below — a fallback reasoning source for the continuity store when the\n  // upstream response itself carries none (resumed dialogs).\n  let lastIncomingThinking = null;\n  if (body.system) {\n    const rawSys = typeof body.system === 'string'\n      ? body.system\n      : Array.isArray(body.system)\n        ? body.system.map(b => b.text || '').join('\\n')\n        : '';\n    // Strip the competitor self-ID that trips Devin's upstream fingerprint gate.\n    // ccActive gates only the opt-in (cc) aggressive block; a1-a5 stay on for all.\n    const sysText = neutralizeClientIdentity(rawSys, process.env, { ccActive });\n    if (sysText) messages.push({ role: 'system', content: sysText });\n  }\n  for (const m of (body.messages || [])) {\n    const role = m.role === 'assistant' ? 'assistant' : 'user';\n    if (typeof m.content === 'string') {\n      messages.push({ role, content: m.content });\n    } else if (Array.isArray(m.content)) {\n      const textParts = [];\n      const imageParts = [];\n      const toolCalls = [];\n      const toolResults = [];\n      const msgThinking = [];\n      for (const block of m.content) {\n        if (block.type === 'text') {\n          textParts.push(block.text || '');\n        } else if (block.type === 'image') {\n          // A3: normalize to OpenAI image_url shape (base64→data URI) instead\n          // of forwarding the raw Anthropic {type:'image',source} block.\n          const normalized = normalizeImageBlock(block);\n          if (normalized) imageParts.push(normalized);\n        } else if (block.type === 'document') {\n          // A2: document blocks had NO branch — silently dropped. Anthropic\n          // documents carry a `source` like images. A text/plain source has the\n          // full text inline, so extract it. A base64 PDF (or other binary) can't\n          // be decoded in this pure translation layer, so drop a text placeholder\n          // (with title/context when present) rather than vanishing the block.\n          // Real PDF text extraction / attachment forwarding needs the gated\n          // upstream path — TODO(PAID-1).\n          const src = block.source || {};\n          const docLabel = block.title\n            ? `${block.title} (${src.media_type || 'text'})`\n            : (src.media_type || 'text');\n          if (src.type === 'text' && typeof src.data === 'string') {\n            textParts.push(wrapDocumentText(docLabel, src.data));\n          } else if (src.type === 'content' && Array.isArray(src.content)) {\n            textParts.push(wrapDocumentText(docLabel, flattenContentBlocks(src.content)));\n          } else {\n            const mt = src.media_type || (src.type === 'base64' ? 'application/pdf' : 'unknown');\n            const label = block.title ? `${block.title} (${mt})` : mt;\n            textParts.push(`[document: ${label} — content not extracted]`);\n            log.info(`messages: document block (${mt}) not decoded — forwarded as text placeholder`);\n          }\n        } else if (block.type === 'thinking') {\n          if (typeof block.thinking === 'string' && block.thinking) msgThinking.push(block.thinking);\n          // Incoming assistant thinking blocks are dropped on history translation:\n          // 1) Upstream swe-1-7 (K2 family) accepts outgoing candidate tag #11 in ChatMessage,\n          //    but causally ignores its content (0/3 causal effect; tag #9 is incoming-only).\n          // 2) Wholesale promotion (reasoning -> text content) is an industry anti-pattern\n          //    inducing self-reflection loops on Kimi/DeepSeek families.\n          // 3) Genuine Bedrock clients send #11+#12 (signature), but K2 family emits no signature.\n        } else if (block.type === 'tool_use' && role === 'assistant') {\n          const id = block.id || `call_${randomUUID().slice(0, 8)}`;\n          toolNameById.set(id, block.name || '');\n          toolCalls.push({\n            id,\n            type: 'function',\n            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },\n          });\n        } else if (block.type === 'tool_result') {\n          // B2: flatten sub-blocks without dropping non-text (image) blocks.\n          let content = typeof block.content === 'string'\n            ? block.content\n            : Array.isArray(block.content)\n              ? flattenContentBlocks(block.content)\n              : JSON.stringify(block.content);\n          content = annotateRiskyReadToolResult(content, {\n            toolName: toolNameById.get(block.tool_use_id),\n            isError: !!block.is_error,\n          });\n          toolResults.push({ role: 'tool', tool_call_id: block.tool_use_id, content });\n        }\n      }\n      if (role === 'assistant' && msgThinking.length) {\n        lastIncomingThinking = msgThinking.join('\\n');\n      }\n      // Tool results must directly follow the assistant tool_calls message\n      // in OpenAI format. Push them before the user content message.\n      for (const tr of toolResults) messages.push(tr);\n      if (toolCalls.length) {\n        messages.push({\n          role: 'assistant',\n          content: textParts.length ? textParts.join('\\n') : null,\n          tool_calls: toolCalls,\n        });\n      } else if (imageParts.length) {\n        const contentArr = [...imageParts];\n        if (textParts.length) contentArr.push({ type: 'text', text: textParts.join('\\n') });\n        messages.push({ role, content: contentArr });\n      } else if (textParts.length) {\n        messages.push({ role, content: textParts.join('\\n') });\n      }\n    }\n  }\n  // Anthropic exposes a growing set of \"server-side\" tool types where\n  // the service itself runs the work and the client only opts in via\n  // type. The proxy can't honor any of these (each needs its own stage-2\n  // implementation - Cascade-side opus advisor pass, web-search bridge,\n  // sandbox code exec). Drop them silently from the OpenAI-shaped tools\n  // forwarded upstream; otherwise the upstream model is free to invent\n  // a normal function tool_use for \"advisor\" the client will never get\n  // a server_tool_result for.\n  const droppedServerTools = [];\n  const convertedServerTools = [];\n  const tools = (body.tools || []).reduce((acc, t) => {\n    if (t?.type && SERVER_SIDE_ANTHROPIC_TOOL_TYPES.has(t.type)) {\n      droppedServerTools.push(t.type);\n      return acc;\n    }\n    // v2.0.93: web_search_20250305 is now converted to a function tool\n    if (t?.type === 'web_search_20250305') {\n      const converted = convertServerSideTool(t);\n      if (converted) {\n        acc.push(converted);\n        convertedServerTools.push('web_search_20250305→web_search');\n      }\n      return acc;\n    }\n    acc.push({\n      type: 'function',\n      function: {\n        name: t.name,\n        description: t.description || '',\n        parameters: t.input_schema || {},\n      },\n    });\n    return acc;\n  }, []);\n  if (droppedServerTools.length) {\n    log.info(`messages: dropped ${droppedServerTools.length} server-side tool(s) [${[...new Set(droppedServerTools)].join(',')}] - proxy does not implement them yet`);\n  }\n  if (convertedServerTools.length) {\n    log.info(`messages: converted ${convertedServerTools.length} server-side tool(s) [${convertedServerTools.join(',')}]`);\n  }\n  const forwardedToolChoice = pruneToolChoice(\n    body.tool_choice ? mapAnthropicToolChoice(body.tool_choice) : undefined,\n    tools,\n  );\n  // Claude Code 2.x and Anthropic SDK clients send response shape and\n  // reasoning controls inside body.output_config — output_config.effort\n  // mirrors OpenAI's reasoning_effort, and output_config.format carries\n  // structured-output schemas Anthropic-side instead of OpenAI's\n  // response_format. The internal handler speaks OpenAI dialect, so\n  // unwrap both here so chat.js sees them on the path it already knows.\n  const oc = body.output_config;\n  const ocEffort = oc?.effort;\n  const ocFormat = oc?.format;\n  let translatedResponseFormat = null;\n  if (ocFormat?.type === 'json_schema' && ocFormat.schema) {\n    translatedResponseFormat = {\n      type: 'json_schema',\n      json_schema: {\n        name: ocFormat.name || 'response',\n        schema: ocFormat.schema,\n        strict: ocFormat.strict !== false,\n      },\n    };\n  } else if (ocFormat?.type === 'json_object') {\n    translatedResponseFormat = { type: 'json_object' };\n  }\n  return {\n    ...(lastIncomingThinking ? { __incomingThinking: lastIncomingThinking } : {}),\n    model: body.model || 'claude-sonnet-4.6',\n    messages,\n    max_tokens: body.max_tokens || 8192,\n    stream: !!body.stream,\n    ...(tools.length ? { tools } : {}),\n    ...(body.temperature != null ? { temperature: body.temperature } : {}),\n    ...(body.top_p != null ? { top_p: body.top_p } : {}),\n    // F1: top_k was dropped by the translation layer. chat.js:1954 reads\n    // body.top_k off the CONVERTED body, so without passing it through here the\n    // Anthropic-side top_k never reached the DEVIN_CONNECT completion config —\n    // every call ran at the upstream default. Pass it through like top_p.\n    ...(body.top_k != null ? { top_k: body.top_k } : {}),\n    ...(body.stop_sequences ? { stop: body.stop_sequences } : {}),\n    // F2: map tool_choice.disable_parallel_tool_use → OpenAI parallel_tool_calls.\n    // Anthropic carries the \"one tool at a time\" hint inside tool_choice; the\n    // OpenAI dialect the internal handler speaks expresses it as a top-level\n    // parallel_tool_calls:false. Only emit it when tools are actually forwarded.\n    ...(tools.length && body.tool_choice?.disable_parallel_tool_use === true\n      ? { parallel_tool_calls: false }\n      : {}),\n    ...(forwardedToolChoice ? { tool_choice: forwardedToolChoice } : {}),\n    ...(body.thinking ? { thinking: body.thinking } : {}),\n    ...(ocEffort ? { reasoning_effort: ocEffort } : {}),\n    ...(translatedResponseFormat ? { response_format: translatedResponseFormat } : {}),\n    ...(cachePolicy.breakpointCount > 0 ? { __cachePolicy: cachePolicy } : {}),\n  };\n}\nexport async function handleMessages(body, context = {}) {\n  const msgId = genMsgId();\n  const requestedModel = body.model || 'claude-sonnet-4.6';\n  const wantStream = !!body.stream;\n  // ccCompat.active (CC compat layer engaged via /v1/cc/* or detect+toggle) gates\n  // ONLY the opt-in aggressive identity block inside neutralizeClientIdentity;\n  // false → byte-identical to the pre-cc translation for every other client.\n  const ccActive = !!context.ccCompat?.active;\n  const openaiBody = anthropicToOpenAI(body, ccActive);\n  // anthropicToOpenAI attaches __cachePolicy only when the request carried\n  // cache_control breakpoints; reuse it for the local cache-token estimate.\n  const cachePolicy = openaiBody.__cachePolicy || null;\n  // A1: LOCAL prompt-token estimate over the original Anthropic body, same口径\n  // as count_tokens (estimateRequestPromptTokens). Used to prefill the streaming\n  // message_start.usage so official SDKs read a non-zero input_tokens there\n  // instead of the old all-zero placeholder. (cache_control deletion inside\n  // anthropicToOpenAI does not affect this count.)\n  const inputEstimate = estimateRequestPromptTokens(body);\n  const chatHandler = context.handleChatCompletions || handleChatCompletions;\n  // Augment callerKey with the per-user tag from metadata.user_id when\n  // present so the cascade pool can isolate concurrent Claude Code users\n  // sharing one API key. Bare API-key callers and other client SDKs that\n  // do not send metadata.user_id keep the original callerKey unchanged.\n  const subKey = extractCallerSubKey(body);\n  const alreadyUserScoped = context.callerKey && context.callerKey.includes(':user:');\n  const effectiveContext = (subKey && !alreadyUserScoped)\n    ? {\n        ...context,\n        callerKey: `${context.callerKey || ''}:user:${subKey}`,\n        nativeBridgeCallerKey: context.nativeBridgeCallerKey\n          ? `${context.nativeBridgeCallerKey}:user:${subKey}`\n          : context.nativeBridgeCallerKey,\n      }\n    : context;\n  // T2: the captured incoming thinking rides the body as __incomingThinking\n  // (single __-prefixed carrier, same convention as __route); chat.js reads it\n  // as a fallback continuity-store source when the outbound response has none.\n  if (!wantStream) {\n    const result = await chatHandler({ ...openaiBody, stream: false, __route: 'messages' }, effectiveContext);\n    if (result.status !== 200) {\n      // Carry the upstream's transport headers across the translation. This used to\n      // pass three scalars, so `Retry-After` — which chat.js:3011 computes and puts\n      // in BOTH the header and the body when the pool is rate-limited — was dropped\n      // here, one step before the router. Measured: a non-stream 429 on /v1/messages\n      // logged \"advertised 600s\" and arrived at the client with no retry-after at\n      // all, while /v1/responses (which does not re-wrap) forwarded it.\n      //\n      // Only the error VOCABULARY is Anthropic-specific; Retry-After is HTTP, and the\n      // comment on the streaming twin of this branch already says the mapping exists\n      // \"so the SDK applies correct retry/backoff\" — which is precisely the header.\n      return withUpstreamHeaders(toAnthropicError(\n        result.status,\n        result.body?.error?.type,\n        result.body?.error?.message,\n      ), result.headers);\n    }\n    return { status: 200, body: openAIToAnthropic(result.body, requestedModel, msgId, cachePolicy, body.stop_sequences) };\n  }\n\n  // Streaming path — ask handleChatCompletions for its streaming handler and\n  // point its writes at our translator shim. This lets the upstream Cascade\n  // poll loop drive the downstream SSE in real time — no buffer-then-replay.\n  //\n  // O1: the internal chat stream now omits the trailing usage-only frame unless\n  // the caller opts in via stream_options.include_usage. This translator consumes\n  // chunk.usage (→ this.finalUsage → the message_delta usage block, processChunk\n  // at ~1147), so it must opt in regardless of what the downstream Anthropic\n  // client asked for — Anthropic always reports usage on message_delta, so the\n  // internal frame is required to fill it.\n  const streamResult = await chatHandler(\n    { ...openaiBody, stream: true, __route: 'messages', stream_options: { ...(openaiBody.stream_options || {}), include_usage: true } },\n    effectiveContext,\n  );\n\n  if (!streamResult.stream) {\n    // The OpenAI path returned a non-stream error (e.g. 403 model_not_entitled,\n    // 503 capacity_error) before any byte streamed — map it to the Anthropic\n    // error enum so the SDK applies correct retry/backoff.\n    return withUpstreamHeaders(toAnthropicError(\n      streamResult.status || 502,\n      streamResult.body?.error?.type,\n      streamResult.body?.error?.message,\n    ), streamResult.headers);\n  }\n\n  return {\n    status: 200,\n    stream: true,\n    headers: {\n      'Content-Type': 'text/event-stream',\n      'Cache-Control': 'no-store',\n      'Connection': 'keep-alive',\n      'X-Accel-Buffering': 'no',\n    },\n    async handler(realRes) {\n      const translator = new AnthropicStreamTranslator(realRes, msgId, requestedModel, cachePolicy, inputEstimate, body.stop_sequences, context.reqId, context.conversation_id);\n      const captureRes = createCaptureRes(translator, realRes);\n\n      // Forward client disconnect so the upstream cascade is cancelled.\n      // We don't call captureRes.end() here — that would set writableEnded=true\n      // and suppress the abort path inside chat.js's stream handler.\n      realRes.on('close', () => {\n        if (!captureRes.writableEnded) captureRes._clientDisconnected();\n      });\n\n      try {\n        await streamResult.handler(captureRes);\n      } catch (e) {\n        log.error(`Messages stream error: ${e.message}`);\n        translator.error({ type: 'api_error', message: e.message });\n      }\n\n      if (!realRes.writableEnded) realRes.end();\n    },\n  };\n}\nfunction isCjkCodePoint(cp) {\n  return (\n    (cp >= 0x1100 && cp <= 0x11FF) ||   // Hangul Jamo\n    (cp >= 0x2E80 && cp <= 0x2FDF) ||   // CJK Radicals / Kangxi Radicals\n    (cp >= 0x3000 && cp <= 0x303F) ||   // CJK Symbols and Punctuation (full-width)\n    (cp >= 0x3040 && cp <= 0x30FF) ||   // Hiragana + Katakana\n    (cp >= 0x3100 && cp <= 0x312F) ||   // Bopomofo\n    (cp >= 0x3130 && cp <= 0x318F) ||   // Hangul Compatibility Jamo\n    (cp >= 0x31F0 && cp <= 0x31FF) ||   // Katakana Phonetic Extensions\n    (cp >= 0x3200 && cp <= 0x33FF) ||   // Enclosed CJK Letters/Months + Compatibility\n    (cp >= 0x3400 && cp <= 0x4DBF) ||   // CJK Unified Ideographs Extension A\n    (cp >= 0x4E00 && cp <= 0x9FFF) ||   // CJK Unified Ideographs\n    (cp >= 0xA000 && cp <= 0xA4CF) ||   // Yi Syllables\n    (cp >= 0xAC00 && cp <= 0xD7AF) ||   // Hangul Syllables\n    (cp >= 0xF900 && cp <= 0xFAFF) ||   // CJK Compatibility Ideographs\n    (cp >= 0xFF00 && cp <= 0xFFEF) ||   // Halfwidth and Fullwidth Forms\n    (cp >= 0x20000 && cp <= 0x2FA1F)    // CJK Unified Ideographs Extension B–F + Supplement\n  );\n}\nfunction estimateTextTokens(str) {\n  if (!str) return 0;\n  let cjk = 0;\n  let other = 0;\n  // Iterating with for…of yields whole code points (surrogate pairs included),\n  // so astral-plane CJK (Extension B+) is classified correctly.\n  for (const ch of String(str)) {\n    if (isCjkCodePoint(ch.codePointAt(0))) cjk += 1;\n    else other += 1;\n  }\n  // CJK ≈ 1 token/char (conservative upper bound); the rest ≈ chars/4.\n  return cjk + Math.ceil(other / 4);\n}\nfunction anthropicContentTokens(content) {\n  if (content == null) return 0;\n  if (typeof content === 'string') return estimateTextTokens(content);\n  if (Array.isArray(content)) {\n    let n = 0;\n    for (const block of content) n += anthropicBlockTokens(block);\n    return n;\n  }\n  if (typeof content === 'object') return anthropicBlockTokens(content);\n  return 0;\n}\nfunction anthropicBlockTokens(block) {\n  if (!block || typeof block !== 'object') return 0;\n  switch (block.type) {\n    case 'text': return estimateTextTokens(block.text || '');\n    case 'tool_use': return estimateTextTokens(block.name || '') + estimateTextTokens(JSON.stringify(block.input || {}));\n    case 'tool_result': return anthropicContentTokens(block.content);\n    case 'thinking': return estimateTextTokens(block.thinking || '');\n    case 'document': {\n      // A2: keep count_tokens consistent with anthropicToOpenAI — a text/plain\n      // (or nested-content) document is inlined as its text there, so count its\n      // real text tokens here; a base64/binary document is a flat attachment\n      // estimate (real PDF token cost needs the gated decode path — TODO(PAID-1)).\n      const src = block.source || {};\n      if (src.type === 'text' && typeof src.data === 'string') return estimateTextTokens(src.data);\n      if (src.type === 'content') return anthropicContentTokens(src.content);\n      return ATTACHMENT_TOKEN_ESTIMATE;\n    }\n    case 'image':\n      return ATTACHMENT_TOKEN_ESTIMATE;\n    default:\n      // Unknown block: fall back to its serialized text content if present.\n      return typeof block.text === 'string' ? estimateTextTokens(block.text) : 0;\n  }\n}\nfunction estimateRequestPromptTokens(body) {\n  let tokens = 0;\n  // system can be a string or an array of text blocks.\n  tokens += anthropicContentTokens(body?.system);\n  if (Array.isArray(body?.messages)) {\n    for (const m of body.messages) tokens += anthropicContentTokens(m?.content);\n  }\n  // Tool schemas are part of the prompt the model sees.\n  if (Array.isArray(body?.tools)) {\n    for (const t of body.tools) {\n      tokens += estimateTextTokens(t?.name || '') + estimateTextTokens(t?.description || '');\n      if (t?.input_schema) tokens += estimateTextTokens(JSON.stringify(t.input_schema));\n    }\n  }\n  return tokens;\n}\n";

const tokenFunctionNames = [
  'cacheToolTokens', 'extractCachePolicy', 'minCacheablePrefixTokens',
  'anthropicToOpenAI', 'handleMessages', 'isCjkCodePoint', 'estimateTextTokens',
  'anthropicContentTokens', 'anthropicBlockTokens', 'estimateRequestPromptTokens',
];

function messagesHarness({ baseline = false, poisonIterator = false } = {}) {
  const current = readSource('src/handlers/messages.js');
  const source = baseline ? MESSAGES_014204F_FUNCTIONS
    : tokenFunctionNames.map(name => functionText(current, name)).join('\n')
      + functionText(current, 'systemBlockPromptTokens', true);
  const constants = baseline
    ? 'const MIN_CACHEABLE_PREFIX_DEFAULT = 1024; const MIN_CACHEABLE_PREFIX_HAIKU = 2048; const ATTACHMENT_TOKEN_ESTIMATE = 1500;'
    : ['MIN_CACHEABLE_PREFIX_DEFAULT', 'MIN_CACHEABLE_PREFIX_HAIKU', 'ATTACHMENT_TOKEN_ESTIMATE']
    .map(name => {
      const line = current.match(new RegExp('^const ' + name + ' = [^;]+;', 'm'))?.[0];
      assert(line, 'Missing existing threshold ' + name);
      return line;
    }).join('\n');
  let schemaCalls = 0;
  const seenInputs = [];
  const wireBodies = [];
  const api = evaluate(
    (poisonIterator ? "String.prototype[Symbol.iterator] = function () { throw new Error('string iterator used'); };\n" : '')
    + constants + '\n' + source,
    tokenFunctionNames,
    {
      randomUUID: () => '00000000-0000-4000-8000-000000000000',
      genMsgId: () => 'msg_synthetic',
      neutralizeClientIdentity: text => text,
      SERVER_SIDE_ANTHROPIC_TOOL_TYPES: new Set(),
      convertServerSideTool: () => null,
      normalizeImageBlock: block => ({ type: 'image_url', image_url: { url: block.source?.data || '' } }),
      wrapDocumentText: (label, text) => label + '\n' + text,
      flattenContentBlocks: blocks => blocks.map(b => b.text || '').join('\n'),
      annotateRiskyReadToolResult: value => value,
      extractCallerSubKey: () => '',
      buildToolNameMap: () => ({ toUpstream: new Map(), toClient: new Map() }),
      toolHygieneEnabled: () => true,
      signedThinkingReplayEnabled: () => false,
      normalizeToolIdsInMessages: (messages) => messages,
      normalizeHistoryTail: (messages) => messages,
      restoreToolName: name => name,
      handleChatCompletions: async b => {
        wireBodies.push(JSON.stringify(b));
        return { stream: true, handler: async () => {} };
      },
      createCaptureRes: (_translator, res) => res,
      AnthropicStreamTranslator: class {
        constructor(_res, _id, _model, _policy, inputEstimate) { seenInputs.push(inputEstimate); }
      },
      JSON: {
        parse: JSON.parse,
        stringify(value, ...args) {
          if (value && value._s1_schema_probe === true) schemaCalls++;
          return JSON.stringify(value, ...args);
        },
      },
    });
  return {
    ...api, seenInputs, wireBodies,
    schemaCalls: () => schemaCalls, resetCalls: () => { schemaCalls = 0; },
    async run(request) {
      const result = await api.handleMessages(request);
      assert.equal(result.stream, true);
      const response = { writableEnded: false, on() {}, end() { this.writableEnded = true; } };
      await result.handler(response);
      return { estimate: seenInputs.at(-1), wire: wireBodies.at(-1), body: JSON.stringify(request) };
    },
  };
}

function combinedEstimate(h, input) {
  const request = structuredClone(input);
  const carrier = {};
  const policy = h.extractCachePolicy(request, carrier);
  // The old implementation leaves the optional out-parameter untouched.
  const tokens = Object.hasOwn(carrier, 'tokens')
    ? carrier.tokens : h.estimateRequestPromptTokens(request);
  return { policy: plain(policy), tokens, body: JSON.stringify(request) };
}

test('all Unicode code points preserve the legacy numeric result', () => {
  const old = messagesHarness({ baseline: true });
  const next = messagesHarness();
  for (let cp = 0; cp <= 0x10FFFF; cp++) {
    const text = String.fromCodePoint(cp);
    if (!Object.is(next.estimateTextTokens(text), old.estimateTextTokens(text))) {
      assert.fail('Token mismatch at U+' + cp.toString(16));
    }
  }
});

test('arbitrary UTF-16, lone surrogates, combining sequences and rounding stay bit-identical', () => {
  const old = messagesHarness({ baseline: true });
  const next = messagesHarness();
  const cases = [
    '', 'a', 'abc', 'abcd', 'abcde', '中文かな한글', '𠀀😀', 'e\u0301', '👩‍💻',
    '\ud800', '\udc00', '\ud800\ud800\udc00', '\udc00\ud800', '\udbff\udfff',
    'a\ud800b\udc00c😀𠀀', '\u10ff\u1100\u11ff\u1200',
    null, undefined, false, 0, 1, Symbol('中'), { toString: () => '中😀e\u0301' },
  ];
  let seed = 0x51A7;
  for (let row = 0; row < 10000; row++) {
    let text = '';
    for (let col = 0; col < 1 + row % 49; col++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      text += String.fromCharCode(seed & 0xFFFF);
    }
    cases.push(text);
  }
  for (const text of cases) {
    assert(Object.is(next.estimateTextTokens(text), old.estimateTextTokens(text)));
  }
  assert.equal(messagesHarness({ poisonIterator: true }).estimateTextTokens('ASCII 中😀𠀀\ud800'), 4);
});

test('the fused pass preserves both definitions, TTL buckets, deletion and additions', () => {
  const old = messagesHarness({ baseline: true });
  const next = messagesHarness();
  const cc = ttl => ({ type: 'ephemeral', ttl });
  const shapes = [
    undefined, '', 'abcde中😀', { type: 'text', text: 'object-form中' },
    [{ type: 'text', text: 'abc', cache_control: cc('5m') }],
    [
      { type: 'image', text: 'prefix-only中' },
      { type: 'thinking', text: 'prefix side', thinking: 'count side中' },
      { type: 'tool_result', text: 'prefix', content: [{ type: 'text', text: 'nested中文' }] },
      { type: 'document', text: 'prefix', source: { type: 'text', data: 'document 😀' } },
      { type: 'unknown', text: 17, cache_control: cc('1h') },
      null, 12, 'bare block',
    ],
  ];
  for (const system of shapes) {
    for (const content of shapes) {
      const request = {
        model: 'claude-haiku-test', system,
        tools: [
          { name: 'one', description: '中', input_schema: { type: 'object', _s1_schema_probe: true },
            cache_control: cc('1h') },
          { name: 'two', input_schema: false, cache_control: cc('5m') },
          null, 7,
        ],
        messages: [{ role: 'user', content }],
        cache_control: cc('1h'),
      };
      assert.deepEqual(combinedEstimate(next, request), combinedEstimate(old, request));
    }
  }
});

test('the real handleMessages/conversion path stringifies each schema once and keeps stream bytes', async () => {
  const old = messagesHarness({ baseline: true });
  const next = messagesHarness();
  const request = {
    model: 'claude-sonnet-test', stream: true,
    system: [{ type: 'text', text: 'system 中文', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    tools: [{ name: 'search', description: 'Find 中', input_schema: {
      _s1_schema_probe: true, type: 'object', properties: { q: { type: 'string' } },
    }, cache_control: { type: 'ephemeral', ttl: '5m' } }],
    messages: [{ role: 'user', content: 'hello 😀𠀀' }],
  };
  const before = await old.run(structuredClone(request));
  const after = await next.run(structuredClone(request));
  assert.deepEqual(after, before);
  assert.equal(old.schemaCalls(), 2);
  assert.equal(next.schemaCalls(), 1, 'the second full schema serialization must disappear');
  assert.equal(after.estimate, next.estimateRequestPromptTokens(request));
});
