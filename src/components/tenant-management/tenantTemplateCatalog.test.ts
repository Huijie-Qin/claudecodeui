import assert from 'node:assert/strict';
import test from 'node:test';

import { tenantTemplateSkillCandidates } from './tenantTemplateCatalog';

test('tenant templates use published preset IDs without collapsing duplicate names or crossing tenants', () => {
  const rows = tenantTemplateSkillCandidates([
    { id: 1, tenantId: 10, name: 'same', displayName: '同名技能' },
    { id: 2, tenantId: 10, name: 'same', displayName: '同名技能' },
    { id: 3, tenantId: 20, name: 'other', displayName: '其他租户' },
    { id: 0, tenantId: 10, name: 'bad', displayName: '无效' },
  ], 10);
  assert.deepEqual(rows.map(row => [row.tenantId, row.presetId, row.sourceRef, row.status]), [
    [10, 1, 'preset:1', 'published'], [10, 2, 'preset:2', 'published'],
  ]);
});
