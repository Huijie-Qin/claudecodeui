// Deterministic local model responses; the caller still runs the native SDK loop.
import { createServer } from 'node:http';

export async function startMainloopModelFixture({ reply = () => '你好。' } = {}) {
  let requestCount = 0;
  const requests = [];
  const rawRequests = [];
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (request.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(pathname)) {
        response.writeHead(404).end();
        return;
      }
      let input = '';
      for await (const chunk of request) {
        input += chunk;
        if (input.length > 2 * 1024 * 1024) throw new Error('Fixture request too large');
      }
      const body = JSON.parse(input);
      if (pathname.endsWith('/count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":100}');
        return;
      }
      requestCount += 1;
      rawRequests.push(structuredClone(body));
      requests.push({ messages: (body.messages || []).map((message) => ({
        role: message.role,
        text: typeof message.content === 'string' ? message.content
          : (message.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n'),
      })) });
      // String replies keep the original main-loop fixture behavior. A reply
      // may also provide content blocks so an SDK test can exercise real tools.
      const replyValue = await reply({ body, requestCount });
      const content = typeof replyValue === 'object' && Array.isArray(replyValue?.content)
        ? replyValue.content : [{ type: 'text', text: String(replyValue) }];
      const stopReason = content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
      const message = { id: `msg_mainloop_fixture_${requestCount}`, type: 'message', role: 'assistant',
        model: body.model, content, stop_reason: stopReason, stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 30 } };
      if (!body.stream) {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const emit = (type, payload) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
      emit('message_start', { message: { ...message, content: [], stop_reason: null,
        usage: { input_tokens: 100, output_tokens: 0 } } });
      content.forEach((block, index) => {
        emit('content_block_start', { index, content_block: block.type === 'tool_use'
          ? { ...block, input: {} } : { type: 'text', text: '' } });
        emit('content_block_delta', { index, delta: block.type === 'tool_use'
          ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
          : { type: 'text_delta', text: block.text } });
        emit('content_block_stop', { index });
      });
      emit('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 30 } });
      emit('message_stop', {});
      response.end();
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"Invalid local fixture request"}');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    getRequestCount: () => requestCount,
    getRequests: () => structuredClone(requests),
    getRawRequests: () => structuredClone(rawRequests),
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}
