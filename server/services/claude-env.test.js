import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { MULTITENANCY_SCHEMA_SQL } from '../database/multitenancy-schema.js';

import {
  BUILTIN_PERSONAL_ENV_DENY_RULES,
  ClaudeEnvError,
  MAX_CLAUDE_ENV_BATCH_TENANTS,
  createClaudeEnvService,
} from './claude-env.js';

const TEST_ENCRYPTION_SECRET = 'claude-env-service-test-secret';
const TEST_PERSONAL_ALLOWLIST = [
  ['ANTHROPIC_BASE_URL', 2048],
  ['ANTHROPIC_AUTH_TOKEN', 8192],
  ['ANTHROPIC_API_KEY', 8192],
  ['ANTHROPIC_MODEL', 256],
  ['DAS', 1024],
];

function createFixture({ adminUserEnv = {}, seedPersonalAllowlist = true } = {}) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL
    );
    INSERT INTO users (id, username) VALUES (1, 'alice'), (2, 'bob'), (9, 'admin');
  `);
  database.exec(MULTITENANCY_SCHEMA_SQL);
  if (seedPersonalAllowlist) {
    const insertAllowlist = database.prepare(`
      INSERT INTO claude_env_allowlist (name, max_length, enabled, updated_by_user_id)
      VALUES (?, ?, 1, 9)
    `);
    for (const [name, maxLength] of TEST_PERSONAL_ALLOWLIST) {
      insertAllowlist.run(name, maxLength);
    }
  }
  database.prepare(`
    INSERT INTO tenants (id, code, name) VALUES (10, 'tenant-ten', 'Tenant Ten')
  `).run();

  const users = {
    getEnvForUser: (userId) => userId === 1 ? { ...adminUserEnv } : {},
  };
  const service = createClaudeEnvService({
    database,
    users,
    encryptionSecret: TEST_ENCRYPTION_SECRET,
  });
  return { database, service };
}

test('schema starts with an empty allowlist and enforces global user versus tenant scope', () => {
  const { database } = createFixture({ seedPersonalAllowlist: false });
  try {
    assert.deepEqual(
      database.prepare(`
        SELECT name, max_length AS maxLength, enabled
        FROM claude_env_allowlist
        ORDER BY name
      `).all(),
      [],
    );

    assert.throws(() => database.prepare(`
      INSERT INTO claude_env_variables (scope_type, tenant_id, user_id, name, value)
      VALUES ('user', 10, 1, 'DAS', 'invalid')
    `).run(), /CHECK constraint failed/);
    assert.throws(() => database.prepare(`
      INSERT INTO claude_env_variables (scope_type, tenant_id, user_id, name, value)
      VALUES ('tenant', NULL, NULL, 'DAS', 'invalid')
    `).run(), /CHECK constraint failed/);
    database.prepare(`
      INSERT INTO claude_env_variables (scope_type, tenant_id, user_id, name, value)
      VALUES ('user', NULL, 1, 'CASE_TEST', 'first')
    `).run();
    assert.throws(() => database.prepare(`
      INSERT INTO claude_env_variables (scope_type, tenant_id, user_id, name, value)
      VALUES ('user', NULL, 1, 'case_test', 'second')
    `).run(), /UNIQUE constraint failed/);
  } finally {
    database.close();
  }
});

test('personal updates are explicit, transactional, allowlisted, and mask encrypted values', () => {
  const { database, service } = createFixture();
  try {
    const listed = service.updatePersonal(1, {
      actorUserId: 1,
      upserts: [
        { name: 'ANTHROPIC_MODEL', value: 'claude-sonnet', encrypted: false },
        { name: 'ANTHROPIC_AUTH_TOKEN', value: 'personal-secret', encrypted: true },
      ],
    });
    assert.equal(listed.length, 2);
    assert.equal(listed.find((entry) => entry.name === 'ANTHROPIC_MODEL').value, 'claude-sonnet');
    const tokenEntry = listed.find((entry) => entry.name === 'ANTHROPIC_AUTH_TOKEN');
    assert.equal(tokenEntry.encrypted, true);
    assert.equal(Object.hasOwn(tokenEntry, 'value'), false);

    const storedToken = database.prepare(`
      SELECT value FROM claude_env_variables
      WHERE scope_type = 'user' AND user_id = 1 AND name = 'ANTHROPIC_AUTH_TOKEN'
    `).get().value;
    assert.match(storedToken, /^secret:/);
    assert.equal(storedToken.includes('personal-secret'), false);

    assert.throws(
      () => service.updatePersonal(1, {
        upserts: [
          { name: 'DAS', value: 'would-have-been-valid' },
          { name: 'NOT_ALLOWLISTED', value: 'blocked' },
        ],
      }),
      (error) => error instanceof ClaudeEnvError && error.code === 'NOT_ALLOWLISTED',
    );
    assert.equal(service.listPersonal(1).some((entry) => entry.name === 'DAS'), false);

    const afterDelete = service.updatePersonal(1, { deletes: ['ANTHROPIC_MODEL'] });
    assert.deepEqual(afterDelete.map((entry) => entry.name), ['ANTHROPIC_AUTH_TOKEN']);

    const caseInsensitiveAllowlist = service.updatePersonal(1, {
      upserts: [{ name: 'anthropic_model', value: 'lowercase-name' }],
    });
    assert.equal(
      caseInsensitiveAllowlist.find((entry) => entry.name === 'anthropic_model')?.value,
      'lowercase-name',
    );
  } finally {
    database.close();
  }
});

test('personal maxLength is measured in UTF-8 bytes and allowlist replacement is atomic', () => {
  const { database, service } = createFixture();
  try {
    assert.deepEqual(service.replaceAllowlist([
      { name: 'DAS', maxLength: 4, enabled: false },
    ], { actorUserId: 9 }).map(({ name, maxLength, enabled }) => ({ name, maxLength, enabled })), [
      { name: 'DAS', maxLength: 4, enabled: true },
    ]);
    assert.equal(
      database.prepare("SELECT enabled FROM claude_env_allowlist WHERE name = 'DAS'").get().enabled,
      1,
    );
    database.prepare("UPDATE claude_env_allowlist SET enabled = 0 WHERE name = 'DAS'").run();
    service.updatePersonal(1, { upserts: [{ name: 'DAS', value: 'éé' }] });
    assert.equal(service.listAllowlist()[0].enabled, true);
    assert.throws(
      () => service.replaceAllowlist([
        { name: 'DAS', maxLength: 4, enabled: true },
        { name: 'das', maxLength: 4, enabled: true },
      ]),
      (error) => error instanceof ClaudeEnvError && error.code === 'DUPLICATE_ALLOWLIST_ENTRY',
    );
    assert.throws(
      () => service.updatePersonal(1, { upserts: [{ name: 'DAS', value: 'ééa' }] }),
      (error) => error instanceof ClaudeEnvError && error.code === 'VALUE_TOO_LONG',
    );
    assert.equal(service.listPersonal(1)[0].value, 'éé');
  } finally {
    database.close();
  }
});

test('allowlist replacement accepts an explicit empty array but rejects missing or invalid input', () => {
  const { database, service } = createFixture();
  try {
    assert.deepEqual(service.replaceAllowlist([], { actorUserId: 9 }), []);
    assert.deepEqual(service.listAllowlist(), []);
    assert.throws(
      () => service.replaceAllowlist(undefined, { actorUserId: 9 }),
      (error) => error instanceof ClaudeEnvError && error.code === 'INVALID_ALLOWLIST',
    );
    assert.throws(
      () => service.replaceAllowlist({}, { actorUserId: 9 }),
      (error) => error instanceof ClaudeEnvError && error.code === 'INVALID_ALLOWLIST',
    );
    assert.deepEqual(service.listAllowlist(), []);
  } finally {
    database.close();
  }
});

test('tenant values bypass personal allowlist but reject immutable managed keys', () => {
  const { database, service } = createFixture();
  try {
    const listed = service.updateTenant(10, {
      actorUserId: 9,
      upserts: [
        { name: 'TENANT_CUSTOM_FLAG', value: 'enabled' },
        { name: 'ANTHROPIC_API_KEY', value: 'tenant-secret', encrypted: true },
      ],
    });
    assert.equal(listed.find((entry) => entry.name === 'TENANT_CUSTOM_FLAG').value, 'enabled');
    assert.equal(Object.hasOwn(listed.find((entry) => entry.name === 'ANTHROPIC_API_KEY'), 'value'), false);
    assert.throws(
      () => service.updateTenant(10, { upserts: [{ name: 'W3_NAME', value: 'spoofed' }] }),
      (error) => error instanceof ClaudeEnvError && error.code === 'BUILTIN_DENY',
    );
    assert.equal(service.listTenant(10).some((entry) => entry.name === 'W3_NAME'), false);
  } finally {
    database.close();
  }
});

test('tenant batch updates deduplicate ids, apply explicit mutations, and mask encrypted values', () => {
  const { database, service } = createFixture();
  try {
    database.prepare(`
      INSERT INTO tenants (id, code, name) VALUES (11, 'tenant-eleven', 'Tenant Eleven')
    `).run();
    service.updateTenant(10, { upserts: [{ name: 'OLD_FLAG', value: 'old-ten' }] });
    service.updateTenant(11, { upserts: [{ name: 'OLD_FLAG', value: 'old-eleven' }] });

    const updated = service.updateTenants([10, '11', 10], {
      actorUserId: 9,
      upserts: [
        { name: 'SHARED_FLAG', value: 'enabled' },
        { name: 'TENANT_SECRET', value: 'batch-secret', encrypted: true },
      ],
      deletes: ['OLD_FLAG', 'old_flag'],
    });

    assert.deepEqual(updated.map((entry) => entry.tenantId), [10, 11]);
    for (const entry of updated) {
      assert.equal(entry.variables.some((variable) => variable.name === 'OLD_FLAG'), false);
      assert.equal(entry.variables.find((variable) => variable.name === 'SHARED_FLAG')?.value, 'enabled');
      const secret = entry.variables.find((variable) => variable.name === 'TENANT_SECRET');
      assert.equal(secret?.encrypted, true);
      assert.equal(Object.hasOwn(secret, 'value'), false);
    }

    const storedSecrets = database.prepare(`
      SELECT tenant_id, value, created_by_user_id, updated_by_user_id
      FROM claude_env_variables
      WHERE scope_type = 'tenant' AND name = 'TENANT_SECRET'
      ORDER BY tenant_id ASC
    `).all();
    assert.deepEqual(storedSecrets.map((row) => row.tenant_id), [10, 11]);
    assert.equal(storedSecrets.every((row) => /^secret:/.test(row.value)), true);
    assert.equal(storedSecrets.every((row) => !row.value.includes('batch-secret')), true);
    assert.equal(storedSecrets.every((row) => row.created_by_user_id === 9), true);
    assert.equal(storedSecrets.every((row) => row.updated_by_user_id === 9), true);
  } finally {
    database.close();
  }
});

test('tenant batch updates validate ids, active status, and explicit mutation arrays', () => {
  const { database, service } = createFixture();
  try {
    database.prepare(`
      INSERT INTO tenants (id, code, name, status)
      VALUES (11, 'tenant-disabled', 'Tenant Disabled', 'disabled')
    `).run();
    const mutation = { upserts: [], deletes: [] };

    assert.throws(
      () => service.updateTenants([], mutation),
      (error) => error instanceof ClaudeEnvError && error.code === 'INVALID_TENANT_IDS',
    );
    assert.throws(
      () => service.updateTenants([0], mutation),
      (error) => error instanceof ClaudeEnvError && error.code === 'INVALID_TENANT_IDS',
    );
    assert.throws(
      () => service.updateTenants(
        Array.from({ length: MAX_CLAUDE_ENV_BATCH_TENANTS + 1 }, () => 10),
        mutation,
      ),
      (error) => error instanceof ClaudeEnvError && error.code === 'INVALID_TENANT_IDS',
    );
    assert.throws(
      () => service.updateTenants([10], { deletes: [] }),
      (error) => error instanceof ClaudeEnvError && error.code === 'INVALID_UPSERTS',
    );
    assert.throws(
      () => service.updateTenants([10], { upserts: [] }),
      (error) => error instanceof ClaudeEnvError && error.code === 'INVALID_DELETES',
    );
    assert.throws(
      () => service.updateTenants([10, 999], {
        upserts: [{ name: 'SHOULD_NOT_EXIST', value: 'value' }],
        deletes: [],
      }),
      (error) => error instanceof ClaudeEnvError && error.code === 'TENANT_NOT_FOUND',
    );
    assert.equal(service.listTenant(10).some((entry) => entry.name === 'SHOULD_NOT_EXIST'), false);
    assert.throws(
      () => service.updateTenants([10, 11], {
        upserts: [{ name: 'SHOULD_NOT_EXIST', value: 'value' }],
        deletes: [],
      }),
      (error) => error instanceof ClaudeEnvError && error.code === 'TENANT_NOT_ACTIVE',
    );
    assert.equal(service.listTenant(10).some((entry) => entry.name === 'SHOULD_NOT_EXIST'), false);
  } finally {
    database.close();
  }
});

test('tenant batch updates roll back every tenant when a later write fails', () => {
  const { database, service } = createFixture();
  try {
    database.prepare(`
      INSERT INTO tenants (id, code, name) VALUES (11, 'tenant-eleven', 'Tenant Eleven')
    `).run();
    service.updateTenant(10, { upserts: [{ name: 'ATOMIC_FLAG', value: 'before-ten' }] });
    service.updateTenant(11, { upserts: [{ name: 'ATOMIC_FLAG', value: 'before-eleven' }] });
    database.exec(`
      CREATE TRIGGER reject_tenant_eleven_env_update
      BEFORE UPDATE OF value ON claude_env_variables
      WHEN OLD.scope_type = 'tenant' AND OLD.tenant_id = 11 AND OLD.name = 'ATOMIC_FLAG'
      BEGIN
        SELECT RAISE(ABORT, 'forced batch failure');
      END;
    `);

    assert.throws(
      () => service.updateTenants([10, 11], {
        upserts: [{ name: 'ATOMIC_FLAG', value: 'after' }],
        deletes: [],
      }),
      (error) => error instanceof ClaudeEnvError && error.code === 'CONFLICT',
    );
    assert.equal(service.listTenant(10).find((entry) => entry.name === 'ATOMIC_FLAG')?.value, 'before-ten');
    assert.equal(service.listTenant(11).find((entry) => entry.name === 'ATOMIC_FLAG')?.value, 'before-eleven');
  } finally {
    database.close();
  }
});

test('built-in process-loading rules cannot be bypassed through the allowlist', () => {
  const { database, service } = createFixture();
  try {
    service.replaceAllowlist([
      { name: 'LD_PRELOAD', maxLength: 4096, enabled: true },
      { name: 'Path', maxLength: 4096, enabled: true },
    ], { actorUserId: 9 });
    assert.throws(
      () => service.updatePersonal(1, { upserts: [{ name: 'LD_PRELOAD', value: '/tmp/inject.so' }] }),
      (error) => error instanceof ClaudeEnvError && error.code === 'BUILTIN_DENY',
    );
    assert.throws(
      () => service.updatePersonal(1, { upserts: [{ name: 'Path', value: '/tmp/untrusted' }] }),
      (error) => error instanceof ClaudeEnvError && error.code === 'BUILTIN_DENY',
    );
    assert.throws(
      () => service.updateTenant(10, { upserts: [{ name: 'LD_PRELOAD', value: '/tmp/inject.so' }] }),
      (error) => error instanceof ClaudeEnvError && error.code === 'BUILTIN_DENY',
    );
  } finally {
    database.close();
  }
});

test('platform deny rules remain enforced while retired personal rules are ignored and owner-guarded', () => {
  const { database, service } = createFixture();
  try {
    assert.equal(service.listBuiltinDenyRules().length, BUILTIN_PERSONAL_ENV_DENY_RULES.length);
    assert.equal(service.listBuiltinDenyRules().every((rule) => rule.immutable), true);

    const platformRule = service.createDenyRule({
      ownerType: 'platform',
      matchType: 'exact',
      pattern: 'ANTHROPIC_API_KEY',
      reason: 'Use the platform proxy',
      actorUserId: 9,
    });
    assert.equal(platformRule.createdByUserId, 9);
    assert.throws(
      () => service.updatePersonal(2, { upserts: [{ name: 'ANTHROPIC_API_KEY', value: 'blocked' }] }),
      (error) => error.code === 'PLATFORM_DENY',
    );

    const userRule = service.createDenyRule({
      ownerType: 'user',
      ownerUserId: 1,
      matchType: 'prefix',
      pattern: 'ANTHROPIC_',
      reason: 'Alice opted out',
    });
    const personal = service.updatePersonal(1, {
      upserts: [{ name: 'ANTHROPIC_MODEL', value: 'allowed-despite-history' }],
    });
    assert.equal(personal[0].blocked, false);
    assert.equal(personal[0].value, 'allowed-despite-history');
    assert.equal(Object.hasOwn(personal[0], 'blockedCode'), false);

    const resolved = service.resolveEffectiveEnv({ userId: 1, baseEnv: {} });
    assert.equal(resolved.env.ANTHROPIC_MODEL, 'allowed-despite-history');
    assert.equal(resolved.sources.ANTHROPIC_MODEL, 'personal');
    assert.equal(resolved.blockedVariables.some((entry) => entry.code === 'USER_DENY'), false);
    assert.equal(
      service.listDenyRules({ ownerType: 'user', ownerUserId: 1 })[0].enabled,
      true,
    );
    service.updatePersonal(2, { upserts: [{ name: 'ANTHROPIC_MODEL', value: 'allowed' }] });

    assert.throws(
      () => service.updateDenyRule(userRule.id, { enabled: false }, { ownerType: 'user', ownerUserId: 2 }),
      (error) => error.code === 'DENY_RULE_NOT_FOUND',
    );
    const disabled = service.updateDenyRule(
      userRule.id,
      { enabled: false, actorUserId: 1 },
      { ownerType: 'user', ownerUserId: 1 },
    );
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.updatedByUserId, 1);
    assert.equal(service.deleteDenyRule(userRule.id, { ownerType: 'user', ownerUserId: 2 }), false);
    assert.equal(service.deleteDenyRule(userRule.id, { ownerType: 'user', ownerUserId: 1 }), true);
  } finally {
    database.close();
  }
});

test('custom deny rules support case-insensitive exact, prefix, suffix, and contains matching', () => {
  const { database, service } = createFixture();
  try {
    service.replaceAllowlist([
      { name: 'case_exact', maxLength: 256, enabled: true },
      { name: 'prefix_value', maxLength: 256, enabled: true },
      { name: 'value_suffix', maxLength: 256, enabled: true },
      { name: 'has_middle_value', maxLength: 256, enabled: true },
      { name: 'order_target', maxLength: 256, enabled: true },
      { name: 'change_updated_fragment_value', maxLength: 256, enabled: true },
      { name: 'value_2_token', maxLength: 256, enabled: true },
      { name: 'has_123_value', maxLength: 256, enabled: true },
    ], { actorUserId: 9 });

    service.createDenyRule({
      ownerType: 'platform',
      matchType: 'exact',
      pattern: 'CASE_EXACT',
      reason: 'exact-match',
      actorUserId: 9,
    });
    service.createDenyRule({
      ownerType: 'platform',
      matchType: 'prefix',
      pattern: 'PreFix_',
      reason: 'prefix-match',
      actorUserId: 9,
    });
    service.createDenyRule({
      ownerType: 'platform',
      matchType: 'suffix',
      pattern: '_SuFfIx',
      reason: 'suffix-match',
      actorUserId: 9,
    });
    service.createDenyRule({
      ownerType: 'platform',
      matchType: 'contains',
      pattern: 'MiDdLe',
      reason: 'contains-match',
      actorUserId: 9,
    });

    const assertPlatformDenied = (name, reason) => assert.throws(
      () => service.updatePersonal(1, { upserts: [{ name, value: 'blocked' }] }),
      (error) => error instanceof ClaudeEnvError
        && error.code === 'PLATFORM_DENY'
        && error.message === reason,
    );
    assertPlatformDenied('case_exact', 'exact-match');
    assertPlatformDenied('prefix_value', 'prefix-match');
    assertPlatformDenied('value_suffix', 'suffix-match');
    assertPlatformDenied('has_middle_value', 'contains-match');

    const numericSuffixRule = service.createDenyRule({
      ownerType: 'platform',
      matchType: 'suffix',
      pattern: '2_ToKeN',
      reason: 'numeric-suffix-match',
      actorUserId: 9,
    });
    assertPlatformDenied('value_2_token', 'numeric-suffix-match');
    const numericContainsRule = service.createDenyRule({
      ownerType: 'platform',
      matchType: 'contains',
      pattern: '123',
      reason: 'numeric-contains-match',
      actorUserId: 9,
    });
    assertPlatformDenied('has_123_value', 'numeric-contains-match');

    const containsOrderRule = service.createDenyRule({
      ownerType: 'platform',
      matchType: 'contains',
      pattern: 'TARGET',
      reason: 'contains-order',
      actorUserId: 9,
    });
    const suffixOrderRule = service.createDenyRule({
      ownerType: 'platform',
      matchType: 'suffix',
      pattern: '_TARGET',
      reason: 'suffix-order',
      actorUserId: 9,
    });
    const prefixOrderRule = service.createDenyRule({
      ownerType: 'platform',
      matchType: 'prefix',
      pattern: 'ORDER_',
      reason: 'prefix-order',
      actorUserId: 9,
    });
    const exactOrderRule = service.createDenyRule({
      ownerType: 'platform',
      matchType: 'exact',
      pattern: 'ORDER_TARGET',
      reason: 'exact-order',
      actorUserId: 9,
    });
    assert.deepEqual(
      service.listDenyRules({ ownerType: 'platform' })
        .filter((rule) => new Set(['ORDER_TARGET', 'ORDER_', '_TARGET', 'TARGET'])
          .has(rule.pattern.toUpperCase()))
        .map((rule) => rule.matchType),
      ['exact', 'prefix', 'suffix', 'contains'],
    );
    assertPlatformDenied('order_target', 'exact-order');
    service.updateDenyRule(exactOrderRule.id, { enabled: false, actorUserId: 9 });
    assertPlatformDenied('order_target', 'prefix-order');
    service.updateDenyRule(prefixOrderRule.id, { enabled: false, actorUserId: 9 });
    assertPlatformDenied('order_target', 'suffix-order');
    service.updateDenyRule(suffixOrderRule.id, { enabled: false, actorUserId: 9 });
    assertPlatformDenied('order_target', 'contains-order');
    service.updateDenyRule(containsOrderRule.id, { enabled: false, actorUserId: 9 });

    const updatedRule = service.createDenyRule({
      ownerType: 'platform',
      matchType: 'prefix',
      pattern: 'NEVER_',
      reason: 'before-update',
      actorUserId: 9,
    });
    const suffixUpdated = service.updateDenyRule(updatedRule.id, {
      matchType: 'suffix',
      pattern: '_VaLuE',
      reason: 'updated-suffix',
      actorUserId: 9,
    });
    assert.equal(suffixUpdated.matchType, 'suffix');
    assertPlatformDenied('change_updated_fragment_value', 'updated-suffix');
    const containsUpdated = service.updateDenyRule(updatedRule.id, {
      matchType: 'contains',
      pattern: 'UPDATED_FRAGMENT',
      reason: 'updated-contains',
      actorUserId: 9,
    });
    assert.equal(containsUpdated.matchType, 'contains');
    assertPlatformDenied('change_updated_fragment_value', 'updated-contains');

    const numericUpdated = service.updateDenyRule(numericSuffixRule.id, {
      matchType: 'contains',
      pattern: '2_TOKEN',
      reason: 'numeric-updated-contains',
      actorUserId: 9,
    });
    assert.equal(numericUpdated.pattern, '2_TOKEN');
    assertPlatformDenied('value_2_token', 'numeric-updated-contains');

    assert.throws(
      () => service.createDenyRule({
        ownerType: 'platform',
        matchType: 'prefix',
        pattern: '123',
        actorUserId: 9,
      }),
      (error) => error instanceof ClaudeEnvError && error.code === 'INVALID_DENY_PATTERN',
    );
    assert.throws(
      () => service.updateDenyRule(numericContainsRule.id, { matchType: 'exact', actorUserId: 9 }),
      (error) => error instanceof ClaudeEnvError && error.code === 'INVALID_DENY_PATTERN',
    );

    assert.throws(
      () => service.createDenyRule({
        ownerType: 'platform',
        matchType: 'glob',
        pattern: 'INVALID',
        actorUserId: 9,
      }),
      (error) => error instanceof ClaudeEnvError && error.code === 'INVALID_MATCH_TYPE',
    );
    assert.throws(
      () => service.updateDenyRule(updatedRule.id, { matchType: 'regex', actorUserId: 9 }),
      (error) => error instanceof ClaudeEnvError && error.code === 'INVALID_MATCH_TYPE',
    );
  } finally {
    database.close();
  }
});

test('listPersonal reports records blocked by policy changes without revealing encrypted values', () => {
  const { database, service } = createFixture();
  try {
    service.updatePersonal(1, {
      upserts: [{ name: 'ANTHROPIC_AUTH_TOKEN', value: 'secret', encrypted: true }],
    });
    service.createDenyRule({
      ownerType: 'platform',
      matchType: 'exact',
      pattern: 'ANTHROPIC_AUTH_TOKEN',
      reason: 'Token disabled after configuration',
      actorUserId: 9,
    });
    const [entry] = service.listPersonal(1);
    assert.equal(entry.blocked, true);
    assert.equal(entry.blockedCode, 'PLATFORM_DENY');
    assert.equal(entry.blockedReason, 'Token disabled after configuration');
    assert.equal(Object.hasOwn(entry, 'value'), false);
  } finally {
    database.close();
  }
});

test('effective env applies global personal variables when tenant context is absent', () => {
  const { database, service } = createFixture({ adminUserEnv: { ADMIN_ONLY: 'admin' } });
  try {
    service.updatePersonal(1, {
      upserts: [{ name: 'ANTHROPIC_MODEL', value: 'personal-model' }],
    });
    const resolved = service.resolveEffectiveEnv({
      tenantId: null,
      userId: 1,
      baseEnv: { BASE_ONLY: 'base' },
      managedEnv: { W3_NAME: 'alice' },
    });
    assert.deepEqual(resolved.env, {
      BASE_ONLY: 'base',
      ADMIN_ONLY: 'admin',
      ANTHROPIC_MODEL: 'personal-model',
      W3_NAME: 'alice',
    });
    assert.deepEqual(resolved.sources, {
      BASE_ONLY: 'baseEnv',
      ADMIN_ONLY: 'adminUserEnv',
      ANTHROPIC_MODEL: 'personal',
      W3_NAME: 'managed',
    });
  } finally {
    database.close();
  }
});

test('effective env keeps precedence and credential isolation case-insensitive', () => {
  const { database, service } = createFixture({
    adminUserEnv: { LAYER_VALUE: 'admin' },
  });
  try {
    service.replaceAllowlist([
      { name: 'anthropic_base_url', maxLength: 2048, enabled: true },
      { name: 'layer_value', maxLength: 256, enabled: true },
    ], { actorUserId: 9 });
    service.updateTenant(10, {
      upserts: [
        { name: 'LaYeR_VaLuE', value: 'tenant' },
        { name: 'ANTHROPIC_AUTH_TOKEN', value: 'tenant-token', encrypted: true },
      ],
    });
    service.updatePersonal(1, {
      upserts: [
        { name: 'layer_value', value: 'personal' },
        { name: 'anthropic_base_url', value: 'https://personal.example' },
      ],
    });

    const resolved = service.resolveEffectiveEnv({
      tenantId: 10,
      userId: 1,
      baseEnv: { Layer_Value: 'base' },
    });

    assert.equal(resolved.env.layer_value, 'personal');
    assert.equal(resolved.sources.layer_value, 'personal');
    assert.equal(Object.keys(resolved.env).filter((name) => name.toUpperCase() === 'LAYER_VALUE').length, 1);
    assert.equal(resolved.env.anthropic_base_url, 'https://personal.example');
    assert.equal(
      Object.keys(resolved.env).some((name) => name.toUpperCase() === 'ANTHROPIC_AUTH_TOKEN'),
      false,
    );
    assert.equal(
      resolved.blockedVariables.some((entry) => (
        entry.name === 'ANTHROPIC_AUTH_TOKEN'
        && entry.code === 'PERSONAL_CREDENTIAL_GROUP_ISOLATION'
      )),
      true,
    );
  } finally {
    database.close();
  }
});

test('effective env resolves precedence, blocks stale personal values, and isolates credentials atomically', () => {
  const { database, service } = createFixture({
    adminUserEnv: {
      SHARED: 'admin',
      USER_KEY: 'legacy-user-key',
      ANTHROPIC_API_KEY: 'admin-api-key',
    },
  });
  try {
    service.updateTenant(10, {
      upserts: [
        { name: 'SHARED', value: 'tenant' },
        { name: 'ANTHROPIC_AUTH_TOKEN', value: 'tenant-token', encrypted: true },
        { name: 'ANTHROPIC_API_KEY', value: 'tenant-api-key', encrypted: true },
        { name: 'ANTHROPIC_MODEL', value: 'tenant-model' },
      ],
    });
    service.updatePersonal(1, {
      upserts: [
        { name: 'ANTHROPIC_BASE_URL', value: 'https://personal.example' },
        { name: 'ANTHROPIC_MODEL', value: 'personal-model' },
        { name: 'DAS', value: 'personal-das' },
      ],
    });
    service.createDenyRule({
      ownerType: 'platform',
      matchType: 'exact',
      pattern: 'DAS',
      reason: 'DAS was disabled',
      actorUserId: 9,
    });

    const resolved = service.resolveEffectiveEnv({
      tenantId: 10,
      userId: 1,
      baseEnv: {
        SHARED: 'base',
        BASE_ONLY: 'base-only',
        ANTHROPIC_AUTH_TOKEN: 'base-token',
      },
      managedEnv: {
        ANTHROPIC_MODEL: 'managed-model',
        W3_NAME: 'alice',
      },
    });

    assert.deepEqual(resolved.env, {
      SHARED: 'tenant',
      BASE_ONLY: 'base-only',
      USER_KEY: 'legacy-user-key',
      ANTHROPIC_MODEL: 'managed-model',
      ANTHROPIC_BASE_URL: 'https://personal.example',
      W3_NAME: 'alice',
    });
    assert.deepEqual(resolved.sources, {
      SHARED: 'tenant',
      BASE_ONLY: 'baseEnv',
      USER_KEY: 'adminUserEnv',
      ANTHROPIC_MODEL: 'managed',
      ANTHROPIC_BASE_URL: 'personal',
      W3_NAME: 'managed',
    });
    assert.equal(
      resolved.blockedVariables.some((entry) => entry.name === 'DAS' && entry.code === 'PLATFORM_DENY'),
      true,
    );
    assert.equal(
      resolved.blockedVariables.some((entry) => entry.name === 'ANTHROPIC_AUTH_TOKEN'
        && entry.code === 'PERSONAL_CREDENTIAL_GROUP_ISOLATION'),
      true,
    );
    assert.equal(
      resolved.blockedVariables.some((entry) => entry.name === 'ANTHROPIC_API_KEY'
        && entry.code === 'PERSONAL_CREDENTIAL_GROUP_ISOLATION'),
      true,
    );
  } finally {
    database.close();
  }
});
