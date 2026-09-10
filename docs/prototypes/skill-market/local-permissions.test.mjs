import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const scripts=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];scripts.forEach(s=>new vm.Script(s[1]));
const context=vm.createContext({});vm.runInContext(scripts[0][1],context);const M=context.SkillMarketModel;
let count=0;function test(name,fn){fn();count++;console.log('PASS '+name)}
function fixture(){const s=M.createState(),k=M.skill(s,'sql');return{s,k}}
function finish(s,j){for(let i=0;j.state==='running'&&i<12;i++)M.stepOptimization(s,j.id);assert.notEqual(j.state,'running')}
test('non-owner local evaluation preserves official report and stores actor-local evidence',()=>{
 const {s,k}=fixture();s.user='zhou';M.evaluate(s,k.id,'passed');const original=JSON.stringify(k.report);s.user='lin';
 const r=M.evaluateLocal(s,k.id,'passed');assert.equal(r.scope,'local');assert.equal(r.initiatedBy,'lin');assert.equal(r.ownerAtRun,'zhou');assert.equal(JSON.stringify(k.report),original);assert.equal(M.localState(s,k).report.scope,'local');assert.equal(M.eligible(s,k.id).allowed,false);
 s.user='chen';assert.equal(M.localState(s,k).report,null);
});
test('non-owner optimization adopts only personal content and never publishes',()=>{
 const {s,k}=fixture(),original=M.canonical(k.files),market=M.canonical(k.remoteFiles),suite=M.suiteKey(k),remoteAt=k.remoteAt,imported=k.importedRemoteAt;
 const j=M.startOptimization(s,M.prepareOptimization(s,k.id).id);assert.equal(j.scope,'local');assert.equal(k.optimizationPending,undefined);finish(s,j);assert.equal(j.state,'ready');M.adoptOptimization(s,j.id);
 assert.notEqual(M.canonical(M.localState(s,k).files),original);assert.equal(M.canonical(k.files),original);assert.equal(M.canonical(k.remoteFiles),market);assert.equal(M.suiteKey(k),suite);assert.equal(k.report,null);assert.equal(k.remoteAt,remoteAt);assert.equal(k.importedRemoteAt,imported);assert.equal(s.events.length,0);assert.throws(()=>M.publish(s,k.id),/负责人/);
 s.user='zhou';assert.equal(M.canonical(M.localState(s,k).files),original);assert.equal(k.report,null);
});
test('contribution contains the personal candidate but requires fresh owner evaluation',()=>{
 const {s,k}=fixture(),j=M.startOptimization(s,M.prepareOptimization(s,k.id).id);finish(s,j);M.adoptOptimization(s,j.id);
 const p=M.contribute(s,k.id,'本地优化贡献','请负责人验收');assert.equal(M.canonical(p.files),M.canonical(j.files));assert.equal(p.report,null);
 s.user='zhou';assert.equal(M.eligible(s,k.id,p.id).allowed,false);M.evaluate(s,k.id,'passed',p.id);assert.equal(M.eligible(s,k.id,p.id).allowed,true);
});
test('local reports cannot become formal by copying or transferring ownership',()=>{
 const {s,k}=fixture(),r=M.evaluateLocal(s,k.id,'passed');s.user='zhou';k.report={...M.clone(r),initiatedBy:'zhou',ownerAtRun:'zhou'};
 assert.ok(M.eligible(s,k.id).reasons.some(x=>x.includes('本地测评')));k.marketReport={...k.report,publishedRemoteAt:k.remoteAt,publishedBy:'zhou'};assert.equal(M.publishedReport(s,k.id),null);
 M.transferOwner(s,k.id,'lin',false,M.managementStamp(k));s.user='lin';assert.equal(M.eligible(s,k.id).allowed,false);
});
test('local save and market sync cannot overwrite owner files or imported timestamp',()=>{
 const {s,k}=fixture(),original=M.canonical(k.files),remote=k.importedRemoteAt,files=M.clone(k.files);files['SKILL.md']+='\nMY_LOCAL_NOTE';M.save(s,k.id,files);
 assert.equal(M.canonical(k.files),original);assert.equal(M.canonical(M.localState(s,k).files),M.canonical(files));
 k.remoteAt='2026-09-11T00:00:00Z';assert.throws(()=>M.sync(s,k.id,false),/本地修改/);M.sync(s,k.id,true);assert.equal(k.importedRemoteAt,remote);assert.equal(M.localState(s,k).importedRemoteAt,k.remoteAt);assert.equal(M.canonical(k.files),original);
});
test('local editing and membership are checked at start, progress and adoption',()=>{
 const {s,k}=fixture();k.editorIds=['zhou'];assert.throws(()=>M.prepareOptimization(s,k.id),/编辑权限/);assert.throws(()=>M.evaluateLocal(s,k.id,'passed'),/权限/);assert.throws(()=>M.save(s,k.id,k.files),/权限/);
 k.editorIds=['lin','zhou'];const j=M.startOptimization(s,M.prepareOptimization(s,k.id).id);k.editorIds=['zhou'];M.stepOptimization(s,j.id);assert.equal(j.state,'stale');
 const f=fixture(),ready=M.startOptimization(f.s,M.prepareOptimization(f.s,f.k.id).id);finish(f.s,ready);f.s.memberIds=f.s.memberIds.filter(x=>x!=='lin');assert.throws(()=>M.adoptOptimization(f.s,ready.id),/失效/);
});
test('local tasks remain attributed to initiator across persona switching',()=>{
 const {s,k}=fixture(),j=M.startOptimization(s,M.prepareOptimization(s,k.id).id);s.user='chen';finish(s,j);assert.equal(j.report.initiatedBy,'lin');assert.equal(j.scope,'local');assert.throws(()=>M.adoptOptimization(s,j.id),/无权/);s.user='lin';M.adoptOptimization(s,j.id);assert.equal(M.localState(s,k).report.initiatedBy,'lin');
});
test('private owner cases and drafts are excluded from local evaluation and optimization',()=>{
 const {s,k}=fixture();k.suite[0].localVisible=false;k.draftCases=[{id:'PRIVATE',origin:'ai',expected:'PRIVATE_EXPECTED'}];
 const p=M.prepareOptimization(s,k.id);assert.equal(p.cases.length,0);assert.ok(p.exploration.every(c=>c.expected!=='PRIVATE_EXPECTED'));
 const j=M.startOptimization(s,p.id);finish(s,j);assert.equal(j.state,'needs-input');assert.equal(j.report.results.length,0);assert.throws(()=>M.adoptOptimization(s,j.id));
});
test('local reports and candidates are scoped by tenant and workspace',()=>{
 const {s,k}=fixture(),j=M.startOptimization(s,M.prepareOptimization(s,k.id).id);finish(s,j);M.adoptOptimization(s,j.id);
 s.workspaceId='other';assert.equal(M.localState(s,k).report,null);assert.throws(()=>M.optimizationJob(s,j.id),/无权/);s.workspaceId='workspace-demo';s.tenantId='other';assert.equal(M.localState(s,k).report,null);
});
test('contributors cannot change fixed cases or management after local success',()=>{
 const {s,k}=fixture();M.evaluateLocal(s,k.id,'passed');assert.throws(()=>M.generateCaseDraft(s,k.id,M.caseStamp(k)),/负责人/);assert.throws(()=>M.deleteCase(s,k.id,k.suite[0].id,'active',M.caseStamp(k)),/负责人/);assert.throws(()=>M.transferOwner(s,k.id,'lin',false,M.managementStamp(k)),/负责人/);
});
test('local author can create, confirm, edit and delete a personal case',()=>{
 const {s,k}=fixture(),formal=M.suiteKey(k),work=M.caseTarget(s,k.id),fields={title:'我的 SQL 场景',input:'检查一条测试查询',expected:'解释风险，不执行查询',required:true};
 const draft=M.saveUserCaseDraft(s,k.id,null,fields,M.caseStamp(work));assert.equal(draft.scope,'local');assert.match(draft.id,/LOCAL-lin-/);assert.equal(work.suite.length,0);
 M.confirmUserCaseDraft(s,k.id,draft.id,M.caseStamp(work));assert.equal(M.suiteKey(k),formal);assert.equal(work.suite.length,1);assert.ok(M.evaluationSuite(s,k).some(c=>c.id===draft.id));
 const r=M.evaluateLocal(s,k.id,'passed');assert.equal(r.results.length,2);
 M.saveUserCaseDraft(s,k.id,draft.id,{...fields,expected:'禁止执行查询，并给出替代建议'},M.caseStamp(work));M.confirmUserCaseDraft(s,k.id,draft.id,M.caseStamp(work));assert.notEqual(r.suite,M.evaluationSuiteKey(s,k));
 M.deleteUserCase(s,k.id,draft.id,'active',M.caseStamp(work));assert.equal(work.suite.length,0);assert.equal(M.suiteKey(k),formal);
});
test('local case API cannot edit or delete shared owner cases',()=>{
 const {s,k}=fixture(),work=M.caseTarget(s,k.id),original=M.suiteKey(k),c=k.suite[0];
 assert.throws(()=>M.saveUserCaseDraft(s,k.id,c.id,{title:c.title,input:c.input,expected:'弱化',required:true},M.caseStamp(work)),/不存在/);
 assert.throws(()=>M.deleteUserCase(s,k.id,c.id,'active',M.caseStamp(work)),/不存在/);assert.equal(M.suiteKey(k),original);
});
test('personal AI drafts and active cases remain private to the local author',()=>{
 const {s,k}=fixture(),work=M.caseTarget(s,k.id),d=M.generateUserCaseDraft(s,k.id,M.caseStamp(work));const p=M.prepareOptimization(s,k.id);assert.ok(p.exploration.some(c=>c.sourceId===d.id));
 M.confirmUserCaseDraft(s,k.id,d.id,M.caseStamp(work));s.user='chen';assert.equal(M.caseTarget(s,k.id).suite.length,0);assert.ok(!M.evaluationSuite(s,k).some(c=>c.id===d.id));assert.throws(()=>M.deleteUserCase(s,k.id,d.id,'active',M.caseStamp(M.caseTarget(s,k.id))),/不存在/);
});
test('personal cases can drive optimization without producing formal publication cases',()=>{
 const {s,k}=fixture();k.suite[0].localVisible=false;const work=M.caseTarget(s,k.id),d=M.saveUserCaseDraft(s,k.id,null,{title:'个人要求',input:'测试输入',expected:'符合我的交付要求',required:true},M.caseStamp(work));M.confirmUserCaseDraft(s,k.id,d.id,M.caseStamp(work));
 const j=M.startOptimization(s,M.prepareOptimization(s,k.id).id);finish(s,j);assert.equal(j.state,'ready');M.adoptOptimization(s,j.id);assert.equal(M.localState(s,k).report.scope,'local');assert.equal(k.suite.length,1);assert.ok(!k.protectedCaseIds.includes(d.id));assert.equal(M.eligible(s,k.id).allowed,false);
});
console.log(`\n${count} local permission checks passed. Prototype only.`);
