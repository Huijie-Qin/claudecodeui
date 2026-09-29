// Local deterministic model for the processing-state reproduction only.
import { createServer } from 'node:http';

export async function startProcessingLoopModelFixture() {
  let count = 0;
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (request.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(pathname)) {
        response.writeHead(404).end();
        return;
      }
      let input = '';
      for await (const chunk of request) input += chunk;
      const body = JSON.parse(input);
      if (pathname.endsWith('/count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":100}');
        return;
      }
      count += 1;
      const blocks = (body.messages || []).flatMap(message => Array.isArray(message.content) ? message.content : []);
      const strings = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(strings).join('\n') : value?.text || '';
      const transcript = (body.messages || []).map(message => strings(message.content)).join('\n');
      const deliveredJobs = new Set([...transcript.matchAll(/<ccui-mcp-loop-result job-id="([^"]+)"/g)].map(match => match[1]));
      const parallel = transcript.includes('并行两项');
      const shouldFail = transcript.includes('失败任务');
      const rounds = transcript.includes('两轮循环') ? 2 : 1;
      const suffix = deliveredJobs.size === 0 ? '' : `_${deliveredJobs.size + 1}`;
      const executeId = `toolu_processing_execute${suffix}`;
      const statusId = `toolu_processing_status${suffix}`;
      const resultFor = id => blocks.find(block => block.type === 'tool_result' && block.tool_use_id === id);
      const executeResult = resultFor(executeId);
      const statusResult = resultFor(statusId);
      const taskId = strings(executeResult?.content).match(/"task_id"\s*:\s*"([^"]+)"/)?.[1];
      let content;
      if (parallel) {
        const ids = ['a', 'b'];
        const executeIds = ids.map(id => `toolu_processing_execute_${id}`);
        const statusIds = ids.map(id => `toolu_processing_status_${id}`);
        const taskIds = executeIds.map(id => strings(resultFor(id)?.content).match(/"task_id"\s*:\s*"([^"]+)"/)?.[1]);
        if (deliveredJobs.size >= ids.length) {
          content = [{ type: 'text', text: '并行两项循环均已结束；最终汇总已完成。' }];
        } else if (executeIds.some(id => !resultFor(id))) {
          content = executeIds.map(id => ({ type: 'tool_use', id, name: 'mcp__processing_repro__execute_task', input: { should_fail: false } }));
        } else if (statusIds.some(id => !resultFor(id)) && taskIds.every(Boolean)) {
          content = statusIds.map((id, index) => ({ type: 'tool_use', id, name: 'mcp__processing_repro__get_task_status', input: { task_id: taskIds[index] } }));
        } else {
          content = [{ type: 'text', text: '并行任务正在后台循环。' }];
        }
      } else if (deliveredJobs.size >= rounds) {
        content = [{ type: 'text', text: shouldFail
          ? '失败任务已返回失败结果；最终汇总已完成。'
          : '循环 Hook 已结束，任务执行成功；最终汇总已完成。' }];
      } else if (!executeResult) {
        content = [{ type: 'tool_use', id: executeId, name: 'mcp__processing_repro__execute_task', input: { should_fail: shouldFail } }];
      } else if (!statusResult && taskId) {
        content = [{ type: 'tool_use', id: statusId, name: 'mcp__processing_repro__get_task_status', input: { task_id: taskId } }];
      } else {
        content = [{ type: 'text', text: '初次状态查询已结束，等待后台循环。' }];
      }
      const stopReason = content.every(block => block.type === 'text') ? 'end_turn' : 'tool_use';
      const message = { id: `msg_processing_fixture_${count}`, type: 'message', role: 'assistant',
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
        const isText = block.type === 'text';
        emit('content_block_start', { index, content_block: isText ? { type: 'text', text: '' } : { ...block, input: {} } });
        emit('content_block_delta', { index, delta: isText ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
        emit('content_block_stop', { index });
      });
      emit('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 30 } });
      emit('message_stop', {});
      response.end();
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"Invalid local fixture request"}');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
  };
}
