import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { DATABASE_SCHEMA_SQL } from './schema.js';
import {
  CLAUDE_ENV_ALLOWLIST_DEFAULT_CLEANUP_MIGRATION_KEY,
  CLAUDE_ENV_PERSONAL_DENY_RETIREMENT_MIGRATION_KEY,
  MULTITENANCY_SCHEMA_SQL,
} from './multitenancy-schema.js';
import { createMultitenancyDb, initializeMultitenancyTables } from './multitenancy-db.js';

function createTestDb() {
  const database = new Database(':memory:');
  database.exec(DATABASE_SCHEMA_SQL);
  database.exec(MULTITENANCY_SCHEMA_SQL);
  return database;
}

function seedUser(database, username) {
  const result = database
    .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
    .run(username, `hash-${username}`);
  return Number(result.lastInsertRowid);
}

const LEGACY_CLAUDE_ALLOWLIST_DEFAULTS = [
  ['ANTHROPIC_BASE_URL', 2048],
  ['ANTHROPIC_AUTH_TOKEN', 8192],
  ['ANTHROPIC_API_KEY', 8192],
  ['ANTHROPIC_MODEL', 256],
  ['DAS', 1024],
];

function createAllowlistMigrationDb() {
  const database = new Database(':memory:');
  database.exec(DATABASE_SCHEMA_SQL);
  database.exec(MULTITENANCY_SCHEMA_SQL);
  return database;
}

function insertLegacyAllowlistDefaults(database, { updatedByUserId = null } = {}) {
  const insertAllowlist = database.prepare(`
    INSERT INTO claude_env_allowlist (
      name, max_length, enabled, updated_by_user_id
    ) VALUES (?, ?, 1, ?)
  `);
  for (const [name, maxLength] of LEGACY_CLAUDE_ALLOWLIST_DEFAULTS) {
    insertAllowlist.run(name, maxLength, updatedByUserId);
  }
}

test('multitenancy initialization migrates tenant production code column', () => {
  const database = new Database(':memory:');
  database.exec(DATABASE_SCHEMA_SQL);
  database.exec(`
    CREATE TABLE tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  initializeMultitenancyTables(database);

  const columns = database.prepare('PRAGMA table_info(tenants)').all().map((column) => column.name);
  assert.equal(columns.includes('prod_code'), true);
  assert.equal(columns.includes('tenant_id'), false);
  assert.equal(columns.includes('prod_tenant_id'), false);
});

test('multitenancy initialization copies legacy prod_tenant_id into prod_code', () => {
  const database = new Database(':memory:');
  database.exec(DATABASE_SCHEMA_SQL);
  database.exec(`
    CREATE TABLE tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      prod_tenant_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO tenants (code, name, prod_tenant_id)
    VALUES ('legacy', 'Legacy', 'prod-legacy');
  `);

  initializeMultitenancyTables(database);

  const tenant = database.prepare('SELECT code, prod_code FROM tenants WHERE code = ?').get('legacy');
  assert.deepEqual(tenant, { code: 'legacy', prod_code: 'prod-legacy' });
});

test('multitenancy initialization adds explicit skill market binding columns', () => {
  const database = new Database(':memory:');
  database.exec(DATABASE_SCHEMA_SQL);
  database.exec(`
    CREATE TABLE workspace_skill_market_imports (
      workspace_id INTEGER NOT NULL,
      skill_name TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      remote_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      nsp_path TEXT NOT NULL DEFAULT '',
      create_user_id TEXT,
      version INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'skill-market-api',
      imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (workspace_id, skill_name)
    );
  `);

  initializeMultitenancyTables(database);
  initializeMultitenancyTables(database);

  const columns = new Set(database.prepare('PRAGMA table_info(workspace_skill_market_imports)').all()
    .map((column) => column.name));
  assert.equal(columns.has('origin'), true);
  assert.equal(columns.has('binding_type'), true);
  assert.equal(columns.has('baseline_hash'), true);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM workspace_skill_market_imports').get().count, 0);
});

test('deleted workspace names and paths can be reused without reviving the deleted workspace', () => {
  const database = createTestDb();
  try {
    const mt = createMultitenancyDb(database);
    const ownerId = seedUser(database, 'workspace-recreate-owner');
    const tenant = mt.tenants.createTenant({ code: 'workspace-recreate', name: 'Workspace Recreate' });
    mt.memberships.upsertMembership({
      tenantId: tenant.id,
      userId: ownerId,
      role: 'member',
      permission: 'edit',
      status: 'active',
    });

    const deletedWorkspace = mt.workspaces.createWorkspace({
      tenantId: tenant.id,
      ownerUserId: ownerId,
      slug: 'same-name',
      displayName: 'Same Name',
      path: '/tmp/workspace-recreate/same-name',
    });
    assert.equal(mt.workspaces.markDeleted({ workspaceId: deletedWorkspace.id }), true);
    assert.equal(mt.workspaces.getWorkspaceByTenantSlug({
      tenantId: tenant.id,
      ownerUserId: ownerId,
      slug: 'same-name',
    }), null);

    const recreatedWorkspace = mt.workspaces.createWorkspace({
      tenantId: tenant.id,
      ownerUserId: ownerId,
      slug: 'same-name',
      displayName: 'Same Name Again',
      path: '/tmp/workspace-recreate/same-name',
    });

    assert.notEqual(recreatedWorkspace.id, deletedWorkspace.id);
    assert.equal(recreatedWorkspace.status, 'active');
    assert.equal(mt.workspaces.getWorkspaceByTenantSlug({
      tenantId: tenant.id,
      ownerUserId: ownerId,
      slug: 'same-name',
    })?.id, recreatedWorkspace.id);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count
      FROM workspaces
      WHERE tenant_id = ? AND owner_user_id = ? AND slug = ?
    `).get(tenant.id, ownerId, 'same-name').count, 2);
  } finally {
    database.close();
  }
});

