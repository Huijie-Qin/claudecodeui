// Isolated UI fixture: real creation routes/storage and deterministic creator, no model calls.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-creation-browser-'));
process.env.DATABASE_PATH = path.join(temp, 'auth.db'); await fs.writeFile(process.env.DATABASE_PATH, '');
const { createSkillCreationService } = await import('../server/services/skill-creation/service.js');
const { createSkillCreationRouter } = await import('../server/routes/skill-creation.js');
const db = new Database(':memory:');
const service = createSkillCreationService({ db, authorize: () => {}, own: async () => {}, registerConversation: job => `skill-creation:${job.id}`, listSnippets: () => [],
  creator: async ({ description, signal, onPhase }) => {
    for (const phase of ['selecting', 'generating']) {
      onPhase(phase); await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 700); signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Cancelled')); }, { once: true }); });
    }
    if (description.includes('FAIL')) throw new Error('模拟生成失败');
    return { markdown: '---\nname: weekly-report\ndescription: Weekly report\n---\n# Weekly report\nAsk for missing inputs.', snippets: [{ title: '不编造数据', reason: '任务需要真实数据' }] };
  },
}); await service.ready();
const app = express(); app.use(express.json()); app.use((req, res, next) => { req.user = { id: 1 }; next(); });
app.use('/api/workspaces', createSkillCreationRouter({ service, access: { requireWorkspace: () => ({ workspace: { path: temp } }) }, tenantMiddleware: (req, res, next) => { req.tenant = { id: 1 }; next(); } }));
app.get('/src/components/auth/context/AuthContext.tsx', (req, res) => res.type('application/javascript').send('export const useAuth = () => ({user: {id: 1}});'));
app.get('/src/contexts/TenantContext.tsx', (req, res) => res.type('application/javascript').send('export const useTenant = () => ({currentTenant: {id: 1}});'));
const vite = await createServer({ configFile: false, plugins: [react()], resolve: { alias: { '@': path.resolve('src') } }, server: { middlewareMode: true, hmr: { port: 24692 } }, appType: 'custom' }); app.use(vite.middlewares);
app.get('/', async (req, res) => res.type('html').send(await vite.transformIndexHtml('/', `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">
import React from 'react'; import {createRoot} from 'react-dom/client'; import '/src/index.css'; import i18n from '/src/i18n/config.js';
import {useSkillCreation} from '/src/components/chat/hooks/useSkillCreation.ts'; import Composer from '/src/components/chat/view/subcomponents/ChatComposer.tsx';
import {MessageBody, UserMessageBubble, MessageHeader} from '/src/components/chat/view/subcomponents/MessagePresentation.tsx';
i18n.changeLanguage('zh-CN');
function App(){ const [input,setInput]=React.useState(''), [session,setSession]=React.useState(new URLSearchParams(location.search).get('session')),[ordinary,setOrdinary]=React.useState('');const textareaRef=React.useRef(null),overlay=React.useRef(null);const project={name:'fixture',workspaceId:1,accessRole:location.search.includes('readonly')?'view':'owner'};
const c=useSkillCreation({project,sessionId:session,provider:'claude',input,setInput,onConversationReady:id=>{history.replaceState(null,'','?session='+encodeURIComponent(id));setSession(id)}}); const noop=()=>{};
const send=event=>{event.preventDefault();if(c.mode)void c.submit();else {setOrdinary(input);setInput('')}};
return React.createElement('div',{className:'mx-auto max-w-4xl p-4'},
React.createElement('button',{onClick:()=>setSession(session?'': 'session-b')},session?'返回新会话':'切换会话'),
React.createElement('button',{onClick:()=>{c.adoptSession('session-created');setSession('session-created')}},'开始普通聊天'),
React.createElement('p',{'data-testid':'ordinary'},ordinary),
c.messages.map(m=>React.createElement('div',{key:m.id,className:'my-4'}, m.type==='user'?React.createElement(UserMessageBubble,{content:m.content}):React.createElement(React.Fragment,null,React.createElement(MessageHeader,{label:'DataAgent'}),React.createElement(MessageBody,{content:m.content})))),
c.error&&React.createElement('p',{role:'alert'},c.error),
React.createElement(Composer,{skillCreation:{mode:c.mode,busy:c.busy,disabled:project.accessRole==='view',onToggle:c.toggle},pendingPermissionRequests:[],handlePermissionDecision:noop,handleGrantToolPermission:noop,claudeStatus:null,isLoading:c.busy,onAbortSession:c.cancel,provider:'claude',permissionMode:'default',onModeSwitch:noop,thinkingMode:'none',setThinkingMode:noop,tokenBudget:null,slashCommandsCount:0,onToggleCommandMenu:noop,hasInput:!c.busy&&!!(c.mode?c.description:input).trim(),onClearInput:()=>c.mode?c.change(''):setInput(''),isUserScrolledUp:false,hasMessages:!!c.messages.length,onScrollToBottom:noop,onSubmit:send,isDragActive:false,attachedImages:[],onRemoveImage:noop,uploadingImages:new Map(),imageErrors:new Map(),showFileDropdown:false,filteredFiles:[],selectedFileIndex:0,onSelectFile:noop,filteredCommands:[],selectedCommandIndex:0,onCommandSelect:noop,onCloseCommandMenu:noop,isCommandMenuOpen:false,frequentCommands:[],getRootProps:()=>({}),inputHighlightRef:overlay,renderInputWithMentions:s=>s,textareaRef,input:c.mode?c.description:input,onInputChange:e=>c.mode?c.change(e.target.value):setInput(e.target.value),onTextareaClick:noop,onTextareaKeyDown:e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing)send(e)},onTextareaPaste:noop,onTextareaScrollSync:noop,onTextareaInput:noop,placeholder:c.mode?i18n.t('skillCreation.placeholder'): '普通消息',isTextareaExpanded:false}) );}
createRoot(document.getElementById('root')).render(React.createElement(App));
</script></body></html>`)));
const port=Number(process.env.SKILL_CREATION_FIXTURE_PORT)||5192;const server=app.listen(port,'127.0.0.1',()=>console.log('Creation fixture ready on',port));
async function stop(){await service.stop();server.close();await vite.close();db.close();await fs.rm(temp,{recursive:true,force:true});process.exit(0)}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
