// Local fixture: real React panel/store, with usage-only live events and delayed history.
import path from 'node:path';
import express from 'express';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const app = express();
let phase = 0;
const base = { sessionId: 'panel-demo', provider: 'claude', timestamp: new Date().toISOString() };
const agent = { ...base, id: 'agent', kind: 'tool_use', toolId: 'agent', toolName: 'Agent', toolInput: { description: '侧边栏实时同步验收', run_in_background: true } };
app.post('/fixture/advance', (_req, res) => { phase++; res.json({ phase }); });
app.get('/api/sessions/panel-demo/messages', (_req, res) => {
  const messages = [{ ...agent, ...(phase > 0 ? {
    subagentTools: [{ toolId: 'read', toolName: 'Read', toolInput: { file_path: '/demo/report.txt' }, timestamp: base.timestamp,
      ...(phase > 1 ? { toolResult: { content: '文件读取完成，测试通过。', isError: false } } : {}),
    }],
    subagentMessages: [
    { ...base, id: 'child-text', kind: 'text', role: 'assistant', parentToolUseId: 'agent', content: '子代理正在读取文件，无需刷新页面即可看到这条内容。' },
    { ...base, id: 'child-read', kind: 'tool_use', toolName: 'Read', toolId: 'read', parentToolUseId: 'agent', toolInput: { file_path: '/demo/report.txt' } },
    ...(phase > 1 ? [
      { ...base, id: 'child-result', kind: 'tool_result', toolId: 'read', parentToolUseId: 'agent', content: '文件读取完成，测试通过。' },
      { ...base, id: 'child-final', kind: 'text', role: 'assistant', parentToolUseId: 'agent', content: '子代理已完成，末尾输出已同步。' },
    ] : []),
  ] } : {}) }];
  if (phase > 1) messages.push({ ...base, timestamp: new Date().toISOString(), id: 'done', kind: 'task_notification', taskId: 'child', toolUseId: 'agent', status: 'completed', summary: '验收完成', result: '子代理已完成。', usage: { tool_uses: 2 } });
  res.json({ messages, total: messages.length, hasMore: false });
});
const vite = await createServer({
  configFile: false,
  plugins: [react(), {
    name: 'fixture-websocket',
    enforce: 'pre',
    resolveId(source) { if (/\/contexts\/WebSocketContext(?:\.tsx)?$/.test(source)) return '\0fixture-websocket'; },
    load(id) { if (id === '\0fixture-websocket') return 'export const useWebSocket = () => ({sendMessage() {}, isConnected: true});'; },
  }],
  resolve: { alias: { '@': path.resolve('src') } },
  server: { middlewareMode: true, hmr: false }, appType: 'custom',
});
app.use(vite.middlewares);
app.get('/', async (_req, res) => {
  phase = 0;
  res.type('html').send(await vite.transformIndexHtml('/', `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '/src/index.css';
import i18n from '/src/i18n/config.js';
import { ThemeProvider } from '/src/contexts/ThemeContext.jsx';
import { useSessionStore } from '/src/stores/useSessionStore.ts';
import { normalizedToChatMessages } from '/src/components/chat/hooks/useChatMessages.ts';
import { buildSubagentTraces } from '/src/components/chat/subagent/buildSubagentTraces.ts';
import { SubagentPanel } from '/src/components/chat/subagent/SubagentPanel.tsx';
import { startSubagentHistorySync } from '/src/components/chat/subagent/subagentHistorySync.ts';
i18n.changeLanguage('zh-CN');
function Harness() {
  const store = useSessionStore();
  const mount = useRef(Math.random().toString(36).slice(2));
  const [open, setOpen] = useState(true);
  store.setActiveSession('panel-demo');
  useEffect(() => {
    store.appendRealtime('panel-demo', ${JSON.stringify(agent)});
    store.appendRealtime('panel-demo', { ...${JSON.stringify(base)}, id: 'progress', kind: 'task_notification', taskId: 'child', toolUseId: 'agent', status: 'running', usage: { tool_uses: 2 } });
    store.updateStreaming('panel-demo', '主会话流式内容保留', 'claude');
  }, [store]);
  const chat = normalizedToChatMessages(store.getMessages('panel-demo'));
  const traces = buildSubagentTraces(chat);
  const running = traces.some(trace => ['running','waiting'].includes(trace.status));
  useEffect(() => {
    if (!open) return;
    return startSubagentHistorySync({ isRunning: running, refreshHistory: () => store.refreshFromServer('panel-demo', { provider: 'claude' }), onError: console.error });
  }, [open, running, store]);
  return React.createElement('main', { style: { display:'flex', height:'100vh' } },
    React.createElement('div', { style: { padding:24, flex:1 } },
      React.createElement('p', null, '挂载标识：' + mount.current),
      React.createElement('p', null, chat.find(m => m.isStreaming)?.content),
      React.createElement('button', { onClick: () => fetch('/fixture/advance', {method:'POST'}) }, '推进子代理记录'),
      React.createElement('button', { onClick: () => setOpen(value => !value), style: {marginLeft:20} }, '切换侧边栏')),
    open && React.createElement('div', {style:{width:520}}, React.createElement(SubagentPanel, {
      traces, selectedTraceId:'agent', onSelectTrace() {}, onClose: () => setOpen(false), mode:'docked',
      createDiff: () => [], autoExpandTools:true, provider:'claude',
    })));
}
createRoot(document.getElementById('root')).render(React.createElement(ThemeProvider, null, React.createElement(Harness)));
</script></body></html>`));
});
const server = app.listen(5192, '127.0.0.1', () => console.log('Subagent fixture: http://127.0.0.1:5192'));
async function stop() { server.close(); await vite.close(); process.exit(0); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
