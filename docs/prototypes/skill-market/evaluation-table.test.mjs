import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const scripts=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
scripts.forEach(s=>new vm.Script(s[1]));
const ui=scripts[1][1];
function section(start,end){const a=ui.indexOf(start),b=ui.indexOf(end,a);assert.ok(a>=0&&b>a);return ui.slice(a,b)}
// Exercise the actual presentation functions, without starting a browser or UI timers.
function fixture(){
 const ctx=vm.createContext({});vm.runInContext(scripts[0][1],ctx);
 vm.runInContext(`const M=SkillMarketModel,S=M.createState();let evalJob=null;
 ${section('const names=','let route=')}
 ${section('const runSteps=','let marketFile=')}
 ${section('const esc=','const notice=')}
 ${section('function evaluationContext(', 'function evaluationTableDetail(')}
 ${section('function latestOptimization(', 'function optimizationView(')}
 globalThis.presentation={M,S,context:evaluationContext,view:evaluationTableView,setJob:j=>evalJob=j};`,ctx);
 return ctx.presentation;
}
let count=0;function test(name,fn){fn();count++;console.log('PASS '+name)}
function finish(M,S,j){for(let n=0;j.state==='running'&&n<10;n++)M.stepOptimization(S,j.id)}

test('market renders one read-only table without private expectations or drafts',()=>{
 const {M,S,view}=fixture(),k=M.skill(S,'sales');k.suite[0].expected='PRIVATE_EXPECTATION';k.draftCases.push({id:'PRIVATE_DRAFT',title:'PRIVATE_TITLE'});
 const out=view(k,null,true);assert.equal((out.match(/<table /g)||[]).length,1);assert.match(out,/验证场景/);assert.match(out,/检查人 林舟/);
 assert.doesNotMatch(out,/PRIVATE_|case-edit|case-delete|case-confirm|table-run|opt-open/);
});
test('market never falls back to a local report when the public report is missing',()=>{
 const {M,S,view}=fixture(),k=M.skill(S,'weekly');M.evaluate(S,k.id,'passed');
 const out=view(k,null,true);assert.match(out,/未测评/);assert.doesNotMatch(out,/周报助手基本输出|1 \/ 1 个必跑/);
});
test('drafts are inline and do not inflate the checked denominator',()=>{
 const {M,S,view}=fixture(),k=M.skill(S,'weekly');M.evaluate(S,k.id,'passed');M.generateCaseDraft(S,k.id,M.caseStamp(k));
 const out=view(k);assert.match(out,/eval-draft/);assert.match(out,/核对并确认/);assert.match(out,/1 \/ 1 个必跑/);assert.match(out,/data-action="case-delete"/);
});
test('published rows retain disabled deletion; collaborators can run locally but not manage standards',()=>{
 const {M,S,view}=fixture(),k=M.skill(S,'sales');assert.match(view(k),/data-action="case-delete" data-id="active:TC-01" disabled/);
 S.user='chen';assert.doesNotMatch(view(k),/case-edit|case-delete|case-confirm|data-action="publish"/);assert.match(view(k),/table-run/);assert.match(view(k),/本地测评与改进/);
});
test('running and changed candidates do not advertise the previous report as current',()=>{
 const {M,S,context,view}=fixture(),k=M.skill(S,'weekly'),p=M.prepareOptimization(S,k.id),j=M.startOptimization(S,p.id);
 assert.equal(context(k).current,false);assert.match(view(k),/停止检查/);
 M.stepOptimization(S,j.id);M.stepOptimization(S,j.id);assert.equal(context(k).pendingCandidate,true);assert.equal(context(k).current,false);assert.doesNotMatch(view(k),/1 \/ 1 个必跑场景符合预期/);
 finish(M,S,j);assert.equal(context(k).current,true);assert.match(view(k),/查看并采用结果/);assert.match(view(k),/本轮复测通过/);
 M.adoptOptimization(S,j.id);assert.match(view(k),/预览并确认发布/);
});
test('local changes visibly invalidate old results',()=>{
 const {M,S,context,view}=fixture(),k=M.skill(S,'weekly');M.evaluate(S,k.id,'passed');k.files['SKILL.md']+='\nChanged';
 assert.equal(context(k).current,false);assert.match(view(k),/已失效/);assert.doesNotMatch(view(k),/1 \/ 1 个必跑场景符合预期/);
});
test('manual progress and exceptional conclusions remain distinct',()=>{
 const {M,S,context,view,setJob}=fixture(),k=M.skill(S,'weekly');M.evaluate(S,k.id,'passed');setJob({skillId:k.id,prId:null,phase:4,initiatedBy:S.user});
 assert.equal(context(k).current,false);assert.match(view(k),/独立 AI 评审/);assert.match(view(k),/eval-cancel/);setJob(null);
 for(const [mode,label] of [['error','异常'],['static-blocked','失败']]){M.evaluate(S,k.id,mode);assert.match(view(k),new RegExp(label));assert.doesNotMatch(view(k),/预览发布<\/button>/)}
});
test('contributions reuse the table without local case management or optimization',()=>{
 const {M,S,view}=fixture(),p=S.prs[0],k=M.skill(S,p.skillId);S.user=k.owner;
 const out=view(k,p);assert.equal((out.match(/<table /g)||[]).length,1);assert.match(out,/运行检查/);assert.doesNotMatch(out,/case-edit|case-delete|case-confirm|opt-open/);
});
test('evaluation actions are flat and only scene creation uses a dropdown',()=>{
 const {M,S,view,setJob}=fixture(),k=M.skill(S,'weekly');
 const out=view(k),toolbar=out.slice(out.indexOf('class="eval-toolbar"'),out.indexOf('class="eval-summary"'));
 assert.doesNotMatch(toolbar,/更多操作|只检查|eval-more/);
 assert.match(toolbar,/data-action="table-run"[^>]*>运行全部<\/button>/);
 assert.match(toolbar,/<summary class="button">添加验证场景/);
 const menu=toolbar.match(/<details class="eval-add">([\s\S]*?)<\/details>/)[1];
 assert.equal((menu.match(/<button /g)||[]).length,2);
 assert.match(menu,/data-action="case-generate"[^>]*>AI准备场景<\/button>/);
 assert.match(menu,/data-action="case-new"[^>]*>添加场景<\/button>/);
 assert.doesNotMatch(menu,/table-run|opt-open|publish/);
 setJob({skillId:k.id,prId:null,phase:0,initiatedBy:S.user});
 const running=view(k);assert.doesNotMatch(running,/<details class="eval-add">/);
 assert.match(running,/data-action="case-new"[^>]*disabled>添加验证场景/);
 assert.match(running,/data-action="table-run"[^>]*disabled>运行全部/);
});
test('private expectation text is escaped in table cells',()=>{
 const {M,S,view}=fixture(),k=M.skill(S,'weekly');k.suite[0].expected='<img src=x onerror=alert(1)>';
 const out=view(k);assert.match(out,/&lt;img/);assert.doesNotMatch(out,/<img/);
});
test('autonomous exploration and final acceptance share one table without inflating fixed counts',()=>{
 const {M,S,view}=fixture(),k=M.skill(S,'weekly'),j=M.startOptimization(S,M.prepareOptimization(S,k.id).id);finish(M,S,j);
 const out=view(k);assert.equal((out.match(/<table /g)||[]).length,1);assert.match(out,/AI 探索 · 不计发布验收/);assert.match(out,/独立验收/);assert.match(out,/1 \/ 1 个必跑场景/);assert.match(out,/关键场景重复运行/);
});
test('acceptance failure cannot expose the adopt action despite passing fixed cases',()=>{
 const {M,S,view}=fixture(),k=M.skill(S,'weekly'),j=M.startOptimization(S,M.prepareOptimization(S,k.id).id,{scenario:'unstable'});finish(M,S,j);
 const out=view(k);assert.match(out,/独立验收未通过/);assert.doesNotMatch(out,/data-action="opt-review"/);
});
test('published automatic acceptance exposes only sanitized conclusions',()=>{
 const {M,S,view}=fixture(),k=M.skill(S,'weekly'),j=M.startOptimization(S,M.prepareOptimization(S,k.id).id);finish(M,S,j);M.adoptOptimization(S,j.id);M.publish(S,k.id);
 const publicReport=M.publishedReport(S,k.id);assert.equal(publicReport.autoAcceptance.status,'passed');assert.equal(publicReport.autoAcceptance.checks.length,3);
 const out=view(k,null,true);assert.match(out,/独立验收/);assert.doesNotMatch(out,/AI 探索|opt-explore|补充为验收标准/);assert.doesNotMatch(JSON.stringify(publicReport.autoAcceptance),/input|evidence|expected|report/);
});
test('non-owner local results and adoption lead to contribution, never publication',()=>{
 const {M,S,view}=fixture(),k=M.skill(S,'sql');M.evaluateLocal(S,k.id,'passed');let out=view(k);assert.match(out,/本地结果 · 不用于发布/);assert.match(out,/1 \/ 1 个必跑/);assert.doesNotMatch(out,/data-action="publish"|case-edit|case-confirm/);
 const j=M.startOptimization(S,M.prepareOptimization(S,k.id).id);finish(M,S,j);out=view(k);assert.match(out,/本地复核/);assert.match(out,/查看并采用结果/);M.adoptOptimization(S,j.id);out=view(k);assert.match(out,/data-action="contribute"/);assert.doesNotMatch(out,/data-action="publish"/);
});
test('owner private cases and drafts never appear in another local user table',()=>{
 const {M,S,view}=fixture(),k=M.skill(S,'sql');k.suite[0].localVisible=false;k.suite[0].expected='PRIVATE_EXPECTED';k.draftCases=[{id:'PRIVATE_DRAFT',title:'SECRET_TITLE'}];assert.doesNotMatch(view(k),/PRIVATE|SECRET_TITLE/);
});
test('read-only local members have no evaluation start or adoption actions',()=>{
 const {M,S,view}=fixture(),k=M.skill(S,'sql');k.editorIds=['zhou'];const out=view(k);assert.match(out,/没有本地编辑权限/);assert.doesNotMatch(out,/opt-open|table-run|opt-review/);
});
test('local case controls apply only to personal rows, while shared rows stay readonly',()=>{
 const {M,S,view}=fixture(),k=M.skill(S,'sql'),work=M.caseTarget(S,k.id),d=M.saveUserCaseDraft(S,k.id,null,{title:'我的场景',input:'本地输入',expected:'本地预期',required:true},M.caseStamp(work));
 assert.match(view(k),/核对并确认/);M.confirmUserCaseDraft(S,k.id,d.id,M.caseStamp(work));const out=view(k);assert.match(out,/我的本地用例/);assert.match(out,/负责人共享 · 只读/);assert.match(out,/data-action="case-new"/);assert.doesNotMatch(out,/data-action="case-edit" data-id="active:TC-01"/);assert.match(out,new RegExp('data-action="case-edit" data-id="active:'+d.id+'"'));
});
console.log(`\n${count} evaluation table checks passed. Presentation and simulation only.`);
