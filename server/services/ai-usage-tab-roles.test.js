import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './ai-usage-test-fixture.js';

test('Skill publisher grouping uses period publications, historical catalog, and distinct callers across Skills', t => {
  const f = fixture(t); f.batch();
  for (const [id, userId, date] of [['old',2,'2026-08-01'],['new',2,'2026-09-11'],['zero',3,'2026-09-11']]) {
    f.row({ id, dataset:'skill_publications', subjectId:id, userId, date, value:{ publisherUserId:userId, skillName:id } });
  }
  for (const [id, skill, caller] of [['a','old',3],['b','new',3],['c','new',4]]) {
    f.row({ id, dataset:'skill_invocations', subjectId:skill, userId:2, value:{ publisherUserId:2, callerUserId:caller, skillName:skill } });
  }
  const base = { from:'2026-09-01', to:'2026-09-12', groupBy:'publisher', pageSize:1 };
  const result = f.queryService.skills(f.access, base);
  assert.equal(result.total,2);
  assert.deepEqual([result.items[0].publisherUserId,result.items[0].publishedSkillCount,result.items[0].invocationCount,result.items[0].callerCount],[2,1,3,2]);
  assert.deepEqual(result.summary,{ publishedSkillCount:2, invocationCount:3, callerCount:2 });
  assert.deepEqual(f.queryService.skills(f.access,{...base,page:2}).summary,result.summary);
  assert.equal(f.queryService.skills(f.access,{...base,search:'old'}).summary.publishedSkillCount,0);
  assert.equal(f.queryService.skills(f.access,{...base,search:'new'}).summary.callerCount,2);
  assert.equal(f.queryService.skills(f.access,{...base,search:'missing'}).total,0);
  assert.equal(f.queryService.skills(f.access,{...base,userSearch:'member'}).items[0].invocationCount,0);
  assert.equal(f.queryService.skills(f.access,{...base,from:'2026-09-12'}).summary.publishedSkillCount,0);
  assert.equal(f.queryService.skills(f.access,{...base,groupBy:'skill',pageSize:100}).total,3);
  assert.throws(() => f.queryService.skills(f.access,{...base,groupBy:'workspace'}),{code:'invalidFilter'});
  assert.throws(() => f.queryService.skills(f.access,{...base,sortBy:'skillName'}),{code:'invalidFilter'});
});

test('AI groups exclude Skill-only facts; fixed overview still retains cumulative publications', t => {
  const f = fixture(t); f.batch();
  f.row({id:'skill',dataset:'skill_publications',subjectId:'only-skill',value:{publisherUserId:3}});
  f.row({id:'use',dataset:'interactions',workspaceId:8,userId:4});
  const result = f.queryService.analysis(f.access,{dataset:'usage',groupBy:'workspace'});
  assert.equal(result.total,1); assert.equal(result.items[0].groupKey,'8');
  assert.deepEqual(Object.keys(result.summary).sort(),['activeDurationMs','activeUserCount','sessionCount']);
  assert.equal(f.queryService.summary(f.access).publishedSkillCount,1);
});

test('template exploration isolates exact IDs even for same names and intersects outer filters', t => {
  const f = fixture(t); f.batch();
  for (const [id,userId,workspaceId] of [['one',3,7],['two',4,8]]) {
    f.row({id,dataset:'interactions',userId,workspaceId,sessionKey:id,value:{templateId:id,templateName:'Same name'}});
    f.row({id:`turn-${id}`,dataset:'turns',userId,workspaceId,value:{templateId:id,templateName:'Same name',durationMs:100,status:'completed'}});
  }
  const base = {dataset:'templates',templateId:'one',groupBy:'user'};
  const result=f.queryService.analysis(f.access,base);
  assert.equal(result.total,1); assert.equal(result.items[0].groupKey,'3');
  assert.equal(result.summary.sessionCount,1); assert.equal(result.summary.activeDurationMs,100);
  assert.equal(f.queryService.analysis(f.access,{...base,workspaceId:8}).total,0);
  assert.equal(f.queryService.analysis(f.access,{...base,userId:4}).total,0);
  assert.equal(f.queryService.analysis(f.access,{...base,templateId:'none'}).total,0);
  assert.throws(() => f.queryService.analysis(f.access,{...base,templateId:{bad:'one'}}),{code:'invalidFilter'});
  assert.throws(() => f.queryService.analysis(f.access,{...base,templateId:''}),{code:'invalidFilter'});
});
