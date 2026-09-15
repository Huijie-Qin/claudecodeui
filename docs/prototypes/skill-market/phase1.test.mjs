import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const model=readFileSync(new URL('./phase1-model.js',import.meta.url),'utf8');
const ui=readFileSync(new URL('./phase1-ui.js',import.meta.url),'utf8');
const html=readFileSync(new URL('./phase1.html',import.meta.url),'utf8');
const css=readFileSync(new URL('./phase1.css',import.meta.url),'utf8');
const ctx=vm.createContext({});vm.runInContext(model,ctx);const M=ctx.PhaseOneModel;
let count=0;function test(name,run){run();console.log('PASS '+name);count++}
test('phase one exposes no deferred template, contribution, release or role management actions',()=>{
 new vm.Script(ui);new vm.Script(model);
 assert.doesNotMatch(ui,/data-action="(?:template|contribution|publish|approve|transfer)/);
 assert.doesNotMatch(ui,/模板中心|提交贡献|确认采用|试用技能/);
 assert.match(html,/phase1-model\.js/);assert.match(html,/phase1-ui\.js/);
});
test('creation mode owns highlight independently of draft and keeps the larger chat input',()=>{
 assert.match(ui,/aria-pressed="\$\{createMode\}"/);
 assert.match(ui,/createMode=!createMode;render\(\)/);
 assert.match(ui,/if\(createMode\)\{const job=M.startCreate/);
 assert.match(ui,/!e\.isComposing/);assert.match(css,/\.chat-input\{min-height:112px/);
});
test('description-only creation generates a valid unique name without a name input',()=>{
 const s=M.state();assert.throws(()=>M.startCreate(s,{description:' '}));
 assert.doesNotMatch(ui,/id="skill-name"|技能标识|creator-fields/);
 assert.match(ui,/M\.startCreate\(S,\{description:text\}\)/);
 const original=M.stamp(s.skills[0]),j=M.startCreate(s,{description:'整理周报'});assert.equal(s.skills.length,1);const k=M.finishCreate(s,j);assert.equal(k.name,'weekly-report-2');assert.deepEqual(JSON.parse(k.files['evals/evals.json']),{skill_name:k.name,evals:[]});assert.ok(k.files['SKILL.md'].includes('name: '+k.name));assert.equal(M.stamp(s.skills[0]),original);assert.throws(()=>M.finishCreate(s,j));
 const next=M.finishCreate(s,M.startCreate(s,{description:'整理周报'}));assert.equal(next.name,'weekly-report-3');
});
test('failed generation leaves no partial skill and can be retried',()=>{
 const s=M.state(),j=M.startCreate(s,{description:'处理材料'});assert.equal(M.finishCreate(s,j,true),null);assert.equal(s.skills.length,1);M.finishCreate(s,M.startCreate(s,{description:'处理材料'}));assert.equal(s.skills.length,2);
});
test('public snippets are admin-only and copy semantics do not track later changes',()=>{
 const s=M.state();assert.throws(()=>M.writeSnippet(s,{id:'facts',title:'x',body:'y'}));assert.throws(()=>M.removeSnippet(s,'facts'));
 const j=M.startCreate(s,{description:'生成周报'});s.role='admin';M.writeSnippet(s,{id:'facts',title:'new',body:'new content'});const k=M.finishCreate(s,j);assert.ok(k.files['SKILL.md'].includes('只依据提供的材料'));const saved=k.files['SKILL.md'];M.removeSnippet(s,'facts');assert.equal(k.files['SKILL.md'],saved);
 assert.throws(()=>M.saveFile(s,k,'SKILL.md','片段正文\n'+saved));
 assert.match(ui,/frontmatter&&editor\.selectionStart<frontmatter\[0\]\.length/);
});
test('all case mutations write the same file and published IDs cannot be removed',()=>{
 const s=M.state(),k=s.skills[0],id=M.addCase(s,k,{prompt:'材料不足',expected_output:'询问资料'});assert.equal(M.readCases(k).evals.length,3);M.deleteCase(s,k,id);assert.equal(M.readCases(k).evals.length,2);assert.throws(()=>M.deleteCase(s,k,1));const v=M.readCases(k);v.evals=[];assert.throws(()=>M.saveFile(s,k,'evals/evals.json',JSON.stringify(v)));assert.equal(M.readCases(k).evals.length,2);
});
test('invocation save is direct and idempotent',()=>{
 const s=M.state(),k=s.skills[0],call=M.invocation(s,k,'生成本周总结'),a=M.saveInvocation(s,call),b=M.saveInvocation(s,call);assert.equal(a,b);assert.equal(M.readCases(k).evals.length,3);assert.equal(call.saved,true);
});
test('run all advances one case at a time and never edits skill',()=>{
 const s=M.state(),k=s.skills[0],before=M.stamp(k),j=M.startRun(s,k);assert.equal(j.before.length,0);M.step(s);assert.equal(j.before.length,1);assert.equal(j.state,'running');M.step(s);assert.equal(j.before.length,2);assert.equal(j.state,'completed');assert.equal(M.stamp(k),before);assert.ok(j.before[0].messages.some(m=>m.role==='subagent'));assert.ok(j.before[0].messages.some(m=>m.role==='file'));
});
test('optimization performs full before pass, writes automatically and then full after pass',()=>{
 const s=M.state(),k=s.skills[0],j=M.startRun(s,k,true);M.step(s);M.step(s);assert.equal(j.before.length,2);assert.equal(j.phase,'optimize');assert.equal(j.written,false);M.step(s);assert.equal(j.written,true);assert.equal(j.after.length,0);assert.notEqual(k.files['SKILL.md'],j.beforeFiles['SKILL.md']);M.step(s);M.step(s);assert.equal(j.after.length,2);assert.equal(j.state,'completed');assert.deepEqual(j.cases,M.readCases(k).evals);assert.match(ui,/output-grid \$\{j\?\.optimize\?'compare'/);
});
test('stop after write retains files and external edits stop without overwrite',()=>{
 const s=M.state(),k=s.skills[0],j=M.startRun(s,k,true);M.step(s);M.step(s);M.step(s);const after=M.stamp(k);M.stop(s);assert.equal(j.state,'cancelled');M.step(s);assert.equal(M.stamp(k),after);
 const j2=M.startRun(s,k,true);k.files['SKILL.md']+='\nexternal';const external=M.stamp(k);M.step(s);assert.equal(j2.state,'stale');assert.equal(M.stamp(k),external);
});
test('empty suites, unsafe or missing inputs and edits during execution are blocked',()=>{
 const s=M.state(),k=s.skills[0];assert.throws(()=>M.addCase(s,k,{prompt:'x',expected_output:'y',files:['../secret']}));M.addCase(s,k,{prompt:'x',expected_output:'y',files:['evals/files/missing.txt']});assert.throws(()=>M.startRun(s,k));M.deleteCase(s,k,3);M.startRun(s,k);assert.throws(()=>M.addCase(s,k,{prompt:'x',expected_output:'y'}));assert.throws(()=>M.startRun(s,k));
 const s2=M.state(),empty=M.finishCreate(s2,M.startCreate(s2,{description:'test'}));assert.throws(()=>M.startRun(s2,empty));
});
test('optimization limits reject invalid values without starting or replacing a report',()=>{
 const s=M.state(),k=s.skills[0];for(const value of [0,11,-1,1.5,NaN,Infinity,'3',null])assert.throws(()=>M.startRun(s,k,true,value));assert.equal(s.job,null);assert.equal(k.report,null);
 const j=M.startRun(s,k,true);assert.equal(j.maxIterations,3);
 assert.match(ui,/id="max-iterations" type="number" min="1" max="10" step="1"/);
});
test('failed retests stop exactly at the iteration cap and retain all rounds and writes',()=>{
 for(const cap of [1,3,10]){const s=M.state(),k=s.skills[0],j=M.startRun(s,k,true,cap),cases=JSON.stringify(j.cases);let steps=0;
 while(j.state==='running'&&steps<100){M.step(s,c=>({id:c.id,status:'failed',messages:[],reason:'simulation failure'}));steps++}
 assert.equal(j.state,'completed');assert.equal(j.stopReason,'max_iterations');assert.equal(j.iteration,cap);assert.equal(j.rounds.length,cap);assert.equal(steps,2+3*cap);assert.equal(JSON.stringify(j.cases),cases);assert.equal(M.stamp(k),j.expected);assert.ok(j.written);
 for(const round of j.rounds){assert.equal(round.before.length,2);assert.equal(round.after.length,2)}
 const files=M.stamp(k);M.step(s);assert.equal(M.stamp(k),files);assert.equal(j.iteration,cap);
 }
});
test('passing pretest skips writes and passing retest ends before the cap',()=>{
 const s=M.state(),k=s.skills[0],files=M.stamp(k),j=M.startRun(s,k,true,3);M.step(s,c=>({id:c.id,status:'passed'}));M.step(s,c=>({id:c.id,status:'passed'}));assert.equal(j.iteration,0);assert.equal(j.stopReason,'all_passed');assert.equal(j.written,false);assert.equal(M.stamp(k),files);
 const s2=M.state(),k2=s2.skills[0],j2=M.startRun(s2,k2,true,3);while(j2.state==='running')M.step(s2);assert.equal(j2.iteration,1);assert.equal(j2.stopReason,'all_passed');
});
test('evaluation error does not consume the remaining optimization attempts',()=>{
 const s=M.state(),j=M.startRun(s,s.skills[0],true,3);M.step(s,c=>({id:c.id,status:'error'}));M.step(s,c=>({id:c.id,status:'failed'}));assert.equal(j.state,'failed');assert.equal(j.iteration,0);assert.equal(j.stopReason,'evaluation_error');assert.equal(j.written,false);
});
console.log(count+' phase-one prototype checks passed. No real AI or filesystem operations.');
