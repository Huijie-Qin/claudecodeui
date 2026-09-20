// A stdio MCP tool whose only side effect is a local execution evidence record.
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const logPath = process.env.MCP_CONFIRM_EXECUTION_LOG;
if (!logPath) throw new Error('MCP_CONFIRM_EXECUTION_LOG must identify a local execution log');
await mkdir(path.dirname(logPath), { recursive: true });

const server = new Server({ name: 'confirm_demo', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
  name: 'echo', description: 'Return synthetic demonstration arguments and record their local execution.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      text: { type: 'string' }, count: { type: 'integer' }, sequence: { type: 'integer' },
      nested: { type: 'object', additionalProperties: false, properties: {
        enabled: { type: 'boolean' }, tags: { type: 'array', items: { type: 'string' } }, note: { type: 'string' },
      }, required: ['enabled', 'tags', 'note'] },
    }, required: ['text', 'count', 'sequence', 'nested'],
  },
}] }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'echo') throw new Error('Unknown demonstration tool');
  const args = request.params.arguments;
  if (!args || typeof args.text !== 'string' || !Number.isInteger(args.count)
    || !Number.isInteger(args.sequence) || !args.nested || typeof args.nested !== 'object') {
    throw new Error('Invalid synthetic echo arguments');
  }
  await appendFile(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), tool: 'echo', input: args })}\n`);
  return { content: [{ type: 'text', text: JSON.stringify(args) }] };
});
await server.connect(new StdioServerTransport());