test('workspace soft-delete uniqueness migration preserves history and is idempotent', () => {
  const database = createTestDb();
  try {
    const mt = createMultitenancyDb(database);
    const ownerId = seedUser(database, 'workspace-migration-owner');
    const viewerId = seedUser(database, 'workspace-migration-viewer');
    const tenant = mt.tenants.createTenant({ code: 'workspace-migration', name: 'Workspace Migration' });
    mt.memberships.upsertMembership({
      tenantId: tenant.id,
      userId: ownerId,
      role: 'member',
      permission: 'edit',
      status: 'active',
    });
    const workspace = mt.workspaces.createWorkspace({
      tenantId: tenant.id,
      ownerUserId: ownerId,
      slug: 'legacy-name',
      displayName: 'Legacy Name',
      path: '/tmp/workspace-migration/legacy-name',
    });
    database.prepare(`
      INSERT INTO workspace_acl (workspace_id, user_id, permission, created_by_user_id)
      VALUES (?, ?, 'view', ?)
    `).run(workspace.id, viewerId, ownerId);
    mt.workspaces.markDeleted({ workspaceId: workspace.id });

    database.pragma('foreign_keys = OFF');
    database.exec(`
      CREATE TABLE workspaces_legacy_unique (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        owner_user_id INTEGER NOT NULL,
        slug TEXT NOT NULL,
        display_name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (tenant_id, owner_user_id, slug),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      INSERT INTO workspaces_legacy_unique
      SELECT * FROM workspaces;
      DROP TABLE workspaces;
      ALTER TABLE workspaces_legacy_unique RENAME TO workspaces;
      CREATE INDEX idx_workspaces_tenant_owner ON workspaces(tenant_id, owner_user_id);
    `);
    database.pragma('foreign_keys = ON');

    initializeMultitenancyTables(database);
    initializeMultitenancyTables(database);

    const migratedTableSql = database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'
    `).get().sql.toLowerCase();
    assert.equal(migratedTableSql.includes('path text not null unique'), false);
    assert.equal(migratedTableSql.includes('unique (tenant_id, owner_user_id, slug)'), false);
    assert.deepEqual(database.pragma('foreign_key_check'), []);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM workspace_acl').get().count, 1);

    const migrated = createMultitenancyDb(database);
    const recreatedWorkspace = migrated.workspaces.createWorkspace({
      tenantId: tenant.id,
      ownerUserId: ownerId,
      slug: 'legacy-name',
      displayName: 'Legacy Name Again',
      path: '/tmp/workspace-migration/legacy-name',
    });
    assert.notEqual(recreatedWorkspace.id, workspace.id);
    assert.throws(() => migrated.workspaces.createWorkspace({
      tenantId: tenant.id,
      ownerUserId: ownerId,
      slug: 'legacy-name',
      displayName: 'Duplicate Active',
      path: '/tmp/workspace-migration/another-path',
    }), /UNIQUE constraint failed/);
  } finally {
    database.close();
  }
});

test('multitenancy initialization removes the complete untouched legacy Claude allowlist fingerprint once', () => {
  const database = createAllowlistMigrationDb();
  try {
    assert.deepEqual(database.prepare('SELECT * FROM claude_env_allowlist').all(), []);
    insertLegacyAllowlistDefaults(database);

    initializeMultitenancyTables(database);
    initializeMultitenancyTables(database);
    assert.deepEqual(database.prepare('SELECT * FROM claude_env_allowlist').all(), []);
    assert.equal(
      database.prepare('SELECT value FROM app_config WHERE key = ?')
        .get(CLAUDE_ENV_ALLOWLIST_DEFAULT_CLEANUP_MIGRATION_KEY)?.value,
      'removed',
    );

    insertLegacyAllowlistDefaults(database);
    initializeMultitenancyTables(database);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM claude_env_allowlist').get().count, 5);
  } finally {
    database.close();
  }
});

test('legacy allowlist cleanup preserves administrator-owned rows after actor deletion', () => {
  const database = createAllowlistMigrationDb();
  try {
    const adminId = seedUser(database, 'allowlist-admin');
    insertLegacyAllowlistDefaults(database, { updatedByUserId: adminId });

    initializeMultitenancyTables(database);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM claude_env_allowlist').get().count, 5);
    assert.equal(
      database.prepare('SELECT value FROM app_config WHERE key = ?')
        .get(CLAUDE_ENV_ALLOWLIST_DEFAULT_CLEANUP_MIGRATION_KEY)?.value,
      'preserved',
    );

    database.prepare('DELETE FROM users WHERE id = ?').run(adminId);
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM claude_env_allowlist WHERE updated_by_user_id IS NULL').get().count,
      5,
    );
    initializeMultitenancyTables(database);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM claude_env_allowlist').get().count, 5);
  } finally {
    database.close();
  }
});

test('legacy allowlist cleanup preserves the whole table for partial, modified, or extended fingerprints', () => {
  const partialDatabase = createAllowlistMigrationDb();
  const modifiedDatabase = createAllowlistMigrationDb();
  const extendedDatabase = createAllowlistMigrationDb();
  try {
    insertLegacyAllowlistDefaults(partialDatabase);
    partialDatabase.prepare("DELETE FROM claude_env_allowlist WHERE name = 'DAS'").run();
    initializeMultitenancyTables(partialDatabase);
    assert.equal(
      partialDatabase.prepare('SELECT COUNT(*) AS count FROM claude_env_allowlist').get().count,
      4,
    );

    insertLegacyAllowlistDefaults(modifiedDatabase);
    modifiedDatabase.prepare(`
      UPDATE claude_env_allowlist SET max_length = 8193 WHERE name = 'ANTHROPIC_AUTH_TOKEN'
    `).run();
    initializeMultitenancyTables(modifiedDatabase);
    assert.equal(
      modifiedDatabase.prepare('SELECT COUNT(*) AS count FROM claude_env_allowlist').get().count,
      5,
    );

    insertLegacyAllowlistDefaults(extendedDatabase);
    extendedDatabase.prepare(`
      INSERT INTO claude_env_allowlist (name, max_length, enabled)
      VALUES ('CUSTOM_ALLOWED', 256, 1)
    `).run();
    initializeMultitenancyTables(extendedDatabase);
    assert.equal(
      extendedDatabase.prepare('SELECT COUNT(*) AS count FROM claude_env_allowlist').get().count,
      6,
    );
  } finally {
    partialDatabase.close();
    modifiedDatabase.close();
    extendedDatabase.close();
  }
});

test('multitenancy initialization retires historical personal deny rules once without changing audit data', () => {
  const database = createTestDb();
  try {
    const aliceId = seedUser(database, 'retired-deny-alice');
    const adminId = seedUser(database, 'retired-deny-admin');
    const insertRule = database.prepare(`
      INSERT INTO claude_env_deny_rules (
        id, owner_type, owner_user_id, match_type, pattern, reason, enabled,
        created_by_user_id, updated_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertRule.run(
      21,
      'platform',
      null,
      'exact',
      'PLATFORM_KEY',
      'platform rule',
      1,
      adminId,
      adminId,
      '2026-01-02 03:04:05',
      '2026-02-03 04:05:06',
    );
    insertRule.run(
      22,
      'user',
      aliceId,
      'prefix',
      'PERSONAL_',
      'enabled historical rule',
      1,
      aliceId,
      adminId,
      '2026-03-04 05:06:07',
      '2026-04-05 06:07:08',
    );
    insertRule.run(
      23,
      'user',
      aliceId,
      'contains',
      'OLD',
      'already disabled rule',
      0,
      aliceId,
      aliceId,
      '2026-05-06 07:08:09',
      '2026-06-07 08:09:10',
    );

    initializeMultitenancyTables(database);

    assert.deepEqual(database.prepare(`
      SELECT
        id, owner_type, owner_user_id, match_type, pattern, reason, enabled,
        created_by_user_id, updated_by_user_id, created_at, updated_at
      FROM claude_env_deny_rules
      ORDER BY id ASC
    `).all(), [
      {
        id: 21,
        owner_type: 'platform',
        owner_user_id: null,
        match_type: 'exact',
        pattern: 'PLATFORM_KEY',
        reason: 'platform rule',
        enabled: 1,
        created_by_user_id: adminId,
        updated_by_user_id: adminId,
        created_at: '2026-01-02 03:04:05',
        updated_at: '2026-02-03 04:05:06',
      },
      {
        id: 22,
        owner_type: 'user',
        owner_user_id: aliceId,
        match_type: 'prefix',
        pattern: 'PERSONAL_',
        reason: 'enabled historical rule',
        enabled: 0,
        created_by_user_id: aliceId,
        updated_by_user_id: adminId,
        created_at: '2026-03-04 05:06:07',
        updated_at: '2026-04-05 06:07:08',
      },
      {
        id: 23,
        owner_type: 'user',
        owner_user_id: aliceId,
        match_type: 'contains',
        pattern: 'OLD',
        reason: 'already disabled rule',
        enabled: 0,
        created_by_user_id: aliceId,
        updated_by_user_id: aliceId,
        created_at: '2026-05-06 07:08:09',
        updated_at: '2026-06-07 08:09:10',
      },
    ]);
    assert.equal(
      database.prepare('SELECT value FROM app_config WHERE key = ?')
        .get(CLAUDE_ENV_PERSONAL_DENY_RETIREMENT_MIGRATION_KEY)?.value,
      'completed',
    );

    database.prepare('UPDATE claude_env_deny_rules SET enabled = 1 WHERE id = 22').run();
    initializeMultitenancyTables(database);
    assert.equal(
      database.prepare('SELECT enabled FROM claude_env_deny_rules WHERE id = 22').get().enabled,
      1,
    );
  } finally {
    database.close();
  }
});

test('multitenancy initialization safely rebuilds legacy Claude deny rules for new match types', () => {
  const database = new Database(':memory:');
  try {
    database.exec(DATABASE_SCHEMA_SQL);
    const aliceId = seedUser(database, 'claude-rule-alice');
    const adminId = seedUser(database, 'claude-rule-admin');
    database.exec(`
      CREATE TABLE claude_env_deny_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_type TEXT NOT NULL CHECK (owner_type IN ('platform', 'user')),
        owner_user_id INTEGER,
        match_type TEXT NOT NULL CHECK (match_type IN ('exact', 'prefix')),
        pattern TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_by_user_id INTEGER,
        updated_by_user_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        CHECK (
          (owner_type = 'platform' AND owner_user_id IS NULL)
          OR
          (owner_type = 'user' AND owner_user_id IS NOT NULL)
        ),
        FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE UNIQUE INDEX idx_claude_env_deny_rules_platform_unique_nocase
        ON claude_env_deny_rules(match_type, pattern COLLATE NOCASE)
        WHERE owner_type = 'platform';
      CREATE UNIQUE INDEX idx_claude_env_deny_rules_user_unique_nocase
        ON claude_env_deny_rules(owner_user_id, match_type, pattern COLLATE NOCASE)
        WHERE owner_type = 'user';
      CREATE INDEX idx_claude_env_deny_rules_active_owner
        ON claude_env_deny_rules(owner_type, owner_user_id, enabled);
      CREATE INDEX idx_claude_env_deny_rules_custom_reason
        ON claude_env_deny_rules(reason);
    `);
    database.prepare(`
      INSERT INTO claude_env_deny_rules (
        id, owner_type, owner_user_id, match_type, pattern, reason, enabled,
        created_by_user_id, updated_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      7,
      'platform',
      null,
      'exact',
      'PLATFORM_KEY',
      'platform reason',
      1,
      adminId,
      adminId,
      '2026-01-02 03:04:05',
      '2026-02-03 04:05:06',
    );
    database.prepare(`
      INSERT INTO claude_env_deny_rules (
        id, owner_type, owner_user_id, match_type, pattern, reason, enabled,
        created_by_user_id, updated_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      11,
      'user',
      aliceId,
      'prefix',
      'PERSONAL_',
      'personal reason',
      0,
      aliceId,
      adminId,
      '2026-03-04 05:06:07',
      '2026-04-05 06:07:08',
    );

    database.exec(`
      CREATE TABLE unrelated_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE unrelated_child (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES unrelated_parent(id)
      );
    `);
    database.pragma('foreign_keys = OFF');
    database.prepare('INSERT INTO unrelated_child (id, parent_id) VALUES (1, 999)').run();
    database.pragma('foreign_keys = ON');

    initializeMultitenancyTables(database);
    initializeMultitenancyTables(database);

    assert.deepEqual(database.prepare(`
      SELECT
        id, owner_type, owner_user_id, match_type, pattern, reason, enabled,
        created_by_user_id, updated_by_user_id, created_at, updated_at
      FROM claude_env_deny_rules
      ORDER BY id ASC
    `).all(), [
      {
        id: 7,
        owner_type: 'platform',
        owner_user_id: null,
        match_type: 'exact',
        pattern: 'PLATFORM_KEY',
        reason: 'platform reason',
        enabled: 1,
        created_by_user_id: adminId,
        updated_by_user_id: adminId,
        created_at: '2026-01-02 03:04:05',
        updated_at: '2026-02-03 04:05:06',
      },
      {
        id: 11,
        owner_type: 'user',
        owner_user_id: aliceId,
        match_type: 'prefix',
        pattern: 'PERSONAL_',
        reason: 'personal reason',
        enabled: 0,
        created_by_user_id: aliceId,
        updated_by_user_id: adminId,
        created_at: '2026-03-04 05:06:07',
        updated_at: '2026-04-05 06:07:08',
      },
    ]);

    const indexNames = new Set(
      database.prepare("PRAGMA index_list('claude_env_deny_rules')").all().map((index) => index.name),
    );
    assert.equal(indexNames.has('idx_claude_env_deny_rules_platform_unique_nocase'), true);
    assert.equal(indexNames.has('idx_claude_env_deny_rules_user_unique_nocase'), true);
    assert.equal(indexNames.has('idx_claude_env_deny_rules_active_owner'), true);
    assert.equal(indexNames.has('idx_claude_env_deny_rules_custom_reason'), true);

    const insertRule = database.prepare(`
      INSERT INTO claude_env_deny_rules (
        owner_type, owner_user_id, match_type, pattern, reason,
        created_by_user_id, updated_by_user_id
      ) VALUES ('platform', NULL, ?, ?, ?, ?, ?)
    `);
    const suffixResult = insertRule.run('suffix', '_TOKEN', 'suffix reason', adminId, adminId);
    insertRule.run('contains', 'SECRET', 'contains reason', adminId, adminId);
    assert.equal(Number(suffixResult.lastInsertRowid) > 11, true);
    assert.throws(
      () => insertRule.run('glob', 'INVALID', 'invalid reason', adminId, adminId),
      /CHECK constraint failed/,
    );
    assert.deepEqual(database.pragma('foreign_key_check(claude_env_deny_rules)'), []);
    assert.deepEqual(database.pragma('foreign_key_check'), [{
      table: 'unrelated_child',
      rowid: 1,
      parent: 'unrelated_parent',
      fkid: 0,
    }]);
    assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
  } finally {
    database.close();
  }
});

test('MCP tool preferences are isolated by workspace and user', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const ownerId = seedUser(database, 'mcp-owner');
  const viewerId = seedUser(database, 'mcp-viewer');
  const tenant = mt.tenants.createTenant({ code: 'mcp-team', name: 'MCP Team' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: ownerId, role: 'member', permission: 'edit', status: 'active' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: viewerId, role: 'member', permission: 'view', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: ownerId,
    slug: 'mcp-repo',
    displayName: 'MCP Repo',
    path: '/tmp/mcp-repo',
  });
  const preset = mt.mcpPresets.createPreset({
    tenantId: tenant.id,
    name: 'knowledge',
    displayName: 'Knowledge',
    description: '',
    config: { type: 'http', url: 'https://mcp.example.test' },
    status: 'published',
    createdByUserId: ownerId,
  });
  mt.mcpInstalls.upsertInstall({
    workspaceId: workspace.id,
    presetId: preset.id,
    installedByUserId: ownerId,
    probeStatus: 'healthy',
    toolCount: 2,
    tools: [{ name: 'search_docs' }, { name: 'delete_docs' }],
  });

  mt.mcpToolPreferences.setForUser({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    presetId: preset.id,
    allowedToolNames: ['search_docs'],
  });
  mt.mcpToolPreferences.setForUser({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: viewerId,
    presetId: preset.id,
    allowedToolNames: [],
  });

  assert.deepEqual(
    mt.mcpToolPreferences.listForUser({ tenantId: tenant.id, workspaceId: workspace.id, userId: ownerId })[0].allowedToolNames,
    ['search_docs'],
  );
  assert.deepEqual(
    mt.mcpToolPreferences.listForUser({ tenantId: tenant.id, workspaceId: workspace.id, userId: viewerId })[0].allowedToolNames,
    [],
  );
});

test('tenant membership controls visible tenants', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const userId = seedUser(database, 'alice');
  const otherUserId = seedUser(database, 'bob');
  const tenant = mt.tenants.createTenant({ code: 'acme', name: 'Acme' });
  const hiddenTenant = mt.tenants.createTenant({ code: 'hidden', name: 'Hidden' });

  mt.memberships.upsertMembership({
    tenantId: tenant.id,
    userId,
    role: 'member',
    permission: 'edit',
    status: 'active',
  });
  mt.memberships.upsertMembership({
    tenantId: hiddenTenant.id,
    userId: otherUserId,
    role: 'member',
    permission: 'edit',
    status: 'active',
  });

  assert.deepEqual(
    mt.tenants.listTenantsForUser(userId).map((row) => row.code),
    ['acme'],
  );
  assert.equal(mt.memberships.getActiveMembership(userId, tenant.id).permission, 'edit');
  assert.equal(mt.memberships.getActiveMembership(userId, hiddenTenant.id), null);
});

