import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const scripts=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
scripts.forEach(s=>new vm.Script(s[1]));
const ui=scripts[1][1];
function section(start,end){const a=ui.indexOf(start),b=ui.indexOf(end,a);assert.ok(a>=0&&b>a);return ui.slice(a,b)}
function fixture(){
 const ctx=vm.createContext({});vm.runInContext(scripts[0][1],ctx);
 vm.runInContext('const M=SkillMarketModel,S=M.createState();'+section('const names=','let route=')+
 section('const esc=','const notice=')+'const notice=(x)=>x;'+
 section('function evaluationContext(', 'function evaluationTableDetail(')+
 'globalThis.presentation={M,S,context:evaluationContext,view:evaluationTableView};',ctx);
 return ctx.presentation;
}
let count=0;function test(name,fn){fn();count++;console.log('PASS '+name)}
function finish(M,S,k){const j=M.fileEvaluation(S,k);for(let n=0;j.state==='running'&&n<200;n++)M.stepFileEvaluation(S,k.id);assert.notEqual(j.state,'running');return j}
const fields={prompt:'汇总订单并生成报告',expected_output:'报告包含退款口径且文件可读取',files:[],expectations:['报告可读取']};

test('every seeded Skill has evals/evals.json matching creator schema',()=>{
 const {M,S}=fixture();for(const k of S.skills){const d=M.readEval(k);assert.equal(d.skill_name,k.name);for(const c of d.evals){assert.ok(Number.isInteger(c.id));assert.ok(c.prompt&&c.expected_output);assert.equal(c.status,undefined)}}
});
test('manual and AI additions write the same file immediately without drafts',()=>{
 const {M,S}=fixture(),k=M.skill(S,'weekly'),count=M.readEval(k).evals.length;
 const c=M.writeEvalCase(S,k.id,fields);M.generateEvalCase(S,k.id);
 assert.equal(M.readEval(k).evals.length,count+2);assert.equal(k.draftCases.length,0);assert.equal(c.id,count+1);
 assert.equal(M.readEval(k).evals.at(-2).expected_output,fields.expected_output);
});
test('invalid schemas, forged fields, IDs and paths never mutate the file',()=>{
 const {M,S}=fixture(),k=M.skill(S,'weekly'),before=k.files['evals/evals.json'];
 for(const bad of [{...fields,prompt:''},{...fields,status:'passed'},{...fields,id:9},{...fields,files:['../secret']},{...fields,files:['evals/evals.json']},{...fields,files:['missing.txt']},{...fields,expectations:[1]}])assert.throws(()=>M.writeEvalCase(S,k.id,bad));
 assert.equal(k.files['evals/evals.json'],before);
 const d=M.readEval(k);d.evals.push({...d.evals[0]});assert.throws(()=>M.readEval(k,{...k.files,'evals/evals.json':JSON.stringify(d)}));
});
test('published IDs cannot be deleted via table or source file saves',()=>{
 const {M,S}=fixture(),k=M.skill(S,'sales');
 assert.throws(()=>M.deleteEvalCase(S,k.id,1),/永久不可删除/);
 assert.throws(()=>M.save(S,k.id,{...k.files,'evals/evals.json':JSON.stringify({skill_name:k.name,evals:[]})}),/永久不可删除/);
 const files={...k.files};delete files['evals/evals.json'];assert.throws(()=>M.save(S,k.id,files),/evals\/evals\.json/);
});
test('non-owner local copy holds all imported and personal cases in one file',()=>{
 const {M,S}=fixture(),k=M.skill(S,'sql'),original=k.files['evals/evals.json'];M.writeEvalCase(S,k.id,fields);
 const w=M.localState(S,k);assert.equal(k.files['evals/evals.json'],original);assert.equal(M.readEval(k,w.files).evals.length,M.readEval(k).evals.length+1);
});
test('conversation save uses root schema and deduplicates the same invocation',()=>{
 const {M,S}=fixture(),k=M.skill(S,'weekly'),inv={id:'inv-test',skillId:k.id,query:'生成周报',output:'周报含进展与风险',hasArtifact:true};
 const a=M.saveInvocationEval(S,k.id,inv),b=M.saveInvocationEval(S,k.id,inv);assert.equal(a.id,b.id);assert.match(a.expected_output,/进展与风险/);assert.equal(k.draftCases.length,0);
 assert.throws(()=>M.saveInvocationEval(S,k.id,{...inv,query:''}));
});
test('run all is serial, continues business failures and does not write Skill',()=>{
 const {M,S}=fixture(),k=M.skill(S,'sales'),files=M.canonical(k.files),j=M.startFileEvaluation(S,k.id);
 for(let i=0;i<j.caseSnapshot.length;i++){M.stepFileEvaluation(S,k.id);assert.equal(j.before.length,i+1)}
 assert.equal(j.state,'completed');assert.equal(j.before[0].status,'failed');assert.equal(j.before.at(-1).status,'passed');assert.equal(M.canonical(k.files),files);
 assert.equal(j.after.length,0);assert.deepEqual(Array.from(j.trace,x=>x.caseId),Array.from(j.caseSnapshot,x=>x.id));
});
test('optimization runs every before case then writes then every after case',()=>{
 const {M,S,view}=fixture(),k=M.skill(S,'sales'),files=M.canonical(k.files),evalFile=k.files['evals/evals.json'],j=M.startFileEvaluation(S,k.id,true);
 for(let i=0;i<j.caseSnapshot.length;i++){M.stepFileEvaluation(S,k.id);assert.equal(M.canonical(k.files),files)}
 assert.equal(j.phase,'optimize');M.stepFileEvaluation(S,k.id);assert.equal(j.written,true);assert.notEqual(M.canonical(k.files),files);assert.equal(k.files['evals/evals.json'],evalFile);
 finish(M,S,k);assert.equal(j.after.length,j.before.length);assert.ok(j.after.every(r=>r.status==='passed'));assert.notEqual(j.before[0].actual,j.after[0].actual);
 assert.deepEqual(Array.from(j.trace,x=>x.event),[...j.before.map(()=> 'case-complete'),'write',...j.after.map(()=> 'case-complete')]);
 const out=view(k);assert.match(out,/修改已保存/);assert.match(out,/优化前/);assert.match(out,/优化后/);assert.match(out,/file-eval-diff/);assert.doesNotMatch(out,/opt-adopt|查看并采用|确认改动/);
});
test('cancel after write and failed retest retain actual saved changes',()=>{
 for(const scenario of ['fails','error']){
  const {M,S}=fixture(),k=M.skill(S,'weekly'),before=M.canonical(k.files),j=M.startFileEvaluation(S,k.id,true,scenario);finish(M,S,k);
  assert.equal(j.written,true);assert.notEqual(M.canonical(k.files),before);assert.notEqual(j.after[0].status,'passed');assert.equal(M.releaseFileEligibility(S,k.id).allowed,false);
 }
 const {M,S}=fixture(),k=M.skill(S,'weekly'),j=M.startFileEvaluation(S,k.id,true);M.stepFileEvaluation(S,k.id);M.stepFileEvaluation(S,k.id);const saved=M.canonical(k.files);
 M.cancelFileEvaluation(S,k.id);assert.equal(M.canonical(k.files),saved);assert.equal(j.state,'cancelled');
});
test('no-change optimization still performs both complete runs',()=>{
 const {M,S}=fixture(),k=M.skill(S,'weekly'),before=M.canonical(k.files),j=M.startFileEvaluation(S,k.id,true,'passed');finish(M,S,k);
 assert.equal(j.noChange,true);assert.equal(M.canonical(k.files),before);assert.equal(j.before.length,j.after.length);
});
test('case edits blocked while running; external content change stops without overwrite',()=>{
 const {M,S}=fixture(),k=M.skill(S,'weekly'),j=M.startFileEvaluation(S,k.id,true);
 assert.throws(()=>M.writeEvalCase(S,k.id,fields),/运行中/);assert.throws(()=>M.save(S,k.id,k.files),/运行中/);
 k.files['SKILL.md']+='\nUser external edit';M.stepFileEvaluation(S,k.id);assert.equal(j.state,'stale');assert.equal(j.written,false);assert.match(k.files['SKILL.md'],/User external edit/);
});
test('case file changes invalidate report and details use frozen expectations',()=>{
 const {M,S,context,view}=fixture(),k=M.skill(S,'weekly');M.startFileEvaluation(S,k.id,false,'passed');finish(M,S,k);assert.equal(context(k).current,true);
 M.writeEvalCase(S,k.id,{...fields,expected_output:'changed'},1);assert.equal(context(k).current,false);assert.match(view(k),/已失效/);
 assert.match(section('function evaluationTableDetail(', 'function latestOptimization('),/caseSnapshot/);
});
test('zero cases, invalid manifest and read-only users cannot produce a passing release',()=>{
 const {M,S}=fixture(),k=M.skill(S,'weekly');k.published=false;k.protectedEvalIds=[];M.deleteEvalCase(S,k.id,1);assert.throws(()=>M.startFileEvaluation(S,k.id),/至少一个/);
 M.writeEvalCase(S,k.id,fields);k.files['SKILL.md']='bad';const j=M.startFileEvaluation(S,k.id);finish(M,S,k);assert.equal(j.state,'failed');assert.equal(j.before.length,0);
 k.editorIds=['zhou'];assert.throws(()=>M.startFileEvaluation(S,k.id),/权限/);
});
test('owner appoints admins; admins publish only after their own current full run',()=>{
 const {M,S}=fixture(),k=M.skill(S,'weekly');M.appointAdministrators(S,k.id,['chen'],M.managementStamp(k));S.user='chen';
 assert.equal(M.canRelease(S,k),true);assert.equal(M.releaseFileEligibility(S,k.id).allowed,false);
 assert.throws(()=>M.appointAdministrators(S,k.id,['zhou'],M.managementStamp(k)),/负责人/);
 M.startFileEvaluation(S,k.id,false,'passed');finish(M,S,k);assert.equal(M.releaseFileEligibility(S,k.id).allowed,true);M.publishFileEvaluation(S,k.id);
 assert.equal(k.marketFileReport.publishedBy,'chen');assert.equal(k.remoteFiles['evals/evals.json'],M.localState(S,k).files['evals/evals.json']);
});
test('skill admin needs non-author approval for merge; owner direct exception remains',()=>{
 const {M,S}=fixture(),k=M.skill(S,'sales'),p=S.prs[0];S.user='chen';assert.equal(M.canRelease(S,k),true);assert.equal(M.mergeEligibility(S,k.id,p.id).allowed,false);
 M.reviewContribution(S,p.id,'approve','',M.reviewStamp(p));assert.equal(M.mergeEligibility(S,k.id,p.id).allowed,true);
 M.mergeContribution(S,k.id,p.id);assert.equal(p.state,'merged');assert.equal(k.marketFileReport,undefined);
 S.user='admin';assert.equal(M.canRelease(S,k),false);
});
test('revoking admin invalidates an applicable report and an old management form',()=>{
 const {M,S}=fixture(),k=M.skill(S,'weekly');M.appointAdministrators(S,k.id,['chen'],M.managementStamp(k));S.user='chen';M.startFileEvaluation(S,k.id,false,'passed');finish(M,S,k);
 S.user='lin';const old=M.managementStamp(k);M.appointAdministrators(S,k.id,[],old);assert.throws(()=>M.appointAdministrators(S,k.id,['chen'],old));
 S.user='chen';assert.equal(M.releaseFileEligibility(S,k.id).allowed,false);
});
test('market table is readonly and no current report means untested',()=>{
 const {M,S,view}=fixture(),k=M.skill(S,'weekly');assert.match(view(k,null,true),/未测评/);
 const out=view(M.skill(S,'sales'),null,true);assert.equal((out.match(/<table /g)||[]).length,1);assert.doesNotMatch(out,/case-edit|case-delete|table-run|opt-open/);assert.match(out,/发布测评人 林舟/);
});
test('flat toolbar has exactly the two direct-save creation options and no adoption',()=>{
 const {M,S,view}=fixture(),out=view(M.skill(S,'weekly')),menu=out.match(/<details class="eval-add">([\s\S]*?)<\/details>/)[1];
 assert.equal((menu.match(/<button /g)||[]).length,2);assert.match(menu,/AI准备场景/);assert.match(menu,/添加场景/);assert.match(out,/运行全部/);assert.match(out,/自动优化/);assert.doesNotMatch(out,/case-confirm|opt-adopt|待确认草稿|待采用/);
});
test('contribution stays separate from evaluation and source scripts compile',()=>{
 const out=section('function prView(', 'function templatesView(');assert.match(out,/contributionDiffView/);assert.doesNotMatch(out,/evaluationTableView|table-run|opt-open/);
});
test('run and optimize stay on evaluation page without touching conversation state',()=>{
 const action=section("if(a==='table-run'||a==='opt-open'){","if(a==='file-eval-stop')");
 assert.match(action,/startFileEvaluation/);assert.match(action,/stepFileEvaluation/);assert.match(action,/detailTab='evaluation'/);
 assert.doesNotMatch(action,/route='chat'|selected=null|chatEval=|chatTemplateId=null|chatBoundSkillId=null/);
 const {M,S,view}=fixture(),k=M.skill(S,'sales');M.startFileEvaluation(S,k.id);
 const out=view(k);assert.match(out,/运行中/);
 assert.equal((out.match(/data-action="table-detail"/g)||[]).length,M.readEval(k).evals.length+1);
});
test('toolbar aligns three primary controls and only uses the canonical nested file',()=>{
 assert.match(html,/\.eval-toolbar\{display:flex;align-items:center;justify-content:flex-start/);
 const {M,S}=fixture();for(const k of S.skills){assert.ok(k.files['evals/evals.json']);assert.equal(k.files['eval.json'],undefined)}
});
test('full visible messages retain order, subagent output and both optimization runs',()=>{
 const {M,S}=fixture(),k=M.skill(S,'sales');M.startFileEvaluation(S,k.id,true);const j=finish(M,S,k);
 for(const r of [...j.before,...j.after]){assert.equal(r.messages[0].role,'user');assert.equal(r.messages[0].content,r.prompt);assert.ok(r.messages.some(m=>m.content===r.actual));assert.match(r.messages.at(-1).content,/使用范围/)}
 const sub=j.after.find(r=>/subagent/.test(r.prompt));assert.ok(sub.messages.some(m=>m.role==='subagent'&&m.messages.length));
});
test('conversation renderer shows full escaped content, nested tools and separate grading',()=>{
 const ctx=vm.createContext({});vm.runInContext(section('const names=','let route=')+section('const esc=','const notice=')+
 'const icon=()=>"";'+section('function markdown(','function discardBuffer(')+section('function evaluationOutputView(','function latestOptimization(')+'globalThis.view=evaluationOutputView;',ctx);
 const long='完整段落\n'.repeat(600)+'末尾输出 <script>alert(1)</script>';
 const out=ctx.view('优化前',{status:'failed',actual:'不可代替全部消息的摘要',messages:[{role:'assistant',content:long},{role:'subagent',name:'子任务',content:'执行完成',messages:[{role:'assistant',content:'子任务全部输出'}]}],artifacts:[{path:'result.md',text:'完整文件'}],reason:'独立判断说明'});
 assert.match(out,/chat-message assistant/);assert.match(out,/末尾输出 &lt;script&gt;/);assert.doesNotMatch(out,/<script>|不可代替全部消息的摘要/);assert.equal((out.match(/完整段落/g)||[]).length,600);assert.match(out,/子任务全部输出/);assert.match(out,/完整文件/);assert.match(out,/eval-verdict/);
 assert.match(ctx.view('实际输出',{status:'passed',reason:'通过'}),/原始输出未公开或未采集/);
 assert.match(ctx.view('实际输出',{actual:'---\nname: keep-output-header\n---\n正文'}),/keep-output-header/);
 assert.match(html,/\.eval-output-grid\.compare\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
});
test('manual case form examples are placeholders, not saved defaults or edited values',()=>{
 const {M,S}=fixture(),ctx=vm.createContext({M,S});
 vm.runInContext(section('const esc=','const notice=')+'let caseContext; const dirtyBuffer=()=>false; function showDialog(title,body){globalThis.body=body;}'+section('function caseDialog(','function snippetDialog(')+'caseDialog(M.skill(S,"sales"),null);',ctx);
 const fields=[...ctx.body.matchAll(/<textarea[^>]*placeholder="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)];
 assert.equal(fields.length,4);assert.ok(fields.every(x=>x[1].includes('例如')&&x[2]===''));assert.match(ctx.body,/&#10;/);assert.match(ctx.body,/无需文件时可留空/);
 vm.runInContext('caseDialog(M.skill(S,"sales"),1);',ctx);
 assert.ok(ctx.body.includes(M.readEval(M.skill(S,'sales')).evals[0].prompt));
});
console.log(count+' current file-backed evaluation checks passed. Offline simulation only.');
