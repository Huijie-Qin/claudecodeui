import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const scripts=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
scripts.forEach(s=>new vm.Script(s[1]));
const context=vm.createContext({});vm.runInContext(scripts[0][1],context);const M=context.SkillMarketModel;
let count=0;function test(name,fn){fn();count++;console.log('PASS '+name)}
function fixture(options={}){const s=M.createState(),k=M.skill(s,'weekly'),p=M.prepareOptimization(s,k.id),j=M.startOptimization(s,p.id,options);return{s,k,p,j}}
function finish(s,j){for(let i=0;j.state==='running'&&i<10;i++)M.stepOptimization(s,j.id);assert.notEqual(j.state,'running')}
test('preparing a plan is read-only and requires local editing access',()=>{
 const s=M.createState(),k=M.skill(s,'weekly'),before=JSON.stringify(k);M.prepareOptimization(s,k.id);assert.equal(JSON.stringify(k),before);
 s.user='chen';M.prepareOptimization(s,k.id);assert.equal(JSON.stringify(k),before);
 k.editorIds=['lin'];assert.throws(()=>M.prepareOptimization(s,k.id),/编辑权限/);
});
test('remote updates block; new AI drafts explore without activation',()=>{
 const s=M.createState();assert.throws(()=>M.prepareOptimization(s,'sales'),/市场内容/);
 const k=M.skill(s,'weekly'),suite=M.suiteKey(k);const d=M.generateCaseDraft(s,k.id,M.caseStamp(k)),p=M.prepareOptimization(s,k.id);
 assert.ok(p.exploration.some(c=>c.sourceId===d.id));const j=M.startOptimization(s,p.id);finish(s,j);assert.equal(j.state,'ready');assert.equal(M.suiteKey(k),suite);assert.equal(k.draftCases.length,1);
});
test('old plans and invalid caps cannot start a job',()=>{
 const s=M.createState(),k=M.skill(s,'weekly'),p=M.prepareOptimization(s,k.id);assert.throws(()=>M.startOptimization(s,p.id,{maxRounds:4}),/无效/);
 k.files['SKILL.md']+='\nChanged';assert.throws(()=>M.startOptimization(s,p.id),/变化/);assert.equal(s.activeEvaluations.length,0);
});
test('missing fixed standards allow exploration but never auto-activate or publish',()=>{
 const s=M.createState();s.user='zhou';const k=M.skill(s,'local');k.suite=[];const p=M.prepareOptimization(s,k.id);assert.equal(k.suite.length,0);assert.equal(p.cases.length,0);assert.equal(p.exploration.length,2);
 const j=M.startOptimization(s,p.id,{scenario:'passed'});finish(s,j);assert.equal(j.state,'needs-input');assert.equal(k.suite.length,0);assert.equal(j.explorationResults.length,2);assert.equal(M.eligible(s,k.id).allowed,false);assert.throws(()=>M.adoptOptimization(s,j.id));
});
test('two-round improvement preserves files, standards and market until adoption',()=>{
 const {s,k,j}=fixture(),files=M.canonical(k.files),market=M.canonical(k.remoteFiles),suite=M.suiteKey(k);
 finish(s,j);assert.equal(j.state,'ready');assert.equal(j.rounds.length,2);assert.equal(j.usedUnits,6);assert.equal(j.acceptance.status,'passed');assert.equal(j.acceptance.checks.length,3);
 assert.equal(M.canonical(k.files),files);assert.equal(M.canonical(k.remoteFiles),market);assert.equal(M.suiteKey(k),suite);assert.notEqual(M.canonical(j.files),files);assert.equal(k.report,null);
});
test('adoption attaches exact checked candidate but never publishes',()=>{
 const {s,k,j}=fixture(),remote=k.remoteAt,imported=k.importedRemoteAt;finish(s,j);M.adoptOptimization(s,j.id);
 assert.equal(j.state,'adopted');assert.equal(M.canonical(k.files),j.report.content);assert.equal(k.report.id,j.report.id);
 assert.equal(k.remoteAt,remote);assert.equal(k.importedRemoteAt,imported);assert.equal(s.events.length,0);assert.equal(M.eligible(s,k.id).allowed,true);
 M.publish(s,k.id);assert.equal(s.events.length,1);
});
test('existing passing report cannot bypass a newer unadopted optimization',()=>{
 const s=M.createState(),k=M.skill(s,'weekly');M.evaluate(s,k.id,'passed');assert.ok(M.eligible(s,k.id).allowed);
 const p=M.prepareOptimization(s,k.id),j=M.startOptimization(s,p.id);finish(s,j);assert.equal(M.eligible(s,k.id).allowed,false);
 M.evaluate(s,k.id,'passed');assert.equal(M.eligible(s,k.id).allowed,true);assert.throws(()=>M.adoptOptimization(s,j.id),/失效/);
});
test('cancel and limit never adopt a partially modified candidate',()=>{
 for(const options of [{maxRounds:1},{maxUnits:1}]){const {s,k,j}=fixture(options),before=M.canonical(k.files);finish(s,j);assert.equal(j.state,'limit');assert.equal(M.canonical(k.files),before);assert.throws(()=>M.adoptOptimization(s,j.id));assert.equal(s.activeEvaluations.length,0)}
 const {s,k,j}=fixture();M.stepOptimization(s,j.id);M.cancelOptimization(s,j.id);M.stepOptimization(s,j.id);assert.equal(j.state,'cancelled');assert.equal(k.report,null);
});
test('no improvement, business ambiguity and service failure are distinct stops',()=>{
 for(const [scenario,state] of [['stalled','stalled'],['needs-input','needs-input'],['error','error']]){const {s,k,j}=fixture({scenario});finish(s,j);assert.equal(j.state,state);assert.equal(k.report,null);assert.equal(s.activeEvaluations.length,0);assert.throws(()=>M.adoptOptimization(s,j.id));}
});
test('local edits, remote changes and report replacement invalidate pending work',()=>{
 for(const change of [k=>k.files['SKILL.md']+='\nManual',k=>k.remoteAt='2099-01-01T00:00:00Z',k=>k.remoteFiles['SKILL.md']+='\nExternal',k=>k.report={id:'new-report'}]){
  const {s,k,j}=fixture();change(k);M.stepOptimization(s,j.id);assert.equal(j.state,'stale');assert.equal(s.activeEvaluations.length,0);
 }
});
test('suite and owner changes invalidate a ready candidate',()=>{
 for(const change of [k=>k.suite[0].expected='Changed',k=>k.owner='zhou',k=>k.authorityEpoch=1]){
  const {s,k,j}=fixture();finish(s,j);change(k);assert.throws(()=>M.adoptOptimization(s,j.id),/失效/);
 }
});
test('candidate/report tampering, replay and another user cannot adopt',()=>{
 const {s,k,j}=fixture();finish(s,j);s.user='chen';assert.throws(()=>M.adoptOptimization(s,j.id),/无权/);s.user='lin';
 j.files['SKILL.md']+='\nUnchecked';assert.throws(()=>M.adoptOptimization(s,j.id),/不匹配/);
 const f=fixture();finish(f.s,f.j);M.adoptOptimization(f.s,f.j.id);assert.throws(()=>M.adoptOptimization(f.s,f.j.id),/失效/);
});
test('identity switching does not attribute background work to a different user',()=>{
 const {s,k,j}=fixture();s.user='chen';finish(s,j);assert.equal(j.report.initiatedBy,'lin');assert.equal(j.report.ownerAtRun,'lin');
 s.user='lin';M.adoptOptimization(s,j.id);assert.ok(M.eligible(s,k.id).allowed);
});
test('published cases remain protected and concurrent formal mutations are blocked',()=>{
 const s=M.createState();M.sync(s,'sales',true);const k=M.skill(s,'sales'),protectedIds=JSON.stringify(k.protectedCaseIds),suite=M.suiteKey(k);
 const j=M.startOptimization(s,M.prepareOptimization(s,k.id).id);
 assert.throws(()=>M.transferOwner(s,k.id,'zhou',false,M.managementStamp(k)),/测评运行中/);
 assert.throws(()=>M.startOptimization(s,M.prepareOptimization(s,'weekly').id),/当前检查|正在运行/);
 finish(s,j);M.adoptOptimization(s,j.id);assert.equal(M.suiteKey(k),suite);assert.equal(JSON.stringify(k.protectedCaseIds),protectedIds);
});
test('local optimization does not invalidate a separately evaluated contribution',()=>{
 const s=M.createState();M.sync(s,'sales',true);const p=M.prepareOptimization(s,'sales'),j=M.startOptimization(s,p.id);M.cancelOptimization(s,j.id);
 M.evaluate(s,'sales','passed','PR-028');assert.equal(M.eligible(s,'sales','PR-028').allowed,true);assert.equal(M.eligible(s,'sales').allowed,false);
});
test('fixed suite success cannot bypass fresh-sample or stability failure',()=>{
 for(const scenario of ['acceptance-failed','unstable']){const {s,k,j}=fixture({scenario});finish(s,j);assert.equal(j.state,'acceptance-failed');assert.equal(j.acceptance.status,'failed');assert.ok(j.report.results.every(c=>c.status==='passed'));assert.throws(()=>M.adoptOptimization(s,j.id));assert.equal(M.eligible(s,k.id).allowed,false);assert.equal(k.report,null);}
});
test('final acceptance requires its own budget and exact candidate binding',()=>{
 const f=fixture({maxUnits:3});finish(f.s,f.j);assert.equal(f.j.state,'limit');assert.equal(f.j.acceptance,null);assert.throws(()=>M.adoptOptimization(f.s,f.j.id));
 const {s,j}=fixture();finish(s,j);j.acceptance.content='other';assert.throws(()=>M.adoptOptimization(s,j.id),/独立验收/);
});
test('edited acceptance drafts never replace fixed standards in exploration',()=>{
 const s=M.createState(),k=M.skill(s,'weekly'),c=k.suite[0];
 M.saveCaseDraft(s,k.id,c.id,{title:c.title,input:c.input,expected:'WEAKENED_EXPECTATION',required:true},M.caseStamp(k));
 const p=M.prepareOptimization(s,k.id);assert.notEqual(p.cases[0].expected,'WEAKENED_EXPECTATION');assert.ok(p.exploration.every(c=>c.expected!=='WEAKENED_EXPECTATION'));
 const j=M.startOptimization(s,p.id);finish(s,j);assert.equal(j.state,'ready');assert.equal(k.draftCases.length,1);
});
test('static blocking creates no exploration execution evidence',()=>{
 const s=M.createState(),k=M.skill(s,'weekly');k.files['SKILL.md']='invalid';const j=M.startOptimization(s,M.prepareOptimization(s,k.id).id);M.stepOptimization(s,j.id);
 assert.ok(j.explorationResults.every(c=>c.status==='not_run'&&c.executionCount===0&&c.evidence.length===0));
});
test('exploration identities never become permanently protected publication cases',()=>{
 const {s,k,j}=fixture();finish(s,j);M.adoptOptimization(s,j.id);M.publish(s,k.id);assert.ok(j.exploration.every(c=>!k.protectedCaseIds.includes(c.id)));assert.ok(k.suite.every(c=>k.protectedCaseIds.includes(c.id)));
});
console.log('\n'+count+' optimization checks passed. Simulation only.');