test('tenant codes can be created and updated', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);

  const tenant = mt.tenants.createTenant({
    code: 'external',
    name: 'External',
    prodCode: 'prod-code-001',
  });

  assert.equal(tenant.code, 'external');
  assert.equal(tenant.prod_code, 'prod-code-001');

  const updatedTenant = mt.tenants.updateTenantCodes({
    id: tenant.id,
    code: 'external-updated',
    prodCode: 'prod-code-002',
  });

  assert.equal(updatedTenant.code, 'external-updated');
  assert.equal(updatedTenant.prod_code, 'prod-code-002');
});

test('system admin access can be granted across active tenants', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const adminId = seedUser(database, 'admin');
  const activeTenant = mt.tenants.createTenant({ code: 'active', name: 'Active' });
  const disabledTenant = mt.tenants.createTenant({ code: 'disabled', name: 'Disabled', status: 'disabled' });

  const memberships = mt.memberships.grantSystemAdminAccessToAllTenants(adminId);

  assert.deepEqual(memberships.map((row) => row.tenant_id), [activeTenant.id]);
  assert.equal(mt.memberships.getActiveMembership(adminId, activeTenant.id).permission, 'edit');
  assert.equal(mt.memberships.getMembership(adminId, disabledTenant.id), null);
});

test('tenant memberships can be listed and deleted with workspace ACL cleanup', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const ownerId = seedUser(database, 'owner');
  const editorId = seedUser(database, 'editor');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });

  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: ownerId, role: 'member', permission: 'edit', status: 'active' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: editorId, role: 'member', permission: 'view', status: 'active' });

  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: ownerId,
    slug: 'app',
    displayName: 'App',
    path: '/tmp/cloudcli/team/owner/app',
  });
  mt.workspaceAcl.replaceAcl({
    workspaceId: workspace.id,
    ownerUserId: ownerId,
    entries: [{ userId: editorId, permission: 'view' }],
  });

  const listed = mt.memberships.listMemberships({ tenantId: tenant.id });
  assert.deepEqual(listed.map((row) => row.username), ['editor', 'owner']);

  assert.equal(mt.memberships.deleteMembership({ tenantId: tenant.id, userId: editorId }), true);
  assert.equal(mt.memberships.getMembership(editorId, tenant.id), null);
  assert.deepEqual(mt.workspaceAcl.listAcl(workspace.id), []);
});

