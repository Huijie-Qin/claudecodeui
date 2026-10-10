import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const scripts=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
scripts.forEach(script=>new vm.Script(script[1]));
const context=vm.createContext({});
vm.runInContext(scripts[0][1],context);
const M=context.SkillMarketModel;
let count=0;
function test(name,fn){fn();count++;console.log('PASS '+name)}

test('a completed conversation invocation saves directly as an active case',()=>{
  const s=M.createState(),k=M.skill(s,'weekly'),before=k.suite.length;
  k.report={id:'old'};
  const c=M.saveInvocationCase(s,k.id,{id:'inv-1',skillId:k.id,query:'生成本周周报',output:'已生成包含进展、风险和下周计划的周报。',hasArtifact:true});
  assert.equal(k.suite.length,before+1);
  assert.equal(k.draftCases.length,0);
  assert.equal(c.origin,'conversation');
  assert.equal(c.referenceOutput,'已生成包含进展、风险和下周计划的周报。');
  assert.equal(c.confirmedBy,s.user);
  assert.equal(k.report,undefined);
});

test('a collaborator saves only to their personal active suite',()=>{
  const s=M.createState(),k=M.skill(s,'sales'),formalCount=k.suite.length;
  s.user='chen';
  const c=M.saveInvocationCase(s,k.id,{id:'inv-2',skillId:k.id,query:'分析退款',output:'已按币种分别汇总退款。',hasArtifact:false});
  assert.equal(k.suite.length,formalCount);
  assert.equal(M.localState(s,k,'chen').suite.length,1);
  assert.equal(c.scope,'local');
});

test('incomplete or mismatched invocations cannot create cases',()=>{
  const s=M.createState();
  assert.throws(()=>M.saveInvocationCase(s,'weekly',{id:'x',skillId:'sales',query:'q',output:'o'}));
  assert.throws(()=>M.saveInvocationCase(s,'weekly',{id:'x',skillId:'weekly',query:'',output:'o'}));
});

test('prototype routes template creation into chat without a debug tab',()=>{
  assert.match(html,/data-action="open-chat"/);
  assert.match(html,/data-action="chat-template-picker"/);
  assert.match(html,/chat-save-case/);
  assert.match(html,/在会话中使用/);
  assert.match(html,/直接保存为生效用例/);
  assert.match(html,/下一步：直接调用刚创建的 Skill/);
  assert.match(html,/调用完成后，结果底部会出现“保存为测评用例”/);
  assert.match(html,/\.chat-template-picker \.button\{justify-content:flex-start;text-align:left;width:100%\}/);
  assert.match(html,/\.chat-feed\{position:relative;min-height:0;flex:1;overflow-y:auto;overflow-x:hidden/);
  assert.match(html,/class="chat-user-bubble"/);
  assert.match(html,/class="chat-sender"/);
  assert.match(html,/class="chat-tool-trace"/);
  assert.match(html,/class="chat-composer-foot"[\s\S]*?技能创建/);
  assert.match(html,/请输入额外补充信息/);
  assert.doesNotMatch(html,/class="chat-head"/);
  assert.doesNotMatch(html,/\['debug','单次调试'\]|data-action="debug-run"|function debugView/);
});

console.log(`${count} conversation Skill flow checks passed. Prototype only.`);
