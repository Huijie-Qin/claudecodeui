import assert from 'node:assert/strict';
import test from 'node:test';

import { acceptSkillCreationDraft, finishSkillCreationDraft } from './skillCreationDraft';

const draft = { mode: true, description: '创建周报技能', requestId: 'request', sent: '创建周报技能' };
test('accepted submission clears only the submitted text and retains request identity', () => {
  assert.deepEqual(acceptSkillCreationDraft(draft, draft.description), { ...draft, description: '' });
  const edited = { ...draft, description: '下一条需求' };
  assert.deepEqual(acceptSkillCreationDraft(edited, draft.description), edited);
});
test('completion exits creation mode only if no next draft has been entered', () => {
  const job = { status: 'completed', description: draft.description };
  assert.deepEqual(finishSkillCreationDraft({ ...draft, description: '' }, job), { mode: false, description: '' });
  assert.deepEqual(finishSkillCreationDraft({ ...draft, description: '下一条需求' }, job), { mode: true, description: '下一条需求' });
});
test('failure and cancellation restore submitted text only when the composer is empty', () => {
  for (const status of ['failed', 'cancelled', 'interrupted']) {
    const job = { status, description: draft.description };
    assert.deepEqual(finishSkillCreationDraft({ ...draft, description: '' }, job), { mode: true, description: draft.description });
    assert.deepEqual(finishSkillCreationDraft({ ...draft, description: '下一条需求' }, job), { mode: true, description: '下一条需求' });
  }
});