test('workspace ACL grants access only inside the same tenant', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const ownerId = seedUser(database, 'owner');
  const editorId = seedUser(database, 'editor');
  const outsiderId = seedUser(database, 'outsider');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  const otherTenant = mt.tenants.createTenant({ code: 'other', name: 'Other' });

  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: ownerId, role: 'member', permission: 'edit', status: 'active' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: editorId, role: 'member', permission: 'edit', status: 'active' });
  mt.memberships.upsertMembership({ tenantId: otherTenant.id, userId: outsiderId, role: 'member', permission: 'edit', status: 'active' });

  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: ownerId,
    slug: 'app',
    displayName: 'App',
    path: '/tmp/cloudcli/team/owner/app',
  });

  mt.workspaceAcl.replaceAcl({
    workspaceId: workspace.id,
    ownerUserId: ownerId,
    entries: [{ userId: editorId, permission: 'edit' }],
  });

  assert.deepEqual(mt.workspaces.listVisibleWorkspaces({ tenantId: tenant.id, userId: ownerId }).map((row) => row.accessRole), ['owner']);
  assert.deepEqual(mt.workspaces.listVisibleWorkspaces({ tenantId: tenant.id, userId: editorId }).map((row) => row.accessRole), ['edit']);
  assert.deepEqual(mt.workspaces.listVisibleWorkspaces({ tenantId: tenant.id, userId: outsiderId }), []);
});

test('skill market imports are stored per workspace in the database', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const ownerId = seedUser(database, 'owner');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: ownerId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: ownerId,
    slug: 'app',
    displayName: 'App',
    path: '/tmp/cloudcli/team/owner/app',
  });
  const imports = mt.skillMarketImports.replaceForWorkspace({
    workspaceId: workspace.id,
    imports: {
      '中文技能': {
        name: '中文技能',
        skillId: 'cn-skill',
        id: 'remote-cn-skill',
        skillName: '中文技能',
        nspPath: 'mock://skills/cn-skill',
        createUserId: 'owner',
        version: 3,
        source: 'skill-market-api',
        origin: 'local',
        bindingType: 'published',
        baselineHash: 'abc123',
        importedAt: '2026-05-14T00:00:00.000Z',
        updatedAt: '2026-05-14T01:00:00.000Z',
      },
    },
  });

  assert.equal(imports.length, 1);
  assert.deepEqual(mt.skillMarketImports.listForWorkspace({ workspaceId: workspace.id }), [{
    name: '中文技能',
    skillId: 'cn-skill',
    id: 'remote-cn-skill',
    skillName: '中文技能',
    nspPath: 'mock://skills/cn-skill',
    createUserId: 'owner',
    version: 3,
    source: 'skill-market-api',
    origin: 'local',
    bindingType: 'published',
    baselineHash: 'abc123',
    importedAt: '2026-05-14T00:00:00.000Z',
    updatedAt: '2026-05-14T01:00:00.000Z',
  }]);

  assert.equal(mt.skillMarketImports.renameForWorkspace({
    workspaceId: workspace.id,
    currentName: '中文技能',
    nextName: '中文技能V2',
  }), true);
  assert.equal(mt.skillMarketImports.listForWorkspace({ workspaceId: workspace.id })[0].name, '中文技能V2');

  assert.equal(mt.skillMarketImports.deleteForWorkspace({ workspaceId: workspace.id, skillName: '中文技能V2' }), true);
  assert.deepEqual(mt.skillMarketImports.listForWorkspace({ workspaceId: workspace.id }), []);
});

test('sql check configuration resolves tenant defaults and user overrides', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const ownerId = seedUser(database, 'owner');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: ownerId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: ownerId,
    slug: 'app',
    displayName: 'App',
    path: '/tmp/cloudcli/team/owner/app',
  });
  const otherWorkspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: ownerId,
    slug: 'api',
    displayName: 'API',
    path: '/tmp/cloudcli/team/owner/api',
  });

  const tenantConfig = mt.sqlCheck.replaceTenantConfig({
    tenantId: tenant.id,
    ruleIds: ['require_where', 'limit_rows', 'require_where'],
  });
  assert.deepEqual(tenantConfig.ruleIds, ['require_where', 'limit_rows']);
  assert.deepEqual(mt.sqlCheck.getTenantConfig(tenant.id), {
    tenantId: tenant.id,
    ruleIds: ['require_where', 'limit_rows'],
  });

  assert.deepEqual(mt.sqlCheck.resolveUserConfig({ tenantId: tenant.id, workspaceId: workspace.id, userId: ownerId }), {
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    tenantRuleIds: ['require_where', 'limit_rows'],
    hasUserPreference: false,
    customEnabled: false,
    userRuleIds: [],
    effectiveRuleIds: ['require_where', 'limit_rows'],
    source: 'tenant',
  });

  assert.deepEqual(mt.sqlCheck.setUserPreference({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    customEnabled: true,
    ruleIds: ['limit_rows'],
  }), {
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    customEnabled: true,
    ruleIds: ['limit_rows'],
  });
  assert.deepEqual(mt.sqlCheck.resolveUserConfig({ tenantId: tenant.id, workspaceId: workspace.id, userId: ownerId }).effectiveRuleIds, ['limit_rows']);
  assert.deepEqual(mt.sqlCheck.resolveUserConfig({ tenantId: tenant.id, workspaceId: otherWorkspace.id, userId: ownerId }), {
    tenantId: tenant.id,
    workspaceId: otherWorkspace.id,
    userId: ownerId,
    tenantRuleIds: ['require_where', 'limit_rows'],
    hasUserPreference: false,
    customEnabled: false,
    userRuleIds: [],
    effectiveRuleIds: ['require_where', 'limit_rows'],
    source: 'tenant',
  });

  mt.sqlCheck.setUserPreference({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    customEnabled: false,
    ruleIds: ['limit_rows'],
  });
  assert.deepEqual(mt.sqlCheck.resolveUserConfig({ tenantId: tenant.id, workspaceId: workspace.id, userId: ownerId }), {
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    tenantRuleIds: ['require_where', 'limit_rows'],
    hasUserPreference: true,
    customEnabled: false,
    userRuleIds: ['limit_rows'],
    effectiveRuleIds: ['require_where', 'limit_rows'],
    source: 'tenant',
  });

  mt.sqlCheck.setUserPreference({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    customEnabled: true,
    ruleIds: ['require_where', 'limit_rows'],
  });
  assert.deepEqual(mt.sqlCheck.resolveUserConfig({ tenantId: tenant.id, workspaceId: workspace.id, userId: ownerId }), {
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    tenantRuleIds: ['require_where', 'limit_rows'],
    hasUserPreference: true,
    customEnabled: true,
    userRuleIds: ['require_where', 'limit_rows'],
    effectiveRuleIds: ['require_where', 'limit_rows'],
    source: 'user',
  });
});

