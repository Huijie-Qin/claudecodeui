import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const scripts=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
scripts.forEach(s=>new vm.Script(s[1]));
let count=0;function test(name,fn){fn();count++;console.log('PASS '+name)}
function setup(){
 const ctx=vm.createContext({});vm.runInContext(scripts[0][1],ctx);const M=ctx.SkillMarketModel,s=M.createState(),t=s.templates[1];
 const values=Object.fromEntries(t.fields.map(f=>[f.key,f.defaultValue||(f.kind==='select'?f.options[0]:'脱敏销售分析')]));
 const j=M.startGeneration(s,t.id,{name:'refinement-demo',title:'分析助手',description:'汇总脱敏数据',values},M.templateStamp(t));M.finishGeneration(s,j.id);return {ctx,M,s,j};
}
test('multiple refinements keep the previous candidate until success and save exactly once',()=>{
 const {M,s,j}=setup(),initial=M.canonical(j.files),size=s.skills.length;
 for(const request of ['增加退款分析','输出使用表格']){
  const before=M.canonical(j.files),a=M.startGenerationRefinement(s,j.id,request,before);
  assert.equal(M.canonical(j.files),before);assert.throws(()=>M.adoptGeneration(s,j.id));
  M.finishGenerationRefinement(s,j.id,a.id);assert.match(j.files['SKILL.md'],new RegExp(request));assert.equal(s.skills.length,size);
 }
 assert.notEqual(M.canonical(j.files),initial);assert.equal(j.refinementNotes.length,2);
 const k=M.adoptGeneration(s,j.id);assert.equal(M.canonical(k.files),M.canonical(j.files));assert.equal(k.report,null);assert.equal(k.published,false);
 assert.equal(M.adoptGeneration(s,j.id).id,k.id);assert.equal(s.skills.length,size+1);
 assert.throws(()=>M.startGenerationRefinement(s,j.id,'再次修改',M.canonical(j.files)));
});
test('failure invalid output and cancellation retain the last usable candidate',()=>{
 const {M,s,j}=setup(),before=M.canonical(j.files);
 for(const outcome of ['error','invalid']){const a=M.startGenerationRefinement(s,j.id,'增加说明',before);M.finishGenerationRefinement(s,j.id,a.id,outcome);assert.equal(j.state,'ready');assert.equal(M.canonical(j.files),before);assert.match(j.refinementNotice,/保留/)}
 const old=M.startGenerationRefinement(s,j.id,'旧请求',before);M.cancelGenerationRefinement(s,j.id);
 const next=M.startGenerationRefinement(s,j.id,'新请求',before);assert.equal(M.finishGenerationRefinement(s,j.id,old.id),false);
 assert.equal(j.state,'refining');M.finishGenerationRefinement(s,j.id,next.id);assert.doesNotMatch(j.files['SKILL.md'],/旧请求/);assert.match(j.files['SKILL.md'],/新请求/);
});
test('empty stale parallel and cross-scope refinement requests are rejected',()=>{
 const {M,s,j}=setup(),before=M.canonical(j.files);
 for(const input of ['', 'x'.repeat(4001)])assert.throws(()=>M.startGenerationRefinement(s,j.id,input,before));
 assert.throws(()=>M.startGenerationRefinement(s,j.id,'修改','stale'));
 for(const [key,value] of [['user','chen'],['tenantId','other'],['workspaceId','other']]){const prev=s[key];s[key]=value;assert.throws(()=>M.startGenerationRefinement(s,j.id,'修改',before));s[key]=prev}
 M.startGenerationRefinement(s,j.id,'修改',before);assert.throws(()=>M.startGenerationRefinement(s,j.id,'重复',before));
});
test('completion stays with its initiating user and revoked access cannot apply changes',()=>{
 const {M,s,j}=setup(),before=M.canonical(j.files),user=s.user,a=M.startGenerationRefinement(s,j.id,'保留归属',before);
 s.user='chen';M.finishGenerationRefinement(s,j.id,a.id);assert.equal(j.user,user);assert.throws(()=>M.adoptGeneration(s,j.id));
 s.user=user;const current=M.canonical(j.files),b=M.startGenerationRefinement(s,j.id,'权限变化',current);s.memberIds=s.memberIds.filter(x=>x!==user);M.finishGenerationRefinement(s,j.id,b.id);assert.equal(M.canonical(j.files),current);assert.equal(j.refinement.status,'error');assert.throws(()=>M.adoptGeneration(s,j.id));
});
test('candidate changes during refinement prevent stale completion',()=>{
 const {M,s,j}=setup(),a=M.startGenerationRefinement(s,j.id,'过期修改',M.canonical(j.files));j.files['SKILL.md']+='\n并发内容';
 M.finishGenerationRefinement(s,j.id,a.id);assert.equal(j.refinement.status,'error');assert.doesNotMatch(j.files['SKILL.md'],/过期修改/);
});
test('template creation is routed into chat and materializes automatically',()=>{
 assert.match(html,/button\('在会话中使用','template-use'/);
 assert.match(html,/id="chat-name"/);
 assert.match(html,/技能标识/);
 assert.match(html,/M\.finishGeneration\(S,job\.id,'success'\).*M\.adoptGeneration\(S,job\.id\)/s);
 assert.doesNotMatch(html,/确认保存到我的技能|data-action="generation-adopt"|function useTemplateDialog/);
});
test('template name remains explicit and model validation survives conversation retries',()=>{
 const {M,s,j}=setup();
 const size=s.generationJobs.length,t=s.templates[1];
 assert.throws(()=>M.startGeneration(s,t.id,{...j.input,name:''},M.templateStamp(t)),/请填写技能标识/);
 for(const name of ['Sales Name','-sales','sales--analysis','sales_1'])assert.throws(()=>M.startGeneration(s,t.id,{...j.input,name},M.templateStamp(t)),/技能标识仅支持/);
 assert.equal(s.generationJobs.length,size);
 const a=M.startGenerationRefinement(s,j.id,'补充输出要求',M.canonical(j.files));M.finishGenerationRefinement(s,j.id,a.id);
 const k=M.adoptGeneration(s,j.id);assert.match(k.files['SKILL.md'],/^---\nname: refinement-demo\n/);assert.equal(k.name,'refinement-demo');
});
console.log(`${count} generation refinement checks passed. Prototype only.`);
