/**
 * Smoke-matrix families: models · openai · messages · responses · gemini.
 *
 * All four protocol fronts run through the REAL server → REAL handler → REAL
 * adapter, with only the upstream event stream scripted
 * (__setStreamChatForTest). That is the layer a client actually depends on:
 * request validation, translation, SSE framing, usage and error mapping.
 */

export function registerProtocolFlows(ctx) {
  const { http, requireThat, addFlow, state, sseEvents, MATRIX } = ctx;

  const chatUrl = '/v1/chat/completions';
  const userTurn = (content) => [{ role: 'user', content }];

  function jsonFrames(text) {
    return sseEvents(text)
      .filter((f) => f.data && f.data !== '[DONE]')
      .map((f) => {
        try { return JSON.parse(f.data); } catch { return null; }
      })
      .filter(Boolean);
  }

  // ─── models ──────────────────────────────────────────────────────────
  addFlow('models', 'models.list', async () => {
    const r = await http('GET', '/v1/models', { auth: 'api' });
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(r.json?.object === 'list', `object ${r.json?.object}`);
    requireThat(Array.isArray(r.json?.data) && r.json.data.length > 10, `data ${r.json?.data?.length}`);
    requireThat(r.json.data.every((m) => m.object === 'model' && typeof m.id === 'string'), 'a model row is malformed');
    requireThat(r.json.data.some((m) => m.id === 'swe-1-6-slow'), 'free selector missing from discovery');
    requireThat(r.json.data.some((m) => m.id === 'claude-sonnet-4.6'), 'a known catalog id is missing from discovery');
    return `${r.json.data.length} models`;
  });

  addFlow('models', 'models.get', async () => {
    const r = await http('GET', '/v1/models/claude-sonnet-4.6', { auth: 'api' });
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(r.json?.type === 'model', `type ${r.json?.type}`);
    requireThat(typeof r.json?.id === 'string' && r.json.id, 'id missing');
    requireThat(typeof r.json?.display_name === 'string', 'display_name missing');
    const missing = await http('GET', '/v1/models/smoke-definitely-not-a-model', { auth: 'api' });
    requireThat(missing.status === 404, `unknown status ${missing.status}`);
    requireThat(missing.json?.error?.type === 'not_found_error', `unknown type ${missing.json?.error?.type}`);
    return 'single-model lookup + 404';
  });

  // ─── openai ──────────────────────────────────────────────────────────
  addFlow('openai', 'openai.chat-nonstream', async () => {
    const r = await http('POST', chatUrl, {
      auth: 'api',
      body: { model: MATRIX.models.chat, messages: userTurn('hello') },
    });
    requireThat(r.status === 200, `status ${r.status} error ${r.json?.error?.message || '?'}`);
    requireThat(r.json?.object === 'chat.completion', `object ${r.json?.object}`);
    requireThat(r.json?.choices?.[0]?.message?.content === MATRIX.text, `content ${r.json?.choices?.[0]?.message?.content}`);
    requireThat(r.json?.choices?.[0]?.finish_reason === 'stop', `finish ${r.json?.choices?.[0]?.finish_reason}`);
    requireThat(r.json?.usage?.total_tokens === 18, `usage ${JSON.stringify(r.json?.usage)}`);
    requireThat(r.json?.model === MATRIX.models.chat, `echoed model ${r.json?.model}`);
    requireThat(typeof r.json?.system_fingerprint === 'string', 'system_fingerprint missing');
    requireThat(typeof r.header('x-request-id') === 'string', 'x-request-id missing');
    requireThat(Number(r.header('openai-processing-ms')) >= 0, 'openai-processing-ms missing');
    return '200 chat.completion with usage + fingerprint';
  });

  addFlow('openai', 'openai.chat-stream', async () => {
    const r = await http('POST', chatUrl, {
      auth: 'api',
      body: {
        model: MATRIX.models.chat,
        messages: userTurn('stream please'),
        stream: true,
        stream_options: { include_usage: true },
      },
    });
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(/text\/event-stream/i.test(r.contentType), `content-type ${r.contentType}`);
    requireThat(/no-store/i.test(String(r.header('cache-control'))), `cache-control ${r.header('cache-control')}`);
    requireThat(r.text.trimEnd().endsWith('data: [DONE]'), 'stream does not end with [DONE]');
    const frames = jsonFrames(r.text);
    requireThat(frames.length >= 3, `only ${frames.length} JSON frames`);
    requireThat(frames.every((f) => f.object === 'chat.completion.chunk'), 'a frame is not a chat.completion.chunk');
    requireThat(frames[0]?.choices?.[0]?.delta?.role === 'assistant', 'first frame is not the role prime');
    const content = frames.flatMap((f) => f.choices || []).map((c) => c.delta?.content || '').join('');
    requireThat(content === MATRIX.text, `streamed content ${JSON.stringify(content)}`);
    requireThat(frames.some((f) => (f.choices || []).some((c) => c.finish_reason === 'stop')), 'no finish_reason:stop frame');
    const usageFrame = frames.find((f) => f.usage);
    requireThat(usageFrame?.usage?.total_tokens === 18, `usage frame ${JSON.stringify(usageFrame?.usage)}`);
    return `${frames.length} frames, content + finish + usage + [DONE]`;
  });

  addFlow('openai', 'openai.chat-tools', async () => {
    const r = await http('POST', chatUrl, {
      auth: 'api',
      body: {
        model: MATRIX.models.tools,
        messages: userTurn(`What is the weather? ${MATRIX.marker.tool}`),
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Look up the weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          },
        }],
      },
    });
    requireThat(r.status === 200, `status ${r.status} error ${r.json?.error?.message || '?'}`);
    const choice = r.json?.choices?.[0];
    requireThat(choice?.finish_reason === 'tool_calls', `finish ${choice?.finish_reason}`);
    const call = choice?.message?.tool_calls?.[0];
    requireThat(call?.type === 'function', `tool_call type ${call?.type}`);
    requireThat(call?.function?.name === 'get_weather', `tool name ${call?.function?.name}`);
    const args = JSON.parse(call?.function?.arguments || '{}');
    requireThat(args.city === 'Paris', `tool args ${call?.function?.arguments}`);
    requireThat(!String(choice?.message?.content || '').includes('<tool_call>'), 'tool markup leaked into content');
    return 'emulated tool call parsed, markup stripped';
  });

  addFlow('openai', 'openai.chat-reasoning', async () => {
    const r = await http('POST', chatUrl, {
      auth: 'api',
      body: { model: MATRIX.models.chat, messages: userTurn(`Think it through. ${MATRIX.marker.reasoning}`) },
    });
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(r.json?.choices?.[0]?.message?.reasoning_content === 'weighing the options', 'reasoning_content missing');
    requireThat(r.json?.choices?.[0]?.message?.content === 'Reasoned answer.', 'visible content wrong');
    return 'reasoning_content separated from content';
  });

  addFlow('openai', 'openai.chat-validation', async () => {
    const badJson = await http('POST', chatUrl, { auth: 'api', rawBody: '{' });
    requireThat(badJson.status === 400, `invalid json status ${badJson.status}`);
    requireThat(badJson.json?.error?.type === 'invalid_request_error', `invalid json type ${badJson.json?.error?.type}`);
    const noMessages = await http('POST', chatUrl, { auth: 'api', body: { model: MATRIX.models.chat } });
    requireThat(noMessages.status === 400, `no messages status ${noMessages.status}`);
    const empty = await http('POST', chatUrl, { auth: 'api', body: { model: MATRIX.models.chat, messages: [] } });
    requireThat(empty.status === 400 && /at least 1 item/.test(String(empty.json?.error?.message)), `empty status ${empty.status}`);
    return 'invalid JSON / missing / empty messages all 400';
  });

  addFlow('openai', 'openai.chat-unknown-model', async () => {
    const r = await http('POST', chatUrl, {
      auth: 'api',
      body: { model: 'smoke-definitely-not-a-model', messages: userTurn('hi') },
    });
    requireThat(r.status === 400, `status ${r.status}`);
    requireThat(r.json?.error?.code === 'model_not_found', `code ${r.json?.error?.code}`);
    requireThat(r.json?.error?.param === 'model', `param ${r.json?.error?.param}`);
    return '400 model_not_found, no silent free-tier degrade';
  });

  addFlow('openai', 'openai.chat-upstream-failure', async () => {
    const r = await http('POST', chatUrl, {
      auth: 'api',
      body: { model: MATRIX.models.chat, messages: userTurn(`trigger failure ${MATRIX.marker.fail}`) },
    });
    requireThat(r.status === 503, `status ${r.status}`);
    requireThat(r.json?.error?.code === 'UPSTREAM_INTERNAL', `code ${r.json?.error?.code}`);
    requireThat(r.json?.error?.type === 'api_error', `type ${r.json?.error?.type}`);
    requireThat(typeof r.json?.request_id === 'string', 'request_id missing on the error body');
    return '503 UPSTREAM_INTERNAL normalized to the OpenAI vocabulary';
  });

  addFlow('openai', 'openai.compat-namespaces', async () => {
    // Both compatibility layers are explicit opt-in namespaces that rewrite to
    // the canonical routes; a partner pointing Cline / Claude Code at them must
    // get a normal answer.
    const cline = await http('POST', '/v1/cline/chat/completions', {
      auth: 'api',
      body: { model: MATRIX.models.chat, messages: userTurn('cline namespace') },
    });
    requireThat(cline.status === 200, `cline status ${cline.status} error ${cline.json?.error?.message || '?'}`);
    requireThat(cline.json?.choices?.[0]?.message?.content === MATRIX.text, 'cline namespace content mismatch');
    const cc = await http('POST', '/v1/cc/messages', {
      auth: 'api',
      body: { model: MATRIX.models.messages, max_tokens: 32, messages: userTurn('cc namespace') },
    });
    requireThat(cc.status === 200, `cc status ${cc.status} error ${cc.json?.error?.message || '?'}`);
    requireThat(cc.json?.type === 'message', `cc envelope ${cc.json?.type}`);
    return 'cline + cc namespaces rewrite to the canonical routes';
  });

  addFlow('openai', 'openai.completions', async () => {
    const r = await http('POST', '/v1/completions', {
      auth: 'api',
      body: { model: MATRIX.models.chat, prompt: 'legacy prompt' },
    });
    requireThat(r.status === 200, `status ${r.status} error ${r.json?.error?.message || '?'}`);
    requireThat(r.json?.object === 'text_completion', `object ${r.json?.object}`);
    requireThat(r.json?.choices?.[0]?.text === MATRIX.text, `text ${r.json?.choices?.[0]?.text}`);
    return 'legacy /v1/completions text_completion';
  });

  // ─── messages (Anthropic) ────────────────────────────────────────────
  const messagesBody = (extra = {}) => ({
    model: MATRIX.models.messages,
    max_tokens: 64,
    messages: userTurn('hello claude'),
    ...extra,
  });

  addFlow('messages', 'messages.nonstream', async () => {
    const r = await http('POST', '/v1/messages', { auth: 'api', body: messagesBody() });
    requireThat(r.status === 200, `status ${r.status} error ${r.json?.error?.message || '?'}`);
    requireThat(r.json?.type === 'message', `type ${r.json?.type}`);
    requireThat(r.json?.role === 'assistant', `role ${r.json?.role}`);
    const text = (r.json?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    requireThat(text === MATRIX.text, `text ${JSON.stringify(text)}`);
    requireThat(r.json?.stop_reason === 'end_turn', `stop_reason ${r.json?.stop_reason}`);
    requireThat(r.json?.usage?.input_tokens > 0, `input_tokens ${r.json?.usage?.input_tokens}`);
    requireThat(r.json?.usage?.output_tokens > 0, `output_tokens ${r.json?.usage?.output_tokens}`);
    requireThat(r.header('anthropic-version') === '2023-06-01', `anthropic-version ${r.header('anthropic-version')}`);
    return 'message envelope, text block, usage, version echo';
  });

  addFlow('messages', 'messages.stream', async () => {
    const r = await http('POST', '/v1/messages', { auth: 'api', body: messagesBody({ stream: true }) });
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(/text\/event-stream/i.test(r.contentType), `content-type ${r.contentType}`);
    const frames = sseEvents(r.text);
    const events = frames.map((f) => f.event).filter(Boolean);
    requireThat(events.includes('message_start'), 'message_start missing');
    requireThat(events.includes('content_block_delta'), 'content_block_delta missing');
    requireThat(events.includes('message_stop'), 'message_stop missing');
    const text = frames
      .filter((f) => f.event === 'content_block_delta')
      .map((f) => JSON.parse(f.data)?.delta?.text || '')
      .join('');
    requireThat(text === MATRIX.text, `streamed text ${JSON.stringify(text)}`);
    return `${events.length} events, text reassembled`;
  });

  addFlow('messages', 'messages.tools', async () => {
    const r = await http('POST', '/v1/messages', {
      auth: 'api',
      body: messagesBody({
        messages: userTurn(`weather? ${MATRIX.marker.tool}`),
        tools: [{
          name: 'get_weather',
          description: 'Look up the weather',
          input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        }],
      }),
    });
    requireThat(r.status === 200, `status ${r.status} error ${r.json?.error?.message || '?'}`);
    const use = (r.json?.content || []).find((b) => b.type === 'tool_use');
    requireThat(!!use, 'tool_use block missing');
    requireThat(use.name === 'get_weather', `tool name ${use.name}`);
    requireThat(use.input?.city === 'Paris', `tool input ${JSON.stringify(use.input)}`);
    requireThat(r.json?.stop_reason === 'tool_use', `stop_reason ${r.json?.stop_reason}`);
    return 'tool_use block with parsed input';
  });

  addFlow('messages', 'messages.count-tokens', async () => {
    const r = await http('POST', '/v1/messages/count_tokens', {
      auth: 'api',
      body: { model: MATRIX.models.messages, messages: userTurn('count these tokens please') },
    });
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(Number(r.json?.input_tokens) > 0, `input_tokens ${r.json?.input_tokens}`);
    const missingModel = await http('POST', '/v1/messages/count_tokens', { auth: 'api', body: { messages: userTurn('x') } });
    requireThat(missingModel.status === 400, `missing model status ${missingModel.status}`);
    return `${r.json.input_tokens} estimated tokens; model required`;
  });

  addFlow('messages', 'messages.validation', async () => {
    const noMax = await http('POST', '/v1/messages', {
      auth: 'api',
      body: { model: MATRIX.models.messages, messages: userTurn('hi') },
    });
    requireThat(noMax.status === 400, `no max_tokens status ${noMax.status}`);
    requireThat(noMax.json?.error?.type === 'invalid_request_error', `type ${noMax.json?.error?.type}`);
    requireThat(/max_tokens/.test(String(noMax.json?.error?.message)), `message ${noMax.json?.error?.message}`);

    const badCache = await http('POST', '/v1/messages', {
      auth: 'api',
      body: messagesBody({
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '2h' } }],
        }],
      }),
    });
    requireThat(badCache.status === 400, `bad cache_control status ${badCache.status}`);
    requireThat(/cache_control/.test(String(badCache.json?.error?.message)), `message ${badCache.json?.error?.message}`);
    return 'max_tokens required, cache_control ttl validated';
  });

  // ─── responses (OpenAI Responses) ────────────────────────────────────
  addFlow('responses', 'responses.nonstream', async () => {
    const r = await http('POST', '/v1/responses', {
      auth: 'api',
      body: { model: MATRIX.models.responses, input: 'hello responses', user: 'smoke-user' },
    });
    requireThat(r.status === 200, `status ${r.status} error ${r.json?.error?.message || '?'}`);
    requireThat(r.json?.object === 'response', `object ${r.json?.object}`);
    requireThat(r.json?.status === 'completed', `status ${r.json?.status}`);
    requireThat(/^resp_/.test(String(r.json?.id)), `id ${r.json?.id}`);
    const text = (r.json?.output || [])
      .flatMap((item) => item.content || [])
      .filter((part) => part.type === 'output_text')
      .map((part) => part.text)
      .join('');
    requireThat(text === MATRIX.text, `output_text ${JSON.stringify(text)}`);
    requireThat(r.json?.usage?.total_tokens === 18, `usage ${JSON.stringify(r.json?.usage)}`);
    state.responseId = r.json.id;
    return `response ${r.json.id} with output_text + usage`;
  });

  addFlow('responses', 'responses.stream', async () => {
    const r = await http('POST', '/v1/responses', {
      auth: 'api',
      body: { model: MATRIX.models.responses, input: 'stream it', user: 'smoke-user', stream: true },
    });
    requireThat(r.status === 200, `status ${r.status}`);
    const events = sseEvents(r.text).map((f) => f.event).filter(Boolean);
    requireThat(events.includes('response.created'), 'response.created missing');
    requireThat(events.includes('response.output_text.delta'), 'response.output_text.delta missing');
    requireThat(events.includes('response.completed'), 'response.completed missing');
    const text = sseEvents(r.text)
      .filter((f) => f.event === 'response.output_text.delta')
      .map((f) => JSON.parse(f.data)?.delta || '')
      .join('');
    requireThat(text === MATRIX.text, `streamed text ${JSON.stringify(text)}`);
    return `${events.length} lifecycle events`;
  });

  addFlow('responses', 'responses.retrieve-delete', async () => {
    const id = state.responseId;
    requireThat(typeof id === 'string' && id, 'precondition: no response id from the non-stream flow');
    const scoped = await http('GET', `/v1/responses/${id}`, {
      auth: 'api',
      headers: { 'x-response-user': 'smoke-user' },
    });
    requireThat(scoped.status === 200, `scoped retrieve status ${scoped.status}`);
    requireThat(scoped.json?.id === id, `retrieved id ${scoped.json?.id}`);
    const unscoped = await http('GET', `/v1/responses/${id}`, { auth: 'api' });
    requireThat(unscoped.status === 404, `unscoped retrieve status ${unscoped.status}`);
    const del = await http('DELETE', `/v1/responses/${id}`, {
      auth: 'api',
      headers: { 'x-response-user': 'smoke-user' },
    });
    requireThat(del.status === 200 && del.json?.deleted === true, `delete status ${del.status}`);
    requireThat(del.json?.object === 'response.deleted', `delete object ${del.json?.object}`);
    const gone = await http('GET', `/v1/responses/${id}`, {
      auth: 'api',
      headers: { 'x-response-user': 'smoke-user' },
    });
    requireThat(gone.status === 404, `after-delete status ${gone.status}`);
    return 'scoped retrieve, cross-scope 404, delete then 404';
  });

  addFlow('responses', 'responses.validation-and-alias', async () => {
    const missing = await http('POST', '/v1/responses', { auth: 'api', body: { model: MATRIX.models.responses } });
    requireThat(missing.status === 400 && /input is required/.test(String(missing.json?.error?.message)), `missing input status ${missing.status}`);
    const alias = await http('POST', '/v1/response', {
      auth: 'api',
      body: { model: MATRIX.models.responses, input: 'singular alias', user: 'alias-user' },
    });
    requireThat(alias.status === 200 && alias.json?.object === 'response', `alias status ${alias.status}`);
    return 'input required; /v1/response alias served';
  });

  // ─── gemini ──────────────────────────────────────────────────────────
  const geminiBody = (extra = {}) => ({
    contents: [{ role: 'user', parts: [{ text: 'hello gemini' }] }],
    ...extra,
  });
  const geminiBase = `/v1beta/models/${MATRIX.models.gemini}`;

  addFlow('gemini', 'gemini.generate-content', async () => {
    const r = await http('POST', `${geminiBase}:generateContent`, { auth: 'api', body: geminiBody() });
    requireThat(r.status === 200, `status ${r.status} error ${JSON.stringify(r.json?.error)}`);
    requireThat(r.json?.candidates?.[0]?.content?.parts?.[0]?.text === MATRIX.text, `text ${JSON.stringify(r.json?.candidates?.[0]?.content?.parts?.[0]?.text)}`);
    requireThat(r.json?.candidates?.[0]?.finishReason === 'STOP', `finishReason ${r.json?.candidates?.[0]?.finishReason}`);
    requireThat(r.json?.usageMetadata?.totalTokenCount === 18, `usage ${JSON.stringify(r.json?.usageMetadata)}`);
    return 'GenerateContentResponse with usageMetadata';
  });

  addFlow('gemini', 'gemini.stream-array', async () => {
    const r = await http('POST', `${geminiBase}:streamGenerateContent`, { auth: 'api', body: geminiBody() });
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(/application\/json/i.test(r.contentType), `content-type ${r.contentType}`);
    requireThat(Array.isArray(r.json), 'stream body is not a JSON array');
    const text = r.json.flatMap((f) => f.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    requireThat(text === MATRIX.text, `streamed text ${JSON.stringify(text)}`);
    requireThat(r.json.at(-1)?.candidates?.[0]?.finishReason === 'STOP', 'terminal frame has no STOP');
    return `${r.json.length} array frames`;
  });

  addFlow('gemini', 'gemini.stream-sse', async () => {
    const r = await http('POST', `${geminiBase}:streamGenerateContent?alt=sse`, { auth: 'api', body: geminiBody() });
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(/text\/event-stream/i.test(r.contentType), `content-type ${r.contentType}`);
    const frames = sseEvents(r.text).filter((f) => f.data).map((f) => JSON.parse(f.data));
    const text = frames.flatMap((f) => f.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    requireThat(text === MATRIX.text, `streamed text ${JSON.stringify(text)}`);
    requireThat(frames.some((f) => f.candidates?.[0]?.finishReason === 'STOP'), 'no STOP frame');
    return `${frames.length} SSE frames`;
  });

  addFlow('gemini', 'gemini.function-call', async () => {
    const r = await http('POST', `${geminiBase}:generateContent`, {
      auth: 'api',
      body: geminiBody({
        contents: [{ role: 'user', parts: [{ text: `weather? ${MATRIX.marker.tool}` }] }],
        tools: [{
          functionDeclarations: [{
            name: 'get_weather',
            description: 'Look up the weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          }],
        }],
      }),
    });
    requireThat(r.status === 200, `status ${r.status} error ${JSON.stringify(r.json?.error)}`);
    const part = (r.json?.candidates?.[0]?.content?.parts || []).find((p) => p.functionCall);
    requireThat(!!part, 'functionCall part missing');
    requireThat(part.functionCall.name === 'get_weather', `name ${part.functionCall.name}`);
    requireThat(part.functionCall.args?.city === 'Paris', `args ${JSON.stringify(part.functionCall.args)}`);
    return 'functionCall part with parsed args';
  });

  addFlow('gemini', 'gemini.validation-and-404', async () => {
    const empty = await http('POST', `${geminiBase}:generateContent`, { auth: 'api', body: { contents: [] } });
    requireThat(empty.status === 400, `empty contents status ${empty.status}`);
    requireThat(empty.json?.error?.status === 'INVALID_ARGUMENT', `status ${empty.json?.error?.status}`);
    const badPath = await http('POST', `${geminiBase}:notAMethod`, { auth: 'api', body: geminiBody() });
    requireThat(badPath.status === 404, `bad method status ${badPath.status}`);
    return 'empty contents 400 INVALID_ARGUMENT, unknown method 404';
  });
}