test('mcp presets are isolated per tenant and can be filtered to published presets', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const adminId = seedUser(database, 'admin');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  const otherTenant = mt.tenants.createTenant({ code: 'other', name: 'Other' });

  const draft = mt.mcpPresets.createPreset({
    tenantId: tenant.id,
    name: 'knowledge',
    displayName: 'Knowledge MCP',
    description: 'Search internal docs',
    config: { type: 'http', url: 'https://mcp.internal/knowledge' },
    status: 'draft',
    createdByUserId: adminId,
  });
  const published = mt.mcpPresets.createPreset({
    tenantId: tenant.id,
    name: 'data-query',
    displayName: 'Data Query MCP',
    description: 'Run internal lookups',
    config: { type: 'http', url: 'https://mcp.internal/data' },
    preinstallScope: 'all_workspaces',
    status: 'published',
    createdByUserId: adminId,
  });
  mt.mcpPresets.createPreset({
    tenantId: tenant.id,
    name: 'disabled-search',
    displayName: 'Disabled Search MCP',
    description: 'Disabled preset',
    config: { type: 'http', url: 'https://mcp.internal/disabled' },
    status: 'disabled',
    createdByUserId: adminId,
  });
  mt.mcpPresets.createPreset({
    tenantId: otherTenant.id,
    name: 'knowledge',
    displayName: 'Other Tenant Knowledge MCP',
    description: 'Same name in another tenant is allowed',
    config: { type: 'http', url: 'https://mcp.other/knowledge' },
    status: 'published',
    createdByUserId: adminId,
  });

  assert.throws(() => mt.mcpPresets.createPreset({
    tenantId: tenant.id,
    name: 'knowledge',
    displayName: 'Duplicate Knowledge MCP',
    description: 'Duplicate preset',
    config: { type: 'http', url: 'https://mcp.internal/dupe' },
    status: 'draft',
    createdByUserId: adminId,
  }));

  assert.deepEqual(
    mt.mcpPresets.listPresets({ tenantId: tenant.id }).map((row) => row.name),
    ['data-query', 'disabled-search', 'knowledge'],
  );
  assert.deepEqual(
    mt.mcpPresets.listPresets({ tenantId: tenant.id, status: 'published' }).map((row) => row.id),
    [published.id],
  );
  assert.equal(published.preinstall_scope, 'all_workspaces');
  assert.deepEqual(
    mt.mcpPresets.listPresets({ tenantId: tenant.id, preinstallScope: 'all_workspaces' }).map((row) => row.id),
    [published.id],
  );
  assert.deepEqual(
    mt.mcpPresets.listPresets({ tenantId: tenant.id, includeDisabled: false }).map((row) => row.id),
    [published.id, draft.id],
  );
  assert.deepEqual(
    mt.mcpPresets.listPresets({ tenantId: otherTenant.id }).map((row) => row.display_name),
    ['Other Tenant Knowledge MCP'],
  );
});

test('updating an mcp preset clears stale validation metadata', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const adminId = seedUser(database, 'admin');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  const preset = mt.mcpPresets.createPreset({
    tenantId: tenant.id,
    name: 'knowledge',
    displayName: 'Knowledge MCP',
    description: 'Search internal docs',
    config: { type: 'http', url: 'https://mcp.internal/knowledge' },
    status: 'draft',
    createdByUserId: adminId,
  });
  mt.mcpPresets.recordPresetTest({
    tenantId: tenant.id,
    presetId: preset.id,
    status: 'healthy',
    toolCount: 2,
    tools: [{ name: 'search_docs' }, { name: 'read_doc' }],
    dockerCompatible: true,
    updatedByUserId: adminId,
  });

  const updated = mt.mcpPresets.updatePreset({
    tenantId: tenant.id,
    presetId: preset.id,
    name: 'knowledge',
    displayName: 'Knowledge MCP',
    description: 'Updated docs',
    config: { type: 'http', url: 'https://mcp.internal/updated' },
    status: 'draft',
    updatedByUserId: adminId,
  });

  assert.equal(updated.last_test_status, null);
  assert.equal(updated.last_test_error, null);
  assert.equal(updated.last_tested_at, null);
  assert.equal(updated.tool_count, 0);
  assert.deepEqual(updated.tools, []);
  assert.equal(updated.docker_compatible, 0);
});

test('mcp preset helper scripts are stored outside preset runtime config', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const adminId = seedUser(database, 'admin');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  const preset = mt.mcpPresets.createPreset({
    tenantId: tenant.id,
    name: 'knowledge',
    displayName: 'Knowledge MCP',
    description: 'Search internal docs',
    config: {
      type: 'http',
      url: 'https://mcp.internal/knowledge',
      headersHelper: 'python3 auth.py',
    },
    status: 'draft',
    createdByUserId: adminId,
  });

  const script = mt.mcpPresetHelperScripts.upsertScript({
    tenantId: tenant.id,
    presetId: preset.id,
    fileName: 'auth.py',
    content: 'print("secret")\n',
    uploadedByUserId: adminId,
  });
  const fetchedPreset = mt.mcpPresets.getPresetById({ tenantId: tenant.id, presetId: preset.id });
  const fetchedScript = mt.mcpPresetHelperScripts.getScript({ tenantId: tenant.id, presetId: preset.id });

  assert.equal(script.file_name, 'auth.py');
  assert.equal(script.size_bytes, Buffer.byteLength('print("secret")\n', 'utf8'));
  assert.equal(fetchedScript.content, 'print("secret")\n');
  assert.equal(Object.hasOwn(fetchedPreset.config, 'helperScript'), false);
  assert.equal(Object.hasOwn(fetchedPreset.config, 'scriptContent'), false);
});

