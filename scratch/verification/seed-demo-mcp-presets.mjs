import Database from 'better-sqlite3';

const dbPath = process.env.DATABASE_PATH || '/Users/huijieqin/.cloudcli/auth.db';
const baseUrl = process.env.DEMO_MCP_BASE_URL || 'http://127.0.0.1:39999';
const token = process.env.DEMO_MCP_TOKEN || 'demo-internal-token';
const userId = Number(process.env.DEMO_MCP_USER_ID || 1);

const presets = [
  {
    name: 'demo_knowledge_retrieval',
    displayName: 'Demo Knowledge Retrieval MCP',
    description: 'Demo internal MCP server for searching internal documents and design notes.',
    path: '/knowledge',
    tools: [
      { name: 'search_internal_docs', description: 'Search internal product, engineering, and operation documents.' },
      { name: 'summarize_design_notes', description: 'Summarize internal design notes for the current workspace.' },
      { name: 'find_decision_records', description: 'Find architecture and product decision records.' },
    ],
  },
  {
    name: 'demo_data_query',
    displayName: 'Demo Data Query MCP',
    description: 'Demo internal MCP server for governed business metric and data lookups.',
    path: '/data-query',
    tools: [
      { name: 'query_business_metrics', description: 'Run approved internal metric lookups.' },
      { name: 'lookup_customer_segment', description: 'Return governed customer segment metadata.' },
    ],
  },
  {
    name: 'demo_workspace_insight',
    displayName: 'Demo Workspace Insight MCP',
    description: 'Demo internal MCP server for workspace health, dependency, and agent activity insights.',
    path: '/workspace-insight',
    tools: [
      { name: 'inspect_workspace_health', description: 'Inspect workspace health signals and repository metadata.' },
      { name: 'list_dependency_hotspots', description: 'List dependency and module hotspots for a workspace.' },
      { name: 'summarize_recent_agent_activity', description: 'Summarize recent agent activity visible to the workspace.' },
      { name: 'suggest_project_next_steps', description: 'Suggest next implementation steps from workspace context.' },
    ],
  },
];

const db = new Database(dbPath);
const tenants = db.prepare('select id, code, name from tenants order by id').all();

const upsert = db.prepare(`
  insert into mcp_server_presets (
    tenant_id,
    name,
    display_name,
    description,
    transport,
    config_json,
    status,
    docker_compatible,
    last_test_status,
    last_test_error,
    last_tested_at,
    tool_count,
    tools_json,
    created_by_user_id,
    updated_by_user_id,
    updated_at
  )
  values (
    @tenantId,
    @name,
    @displayName,
    @description,
    'http',
    @configJson,
    'published',
    1,
    'healthy',
    null,
    CURRENT_TIMESTAMP,
    @toolCount,
    @toolsJson,
    @userId,
    @userId,
    CURRENT_TIMESTAMP
  )
  on conflict(tenant_id, name) do update set
    display_name = excluded.display_name,
    description = excluded.description,
    transport = excluded.transport,
    config_json = excluded.config_json,
    status = excluded.status,
    docker_compatible = excluded.docker_compatible,
    last_test_status = excluded.last_test_status,
    last_test_error = excluded.last_test_error,
    last_tested_at = excluded.last_tested_at,
    tool_count = excluded.tool_count,
    tools_json = excluded.tools_json,
    updated_by_user_id = excluded.updated_by_user_id,
    updated_at = CURRENT_TIMESTAMP
`);

const transaction = db.transaction(() => {
  for (const tenant of tenants) {
    for (const preset of presets) {
      upsert.run({
        tenantId: tenant.id,
        name: preset.name,
        displayName: preset.displayName,
        description: preset.description,
        configJson: JSON.stringify({
          type: 'http',
          url: `${baseUrl}${preset.path}`,
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }),
        toolCount: preset.tools.length,
        toolsJson: JSON.stringify(preset.tools),
        userId,
      });
    }
  }
});

transaction();

const rows = db.prepare(`
  select tenant_id, name, display_name, status, tool_count
  from mcp_server_presets
  where name like 'demo_%'
  order by tenant_id, name
`).all();

console.table(rows);
console.log(`Seeded ${presets.length} demo MCP presets across ${tenants.length} tenants.`);
