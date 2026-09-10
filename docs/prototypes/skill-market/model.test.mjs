import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
scripts.forEach((s) => new vm.Script(s[1]));
const context = vm.createContext({});
vm.runInContext(scripts[0][1], context);
const M = context.SkillMarketModel;
let count = 0;
function test(name, fn) {
  fn();
  count += 1;
  console.log(`PASS ${name}`);
}
test('local edit time does not hide a remote update', () => {
  const s=M.createState(), k=M.skill(s,'sales');
  assert.ok(Date.parse(k.localEditedAt)>Date.parse(k.remoteAt));
  assert.equal(M.updateState(k),'update_available');
});
test('save and evaluation preserve imported remote timestamp', () => {
  const s=M.createState(), k=M.skill(s,'sales'), time=k.importedRemoteAt;
  M.save(s,k.id,{...k.files,'SKILL.md':k.files['SKILL.md']+'\nExtra'});
  M.evaluate(s,k.id,'passed');
  assert.equal(k.importedRemoteAt,time);
  assert.equal(M.updateState(k),'update_available');
});
test('dirty sync needs confirmation; success updates files and baseline together', () => {
  const s=M.createState(), k=M.skill(s,'sales'), old=M.canonical(k.files);
  assert.throws(()=>M.sync(s,k.id,false),/本地修改/);
  assert.equal(M.canonical(k.files),old);
  M.sync(s,k.id,true);
  assert.equal(k.importedRemoteAt,k.remoteAt);
  assert.equal(M.modified(k),false);
  assert.equal(M.updateState(k),'up_to_date');
});
test('missing, invalid, reversed and missing-source timestamps stay distinct', () => {
  const s=M.createState(), k=M.skill(s,'sales');
  k.importedRemoteAt=null; assert.equal(M.updateState(k),'unknown');
  k.importedRemoteAt='invalid'; assert.equal(M.updateState(k),'unknown');
  k.importedRemoteAt='2099-01-01T00:00:00Z'; assert.equal(M.updateState(k),'remote_time_anomaly');
  k.published=false; assert.equal(M.updateState(k),'remote_missing');
  assert.equal(M.updateState(M.skill(s,'local')),'not_applicable');
});
test('owner cannot publish without a passing current evaluation', () => {
  const s=M.createState();
  assert.equal(M.eligible(s,'weekly').allowed,false);
  assert.throws(()=>M.publish(s,'weekly'),/测评/);
  M.evaluate(s,'weekly','passed');
  assert.equal(M.eligible(s,'weekly').allowed,true);
});
test('collaborator and standalone admin cannot publish or merge', () => {
  const s=M.createState(); M.evaluate(s,'sales','passed','PR-028');
  for(const user of ['chen','admin','zhou']) {
    s.user=user;
    assert.throws(()=>M.publish(s,'sales','PR-028'),/负责人/);
  }
});
test('owner may merge without collaborator approval; local working copy is preserved', () => {
  const s=M.createState(), k=M.skill(s,'sales'), local=M.canonical(k.files),time=k.importedRemoteAt;
  M.evaluate(s,'sales','passed','PR-028'); M.publish(s,'sales','PR-028');
  assert.equal(s.prs.find(p=>p.id==='PR-028').state,'merged');
  assert.equal(M.canonical(k.files),local); assert.equal(k.importedRemoteAt,time);
});
test('static block, failed and error cases block publishing', () => {
  const s=M.createState();M.sync(s,'sales',true);
  for(const mode of ['static-blocked','failed','error']) {
    const r=M.evaluate(s,'sales',mode);
    assert.equal(M.eligible(s,'sales').allowed,false);
    if(mode==='static-blocked')assert.ok(r.results.every(c=>c.status==='not_run'));
  }
});
test('latest failure supersedes an earlier pass', () => {
  const s=M.createState();M.evaluate(s,'weekly','passed');M.evaluate(s,'weekly','failed');
  assert.equal(M.eligible(s,'weekly').allowed,false);
});
test('content, suite or remote-target changes invalidate the gate', () => {
  for(const change of ['content','suite','remote']) {
    const s=M.createState(),k=M.skill(s,'weekly');M.evaluate(s,k.id,'passed');
    if(change==='content')k.files['SKILL.md']+='\nnew';
    if(change==='suite')k.suite[0].expected+='new';
    if(change==='remote')k.remoteAt='2099-01-01T00:00:00Z';
    assert.equal(M.eligible(s,k.id).allowed,false);
  }
});
test('empty or all optional test suites cannot publish', () => {
  const s=M.createState(),k=M.skill(s,'weekly');
  k.suite=[];M.evaluate(s,k.id,'passed');assert.equal(M.eligible(s,k.id).allowed,false);
  k.suite=M.makeCases();k.suite.forEach(c=>c.required=false);M.evaluate(s,k.id,'passed');
  assert.equal(M.eligible(s,k.id).allowed,false);
});
test('case confirmation is owner-only and cannot accept empty input', () => {
  const s=M.createState(),k=M.skill(s,'sales'),c=M.generateCaseDraft(s,k.id,M.caseStamp(k));s.user='chen';
  assert.throws(()=>M.confirmCaseDraft(s,k.id,c.id,M.caseStamp(k)),/负责人/);
  s.user='lin';assert.throws(()=>M.saveCaseDraft(s,k.id,null,{title:'test',input:'',expected:'x',required:true},M.caseStamp(k)),/不能为空/);
});
test('received includes every collaborated skill request; views can overlap', () => {
  const s=M.createState();s.user='chen';
  assert.equal(M.visiblePrs(s,'received').length,3);
  assert.equal(M.visiblePrs(s,'sent').length,1);
  assert.ok(M.visiblePrs(s,'received').some(p=>p.id===M.visiblePrs(s,'sent')[0].id));
});
test('contributions freeze files and never publish on submit', () => {
  const s=M.createState();s.user='chen';M.sync(s,'sales',true);
  const k=M.skill(s,'sales'),time=k.remoteAt,p=M.contribute(s,k.id,'Test','Reason');
  M.save(s,k.id,{...k.files,'SKILL.md':'later edit'});
  assert.notEqual(p.files['SKILL.md'],k.files['SKILL.md']);assert.equal(k.remoteAt,time);
});
test('snippets are admin-only and changes cannot propagate into copied text', () => {
  const s=M.createState(),k=M.skill(s,'sales'),sn=s.snippets[0];
  assert.throws(()=>M.snippetWrite(s,{...sn,title:'changed'}),/系统管理员/);
  k.files['SKILL.md']+=sn.content;const copied=M.canonical(k.files);
  s.user='admin';M.snippetWrite(s,{...sn,content:'changed'});M.snippetDelete(s,sn.id);
  assert.equal(M.canonical(k.files),copied);
});
test('confirmed unpublish can be followed by fresh owner evaluation and republish', () => {
  const s=M.createState(),k=M.skill(s,'weekly');k.published=false;
  M.evaluate(s,k.id,'passed');assert.equal(M.eligible(s,k.id).allowed,true);
  M.publish(s,k.id);assert.equal(k.published,true);
});
test('a collaborator pass cannot replace the current owner evaluation', () => {
  const s=M.createState();s.user='chen';M.evaluate(s,'weekly','passed');
  s.user='lin';assert.equal(M.eligible(s,'weekly').allowed,false);
  assert.throws(()=>M.publish(s,'weekly'),/负责人运行测评/);
  M.evaluate(s,'weekly','passed');assert.equal(M.eligible(s,'weekly').allowed,true);
});
test('owner replacement invalidates an earlier owner run for publication', () => {
  const s=M.createState(),k=M.skill(s,'weekly');M.evaluate(s,k.id,'passed');
  k.owner='chen';s.user='chen';assert.equal(M.eligible(s,k.id).allowed,false);
});
test('run initiator is captured at start rather than read after identity switching', () => {
  const s=M.createState(),initiator=s.user;s.user='chen';
  const r=M.evaluate(s,'weekly','passed',null,initiator);
  assert.equal(r.initiatedBy,'lin');s.user='lin';assert.equal(M.eligible(s,'weekly').allowed,true);
});
test('published reports are bound to remote content and exclude private case data', () => {
  const s=M.createState(),k=M.skill(s,'weekly');M.evaluate(s,k.id,'passed');
  assert.equal(M.publishedReport(s,k.id),null);M.publish(s,k.id);
  const publicReport=M.publishedReport(s,k.id);
  assert.equal(publicReport.initiatedBy,'lin');assert.equal(publicReport.results[0].status,'passed');
  for(const key of ['input','expected','fixtures','content','suite'])assert.ok(!(key in publicReport));
  assert.ok(!('input' in publicReport.results[0]));assert.ok(!('expected' in publicReport.results[0]));
  const published=JSON.stringify(publicReport);
  M.save(s,k.id,{...k.files,'SKILL.md':k.files['SKILL.md']+'\nprivate edit'});M.evaluate(s,k.id,'failed');
  assert.equal(JSON.stringify(M.publishedReport(s,k.id)),published);
  k.remoteAt='2099-01-01T00:00:00Z';assert.equal(M.publishedReport(s,k.id),null);
});
test('PR merge attaches exactly the owner-run submitted report to the market', () => {
  const s=M.createState(),p=s.prs.find(p=>p.id==='PR-028');
  M.evaluate(s,'sales','passed',p.id);const id=p.report.id;
  M.publish(s,'sales',p.id);assert.equal(M.publishedReport(s,'sales').id,id);
  assert.equal(M.skill(s,'sales').marketReport.content,M.canonical(p.files));
});
test('example market report is independent of the dirty local working copy', () => {
  const s=M.createState(),k=M.skill(s,'sales');
  assert.equal(k.report,null);assert.equal(M.publishedReport(s,k.id).id,'EVAL-DEMO-001');
  assert.notEqual(M.canonical(k.files),k.marketReport.content);
});
test('only the current owner may change management, including against admin bypass', () => {
  const s=M.createState(),k=M.skill(s,'sales');
  for(const user of ['chen','zhou','admin']){
    s.user=user;const stamp=M.managementStamp(k);
    assert.throws(()=>M.updateManagement(s,k.id,{category:'文档协作'},stamp),/仅当前负责人/);
    assert.throws(()=>M.transferOwner(s,k.id,'zhou',false,stamp),/仅当前负责人/);
  }
});
test('helper and category edits preserve file content, timestamps and evaluation', () => {
  const s=M.createState(),k=M.skill(s,'weekly');M.evaluate(s,k.id,'passed');
  const before=JSON.stringify([k.files,k.remoteFiles,k.importedRemoteAt,k.remoteAt,k.localEditedAt,k.report]);
  M.updateManagement(s,k.id,{collaborators:['chen','zhou','chen'],category:'开发效率'},M.managementStamp(k));
  assert.equal(k.collaborators.join(','),'chen,zhou');assert.equal(k.category,'开发效率');
  assert.equal(JSON.stringify([k.files,k.remoteFiles,k.importedRemoteAt,k.remoteAt,k.localEditedAt,k.report]),before);
  assert.equal(M.eligible(s,k.id).allowed,true);
});
test('invalid members, owner-as-helper, category and forged owner fields are rejected', () => {
  const s=M.createState(),k=M.skill(s,'sales'),stamp=M.managementStamp(k);
  for(const changes of [{collaborators:['outside-tenant']},{collaborators:['lin']},{category:'missing'},{owner:'zhou'}]){
    assert.throws(()=>M.updateManagement(s,k.id,changes,stamp));
    assert.equal(M.managementStamp(k),stamp);
  }
  assert.throws(()=>M.transferOwner(s,k.id,'outside-tenant',false,stamp));
  assert.throws(()=>M.transferOwner(s,k.id,'lin',false,stamp));
});
test('stale management forms cannot overwrite newer changes', () => {
  const s=M.createState(),k=M.skill(s,'sales'),stamp=M.managementStamp(k);
  M.updateManagement(s,k.id,{category:'文档协作'},stamp);
  assert.throws(()=>M.updateManagement(s,k.id,{collaborators:[]},stamp),/已变化/);
  assert.throws(()=>M.transferOwner(s,k.id,'chen',false,stamp),/已变化/);
  assert.equal(k.owner,'lin');assert.equal(k.collaborators.join(','),'chen');
});
test('transfer removes the new owner from helpers and immediately revokes former owner', () => {
  const s=M.createState(),k=M.skill(s,'sales');
  M.transferOwner(s,k.id,'chen',false,M.managementStamp(k));
  assert.equal(k.owner,'chen');assert.equal(k.collaborators.length,0);
  assert.equal(M.owner(s,k),false);assert.equal(M.collaborator(s,k),false);
  assert.throws(()=>M.updateManagement(s,k.id,{category:'开发效率'},M.managementStamp(k)),/仅当前负责人/);
  assert.throws(()=>M.publish(s,k.id),/负责人/);
  s.user='chen';assert.equal(M.owner(s,k),true);
});
test('keeping the former owner as helper grants review visibility but not publication', () => {
  const s=M.createState(),k=M.skill(s,'sales');
  M.transferOwner(s,k.id,'chen',true,M.managementStamp(k));
  assert.equal(k.collaborators.join(','),'lin');assert.equal(M.collaborator(s,k),true);
  assert.equal(M.visiblePrs(s,'received').filter(p=>p.skillId===k.id).length,2);
  assert.equal(M.eligible(s,k.id,'PR-028').allowed,false);
  s.user='chen';M.updateManagement(s,k.id,{collaborators:[]},M.managementStamp(k));
  s.user='lin';assert.equal(M.visiblePrs(s,'received').filter(p=>p.skillId===k.id).length,0);
});
test('transfer preserves published evidence and requires a new-owner run', () => {
  const s=M.createState(),k=M.skill(s,'weekly');M.evaluate(s,k.id,'passed');M.publish(s,k.id);
  const evidence=JSON.stringify(M.publishedReport(s,k.id)),files=M.canonical(k.files),time=k.importedRemoteAt;
  M.transferOwner(s,k.id,'chen',false,M.managementStamp(k));s.user='chen';
  assert.equal(JSON.stringify(M.publishedReport(s,k.id)),evidence);
  assert.equal(M.canonical(k.files),files);assert.equal(k.importedRemoteAt,time);
  assert.equal(M.eligible(s,k.id).allowed,false);
  M.evaluate(s,k.id,'passed');assert.equal(M.eligible(s,k.id).allowed,true);
});
test('transferring back cannot revive the first ownership grant evaluation', () => {
  const s=M.createState(),k=M.skill(s,'weekly');M.evaluate(s,k.id,'passed');
  M.transferOwner(s,k.id,'chen',false,M.managementStamp(k));s.user='chen';
  M.transferOwner(s,k.id,'lin',false,M.managementStamp(k));s.user='lin';
  assert.equal(M.eligible(s,k.id).allowed,false);
  M.evaluate(s,k.id,'passed');assert.equal(M.eligible(s,k.id).allowed,true);
});
test('active evaluation or uncertain publication blocks ownership transfer', () => {
  const s=M.createState(),k=M.skill(s,'weekly');s.activeEvaluations.push(k.id);
  assert.throws(()=>M.transferOwner(s,k.id,'chen',false,M.managementStamp(k)),/测评运行中/);
  s.activeEvaluations=[];k.publishState='uncertain';
  assert.throws(()=>M.transferOwner(s,k.id,'chen',false,M.managementStamp(k)),/待核实/);
  assert.throws(()=>M.updateManagement(s,k.id,{category:'开发效率'},M.managementStamp(k)),/待核实/);
  assert.equal(k.owner,'lin');
});
test('AI generation appends drafts without replacing active cases or reports', () => {
  const s=M.createState(),k=M.skill(s,'weekly');M.evaluate(s,k.id,'passed');
  const before=JSON.stringify(k.suite),report=JSON.stringify(k.report),at=k.importedRemoteAt;
  const a=M.generateCaseDraft(s,k.id,M.caseStamp(k)),b=M.generateCaseDraft(s,k.id,M.caseStamp(k));
  assert.notEqual(a.id,b.id);assert.equal(k.draftCases.length,2);assert.equal(a.origin,'ai');
  assert.equal(JSON.stringify(k.suite),before);assert.equal(JSON.stringify(k.report),report);
  assert.equal(k.importedRemoteAt,at);assert.equal(M.eligible(s,k.id).allowed,true);
});
test('confirming one draft leaves other drafts pending and requires reevaluation', () => {
  const s=M.createState(),k=M.skill(s,'weekly');M.evaluate(s,k.id,'passed');
  const a=M.generateCaseDraft(s,k.id,M.caseStamp(k)),b=M.generateCaseDraft(s,k.id,M.caseStamp(k));
  M.confirmCaseDraft(s,k.id,a.id,M.caseStamp(k));
  assert.ok(k.suite.some(c=>c.id===a.id&&c.confirmedBy==='lin'));
  assert.equal(k.draftCases.length,1);assert.equal(k.draftCases[0].id,b.id);
  assert.equal(M.eligible(s,k.id).allowed,false);
});
test('manual additions and edits stay drafts until individually confirmed', () => {
  const s=M.createState(),k=M.skill(s,'weekly'),count=k.suite.length;
  const fields={title:'manual',input:'sample',expected:'answer',required:true};
  const a=M.saveCaseDraft(s,k.id,null,fields,M.caseStamp(k));assert.equal(k.suite.length,count);assert.equal(a.origin,'manual');
  M.confirmCaseDraft(s,k.id,a.id,M.caseStamp(k));
  M.saveCaseDraft(s,k.id,a.id,{...fields,expected:'revised'},M.caseStamp(k));
  assert.equal(k.suite.find(c=>c.id===a.id).expected,'answer');
  M.confirmCaseDraft(s,k.id,a.id,M.caseStamp(k));assert.equal(k.suite.find(c=>c.id===a.id).expected,'revised');
});
test('deleting a draft preserves active definitions and current evaluation', () => {
  const s=M.createState(),k=M.skill(s,'weekly');M.evaluate(s,k.id,'passed');
  const c=M.generateCaseDraft(s,k.id,M.caseStamp(k)),before=JSON.stringify(k.suite);
  M.deleteCase(s,k.id,c.id,'draft',M.caseStamp(k));assert.equal(k.draftCases.length,0);
  assert.equal(JSON.stringify(k.suite),before);assert.equal(M.eligible(s,k.id).allowed,true);
  assert.notEqual(M.generateCaseDraft(s,k.id,M.caseStamp(k)).id,c.id);
});
test('deleting an unpublished active case invalidates qualification even if definitions return to the original', () => {
  const s=M.createState(),k=M.skill(s,'weekly');M.evaluate(s,k.id,'passed');const old=JSON.stringify(k.suite);
  const c=M.generateCaseDraft(s,k.id,M.caseStamp(k));M.confirmCaseDraft(s,k.id,c.id,M.caseStamp(k));
  M.deleteCase(s,k.id,c.id,'active',M.caseStamp(k));assert.equal(JSON.stringify(k.suite),old);
  assert.equal(M.eligible(s,k.id).allowed,false);
});
test('successful publication permanently protects exactly the evaluated active cases', () => {
  const s=M.createState(),k=M.skill(s,'weekly');
  const a=M.generateCaseDraft(s,k.id,M.caseStamp(k));M.confirmCaseDraft(s,k.id,a.id,M.caseStamp(k));
  const pending=M.generateCaseDraft(s,k.id,M.caseStamp(k));
  M.evaluate(s,k.id,'failed');assert.throws(()=>M.publish(s,k.id));assert.equal(M.protectedCase(k,a.id),false);
  M.evaluate(s,k.id,'passed');M.publish(s,k.id);assert.equal(M.protectedCase(k,a.id),true);assert.equal(M.protectedCase(k,pending.id),false);
  assert.throws(()=>M.deleteCase(s,k.id,a.id,'active',M.caseStamp(k)),/永久不可删除/);
  k.published=false;M.transferOwner(s,k.id,'chen',false,M.managementStamp(k));s.user='chen';
  assert.throws(()=>M.deleteCase(s,k.id,a.id,'active',M.caseStamp(k)),/永久不可删除/);
});
test('editing a published case preserves its identity and deletion protection', () => {
  const s=M.createState(),k=M.skill(s,'sales'),c=k.suite[0],before=JSON.stringify(c),evidence=JSON.stringify(k.marketReport);
  const fields={title:c.title,input:c.input,expected:'updated expectation',required:true};
  M.saveCaseDraft(s,k.id,c.id,fields,M.caseStamp(k));
  assert.equal(JSON.stringify(k.suite[0]),before);M.deleteCase(s,k.id,c.id,'draft',M.caseStamp(k));
  assert.equal(JSON.stringify(k.suite[0]),before);
  M.saveCaseDraft(s,k.id,c.id,fields,M.caseStamp(k));M.confirmCaseDraft(s,k.id,c.id,M.caseStamp(k));
  assert.equal(M.protectedCase(k,c.id),true);assert.equal(JSON.stringify(k.marketReport),evidence);
  assert.throws(()=>M.saveCaseDraft(s,k.id,c.id,{...fields,required:false},M.caseStamp(k)),/不能改为观察/);
});
test('collaborators contributors and unrelated administrators cannot maintain cases', () => {
  const s=M.createState(),k=M.skill(s,'sales'),draft=M.generateCaseDraft(s,k.id,M.caseStamp(k));
  for(const user of ['chen','zhou','admin']){s.user=user;
    assert.throws(()=>M.generateCaseDraft(s,k.id,M.caseStamp(k)),/负责人/);
    assert.throws(()=>M.saveCaseDraft(s,k.id,null,{title:'x',input:'x',expected:'x',required:true},M.caseStamp(k)),/负责人/);
    assert.throws(()=>M.confirmCaseDraft(s,k.id,draft.id,M.caseStamp(k)),/负责人/);
    assert.throws(()=>M.deleteCase(s,k.id,draft.id,'draft',M.caseStamp(k)),/负责人/);
  }
});
test('stale confirmations and delete dialogs cannot modify newer case state', () => {
  const s=M.createState(),k=M.skill(s,'weekly'),draft=M.generateCaseDraft(s,k.id,M.caseStamp(k)),old=M.caseStamp(k);
  M.saveCaseDraft(s,k.id,draft.id,{title:'updated',input:'input',expected:'output',required:true},old);
  assert.throws(()=>M.confirmCaseDraft(s,k.id,draft.id,old),/已变化/);
  assert.throws(()=>M.deleteCase(s,k.id,draft.id,'draft',old),/已变化/);
  assert.equal(k.draftCases[0].title,'updated');
});
test('running evaluations and uncertain publications prevent formal case mutations', () => {
  const s=M.createState(),k=M.skill(s,'weekly'),draft=M.generateCaseDraft(s,k.id,M.caseStamp(k));
  s.activeEvaluations.push(k.id);
  assert.throws(()=>M.confirmCaseDraft(s,k.id,draft.id,M.caseStamp(k)),/测评运行中/);
  assert.throws(()=>M.deleteCase(s,k.id,k.suite[0].id,'active',M.caseStamp(k)),/测评运行中/);
  s.activeEvaluations=[];k.publishState='uncertain';
  assert.throws(()=>M.deleteCase(s,k.id,draft.id,'draft',M.caseStamp(k)),/待核实/);
});
test('case metadata cannot forge publication protection or replace protected case identities', () => {
  const s=M.createState(),k=M.skill(s,'sales');
  assert.throws(()=>M.saveCaseDraft(s,k.id,null,{title:'x',input:'x',expected:'x',required:true,protected:false},M.caseStamp(k)),/保护标记/);
  M.sync(s,k.id,true);k.suite=k.suite.slice(1);M.evaluate(s,k.id,'passed');
  assert.equal(M.eligible(s,k.id).allowed,false);assert.throws(()=>M.publish(s,k.id),/曾发布用例缺失/);
});
test('the prototype has no external scripts or durable browser storage', () => {
  assert.equal(scripts.length,2);
  assert.ok(!/<script[^>]+src=/.test(html));
  assert.ok(!/localStorage|sessionStorage|indexedDB|XMLHttpRequest|fetch\(/.test(html));
  assert.ok(!/currentVersion|importedVersion|baseVersion|snippetVersion/.test(html));
});
test('non-JSON case includes actual example text, files, tool evidence and a child task', () => {
  const s=M.createState(),k=M.skill(s,'sales');M.sync(s,k.id,true);
  const r=M.evaluate(s,k.id,'passed'),c=r.results.find(c=>c.id==='TC-07');
  assert.equal(c.executionCount,1);assert.equal(c.judgeCallCount,2);assert.equal(c.judgeSeconds,15);
  assert.equal(c.review.outputKind,'text-file');assert.equal(c.artifacts.length,1);
  assert.ok(c.agents.some(a=>a.parent==='MAIN'));
  for(const kind of ['final','reference','artifact','tools','agents'])assert.ok(c.evidence.some(e=>e.kind===kind));
  assert.ok(c.evidence.find(e=>e.kind==='artifact').text.includes('下降 20%'));
  assert.equal(M.eligible(s,k.id).allowed,true);
});
test('AI fail, disagreement, uncertainty and service error remain distinct and all block', () => {
  const s=M.createState();M.sync(s,'sales',true);
  for(const [scenario,status] of [['ai-failed','failed'],['ai-disagreement','inconclusive'],['ai-uncertain','inconclusive'],['judge-error','error']]){
    const c=M.evaluate(s,'sales',scenario).results.find(c=>c.id==='TC-07');
    assert.equal(c.status,status);assert.equal(M.eligible(s,'sales').allowed,false);
    assert.ok(c.rules.every(a=>a.status==='passed'));
    assert.equal(c.executionCount,1);assert.equal(c.judgeCallCount,2);
    if(scenario==='judge-error'){assert.equal(c.errorKind,'judge');assert.ok(c.semantic.every(a=>a.attempts.every(j=>j.evidenceRefs.length===0)));}
  }
});
test('only two valid met judgments pass the consensus matrix', () => {
  for(const a of ['met','not_met','uncertain','error'])for(const b of ['met','not_met','uncertain','error']){
    assert.equal(M.consensus([a,b])==='passed',a==='met'&&b==='met');
  }
  assert.equal(M.consensus(['met']),'error');assert.equal(M.consensus([]),'error');
});
test('static blocking and cancellation do not invent evidence or successful judgments', () => {
  const s=M.createState();
  for(const mode of ['static-blocked','cancelled']){
    const c=M.evaluate(s,'sales',mode).results.find(c=>c.id==='TC-07');
    assert.equal(c.executionCount,0);assert.equal(c.judgeCallCount,0);assert.equal(c.evidence.length,0);
    assert.equal(c.artifacts.length,0);assert.equal(c.agents.length,0);
    assert.ok(c.semantic.every(a=>a.status==='not_run'&&a.attempts.length===0));
    assert.equal(M.eligible(s,'sales').allowed,false);
  }
});
test('plain rule cases have no fake AI calls and unsupported scenarios are rejected', () => {
  const s=M.createState();
  const c=M.evaluate(s,'weekly','passed').results[0];
  assert.equal(c.semantic.length,0);assert.equal(c.judgeCallCount,0);assert.equal(c.artifacts.length,0);
  assert.throws(()=>M.evaluate(s,'weekly','ai-failed'),/尚未配置必需 AI/);
});
test('semantic editing stays a draft and invalidates qualification only on confirmation', () => {
  const s=M.createState(),k=M.skill(s,'sales');M.sync(s,k.id,true);M.evaluate(s,k.id,'passed');
  const c=k.suite.find(c=>c.id==='TC-07'),review=M.clone(c.review),old=JSON.stringify(k.report),stamp=k.importedRemoteAt;
  review.criteria[0].pass+=' 并说明资料覆盖范围。';
  M.saveCaseDraft(s,k.id,c.id,{title:c.title,input:c.input,expected:c.expected,required:true,review},M.caseStamp(k));
  assert.equal(M.eligible(s,k.id).allowed,true);assert.notEqual(c.review.criteria[0].pass,review.criteria[0].pass);
  M.confirmCaseDraft(s,k.id,c.id,M.caseStamp(k));
  assert.equal(M.eligible(s,k.id).allowed,false);assert.equal(JSON.stringify(k.report),old);assert.equal(k.importedRemoteAt,stamp);
  assert.equal(k.suite.find(c=>c.id==='TC-07').review.criteria[0].pass,review.criteria[0].pass);
});
test('published required semantic criteria cannot be removed or downgraded', () => {
  const s=M.createState(),k=M.skill(s,'sales'),c=k.suite.find(c=>c.id==='TC-07');
  for(const mutate of [v=>v.criteria.shift(),v=>v.criteria[0].required=false]){
    const review=M.clone(c.review);mutate(review);
    assert.throws(()=>M.saveCaseDraft(s,k.id,c.id,{title:c.title,input:c.input,expected:c.expected,required:true,review},M.caseStamp(k)),/不能移除或降为观察/);
  }
});
test('AI draft includes an editable rubric without activating it', () => {
  const s=M.createState(),k=M.skill(s,'sales'),before=JSON.stringify(k.suite);
  const c=M.generateCaseDraft(s,k.id,M.caseStamp(k));
  assert.equal(c.review.criteria.length,1);assert.equal(JSON.stringify(k.suite),before);
  assert.equal(c.confirmedBy,undefined);
});
test('malformed rubric and evidence scopes cannot be saved', () => {
  const valid=M.reviewExample();
  for(const mutate of [v=>v.criteria[0].pass='',v=>v.criteria[0].targets=[],v=>v.criteria[0].targets=['host'],v=>v.criteria[0].verdict='met',v=>v.reference='',v=>v.outputKind='text',v=>v.criteria.push(v.criteria[0])]){
    const v=M.clone(valid);mutate(v);assert.throws(()=>M.normalizeReview(v));
  }
});
test('all sample judge references resolve to the same case evidence', () => {
  const s=M.createState();
  for(const mode of ['passed','ai-failed','ai-disagreement','ai-uncertain']){
    const c=M.evaluate(s,'sales',mode).results.find(c=>c.id==='TC-07');
    for(const a of c.semantic)for(const j of a.attempts)for(const id of j.evidenceRefs)assert.ok(c.evidence.some(e=>e.id===id));
  }
});
test('public semantic report contains only allowlisted conclusions, no rubric or private evidence', () => {
  const s=M.createState(),k=M.skill(s,'sales');M.sync(s,k.id,true);M.evaluate(s,k.id,'passed');M.publish(s,k.id);
  const r=M.publishedReport(s,k.id),c=r.results.find(c=>c.id==='TC-07'),raw=JSON.stringify(r);
  assert.equal(c.semantic.length,2);assert.equal(c.semantic[0].attempts.length,2);
  for(const value of ['reference','requirement','targets','evidenceRefs','reason','artifacts','agents','退款 20 元'])assert.ok(!raw.includes(value));
  const published=raw;M.evaluate(s,k.id,'ai-failed');assert.equal(JSON.stringify(M.publishedReport(s,k.id)),published);
});
test('reported pass cannot bypass missing, one-sided or invalid AI evidence', () => {
  const s=M.createState();M.sync(s,'sales',true);
  for(const mutate of [c=>c.semantic[0].attempts.pop(),c=>c.semantic[0].attempts[0].verdict='not_met',c=>c.semantic[0].attempts[0].evidenceRefs=['MISSING'],c=>c.semantic=[]]){
    const c=M.evaluate(s,'sales','passed').results.find(c=>c.id==='TC-07');mutate(c);c.status='passed';
    assert.equal(M.eligible(s,'sales').allowed,false);
  }
});
test('AI approval never hides an independent failed rule', () => {
  const s=M.createState();M.sync(s,'sales',true);
  const c=M.evaluate(s,'sales','passed').results.find(c=>c.id==='TC-07');c.rules[0].status='failed';
  assert.equal(M.eligible(s,'sales').allowed,false);
});
const templateInput=(name='generated-demo')=>({name,title:'模板生成示例',description:'用于验证按模板生成普通 Skill。',values:{business:'分析脱敏销售数据',source:'本地测试样例',delivery:'分析报告'}});
test('snippets have no separate type and admins can add fixed text', () => {
  const s=M.createState();assert.ok(s.snippets.every(sn=>!('type' in sn)));
  assert.throws(()=>M.snippetWrite(s,{title:'新片段',content:'正文'}),/管理员/);
  s.user='admin';M.snippetWrite(s,{title:'新片段',content:'{{name}} 原样正文',type:'ignored'});
  const sn=s.snippets.at(-1);assert.equal(sn.content,'{{name}} 原样正文');assert.ok(!('type' in sn));
});
test('only admins can create or edit tenant templates, with stale form protection', () => {
  const s=M.createState(),base=M.clone(M.template(s,'analysis')),stamp=M.templateStamp(base);
  assert.throws(()=>M.templateWrite(s,base,stamp),/管理员/);
  s.user='admin';const created=M.templateWrite(s,{...base,id:'',title:'新的分析模板'});
  assert.equal(created.tenantId,s.tenantId);assert.equal(s.templates.length,4);
  M.templateWrite(s,{...base,title:'新名称'},stamp);
  assert.throws(()=>M.templateWrite(s,base,stamp),/已变化/);
});
test('custom field schemas reject collisions invalid defaults and malformed definitions', () => {
  const s=M.createState();s.user='admin';
  const base=M.clone(M.template(s,'analysis'));base.id='';
  for(const patch of [
    fields=>fields.push({...fields[0]}),
    fields=>fields[0].key='__proto__',
    fields=>fields[0].label='',
    fields=>fields[2].options=['重复','重复'],
    fields=>fields[2].defaultValue='不在选项中',
    fields=>fields[0].kind='script'
  ]){const t=M.clone(base);patch(t.fields);assert.throws(()=>M.templateWrite(s,t));}
  const t=M.templateWrite(s,{...base,fields:[]});assert.equal(t.fields.length,0);
});
test('copied template blocks and Skill text are unaffected by snippet edits and deletion', () => {
  const s=M.createState(),t=M.template(s,'analysis'),before=M.templateStamp(t);
  s.user='admin';M.snippetWrite(s,{...s.snippets[0],content:'改过的正文'});M.snippetDelete(s,'sn1');
  assert.equal(M.templateStamp(t),before);
  s.user='lin';const j=M.startGeneration(s,t.id,templateInput(),before);M.finishGeneration(s,j.id);const k=M.adoptGeneration(s,j.id);
  assert.ok(k.files['SKILL.md'].includes('无法确认时明确说明'));assert.ok(!k.files['SKILL.md'].includes('改过的正文'));
});
test('generation validates required fields choices undeclared values and names before starting', () => {
  const s=M.createState(),t=M.template(s,'analysis'),stamp=M.templateStamp(t);
  for(const change of [
    input=>input.values.business='',
    input=>input.values.delivery='其他',
    input=>input.values.unknown='注入',
    input=>input.name='../escape',
    input=>input.name='sales-summary'
  ]){const input=templateInput();change(input);assert.throws(()=>M.startGeneration(s,t.id,input,stamp));}
  assert.equal(s.generationJobs.length,0);
});
test('generation binds a fixed template and data copy without writing a local Skill', () => {
  const s=M.createState(),t=M.template(s,'analysis'),before=s.skills.length,input=templateInput();
  const j=M.startGeneration(s,t.id,input,M.templateStamp(t)),frozen=M.templateStamp(j.template);
  t.instructions='管理员后来修改';input.values.business='用户后来改动';
  assert.equal(M.templateStamp(j.template),frozen);assert.equal(j.input.values.business,'分析脱敏销售数据');
  assert.equal(s.skills.length,before);assert.equal(j.files,null);
  assert.throws(()=>M.startGeneration(s,t.id,templateInput('second'),M.templateStamp(t)),/先完成或取消/);
});
test('stale template and cross tenant requests cannot start generation', () => {
  const s=M.createState(),t=M.template(s,'analysis'),stamp=M.templateStamp(t);
  t.description+='改';assert.throws(()=>M.startGeneration(s,t.id,templateInput(),stamp),/已更新/);
  s.tenantId='another';assert.throws(()=>M.template(s,'analysis'),/无权/);
});
test('generation completion yields preview files, not a published or evaluated Skill', () => {
  const s=M.createState(),t=M.template(s,'analysis'),before=s.skills.length,j=M.startGeneration(s,t.id,templateInput(),M.templateStamp(t));
  M.finishGeneration(s,j.id);assert.equal(j.state,'ready');assert.equal(j.cleanup,'complete');assert.equal(s.skills.length,before);
  assert.ok(j.files['references/requirements.md'].includes('分析脱敏销售数据'));
  assert.ok(j.files['SKILL.md'].includes('references/requirements.md'));
  for(const forbidden of ['snippetId','templateId','sn1','{{template'])assert.ok(!j.files['SKILL.md'].includes(forbidden));
  const k=M.adoptGeneration(s,j.id);assert.equal(k.owner,'lin');assert.equal(k.published,false);assert.equal(k.report,null);assert.equal(k.suite.length,0);assert.equal(k.source,'created');assert.equal(k.importedRemoteAt,null);assert.equal(k.category,'未分类');
  assert.equal(M.eligible(s,k.id).allowed,false);
});
test('adoption is scoped to initiating user tenant and workspace, and idempotent', () => {
  const s=M.createState(),t=M.template(s,'analysis'),j=M.startGeneration(s,t.id,templateInput(),M.templateStamp(t));M.finishGeneration(s,j.id);
  s.user='admin';assert.throws(()=>M.adoptGeneration(s,j.id),/无权/);s.user='lin';
  s.workspaceId='another';assert.throws(()=>M.adoptGeneration(s,j.id),/无权/);s.workspaceId='workspace-demo';
  s.tenantId='another';assert.throws(()=>M.adoptGeneration(s,j.id),/无权/);s.tenantId='tenant-demo';
  const first=M.adoptGeneration(s,j.id),count=s.skills.length;assert.equal(M.adoptGeneration(s,j.id).id,first.id);assert.equal(s.skills.length,count);
});
test('adoption rechecks name conflict and preserves an existing local Skill', () => {
  const s=M.createState(),t=M.template(s,'analysis'),j=M.startGeneration(s,t.id,templateInput(),M.templateStamp(t));M.finishGeneration(s,j.id);
  s.skills.push({id:'race',name:j.input.name,local:true,files:{'SKILL.md':'existing'}});
  assert.throws(()=>M.adoptGeneration(s,j.id),/同名/);assert.equal(M.skill(s,'race').files['SKILL.md'],'existing');assert.equal(j.state,'ready');
});
test('failed invalid and cancelled jobs never create usable files or local Skills', () => {
  for(const outcome of ['error','invalid','cancelled']){
    const s=M.createState(),t=M.template(s,'analysis'),before=s.skills.length,j=M.startGeneration(s,t.id,templateInput(),M.templateStamp(t));
    if(outcome==='cancelled')M.cancelGeneration(s,j.id);else M.finishGeneration(s,j.id,outcome);
    assert.equal(j.files,null);assert.equal(j.cleanup,'complete');assert.equal(s.skills.length,before);assert.throws(()=>M.adoptGeneration(s,j.id),/仅可保存/);
    assert.throws(()=>M.finishGeneration(s,j.id),/已结束/);
  }
});
test('job completion does not change ownership when the UI persona changes', () => {
  const s=M.createState(),t=M.template(s,'analysis'),j=M.startGeneration(s,t.id,templateInput(),M.templateStamp(t));s.user='chen';M.finishGeneration(s,j.id);
  assert.equal(j.user,'lin');assert.throws(()=>M.cancelGeneration(s,j.id),/无权/);assert.throws(()=>M.adoptGeneration(s,j.id),/无权/);
  s.user='lin';assert.equal(M.adoptGeneration(s,j.id).owner,'lin');
});
console.log(`\n${count} checks passed. These validate the prototype model, not production services.`);