test('mcp preset installs are idempotent per workspace and preset', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const adminId = seedUser(database, 'admin');
  const userId = seedUser(database, 'alice');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: userId,
    slug: 'repo',
    displayName: 'Repo',
    path: '/tmp/cloudcli/team/alice/repo',
  });
  const preset = mt.mcpPresets.createPreset({
    tenantId: tenant.id,
    name: 'knowledge',
    displayName: 'Knowledge MCP',
    description: 'Search internal docs',
    config: { type: 'http', url: 'https://mcp.internal/knowledge' },
    status: 'published',
    createdByUserId: adminId,
  });

  const first = mt.mcpInstalls.upsertInstall({
    workspaceId: workspace.id,
    presetId: preset.id,
    installedByUserId: userId,
    probeStatus: 'ok',
    probeError: null,
    toolCount: 2,
    tools: [{ name: 'search_docs' }],
  });
  const second = mt.mcpInstalls.upsertInstall({
    workspaceId: workspace.id,
    presetId: preset.id,
    installedByUserId: userId,
    probeStatus: 'ok',
    probeError: null,
    toolCount: 3,
    tools: [{ name: 'search_docs' }, { name: 'read_doc' }, { name: 'summarize_doc' }],
  });

  assert.equal(second.workspace_id, first.workspace_id);
  assert.equal(second.preset_id, first.preset_id);
  assert.equal(second.status, 'installed');
  assert.equal(second.tool_count, 3);
  assert.deepEqual(
    mt.mcpInstalls.listInstallsForWorkspace({ workspaceId: workspace.id }).map((row) => row.preset_id),
    [preset.id],
  );

  const probed = mt.mcpInstalls.recordProbe({
    workspaceId: workspace.id,
    presetId: preset.id,
    probeStatus: 'probe_failed',
    probeError: 'connection refused',
    toolCount: 0,
    tools: [],
  });

  assert.equal(probed.last_probe_status, 'probe_failed');
  assert.equal(probed.last_probe_error, 'connection refused');
  assert.equal(probed.tool_count, 0);

  assert.deepEqual(
    mt.mcpInstalls.listInstallsForPreset({
      tenantId: tenant.id,
      presetId: preset.id,
    }).map((row) => ({
      workspaceId: row.workspace_id,
      workspacePath: row.workspace_path,
    })),
    [{
      workspaceId: workspace.id,
      workspacePath: '/tmp/cloudcli/team/alice/repo',
    }],
  );

  const applied = mt.mcpInstalls.recordApplied({
    workspaceId: workspace.id,
    presetId: preset.id,
  });
  assert.equal(applied.last_probe_status, null);
  assert.equal(applied.last_probe_error, null);
  assert.equal(applied.tool_count, 0);
  assert.deepEqual(applied.tools, []);

  const removed = mt.mcpInstalls.removeInstall({ workspaceId: workspace.id, presetId: preset.id });

  assert.equal(removed.status, 'removed');
  assert.deepEqual(mt.mcpInstalls.listInstallsForWorkspace({ workspaceId: workspace.id }), []);
  assert.deepEqual(mt.mcpInstalls.listInstallsForPreset({
    tenantId: tenant.id,
    presetId: preset.id,
  }), []);
});

test('session index keeps shared workspace sessions private per user', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const ownerId = seedUser(database, 'owner');
  const editorId = seedUser(database, 'editor');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: ownerId, role: 'member', permission: 'edit', status: 'active' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: editorId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: ownerId,
    slug: 'repo',
    displayName: 'Repo',
    path: '/tmp/cloudcli/team/owner/repo',
  });
  mt.workspaceAcl.replaceAcl({
    workspaceId: workspace.id,
    ownerUserId: ownerId,
    entries: [{ userId: editorId, permission: 'edit' }],
  });

  mt.sessions.upsertSession({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    provider: 'claude',
    providerSessionId: 'owner-session',
    summary: 'Owner session',
    status: 'active',
  });
  mt.sessions.upsertSession({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: editorId,
    provider: 'claude',
    providerSessionId: 'editor-session',
    summary: 'Editor session',
    status: 'active',
  });

  assert.deepEqual(mt.sessions.listSessions({ tenantId: tenant.id, workspaceId: workspace.id, userId: ownerId }).map((row) => row.provider_session_id), ['owner-session']);
  assert.deepEqual(mt.sessions.listSessions({ tenantId: tenant.id, workspaceId: workspace.id, userId: editorId }).map((row) => row.provider_session_id), ['editor-session']);
  assert.equal(mt.sessions.findOwnedSession({ tenantId: tenant.id, userId: editorId, provider: 'claude', providerSessionId: 'owner-session' }), null);
});

test('session favorites persist per user and sort favorited sessions first', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const ownerId = seedUser(database, 'owner');
  const editorId = seedUser(database, 'editor');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: ownerId, role: 'member', permission: 'edit', status: 'active' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: editorId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: ownerId,
    slug: 'repo',
    displayName: 'Repo',
    path: '/tmp/cloudcli/team/owner/repo',
  });

  mt.sessions.upsertSession({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    provider: 'claude',
    providerSessionId: 'older-session',
    summary: 'Older session',
    status: 'active',
  });
  mt.sessions.upsertSession({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    provider: 'claude',
    providerSessionId: 'newer-session',
    summary: 'Newer session',
    status: 'active',
  });

  mt.sessionFavorites.setFavorite({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    provider: 'claude',
    providerSessionId: 'older-session',
    favorited: true,
  });

  assert.equal(mt.sessionFavorites.isFavorite({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    provider: 'claude',
    providerSessionId: 'older-session',
  }), true);
  assert.equal(mt.sessionFavorites.isFavorite({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: editorId,
    provider: 'claude',
    providerSessionId: 'older-session',
  }), false);
  assert.deepEqual(
    mt.sessions.listSessions({ tenantId: tenant.id, workspaceId: workspace.id, userId: ownerId })
      .map((row) => [row.provider_session_id, row.is_favorited]),
    [['older-session', 1], ['newer-session', 0]],
  );

  mt.sessionFavorites.setFavorite({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    provider: 'claude',
    providerSessionId: 'older-session',
    favorited: false,
  });

  assert.equal(mt.sessionFavorites.isFavorite({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    provider: 'claude',
    providerSessionId: 'older-session',
  }), false);
});

test('session index preserves scheduled task metadata on ordinary session updates', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const userId = seedUser(database, 'scheduled-user');
  const tenant = mt.tenants.createTenant({ code: 'scheduled-team', name: 'Scheduled Team' });
  mt.memberships.upsertMembership({
    tenantId: tenant.id,
    userId,
    role: 'member',
    permission: 'edit',
    status: 'active',
  });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: userId,
    slug: 'scheduled-repo',
    displayName: 'Scheduled Repo',
    path: '/tmp/cloudcli/scheduled-team/scheduled-user/repo',
  });

  mt.sessions.upsertSession({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId,
    provider: 'claude',
    providerSessionId: 'scheduled-run-1',
    summary: 'Scheduled run',
    metadata: { scheduledTaskId: 42 },
  });
  mt.sessions.upsertSession({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId,
    provider: 'claude',
    providerSessionId: 'scheduled-run-1',
    summary: 'Continued scheduled run',
    status: 'completed',
  });

  const session = mt.sessions.findOwnedSession({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId,
    provider: 'claude',
    providerSessionId: 'scheduled-run-1',
  });
  assert.deepEqual(JSON.parse(session.metadata_json), { scheduledTaskId: 42 });
});

test('agent session runtime binds provider session id for resume', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const userId = seedUser(database, 'alice');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: userId,
    slug: 'repo',
    displayName: 'Repo',
    path: '/tmp/cloudcli/team/alice/repo',
  });

  const runtime = mt.runtimes.createRuntime({
    runtimeId: 'runtime-1',
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    provider: 'claude',
    containerName: 'cloudcli-claude-t1-u1-w1-r1',
    image: 'cloudcli/test:claude',
    workspaceHostPath: workspace.path,
    runtimeHomePath: '/tmp/cloudcli/runtimes/runtime-1/home',
  });
  assert.equal(runtime.status, 'pending');
  assert.equal(runtime.provider_session_id, null);

  const bound = mt.runtimes.bindProviderSession({
    runtimeId: 'runtime-1',
    providerSessionId: 'claude-session-1',
  });

  assert.equal(bound.provider_session_id, 'claude-session-1');
  assert.equal(bound.status, 'active');
  assert.equal(
    mt.runtimes.findByProviderSession({
      tenantId: tenant.id,
      userId,
      workspaceId: workspace.id,
      provider: 'claude',
      providerSessionId: 'claude-session-1',
    }).runtime_id,
    'runtime-1',
  );
});

