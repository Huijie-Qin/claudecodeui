import assert from 'node:assert/strict';
import test from 'node:test';

import { acceptLatest, type EvaluationJob } from './types';

test('late polls cannot restore replaced reports or move task progress backward', () => {
  const latest = { id: 'new', generation: 2, version: 8 } as EvaluationJob;
  assert.equal(acceptLatest(latest, null), latest);
  assert.equal(acceptLatest(latest, { id: 'old', generation: 1, version: 99 } as EvaluationJob), latest);
  assert.equal(acceptLatest(latest, { ...latest, version: 7 }), latest);
  const next = { ...latest, version: 9 };
  assert.equal(acceptLatest(latest, next), next);
});
