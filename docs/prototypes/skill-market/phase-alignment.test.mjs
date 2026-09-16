import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
function fixture(){const ctx=vm.createContext({});vm.runInContext([...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)][0][1],ctx);const M=ctx.SkillMarketModel;return {M,S:M.createState()};}
function finish(M,S,k){const j=M.fileEvaluation(S,k);for(let i=0;j.state==='running'&&i<200;i++)M.stepFileEvaluation(S,k.id);assert.notEqual(j.state,'running');return j;}
test('description creation needs neither user name nor template and preserves naming invariants',()=>{
 const {M,S}=fixture(),before=S.templates.length,j=M.startDescriptionGeneration(S,'生成销售报告，列出数据依据');
 assert.equal(j.intent,'create-skill');assert.equal(j.referenceLibrary.length,S.snippets.length);assert.equal(S.templates.length,before);
 M.finishGeneration(S,j.id);const k=M.adoptGeneration(S,j.id);assert.equal(k.name,j.input.name);assert.match(k.files['SKILL.md'],new RegExp('name: '+k.name));assert.equal(M.readEval(k).skill_name,k.name);
 const second=M.startDescriptionGeneration(S,'生成销售报告');assert.notEqual(second.input.name,k.name);M.finishGeneration(S,second.id);M.adoptGeneration(S,second.id);assert.equal(S.templates.length,before);
});
test('invalid, failed, cancelled creation never installs partial files',()=>{
 const {M,S}=fixture(),n=S.skills.length;assert.throws(()=>M.startDescriptionGeneration(S,''));
 const j=M.startDescriptionGeneration(S,'生成周报');assert.throws(()=>M.startDescriptionGeneration(S,'重复'));M.cancelGeneration(S,j.id);assert.throws(()=>M.adoptGeneration(S,j.id));
 const failed=M.startDescriptionGeneration(S,'再试一次');M.finishGeneration(S,failed.id,'error');assert.throws(()=>M.adoptGeneration(S,failed.id));assert.equal(S.skills.length,n);
});
test('limits validate before replacing any report',()=>{
 const {M,S}=fixture();for(const n of [0,11,1.5,NaN,'3'])assert.throws(()=>M.startFileEvaluation(S,'weekly',true,'fails',n),/整数/);assert.equal(S.activeEvaluations.length,0);
});
test('failed retests stop exactly at cap and retain serial round evidence',()=>{
 for(const cap of [1,3,10]){const {M,S}=fixture(),k=M.skill(S,'weekly'),before=k.files['SKILL.md'],evals=k.files['evals/evals.json'];const j=M.startFileEvaluation(S,k.id,true,'fails',cap);finish(M,S,k);
 assert.equal(j.iteration,cap);assert.equal(j.rounds.length,cap);assert.equal(j.stopReason,'max_iterations');assert.notEqual(k.files['SKILL.md'],before);assert.equal(k.files['evals/evals.json'],evals);
 for(const r of j.rounds){assert.equal(r.after.length,j.caseSnapshot.length);assert.equal(r.before.length,j.caseSnapshot.length)}
 assert.equal(j.trace.filter(x=>x.event==='case-complete').length,(cap+1)*j.caseSnapshot.length);assert.equal(M.releaseFileEligibility(S,k.id).allowed,false);
 }
});
test('all-pass early stopping and runtime error do not spend remaining attempts',()=>{
 for(const scenario of ['passed','improves','error']){const {M,S}=fixture(),k=M.skill(S,'weekly'),j=M.startFileEvaluation(S,k.id,true,scenario,10);finish(M,S,k);assert.equal(j.iteration,scenario==='passed'?0:1);assert.equal(j.state,scenario==='error'?'failed':'completed');}
});
test('a no-change attempt still consumes one iteration and runs the full frozen suite',()=>{
 const {M,S}=fixture(),k=M.skill(S,'weekly'),files=M.canonical(k.files),j=M.startFileEvaluation(S,k.id,true,'no-change',3);finish(M,S,k);
 assert.equal(j.iteration,3);assert.equal(j.stopReason,'max_iterations');assert.equal(j.written,false);assert.equal(M.canonical(k.files),files);assert.equal(j.rounds.length,3);assert.ok(j.rounds.every(r=>r.after.length===j.caseSnapshot.length));
});
test('full prototype separates direct creation from deferred template and configures optimization',()=>{
 assert.match(html,/chat-create-toggle[\s\S]*?aria-pressed="\$\{chatCreateMode\}"/);assert.match(html,/使用模板（后续）/);assert.match(html,/查看第一阶段/);
 assert.match(html,/最大迭代次数/);assert.match(html,/opt-start/);assert.match(html,/初始前测完整输出/);assert.match(html,/已执行 /);
});
test('generic template delegates both names to creator and keeps business fields',()=>{
 const {M,S}=fixture(),t=M.template(S,'blank'),j=M.startGeneration(S,t.id,{description:'分析销售数据',values:{goal:'分析门店销售数据，说明退款'}},M.templateStamp(t));
 assert.match(j.input.name,/^[a-z0-9]+(?:-[a-z0-9]+)*$/);assert.ok(j.input.title);assert.equal(j.input.values.goal,'分析门店销售数据，说明退款');M.finishGeneration(S,j.id);const k=M.adoptGeneration(S,j.id);assert.equal(M.readEval(k).skill_name,k.name);
});
test('generic template UI hides both naming fields and indicates selected state',()=>{
 const ctx=vm.createContext({});const scripts=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];vm.runInContext(scripts[0][1],ctx);
 const ui=scripts[1][1],start=ui.indexOf('function chatView(){'),end=ui.indexOf('function ',start+12);
 vm.runInContext(`const M=SkillMarketModel,S=M.createState();let chatTemplateId='blank',chatTemplateValues={},chatBoundSkillId=null,chatMessages=[],chatBusy=false,chatEval=null,chatCreateMode=false,chatDraft='',chatCreationJobId=null;const esc=x=>String(x??''),icon=()=>'',button=()=>'',chatMessageView=()=>'',chatEvaluationCard=()=>'';`+ui.slice(start,end),ctx);
 const result=vm.runInContext('chatView()',ctx);assert.doesNotMatch(result,/id="chat-title"|id="chat-name"/);assert.match(result,/chat-field-goal/);assert.match(result,/chat-template-picker" aria-pressed="true"/);
 vm.runInContext("chatTemplateId='analysis'",ctx);assert.match(vm.runInContext('chatView()',ctx),/id="chat-name"/);
});
test('workspace edits cannot change running static input or optimization evidence',()=>{
 const {M,S}=fixture(),k=M.skill(S,'weekly'),j=M.startFileEvaluation(S,k.id,true,'fails',3),base=j.beforeFiles['SKILL.md'];
 M.save(S,k.id,{...k.files,'SKILL.md':base+'\nmanual change'});const external=M.canonical(k.files);finish(M,S,k);
 assert.equal(j.iteration,3);assert.equal(j.writebackConflict,true);assert.equal(j.written,false);assert.equal(M.canonical(k.files),external);assert.doesNotMatch(j.runFiles['SKILL.md'],/manual change/);assert.equal(j.caseSnapshot.length,j.before.length);
});
test('editing during a plain run keeps results on the start snapshot',()=>{
 const {M,S}=fixture(),k=M.skill(S,'weekly'),j=M.startFileEvaluation(S,k.id,false,'passed');
 M.save(S,k.id,{...k.files,'SKILL.md':'invalid new draft'});finish(M,S,k);assert.equal(j.state,'completed');assert.equal(j.staticBefore,true);assert.equal(k.files['SKILL.md'],'invalid new draft');assert.equal(M.releaseFileEligibility(S,k.id).allowed,false);
});
test('version management is owner-only and retired administrator metadata grants nothing',()=>{
 const {M,S}=fixture(),k=M.skill(S,'sales');for(const user of ['chen','admin']){S.user=user;k.administrators=[user];assert.equal(M.canRelease(S,k),false);assert.equal(M.visiblePrs(S,'received').filter(p=>p.skillId===k.id).length,0);}
 const nav=html.slice(html.indexOf('function navigationView'),html.indexOf('function listView'));assert.doesNotMatch(nav,/\['contributions','贡献'\]/);assert.match(html,/M.owner\(S,k\)\?\[\['versions','版本管理'\]\]/);assert.match(html,/function versionManagementView\(k\)\{\s*if\(!M.owner\(S,k\)\)/);
});