test('agent session runtime image updates preserve runtime identity and skip deleted rows', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const userId = seedUser(database, 'alice');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: userId,
    slug: 'repo',
    displayName: 'Repo',
    path: '/tmp/cloudcli/team/alice/repo',
  });

  mt.runtimes.createRuntime({
    runtimeId: 'runtime-1',
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    provider: 'claude',
    containerName: 'cloudcli-claude-t1-u1-w1-r1',
    image: 'cloudcli/test:old',
    workspaceHostPath: workspace.path,
    runtimeHomePath: '/tmp/cloudcli/runtimes/runtime-1/home',
  });
  mt.runtimes.bindProviderSession({
    runtimeId: 'runtime-1',
    providerSessionId: 'claude-session-1',
  });

  const updated = mt.runtimes.updateImage({
    runtimeId: 'runtime-1',
    image: 'cloudcli/test:new',
  });

  assert.equal(updated.image, 'cloudcli/test:new');
  assert.equal(updated.runtime_id, 'runtime-1');
  assert.equal(updated.provider_session_id, 'claude-session-1');
  assert.equal(updated.status, 'active');
  assert.equal(updated.container_name, 'cloudcli-claude-t1-u1-w1-r1');
  assert.equal(updated.runtime_home_path, '/tmp/cloudcli/runtimes/runtime-1/home');
  assert.equal(mt.runtimes.updateImage({ runtimeId: 'missing', image: 'cloudcli/test:new' }), null);

  mt.runtimes.updateStatus({ runtimeId: 'runtime-1', status: 'deleted' });
  assert.equal(mt.runtimes.updateImage({ runtimeId: 'runtime-1', image: 'cloudcli/test:later' }), null);
  const deleted = database.prepare('SELECT image, status FROM agent_session_runtime WHERE runtime_id = ?').get('runtime-1');
  assert.deepEqual(deleted, { image: 'cloudcli/test:new', status: 'deleted' });
});

test('agent session messages persist normalized history idempotently', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const userId = seedUser(database, 'alice');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: userId,
    slug: 'repo',
    displayName: 'Repo',
    path: '/tmp/cloudcli/team/alice/repo',
  });

  mt.runtimes.createRuntime({
    runtimeId: 'runtime-1',
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    provider: 'claude',
    containerName: 'cloudcli-claude-t1-u1-w1-r1',
    image: 'cloudcli/test:claude',
    workspaceHostPath: workspace.path,
    runtimeHomePath: '/tmp/cloudcli/runtimes/runtime-1/home',
  });

  const messages = [
    {
      id: 'msg-1',
      sessionId: 'claude-session-1',
      timestamp: '2026-04-26T00:00:00.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'user',
      content: 'hello',
    },
    {
      id: 'msg-2',
      sessionId: 'claude-session-1',
      timestamp: '2026-04-26T00:00:01.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'assistant',
      content: 'hi<|assistant|>',
    },
  ];

  mt.sessionMessages.upsertMessages({
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    runtimeId: 'runtime-1',
    provider: 'claude',
    providerSessionId: 'claude-session-1',
    messages,
  });
  mt.sessionMessages.upsertMessages({
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    runtimeId: 'runtime-1',
    provider: 'claude',
    providerSessionId: 'claude-session-1',
    messages,
  });

  const history = mt.sessionMessages.listMessages({
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    provider: 'claude',
    providerSessionId: 'claude-session-1',
    limit: null,
    offset: 0,
  });

  assert.equal(history.total, 2);
  assert.equal(history.hasMore, false);
  assert.deepEqual(history.messages.map((message) => message.id), ['msg-1', 'msg-2']);
  assert.equal(history.messages[1].content, 'hi');
});

