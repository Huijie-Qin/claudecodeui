// Deterministic local Anthropic endpoint for the CCUI MCP confirmation demo.
import { appendFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const TOOL_NAME = 'mcp__confirm_demo__echo';

function contentParts(message) {
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }];
  return Array.isArray(message.content) ? message.content : [];
}

function nextReply(messages, requestCount) {
  let turnStart = 0;
  let prompt = '';
  for (let index = 0; index < messages.length; index += 1) {
    const parts = contentParts(messages[index]);
    if (messages[index].role !== 'user' || parts.some((part) => part.type === 'tool_result')) continue;
    const text = parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    if (text) {
      turnStart = index;
      prompt = text;
    }
  }
  const turnMessages = messages.slice(turnStart);
  const toolCalls = turnMessages.flatMap(contentParts)
    .filter((part) => part.type === 'tool_use' && part.name === TOOL_NAME);
  const toolIds = new Set(toolCalls.map((part) => part.id));
  const toolResults = turnMessages.flatMap(contentParts)
    .filter((part) => part.type === 'tool_result' && toolIds.has(part.tool_use_id));
  const targetCalls = /两次|2\s*次|twice|two calls/i.test(prompt) ? 2 : 1;
  const denied = toolResults.some((part) => part.is_error === true);
  if (toolResults.length >= targetCalls || denied) {
    return { type: 'text', text: denied
      ? '此次 MCP 调用已取消，演示结束。'
      : `已完成 ${toolResults.length} 次 MCP 回声调用。` };
  }
  const sequence = toolCalls.length + 1;
  return {
    type: 'tool_use', id: `toolu_confirm_demo_${requestCount}_${sequence}`, name: TOOL_NAME,
    input: {
      text: `用于 MCP 参数确认的演示文本（第 ${sequence} 次）`,
      count: 7,
      sequence,
      nested: { enabled: true, tags: ['本地演示', '完整参数'], note: '确认后才会执行' },
    },
  };
}

export async function startMcpConfirmModelFixture({ logPath } = {}) {
  const requests = [];
  if (logPath) await mkdir(path.dirname(logPath), { recursive: true });
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
        if (input.length > 4 * 1024 * 1024) throw new Error('Fixture request too large');
      }
      const body = JSON.parse(input);
      if (pathname.endsWith('/count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":100}');
        return;
      }
      const content = nextReply(body.messages || [], requests.length + 1);
      const entry = {
        timestamp: new Date().toISOString(), index: requests.length + 1,
        messages: body.messages || [], tools: (body.tools || []).map((tool) => tool.name), reply: content,
      };
      requests.push(entry);
      if (logPath) await appendFile(logPath, `${JSON.stringify(entry)}\n`);
      const stopReason = content.type === 'tool_use' ? 'tool_use' : 'end_turn';
      const message = {
        id: `msg_confirm_demo_${requests.length}`, type: 'message', role: 'assistant', model: body.model,
        content: [content], stop_reason: stopReason, stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 },
      };
      if (!body.stream) {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const emit = (type, payload) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
      emit('message_start', { message: { ...message, content: [], stop_reason: null,
        usage: { input_tokens: 100, output_tokens: 0 } } });
      emit('content_block_start', { index: 0, content_block: content.type === 'tool_use'
        ? { ...content, input: {} } : { type: 'text', text: '' } });
      emit('content_block_delta', { index: 0, delta: content.type === 'tool_use'
        ? { type: 'input_json_delta', partial_json: JSON.stringify(content.input) }
        : { type: 'text_delta', text: content.text } });
      emit('content_block_stop', { index: 0 });
      emit('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 50 } });
      emit('message_stop', {});
      response.end();
    } catch {
      if (!response.headersSent) response.writeHead(400, { 'content-type': 'application/json' });
      response.end('{"error":"Invalid local fixture request"}');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, baseUrl: url, getRequests: () => structuredClone(requests),
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}
