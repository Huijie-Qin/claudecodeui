import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const context=vm.createContext({});
vm.runInContext([...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)][0][1],context);
const M=context.SkillMarketModel;
const fixture=()=>{const s=M.createState();return{s,p:s.prs[0],k:M.skill(s,'sales')}};
function test(name,fn){fn();console.log('PASS '+name)}

test('changed files include modifications additions deletions with a frozen baseline',()=>{
 const {s,p,k}=fixture(),files=M.contributionFiles(p);
 assert.equal(files.length,4);
 assert.ok(files.some(f=>f.kind==='added'));
 assert.ok(files.some(f=>f.kind==='deleted'));
 const before=JSON.stringify(files);k.remoteFiles['references/example.md']='external change';
 assert.equal(JSON.stringify(M.contributionFiles(p)),before);
 assert.equal(M.mergeEligibility(s,k.id,p.id).allowed,false);
});
test('diff operations reconstruct both source texts and carry the correct line numbers',()=>{
 for(const [a,b] of [['a\nb\nc','a\nchanged\nc'],[undefined,'new\nfile'],['deleted',undefined],['',''],['same','same']]){
  const rows=M.lineDiff(a,b),left=rows.filter(r=>r.kind!=='add'),right=rows.filter(r=>r.kind!=='delete');
  assert.equal(left.map(r=>r.text).join('\n'),a??'');assert.equal(right.map(r=>r.text).join('\n'),b??'');
  assert.deepEqual(Array.from(left,r=>r.old),Array.from(left,(_,i)=>i+1));assert.deepEqual(Array.from(right,r=>r.new),Array.from(right,(_,i)=>i+1));
 }
});
test('all authorized members may approve except the author; none gains merge permission',()=>{
 const {s,p,k}=fixture();s.user='admin';M.reviewContribution(s,p.id,'approve','',M.reviewStamp(p));assert.equal(M.approvals(s,p).length,1);
 assert.throws(()=>M.mergeContribution(s,k.id,p.id),/负责人/);
 s.user=p.author;assert.throws(()=>M.reviewContribution(s,p.id,'approve','',M.reviewStamp(p)),/自己/);
 s.user='outsider';assert.equal(M.skillPrs(s,k.id).length,0);assert.throws(()=>M.reviewContribution(s,p.id,'approve','',M.reviewStamp(p)),/权限/);
});
test('approvals deduplicate and cease to count after content changes or a later change request',()=>{
 const {s,p}=fixture();s.user='chen';const old=M.reviewStamp(p);
 M.reviewContribution(s,p.id,'approve','',old);M.reviewContribution(s,p.id,'approve','',old);assert.equal(M.approvals(s,p).length,1);
 M.reviewContribution(s,p.id,'request_changes','补充依据',old);assert.equal(M.approvals(s,p).length,0);
 M.reviewContribution(s,p.id,'approve','',old);p.files['SKILL.md']+='\nchange';assert.equal(M.approvals(s,p).length,0);
 assert.throws(()=>M.reviewContribution(s,p.id,'approve','',old),/已变化/);
});
test('reviewed merge and owner direct merge need no evaluation and clear current market report',()=>{
 for(const reviewed of [false,true]){
  const {s,p,k}=fixture(),files=M.canonical(k.files),time=k.importedRemoteAt,protectedIds=JSON.stringify(k.protectedCaseIds);
  if(reviewed){s.user='chen';M.reviewContribution(s,p.id,'approve','',M.reviewStamp(p));s.user='lin'}
  p.report=null;M.mergeContribution(s,k.id,p.id,M.mergeStamp(s,p));
  assert.equal(p.mergeMode,reviewed?'reviewed':'owner_direct');assert.equal(p.state,'merged');
  assert.equal(M.publishedReport(s,k.id),null);assert.equal(M.canonical(k.remoteFiles),M.canonical(p.files));
  assert.equal(M.canonical(k.files),files);assert.equal(k.importedRemoteAt,time);assert.equal(JSON.stringify(k.protectedCaseIds),protectedIds);
  assert.throws(()=>M.mergeContribution(s,k.id,p.id),/结束/);
 }
});
test('owner authored contributions may direct merge without self approval',()=>{
 const {s,p,k}=fixture();p.author=s.user;assert.throws(()=>M.reviewContribution(s,p.id,'approve','',M.reviewStamp(p)),/自己/);
 M.mergeContribution(s,k.id,p.id);assert.equal(p.mergeMode,'owner_direct');
});
test('malformed packages, stale confirmation, mismatched target and unpublished skills cannot merge',()=>{
 for(const change of [p=>delete p.files['SKILL.md'],p=>p.files['../escape']='x',p=>p.files['a\\b']='x']){
  const {s,p,k}=fixture();change(p);assert.equal(M.mergeEligibility(s,k.id,p.id).allowed,false);
 }
 const {s,p,k}=fixture(),stamp=M.mergeStamp(s,p);p.files['SKILL.md']+='\nchanged';
 assert.throws(()=>M.mergeContribution(s,k.id,p.id,stamp),/已变化/);
 assert.throws(()=>M.mergeContribution(s,'sql',p.id),/不匹配/);
 k.published=false;assert.equal(M.mergeEligibility(s,k.id,p.id).allowed,false);
});
console.log('7 contribution workflow checks passed. Prototype model only.');