test('agent session message history hides Claude meta messages from durable history', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const userId = seedUser(database, 'alice');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: userId,
    slug: 'repo',
    displayName: 'Repo',
    path: '/tmp/cloudcli/team/alice/repo',
  });

  mt.runtimes.createRuntime({
    runtimeId: 'runtime-1',
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    provider: 'claude',
    containerName: 'cloudcli-claude-t1-u1-w1-r1',
    image: 'cloudcli/test:claude',
    workspaceHostPath: workspace.path,
    runtimeHomePath: '/tmp/cloudcli/runtimes/runtime-1/home',
  });

  const changed = mt.sessionMessages.upsertMessages({
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    runtimeId: 'runtime-1',
    provider: 'claude',
    providerSessionId: 'claude-session-1',
    messages: [
      {
        id: 'skill-meta-new',
        sessionId: 'claude-session-1',
        timestamp: '2026-05-12T00:00:00.000Z',
        provider: 'claude',
        kind: 'text',
        role: 'user',
        isMeta: true,
        content: 'Base directory for this skill: /Users/song/.claude/skills/find-skills\n\n# Find Skills',
      },
      {
        id: 'visible-1',
        sessionId: 'claude-session-1',
        timestamp: '2026-05-12T00:00:02.000Z',
        provider: 'claude',
        kind: 'text',
        role: 'assistant',
        content: 'visible',
      },
    ],
  });

  assert.equal(changed, 1);

  database.prepare(`
    INSERT INTO agent_session_messages (
      tenant_id,
      workspace_id,
      user_id,
      runtime_id,
      provider,
      provider_session_id,
      message_id,
      kind,
      role,
      content_text,
      normalized_json,
      provider_timestamp,
      sequence
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tenant.id,
    workspace.id,
    userId,
    'runtime-1',
    'claude',
    'claude-session-1',
    'skill-meta-legacy',
    'text',
    'user',
    'Base directory for this skill: /Users/song/.claude/skills/find-skills\n\n# Find Skills',
    JSON.stringify({
      id: 'skill-meta-legacy',
      sessionId: 'claude-session-1',
      timestamp: '2026-05-12T00:00:01.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'user',
      content: 'Base directory for this skill: /Users/song/.claude/skills/find-skills\n\n# Find Skills',
    }),
    '2026-05-12T00:00:01.000Z',
    2,
  );

  const history = mt.sessionMessages.listMessages({
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    provider: 'claude',
    providerSessionId: 'claude-session-1',
    limit: null,
    offset: 0,
  });

  assert.equal(history.total, 1);
  assert.deepEqual(history.messages.map((message) => message.id), ['visible-1']);
});

test('agent session message pagination returns recent messages in chronological order', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const userId = seedUser(database, 'alice');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: userId,
    slug: 'repo',
    displayName: 'Repo',
    path: '/tmp/cloudcli/team/alice/repo',
  });

  mt.runtimes.createRuntime({
    runtimeId: 'runtime-1',
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    provider: 'claude',
    containerName: 'cloudcli-claude-t1-u1-w1-r1',
    image: 'cloudcli/test:claude',
    workspaceHostPath: workspace.path,
    runtimeHomePath: '/tmp/cloudcli/runtimes/runtime-1/home',
  });

  mt.sessionMessages.upsertMessages({
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    runtimeId: 'runtime-1',
    provider: 'claude',
    providerSessionId: 'claude-session-1',
    messages: ['1', '2', '3', '4'].map((id) => ({
      id: `msg-${id}`,
      sessionId: 'claude-session-1',
      timestamp: `2026-04-26T00:00:0${id}.000Z`,
      provider: 'claude',
      kind: 'text',
      role: 'assistant',
      content: `message ${id}`,
    })),
  });

  const page = mt.sessionMessages.listMessages({
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    provider: 'claude',
    providerSessionId: 'claude-session-1',
    limit: 2,
    offset: 1,
  });

  assert.equal(page.total, 4);
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.messages.map((message) => message.id), ['msg-2', 'msg-3']);
});

test('runtime monitor lists runtimes with tenant user and workspace context', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const tenant = mt.tenants.createTenant({ code: 'default', name: 'Default' });
  const user = { id: 1 };
  database.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'admin', 'hash')").run();
  mt.memberships.upsertMembership({
    tenantId: tenant.id,
    userId: user.id,
    role: 'member',
    permission: 'edit',
    status: 'active',
  });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: user.id,
    slug: 'demo',
    displayName: 'Demo Workspace',
    path: '/tmp/demo',
  });
  mt.runtimes.createRuntime({
    runtimeId: 'runtime-1',
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: user.id,
    provider: 'claude',
    providerSessionId: 'session-1',
    containerName: 'cloudcli-claude-demo',
    image: 'cloudcli/test:claude',
    workspaceHostPath: '/tmp/demo',
    runtimeHomePath: '/tmp/runtime/home',
    status: 'idle',
  });
  database.prepare("UPDATE workspaces SET status = 'deleted' WHERE id = ?").run(workspace.id);

  const result = mt.runtimes.listForMonitor({ limit: 20, offset: 0 });
  const row = mt.runtimes.getMonitorRowByRuntimeId('runtime-1');

  assert.equal(result.total, 1);
  assert.equal(result.rows[0].runtime_id, 'runtime-1');
  assert.equal(result.rows[0].tenant_code, 'default');
  assert.equal(result.rows[0].username, 'admin');
  assert.equal(result.rows[0].workspace_display_name, 'Demo Workspace');
  assert.equal(row.runtime_id, 'runtime-1');
  assert.equal(row.workspace_display_name, 'Demo Workspace');
});

test('runtime monitor filters by status and query text', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const tenant = mt.tenants.createTenant({ code: 'acme', name: 'Acme' });
  database.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'alice', 'hash')").run();
  mt.memberships.upsertMembership({
    tenantId: tenant.id,
    userId: 1,
    role: 'member',
    permission: 'edit',
    status: 'active',
  });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: 1,
    slug: 'alpha',
    displayName: 'Alpha',
    path: '/tmp/alpha',
  });
  mt.runtimes.createRuntime({
    runtimeId: 'runtime-active',
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: 1,
    provider: 'claude',
    providerSessionId: 'session-alpha',
    containerName: 'container-alpha',
    image: 'cloudcli/test:claude',
    workspaceHostPath: '/tmp/alpha',
    runtimeHomePath: '/tmp/runtime/alpha',
    status: 'active',
  });

  const active = mt.runtimes.listForMonitor({ status: 'active', q: 'alpha' });
  const idle = mt.runtimes.listForMonitor({ status: 'idle', q: 'alpha' });

  assert.equal(active.total, 1);
  assert.equal(active.rows[0].runtime_id, 'runtime-active');
  assert.equal(idle.total, 0);
});

test('runtime monitor accepts query-shaped pagination filters', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const tenant = mt.tenants.createTenant({ code: 'query', name: 'Query' });
  database.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'pager', 'hash')").run();
  mt.memberships.upsertMembership({
    tenantId: tenant.id,
    userId: 1,
    role: 'member',
    permission: 'edit',
    status: 'active',
  });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: 1,
    slug: 'pages',
    displayName: 'Pages',
    path: '/tmp/pages',
  });
  for (const runtimeId of ['runtime-first', 'runtime-second']) {
    mt.runtimes.createRuntime({
      runtimeId,
      tenantId: tenant.id,
      workspaceId: workspace.id,
      userId: 1,
      provider: 'claude',
      providerSessionId: `${runtimeId}-session`,
      containerName: `${runtimeId}-container`,
      image: 'cloudcli/test:claude',
      workspaceHostPath: '/tmp/pages',
      runtimeHomePath: `/tmp/runtime/${runtimeId}`,
      status: 'idle',
    });
  }

  const result = mt.runtimes.listForMonitor({ limit: '1', offset: '1' });

  assert.equal(result.total, 2);
  assert.equal(result.limit, 1);
  assert.equal(result.offset, 1);
  assert.deepEqual(result.rows.map((row) => row.runtime_id), ['runtime-first']);
});

test('runtime monitor selects expired idle runtimes only', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  database.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'owner', 'hash')").run();
  mt.memberships.upsertMembership({
    tenantId: tenant.id,
    userId: 1,
    role: 'member',
    permission: 'edit',
    status: 'active',
  });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: 1,
    slug: 'work',
    displayName: 'Work',
    path: '/tmp/work',
  });
  for (const [runtimeId, status] of [['old-idle', 'idle'], ['old-active', 'active']]) {
    mt.runtimes.createRuntime({
      runtimeId,
      tenantId: tenant.id,
      workspaceId: workspace.id,
      userId: 1,
      provider: 'claude',
      providerSessionId: `${runtimeId}-session`,
      containerName: `${runtimeId}-container`,
      image: 'cloudcli/test:claude',
      workspaceHostPath: '/tmp/work',
      runtimeHomePath: `/tmp/runtime/${runtimeId}`,
      status,
    });
    database.prepare(`
      UPDATE agent_session_runtime
      SET last_used_at = datetime('now', '-45 minutes')
      WHERE runtime_id = ?
    `).run(runtimeId);
  }
  database.prepare("UPDATE workspaces SET status = 'deleted' WHERE id = ?").run(workspace.id);

  const expired = mt.runtimes.listExpiredIdleRuntimes({ olderThanMinutes: 30, limit: 10 });

  assert.deepEqual(expired.map((row) => row.runtime_id), ['old-idle']);
});

test('runtime monitor pages expired idle runtimes with a stable cursor', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  database.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'owner', 'hash')").run();
  mt.memberships.upsertMembership({
    tenantId: tenant.id,
    userId: 1,
    role: 'member',
    permission: 'edit',
    status: 'active',
  });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: 1,
    slug: 'work',
    displayName: 'Work',
    path: '/tmp/work',
  });
  for (const runtimeId of ['old-idle-1', 'old-idle-2', 'old-idle-3']) {
    mt.runtimes.createRuntime({
      runtimeId,
      tenantId: tenant.id,
      workspaceId: workspace.id,
      userId: 1,
      provider: 'claude',
      providerSessionId: `${runtimeId}-session`,
      containerName: `${runtimeId}-container`,
      image: 'cloudcli/test:claude',
      workspaceHostPath: '/tmp/work',
      runtimeHomePath: `/tmp/runtime/${runtimeId}`,
      status: 'idle',
    });
    database.prepare(`
      UPDATE agent_session_runtime
      SET last_used_at = datetime('now', '-45 minutes')
      WHERE runtime_id = ?
    `).run(runtimeId);
  }

  const firstPage = mt.runtimes.listExpiredIdleRuntimes({ olderThanMinutes: 30, limit: 2 });
  const secondPage = mt.runtimes.listExpiredIdleRuntimes({
    olderThanMinutes: 30,
    limit: 2,
    cursor: {
      lastUsedAt: firstPage[1].last_used_at,
      id: firstPage[1].id,
    },
  });

  assert.deepEqual(firstPage.map((row) => row.runtime_id), ['old-idle-1', 'old-idle-2']);
  assert.deepEqual(secondPage.map((row) => row.runtime_id), ['old-idle-3']);
});

test('runtime monitor revalidates one expired idle runtime by id', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  database.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'owner', 'hash')").run();
  mt.memberships.upsertMembership({
    tenantId: tenant.id,
    userId: 1,
    role: 'member',
    permission: 'edit',
    status: 'active',
  });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: 1,
    slug: 'work',
    displayName: 'Work',
    path: '/tmp/work',
  });
  for (const [runtimeId, status, age] of [
    ['old-idle', 'idle', '-45 minutes'],
    ['recent-idle', 'idle', '-5 minutes'],
    ['old-active', 'active', '-45 minutes'],
  ]) {
    mt.runtimes.createRuntime({
      runtimeId,
      tenantId: tenant.id,
      workspaceId: workspace.id,
      userId: 1,
      provider: 'claude',
      providerSessionId: `${runtimeId}-session`,
      containerName: `${runtimeId}-container`,
      image: 'cloudcli/test:claude',
      workspaceHostPath: '/tmp/work',
      runtimeHomePath: `/tmp/runtime/${runtimeId}`,
      status,
    });
    database.prepare(`
      UPDATE agent_session_runtime
      SET last_used_at = datetime('now', ?)
      WHERE runtime_id = ?
    `).run(age, runtimeId);
  }

  assert.equal(
    mt.runtimes.findExpiredIdleRuntimeById({
      runtimeId: 'old-idle',
      olderThanMinutes: 30,
    }).runtime_id,
    'old-idle',
  );
  assert.equal(mt.runtimes.findExpiredIdleRuntimeById({
    runtimeId: 'recent-idle',
    olderThanMinutes: 30,
  }), null);
  assert.equal(mt.runtimes.findExpiredIdleRuntimeById({
    runtimeId: 'old-active',
    olderThanMinutes: 30,
  }), null);
});
