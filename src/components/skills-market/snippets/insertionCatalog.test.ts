import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkspaceSkill } from '../utils/skillFormatting';

import { filterInsertionItems, mcpInsertionItems, mySkillInsertionItems } from './insertionCatalog';

test('my skills includes local and market-imported workspace copies but excludes system and current skill', () => {
  const skills = [
    { name: 'current', kind: 'unmanaged' },
    { name: 'local', kind: 'unmanaged', displayName: '本地技能', description: '本地分析' },
    { name: 'imported', kind: 'managed', origin: 'market' },
    { name: 'builtin', kind: 'system' },
  ] as WorkspaceSkill[];
  const items = mySkillInsertionItems(skills, 'current');
  assert.deepEqual(items.map((item) => item.name), ['local', 'imported']);
  assert.equal(items[0].label, '本地技能');
  assert.equal(filterInsertionItems(items, 'IMPORTED')[0].name, 'imported');
  assert.equal(filterInsertionItems(items, '分析')[0].name, 'local');
  assert.equal(filterInsertionItems(items, 'missing').length, 0);
});

test('MCP insertion retains qualified names and searches server, tool name and description', () => {
  const items = mcpInsertionItems([
    { name: 'mcp__docs__search', serverName: 'docs', serverDisplayName: '文档服务', description: '检索资料' },
    { name: 'mcp__data__search', serverName: 'data', description: '查询数据' },
    { name: 'mcp__data__search', serverName: 'data', description: '查询数据' },
  ]);
  assert.equal(items.length, 2);
  assert.equal(filterInsertionItems(items, '文档服务')[0].name, 'mcp__docs__search');
  assert.equal(filterInsertionItems(items, 'SEARCH').length, 2);
  assert.equal(filterInsertionItems(items, '查询')[0].name, 'mcp__data__search');
});
