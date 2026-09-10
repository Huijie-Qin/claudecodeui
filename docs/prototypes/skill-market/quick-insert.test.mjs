import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const scripts=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
scripts.forEach(s=>new vm.Script(s[1]));
const ui=scripts[1][1],context=vm.createContext({});vm.runInContext(scripts[0][1],context);
const helpers=ui.slice(ui.indexOf('const esc='),ui.indexOf('const notice='));
const functions=ui.slice(ui.indexOf('const quickInsertTabs='),ui.indexOf('let caseContext='));
vm.runInContext(`const statusNames={};let snippetQuery='',chosenSnippet=null,output=null;
 ${helpers}
 function showDialog(title,body,foot){output={title,body,foot}}
 ${functions}
 globalThis.Q={items:quickInsertItems,insert:quickInsertTransaction,render:(catalog,type,query='')=>{quickInsertCatalog=catalog;quickInsertType=type;snippetQuery=query;chosenSnippet=null;showSnippets();return output}};`,context);
const M=context.SkillMarketModel,Q=context.Q;let count=0;
function test(name,fn){fn();count++;console.log('PASS '+name)}
test('only local other skills are offered and no skill files are copied',()=>{
 const s=M.createState(),before=JSON.stringify(s),items=Q.items(s,'weekly','skill');
 assert.ok(items.length);assert.ok(items.every(x=>x.id!=='weekly'&&M.skill(s,x.id).local));
 assert.equal(items[0].content,items[0].name);assert.doesNotMatch(items[0].content,/---\nname:|片段 ID/);assert.equal(JSON.stringify(s),before);
});
test('MCP selection excludes uninstalled or disabled tools and omits config',()=>{
 const s=M.createState(),tools=[{id:'a',title:'查询',name:'mcp__demo__query',description:'只读查询',server:'测试',installed:true,enabled:true,secret:'PRIVATE_TOKEN'},{id:'b',installed:false,enabled:true},{id:'c',installed:true,enabled:false}];
 const items=Q.items(s,'weekly','mcp',tools);assert.equal(items.length,1);assert.equal(items[0].content,'mcp__demo__query');assert.doesNotMatch(items[0].content,/PRIVATE_TOKEN/);
});
test('snippet preview is a fixed text copy without live updates',()=>{
 const s=M.createState(),items=Q.items(s,'weekly','snippet'),text=items[0].content;s.snippets[0].content='new';assert.equal(items[0].content,text);
});
test('search titles are absent and only snippets have a preview',()=>{
 for(const type of ['snippet','skill','mcp']){const items=Q.items(M.createState(),'weekly',type).map(x=>({...x,type})),out=Q.render(items,type);assert.equal((out.body.match(/role="tab"/g)||[]).length,3);assert.match(out.body,/role="tabpanel"/);assert.doesNotMatch(out.foot,/disabled/);assert.doesNotMatch(out.body,/>查找/);assert.match(out.body,/aria-label="查找/);if(type==='snippet')assert.match(out.body,/quick-preview/);else{assert.doesNotMatch(out.body,/quick-preview|<pre/);assert.match(out.body,/quick-name-list/)}}
 const out=Q.render([{id:'x',type:'snippet',title:'<img>',description:'<script>',content:'<b>unsafe</b>'}],'snippet');assert.match(out.body,/&lt;b&gt;/);assert.doesNotMatch(out.body,/<img>|<script>|<b>/);
});
test('search covers names and clears preview and insert action on no match',()=>{
 const items=Q.items(M.createState(),'weekly','mcp').map(x=>({...x,type:'mcp'}));
 assert.match(Q.render(items,'mcp','CHECK_SQL').body,/SQL 语法检查/);
 const out=Q.render(items,'mcp','no-such-tool');assert.match(out.body,/没有可插入/);assert.match(out.foot,/disabled/);assert.doesNotMatch(out.body,/<pre/);
});
test('skill and MCP names insert inline without any formatting or explanation',()=>{
 const before='请使用完成任务',start=3;
 for(const type of ['skill','mcp']){const item=Q.items(M.createState(),'weekly',type)[0],r=Q.insert(before,{before,start,end:start},item.content,true);assert.equal(r.after,'请使用'+item.name+'完成任务');assert.equal(r.cursor,start+item.name.length);assert.equal(r.before,before)}
 assert.match(ui,/chosenSnippet\.content,quickInsertType!=='snippet'/);
});
test('insertion replaces only the selected body and returns an undo snapshot',()=>{
 const before='---\nname: sample\n---\n\n正文需要替换的文字结尾',start=before.indexOf('需要'),end=before.indexOf('结尾');
 const result=Q.insert(before,{before,start,end},'## 新要求\n- 有依据');
 assert.equal(result.before,before);assert.ok(result.after.startsWith(before.slice(0,start)));assert.ok(result.after.endsWith('结尾'));assert.doesNotMatch(result.after,/需要替换的文字/);assert.match(result.after,/\n\n## 新要求/);
});
test('stale editor, invalid ranges, empty content and frontmatter are rejected',()=>{
 const before='---\nname: sample\n---\n\n正文';
 assert.throws(()=>Q.insert(before,{before:'old',start:before.length,end:before.length},'text'),/变化/);
 for(const range of [{start:1,end:3},{start:-1,end:1},{start:before.length,end:99}])assert.throws(()=>Q.insert(before,{before,...range},'text'),/有效/);
 assert.throws(()=>Q.insert(before,{before,start:before.length,end:before.length},'  '),/有效/);
});
test('insertion is pure and preserves published and evaluation state',()=>{
 const s=M.createState(),k=M.skill(s,'weekly'),state=JSON.stringify(s),before=k.files['SKILL.md'];
 Q.insert(before,{before,start:before.length,end:before.length},Q.items(s,k.id,'mcp')[0].content);assert.equal(JSON.stringify(s),state);
});
test('UI wires keyboard tabs and target-bound undo without enabling any tool',()=>{
 assert.match(ui,/ArrowLeft.*ArrowRight.*Home.*End/);assert.match(ui,/snippetUndo\.skillId===selected&&snippetUndo\.file===selectedFile/);
 assert.match(ui,/selected!==snippetSelection\.skillId/);assert.match(ui,/snippetSelection=\{start,end,before:e\.value/);
});
console.log(`\n${count} quick insertion checks passed. Prototype only.`);
