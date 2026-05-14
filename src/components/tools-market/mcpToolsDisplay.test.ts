import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getPresetCardBadges,
  getPresetToolDetails,
  type ToolCountFormatter,
} from './mcpToolsDisplay';
import type { WorkspaceMcpPreset } from './hooks/useWorkspaceMcpTools';

const formatToolCount: ToolCountFormatter = (count) => `${count} tools`;

function createPreset(overrides: Partial<WorkspaceMcpPreset> = {}): WorkspaceMcpPreset {
  return {
    id: 1,
    name: 'demo_data_query',
    displayName: 'Demo Data Query MCP',
    description: 'Demo internal MCP server for governed business metrics.',
    transport: 'http',
    status: 'available',
    dockerCompatible: true,
    toolCount: 2,
    tools: [
      { name: 'query_business_metrics', description: 'Run approved metric lookups.' },
      { name: 'lookup_customer_segment', description: 'Return governed segment metadata.' },
    ],
    installed: false,
    userSetupRequired: false,
    source: 'admin_published',
    containerPath: '/workspace/.mcp.json',
    appliesOn: 'next_agent_turn',
    ...overrides,
  };
}

test('preset cards expose only user-facing badges', () => {
  const badges = getPresetCardBadges(createPreset(), formatToolCount);

  assert.deepEqual(badges, [
    { key: 'transport', label: 'HTTP' },
    { key: 'toolCount', label: '2 tools' },
  ]);
});

test('preset details list tool names and descriptions', () => {
  const tools = getPresetToolDetails(createPreset({
    tools: [
      { name: 'query_business_metrics', description: 'Run approved metric lookups.' },
      { name: 'lookup_customer_segment' },
      { name: '  ' },
    ],
  }));

  assert.deepEqual(tools, [
    { name: 'query_business_metrics', description: 'Run approved metric lookups.' },
    { name: 'lookup_customer_segment', description: '' },
  ]);
});
