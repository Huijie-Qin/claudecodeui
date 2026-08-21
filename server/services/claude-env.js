import crypto from 'node:crypto';

import { appConfigDb, db, userDb } from '../database/db.js';
import { decryptSecretString, encryptSecretString } from '../database/user-env.js';

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_NAME_FRAGMENT_PATTERN = /^[A-Za-z0-9_]+$/;
const OWNER_TYPES = new Set(['platform', 'user']);
const MATCH_TYPES = new Set(['exact', 'prefix', 'suffix', 'contains']);
const DENY_RULE_MATCH_ORDER_SQL = `
  CASE match_type
    WHEN 'exact' THEN 0
    WHEN 'prefix' THEN 1
    WHEN 'suffix' THEN 2
    WHEN 'contains' THEN 3
    ELSE 4
  END,
  LENGTH(pattern) DESC,
  pattern COLLATE NOCASE ASC,
  id ASC
`;
const ENCRYPTION_SECRET_CONFIG_KEY = 'user_key_encryption_secret';
export const MAX_CLAUDE_ENV_BATCH_TENANTS = 500;

export const PERSONAL_CREDENTIAL_ENV_NAMES = Object.freeze([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
]);
const PERSONAL_CREDENTIAL_ENV_NAME_KEYS = new Set(
  PERSONAL_CREDENTIAL_ENV_NAMES.map((name) => name.toUpperCase()),
);

export const BUILTIN_PERSONAL_ENV_DENY_RULES = Object.freeze([
  { matchType: 'exact', pattern: 'USER_KEY', reason: 'Managed per-user encryption identity' },
  { matchType: 'exact', pattern: 'W3_NAME', reason: 'Managed execution identity' },
  { matchType: 'exact', pattern: 'TENANT_ID', reason: 'Managed tenant identity' },
  { matchType: 'exact', pattern: 'WORKSPACE_ID', reason: 'Managed workspace identity' },
  { matchType: 'exact', pattern: 'PRIVATE_TOKEN', reason: 'Managed source-control credential' },
  { matchType: 'exact', pattern: 'HOME', reason: 'Managed runtime path' },
  { matchType: 'exact', pattern: 'PATH', reason: 'Managed runtime path' },
  { matchType: 'exact', pattern: 'USER', reason: 'Managed operating-system identity' },
  { matchType: 'exact', pattern: 'LOGNAME', reason: 'Managed operating-system identity' },
  { matchType: 'exact', pattern: 'SHELL', reason: 'Managed runtime shell' },
  { matchType: 'exact', pattern: 'NODE_OPTIONS', reason: 'Managed Node.js runtime options' },
  { matchType: 'exact', pattern: 'NODE_PATH', reason: 'Runtime module loading is protected' },
  { matchType: 'exact', pattern: 'LD_PRELOAD', reason: 'Native process loading is protected' },
  { matchType: 'exact', pattern: 'LD_LIBRARY_PATH', reason: 'Native process loading is protected' },
  { matchType: 'exact', pattern: 'DYLD_INSERT_LIBRARIES', reason: 'Native process loading is protected' },
  { matchType: 'exact', pattern: 'DYLD_LIBRARY_PATH', reason: 'Native process loading is protected' },
  { matchType: 'exact', pattern: 'BASH_ENV', reason: 'Shell startup loading is protected' },
  { matchType: 'exact', pattern: 'ENV', reason: 'Shell startup loading is protected' },
  { matchType: 'exact', pattern: 'PROMPT_COMMAND', reason: 'Shell startup execution is protected' },
  { matchType: 'prefix', pattern: 'GIT_AUTHOR_', reason: 'Managed Git identity' },
  { matchType: 'prefix', pattern: 'GIT_COMMITTER_', reason: 'Managed Git identity' },
  { matchType: 'prefix', pattern: 'CLOUDCLI_', reason: 'Managed CloudCLI runtime configuration' },
  { matchType: 'prefix', pattern: 'DOCKER_', reason: 'Managed container runtime configuration' },
].map((rule) => Object.freeze(rule)));

export class ClaudeEnvError extends Error {
  constructor(message, { code = 'CLAUDE_ENV_ERROR', statusCode = 400, details = null } = {}) {
    super(message);
    this.name = 'ClaudeEnvError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function getDefaultEncryptionSecret() {
  const configured = process.env.PROXY_ENCRYPTION_KEY;
  if (typeof configured === 'string' && configured.trim() !== '') {
    return configured;
  }

  let secret = appConfigDb.get(ENCRYPTION_SECRET_CONFIG_KEY);
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    appConfigDb.set(ENCRYPTION_SECRET_CONFIG_KEY, secret);
  }
  return secret;
}

function requirePositiveInteger(value, name) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new ClaudeEnvError(`${name} must be a positive integer`, { code: 'INVALID_ID' });
  }
  return normalized;
}

function normalizeOptionalPositiveInteger(value, name) {
  if (value === undefined || value === null || value === '') return null;
  return requirePositiveInteger(value, name);
}

function normalizeEnvName(value) {
  const name = String(value ?? '').trim();
  if (!ENV_NAME_PATTERN.test(name)) {
    throw new ClaudeEnvError('Environment variable names must use shell-safe syntax', {
      code: 'INVALID_ENV_NAME',
      details: { name },
    });
  }
  return name;
}

function normalizeRequiredValue(value, name) {
  if (value === undefined || value === null) {
    throw new ClaudeEnvError(`A value is required for ${name}`, {
      code: 'VALUE_REQUIRED',
      details: { name },
    });
  }
  return String(value);
}

function assertNoNul(value, name) {
  if (value.includes('\0')) {
    throw new ClaudeEnvError(`${name} cannot contain NUL bytes`, {
      code: 'VALUE_CONTAINS_NUL',
      details: { name },
    });
  }
}

function normalizeBoolean(value, fallback = false) {
  return value === undefined ? fallback : value === true || value === 1;
}

function normalizeOwnerType(value) {
  const ownerType = String(value ?? '').trim();
  if (!OWNER_TYPES.has(ownerType)) {
    throw new ClaudeEnvError('ownerType must be one of: platform, user', { code: 'INVALID_OWNER_TYPE' });
  }
  return ownerType;
}

function normalizeMatchType(value) {
  const matchType = String(value ?? '').trim();
  if (!MATCH_TYPES.has(matchType)) {
    throw new ClaudeEnvError('matchType must be one of: exact, prefix, suffix, contains', {
      code: 'INVALID_MATCH_TYPE',
    });
  }
  return matchType;
}

function normalizePattern(value, matchType) {
  const pattern = String(value ?? '').trim();
  const patternMatcher = matchType === 'suffix' || matchType === 'contains'
    ? ENV_NAME_FRAGMENT_PATTERN
    : ENV_NAME_PATTERN;
  if (!patternMatcher.test(pattern)) {
    throw new ClaudeEnvError(
      'Deny-rule patterns must use letters, numbers, and underscores; exact/prefix patterns must begin with a letter or underscore',
      {
        code: 'INVALID_DENY_PATTERN',
        details: { matchType, pattern },
      },
    );
  }
  return pattern;
}

function normalizeReason(value) {
  const reason = String(value ?? '').trim();
  if (Buffer.byteLength(reason, 'utf8') > 1024) {
    throw new ClaudeEnvError('Deny-rule reasons must be 1024 UTF-8 bytes or fewer', {
      code: 'DENY_REASON_TOO_LONG',
    });
  }
  return reason;
}

function envNameKey(value) {
  return String(value).toUpperCase();
}

function matchesRule(name, rule) {
  const normalizedName = envNameKey(name);
  const normalizedPattern = envNameKey(rule.pattern);
  switch (rule.matchType) {
    case 'exact':
      return normalizedName === normalizedPattern;
    case 'prefix':
      return normalizedName.startsWith(normalizedPattern);
    case 'suffix':
      return normalizedName.endsWith(normalizedPattern);
    case 'contains':
      return normalizedName.includes(normalizedPattern);
    default:
      return false;
  }
}

function cloneBuiltinRule(rule) {
  return {
    ownerType: 'builtin',
    matchType: rule.matchType,
    pattern: rule.pattern,
    reason: rule.reason,
    enabled: true,
    immutable: true,
  };
}

function mapVariableRow(row, { block = null } = {}) {
  const result = {
    id: row.id,
    scopeType: row.scope_type,
    tenantId: row.tenant_id ?? null,
    userId: row.user_id ?? null,
    name: row.name,
    configured: true,
    encrypted: row.encrypted === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    blocked: Boolean(block),
  };
  if (row.encrypted !== 1) result.value = row.value;
  if (block) {
    result.blockedCode = block.code;
    result.blockedReason = block.reason;
    result.blockedBy = block.ownerType;
  }
  return result;
}

function mapAllowlistRow(row) {
  return {
    name: row.name,
    maxLength: row.max_length,
    // Presence in the allowlist is the activation state. Keep `enabled: true`
    // in the response for backwards compatibility with older clients.
    enabled: true,
    updatedByUserId: row.updated_by_user_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDenyRuleRow(row) {
  return {
    id: row.id,
    ownerType: row.owner_type,
    ownerUserId: row.owner_user_id ?? null,
    matchType: row.match_type,
    pattern: row.pattern,
    reason: row.reason,
    enabled: row.enabled === 1,
    createdByUserId: row.created_by_user_id ?? null,
    updatedByUserId: row.updated_by_user_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function copyStringEnvironment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name, entry]) => ENV_NAME_PATTERN.test(name) && entry !== undefined && entry !== null)
      .map(([name, entry]) => [name, String(entry)]),
  );
}

function normalizeUpserts(upserts) {
  if (upserts === undefined || upserts === null) return [];
  if (!Array.isArray(upserts)) {
    throw new ClaudeEnvError('upserts must be an array', { code: 'INVALID_UPSERTS' });
  }
  const seen = new Set();
  return upserts.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ClaudeEnvError('Each upsert must be an object', { code: 'INVALID_UPSERT' });
    }
    const name = normalizeEnvName(entry.name);
    const nameKey = envNameKey(name);
    if (seen.has(nameKey)) {
      throw new ClaudeEnvError(`Duplicate upsert for ${name}`, {
        code: 'DUPLICATE_ENV_OPERATION',
        details: { name },
      });
    }
    seen.add(nameKey);
    return {
      name,
      value: normalizeRequiredValue(entry.value, name),
      encrypted: entry.encrypted === true,
    };
  });
}

function normalizeDeletes(deletes, upsertNames) {
  if (deletes === undefined || deletes === null) return [];
  if (!Array.isArray(deletes)) {
    throw new ClaudeEnvError('deletes must be an array', { code: 'INVALID_DELETES' });
  }
  const seen = new Set();
  return deletes.map(normalizeEnvName).filter((name) => {
    const nameKey = envNameKey(name);
    if (seen.has(nameKey)) return false;
    if (upsertNames.has(nameKey)) {
      throw new ClaudeEnvError(`${name} cannot be both upserted and deleted`, {
        code: 'DUPLICATE_ENV_OPERATION',
        details: { name },
      });
    }
    seen.add(nameKey);
    return true;
  });
}

function normalizeTenantIds(tenantIds) {
  if (!Array.isArray(tenantIds) || tenantIds.length === 0) {
    throw new ClaudeEnvError('tenantIds must be a non-empty array', {
      code: 'INVALID_TENANT_IDS',
    });
  }
  if (tenantIds.length > MAX_CLAUDE_ENV_BATCH_TENANTS) {
    throw new ClaudeEnvError(
      `tenantIds cannot contain more than ${MAX_CLAUDE_ENV_BATCH_TENANTS} entries`,
      { code: 'INVALID_TENANT_IDS' },
    );
  }

  const seen = new Set();
  const normalizedTenantIds = [];
  for (const value of tenantIds) {
    let tenantId;
    try {
      tenantId = requirePositiveInteger(value, 'tenantId');
    } catch {
      throw new ClaudeEnvError('tenantIds must contain only positive integers', {
        code: 'INVALID_TENANT_IDS',
        details: { tenantId: value },
      });
    }
    if (seen.has(tenantId)) continue;
    seen.add(tenantId);
    normalizedTenantIds.push(tenantId);
  }
  return normalizedTenantIds;
}

function translateConstraintError(error, fallbackMessage) {
  if (error instanceof ClaudeEnvError) return error;
  if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) {
    return new ClaudeEnvError(fallbackMessage, { code: 'CONFLICT', statusCode: 409 });
  }
  return error;
}

export function createClaudeEnvService({
  database = db,
  users = userDb,
  encryptionSecret = getDefaultEncryptionSecret,
} = {}) {
  const readEncryptionSecret = () => {
    const value = typeof encryptionSecret === 'function' ? encryptionSecret() : encryptionSecret;
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ClaudeEnvError('Environment variable encryption is not configured', {
        code: 'ENCRYPTION_NOT_CONFIGURED',
        statusCode: 500,
      });
    }
    return value;
  };

  const encryptValue = (value) => encryptSecretString(value, { secretMaterial: readEncryptionSecret() });
  const decryptValue = (row) => row.encrypted === 1
    ? decryptSecretString(row.value, { secretMaterial: readEncryptionSecret() })
    : row.value;

  const listVariableRows = ({ scopeType, tenantId = null, userId = null }) => {
    if (scopeType === 'tenant') {
      return database.prepare(`
        SELECT *
        FROM claude_env_variables
        WHERE scope_type = 'tenant' AND tenant_id = ?
        ORDER BY name COLLATE BINARY ASC
      `).all(tenantId);
    }
    return database.prepare(`
      SELECT *
      FROM claude_env_variables
      WHERE scope_type = 'user' AND user_id = ?
      ORDER BY name COLLATE BINARY ASC
    `).all(userId);
  };

  const findPlatformRule = (name) => {
    const rows = database.prepare(`
      SELECT *
      FROM claude_env_deny_rules
      WHERE owner_type = 'platform' AND enabled = 1
      ORDER BY ${DENY_RULE_MATCH_ORDER_SQL}
    `).all();
    return rows.find((row) => matchesRule(name, {
      matchType: row.match_type,
      pattern: row.pattern,
    })) ?? null;
  };

  const findBuiltinBlock = (name) => {
    const rule = BUILTIN_PERSONAL_ENV_DENY_RULES.find((candidate) => matchesRule(name, candidate));
    return rule ? {
      code: 'BUILTIN_DENY',
      ownerType: 'builtin',
      reason: rule.reason,
      rule: cloneBuiltinRule(rule),
    } : null;
  };

  const findPersonalBlock = (name, value = null) => {
    const builtin = findBuiltinBlock(name);
    if (builtin) return builtin;

    const platformRule = findPlatformRule(name);
    if (platformRule) {
      return {
        code: 'PLATFORM_DENY',
        ownerType: 'platform',
        reason: platformRule.reason || 'Blocked by platform policy',
        rule: mapDenyRuleRow(platformRule),
      };
    }

    const allowlist = database.prepare(`
      SELECT * FROM claude_env_allowlist WHERE name = ? COLLATE NOCASE
    `).get(name);
    if (!allowlist) {
      return {
        code: 'NOT_ALLOWLISTED',
        ownerType: 'allowlist',
        reason: 'Environment variable is not on the personal allowlist',
      };
    }
    if (value !== null && Buffer.byteLength(value, 'utf8') > allowlist.max_length) {
      return {
        code: 'VALUE_TOO_LONG',
        ownerType: 'allowlist',
        reason: `${name} must be ${allowlist.max_length} UTF-8 bytes or fewer`,
        maxLength: allowlist.max_length,
      };
    }
    if (value !== null && value.includes('\0')) {
      return {
        code: 'VALUE_CONTAINS_NUL',
        ownerType: 'validation',
        reason: `${name} cannot contain NUL bytes`,
      };
    }
    return null;
  };

  const assertPersonalAllowed = (name, value) => {
    const block = findPersonalBlock(name, value);
    if (block) {
      throw new ClaudeEnvError(block.reason, {
        code: block.code,
        details: { name, block },
      });
    }
  };

  const assertTenantAllowed = (name, value) => {
    const block = findBuiltinBlock(name);
    if (block) {
      throw new ClaudeEnvError(block.reason, {
        code: block.code,
        details: { name, block },
      });
    }
    assertNoNul(value, name);
  };

  const runVariableUpdate = ({ scopeType, tenantId = null, userId = null, upserts, deletes, actorUserId }) => {
    const actorId = normalizeOptionalPositiveInteger(actorUserId, 'actorUserId');
    const upsertStatement = database.prepare(`
      INSERT INTO claude_env_variables (
        scope_type, tenant_id, user_id, name, value, encrypted,
        created_by_user_id, updated_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET
        value = excluded.value,
        encrypted = excluded.encrypted,
        updated_by_user_id = excluded.updated_by_user_id,
        updated_at = CURRENT_TIMESTAMP
    `);
    const deleteStatement = scopeType === 'tenant'
      ? database.prepare(`
          DELETE FROM claude_env_variables
          WHERE scope_type = 'tenant' AND tenant_id = ? AND name = ? COLLATE NOCASE
        `)
      : database.prepare(`
          DELETE FROM claude_env_variables
          WHERE scope_type = 'user' AND user_id = ? AND name = ? COLLATE NOCASE
        `);

    for (const entry of upserts) {
      if (scopeType === 'user') assertPersonalAllowed(entry.name, entry.value);
      else assertTenantAllowed(entry.name, entry.value);
    }
    for (const name of deletes) {
      deleteStatement.run(scopeType === 'tenant' ? tenantId : userId, name);
    }
    for (const entry of upserts) {
      upsertStatement.run(
        scopeType,
        tenantId,
        userId,
        entry.name,
        entry.encrypted ? encryptValue(entry.value) : entry.value,
        entry.encrypted ? 1 : 0,
        actorId,
        actorId,
      );
    }
  };

  const applyVariableUpdate = database.transaction(runVariableUpdate);

  const listPersonal = (userId) => {
    const normalizedUserId = requirePositiveInteger(userId, 'userId');
    return listVariableRows({ scopeType: 'user', userId: normalizedUserId }).map((row) => {
      let block;
      try {
        block = findPersonalBlock(row.name, decryptValue(row));
      } catch {
        block = {
          code: 'DECRYPTION_FAILED',
          ownerType: 'encryption',
          reason: 'Encrypted value cannot be decrypted',
        };
      }
      return mapVariableRow(row, { block });
    });
  };

  const updatePersonal = (userId, { upserts = [], deletes = [], actorUserId = userId } = {}) => {
    const normalizedUserId = requirePositiveInteger(userId, 'userId');
    const normalizedUpserts = normalizeUpserts(upserts);
    const normalizedDeletes = normalizeDeletes(
      deletes,
      new Set(normalizedUpserts.map((entry) => envNameKey(entry.name))),
    );
    try {
      applyVariableUpdate({
        scopeType: 'user',
        userId: normalizedUserId,
        upserts: normalizedUpserts,
        deletes: normalizedDeletes,
        actorUserId,
      });
    } catch (error) {
      throw translateConstraintError(error, 'Personal environment update conflicts with an existing record');
    }
    return listPersonal(normalizedUserId);
  };

  const listTenant = (tenantId) => {
    const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
    return listVariableRows({ scopeType: 'tenant', tenantId: normalizedTenantId }).map((row) => mapVariableRow(row));
  };

  const updateTenant = (tenantId, { upserts = [], deletes = [], actorUserId = null } = {}) => {
    const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
    const normalizedUpserts = normalizeUpserts(upserts);
    const normalizedDeletes = normalizeDeletes(
      deletes,
      new Set(normalizedUpserts.map((entry) => envNameKey(entry.name))),
    );
    try {
      applyVariableUpdate({
        scopeType: 'tenant',
        tenantId: normalizedTenantId,
        upserts: normalizedUpserts,
        deletes: normalizedDeletes,
        actorUserId,
      });
    } catch (error) {
      throw translateConstraintError(error, 'Tenant environment update conflicts with an existing record');
    }
    return listTenant(normalizedTenantId);
  };

  const updateTenants = (tenantIds, mutation) => {
    const normalizedTenantIds = normalizeTenantIds(tenantIds);
    if (!mutation || typeof mutation !== 'object' || Array.isArray(mutation)) {
      throw new ClaudeEnvError('A tenant environment mutation is required', {
        code: 'INVALID_TENANT_ENV_MUTATION',
      });
    }
    if (!Array.isArray(mutation.upserts)) {
      throw new ClaudeEnvError('upserts must be provided as an array', { code: 'INVALID_UPSERTS' });
    }
    if (!Array.isArray(mutation.deletes)) {
      throw new ClaudeEnvError('deletes must be provided as an array', { code: 'INVALID_DELETES' });
    }

    const normalizedUpserts = normalizeUpserts(mutation.upserts);
    const normalizedDeletes = normalizeDeletes(
      mutation.deletes,
      new Set(normalizedUpserts.map((entry) => envNameKey(entry.name))),
    );
    const actorUserId = normalizeOptionalPositiveInteger(mutation.actorUserId, 'actorUserId');
    const getTenant = database.prepare('SELECT id, status FROM tenants WHERE id = ?');
    const tenants = normalizedTenantIds.map((tenantId) => getTenant.get(tenantId));
    const missingTenantIds = normalizedTenantIds.filter((_tenantId, index) => !tenants[index]);
    if (missingTenantIds.length > 0) {
      throw new ClaudeEnvError('Tenant not found', {
        code: 'TENANT_NOT_FOUND',
        statusCode: 404,
        details: { tenantIds: missingTenantIds },
      });
    }
    const inactiveTenantIds = normalizedTenantIds.filter((_tenantId, index) => (
      tenants[index].status !== 'active'
    ));
    if (inactiveTenantIds.length > 0) {
      throw new ClaudeEnvError('Tenant is not active', {
        code: 'TENANT_NOT_ACTIVE',
        statusCode: 409,
        details: { tenantIds: inactiveTenantIds },
      });
    }

    const applyBatch = database.transaction(() => {
      for (const tenantId of normalizedTenantIds) {
        runVariableUpdate({
          scopeType: 'tenant',
          tenantId,
          upserts: normalizedUpserts,
          deletes: normalizedDeletes,
          actorUserId,
        });
      }
    });
    try {
      applyBatch();
    } catch (error) {
      throw translateConstraintError(error, 'Tenant environment batch update conflicts with an existing record');
    }
    return normalizedTenantIds.map((tenantId) => ({
      tenantId,
      variables: listTenant(tenantId),
    }));
  };

  const listAllowlist = () => database.prepare(`
    SELECT * FROM claude_env_allowlist ORDER BY name COLLATE BINARY ASC
  `).all().map(mapAllowlistRow);

  const replaceAllowlist = (entries, { actorUserId = null } = {}) => {
    if (!Array.isArray(entries)) {
      throw new ClaudeEnvError('Allowlist replacement requires an array', {
        code: 'INVALID_ALLOWLIST',
      });
    }
    const actorId = normalizeOptionalPositiveInteger(actorUserId, 'actorUserId');
    const seen = new Set();
    const normalizedEntries = entries.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new ClaudeEnvError('Each allowlist entry must be an object', { code: 'INVALID_ALLOWLIST_ENTRY' });
      }
      const name = normalizeEnvName(entry.name);
      const nameKey = envNameKey(name);
      if (seen.has(nameKey)) {
        throw new ClaudeEnvError(`Duplicate allowlist entry for ${name}`, { code: 'DUPLICATE_ALLOWLIST_ENTRY' });
      }
      seen.add(nameKey);
      const maxLength = Number(entry.maxLength ?? entry.max_length);
      if (!Number.isInteger(maxLength) || maxLength <= 0) {
        throw new ClaudeEnvError(`maxLength for ${name} must be a positive integer`, {
          code: 'INVALID_MAX_LENGTH',
          details: { name },
        });
      }
      return { name, maxLength };
    });

    const replace = database.transaction(() => {
      database.prepare('DELETE FROM claude_env_allowlist').run();
      const insert = database.prepare(`
        INSERT INTO claude_env_allowlist (name, max_length, enabled, updated_by_user_id)
        VALUES (?, ?, ?, ?)
      `);
      for (const entry of normalizedEntries) {
        insert.run(entry.name, entry.maxLength, 1, actorId);
      }
    });
    try {
      replace();
    } catch (error) {
      throw translateConstraintError(error, 'Allowlist replacement conflicts with an existing record');
    }
    return listAllowlist();
  };

  const listDenyRules = ({ ownerType = null, ownerUserId = null, includeDisabled = true } = {}) => {
    const filters = [];
    const params = [];
    if (ownerType !== null && ownerType !== undefined) {
      const normalizedOwnerType = normalizeOwnerType(ownerType);
      filters.push('owner_type = ?');
      params.push(normalizedOwnerType);
      if (normalizedOwnerType === 'platform' && ownerUserId != null) {
        throw new ClaudeEnvError('Platform deny rules cannot have an ownerUserId', { code: 'INVALID_RULE_OWNER' });
      }
    }
    if (ownerUserId !== null && ownerUserId !== undefined) {
      filters.push('owner_user_id = ?');
      params.push(requirePositiveInteger(ownerUserId, 'ownerUserId'));
    }
    if (!includeDisabled) filters.push('enabled = 1');
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    return database.prepare(`
      SELECT *
      FROM claude_env_deny_rules
      ${where}
      ORDER BY owner_type ASC, owner_user_id ASC, ${DENY_RULE_MATCH_ORDER_SQL}
    `).all(...params).map(mapDenyRuleRow);
  };

  const createDenyRule = ({
    ownerType,
    ownerUserId = null,
    matchType,
    pattern,
    reason = '',
    enabled = true,
    actorUserId = null,
  }) => {
    const normalizedOwnerType = normalizeOwnerType(ownerType);
    const normalizedOwnerUserId = normalizedOwnerType === 'user'
      ? requirePositiveInteger(ownerUserId, 'ownerUserId')
      : null;
    if (normalizedOwnerType === 'platform' && ownerUserId != null) {
      throw new ClaudeEnvError('Platform deny rules cannot have an ownerUserId', { code: 'INVALID_RULE_OWNER' });
    }
    const normalizedActorId = normalizeOptionalPositiveInteger(
      actorUserId ?? (normalizedOwnerType === 'user' ? normalizedOwnerUserId : null),
      'actorUserId',
    );
    const normalizedMatchType = normalizeMatchType(matchType);
    const normalizedPattern = normalizePattern(pattern, normalizedMatchType);
    try {
      const result = database.prepare(`
        INSERT INTO claude_env_deny_rules (
          owner_type, owner_user_id, match_type, pattern, reason, enabled,
          created_by_user_id, updated_by_user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalizedOwnerType,
        normalizedOwnerUserId,
        normalizedMatchType,
        normalizedPattern,
        normalizeReason(reason),
        normalizeBoolean(enabled, true) ? 1 : 0,
        normalizedActorId,
        normalizedActorId,
      );
      return mapDenyRuleRow(database.prepare(`
        SELECT * FROM claude_env_deny_rules WHERE id = ?
      `).get(Number(result.lastInsertRowid)));
    } catch (error) {
      throw translateConstraintError(error, 'An equivalent deny rule already exists');
    }
  };

  const updateDenyRule = (id, patch = {}, ownership = {}) => {
    const normalizedId = requirePositiveInteger(id, 'id');
    const current = database.prepare('SELECT * FROM claude_env_deny_rules WHERE id = ?').get(normalizedId);
    if (!current) {
      throw new ClaudeEnvError('Deny rule not found', { code: 'DENY_RULE_NOT_FOUND', statusCode: 404 });
    }
    if (ownership.ownerType != null && normalizeOwnerType(ownership.ownerType) !== current.owner_type) {
      throw new ClaudeEnvError('Deny rule not found', { code: 'DENY_RULE_NOT_FOUND', statusCode: 404 });
    }
    if (ownership.ownerUserId != null
      && requirePositiveInteger(ownership.ownerUserId, 'ownerUserId') !== current.owner_user_id) {
      throw new ClaudeEnvError('Deny rule not found', { code: 'DENY_RULE_NOT_FOUND', statusCode: 404 });
    }
    const actorId = normalizeOptionalPositiveInteger(patch.actorUserId, 'actorUserId');
    const effectiveMatchType = patch.matchType === undefined
      ? current.match_type
      : normalizeMatchType(patch.matchType);
    const effectivePattern = normalizePattern(
      patch.pattern === undefined ? current.pattern : patch.pattern,
      effectiveMatchType,
    );
    try {
      database.prepare(`
        UPDATE claude_env_deny_rules
        SET match_type = ?, pattern = ?, reason = ?, enabled = ?,
            updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        effectiveMatchType,
        effectivePattern,
        patch.reason === undefined ? current.reason : normalizeReason(patch.reason),
        patch.enabled === undefined ? current.enabled : (normalizeBoolean(patch.enabled) ? 1 : 0),
        actorId ?? current.updated_by_user_id,
        normalizedId,
      );
      return mapDenyRuleRow(database.prepare('SELECT * FROM claude_env_deny_rules WHERE id = ?').get(normalizedId));
    } catch (error) {
      throw translateConstraintError(error, 'An equivalent deny rule already exists');
    }
  };

  const deleteDenyRule = (id, ownership = {}) => {
    const normalizedId = requirePositiveInteger(id, 'id');
    const filters = ['id = ?'];
    const params = [normalizedId];
    if (ownership.ownerType != null) {
      filters.push('owner_type = ?');
      params.push(normalizeOwnerType(ownership.ownerType));
    }
    if (ownership.ownerUserId != null) {
      filters.push('owner_user_id = ?');
      params.push(requirePositiveInteger(ownership.ownerUserId, 'ownerUserId'));
    }
    return database.prepare(`
      DELETE FROM claude_env_deny_rules WHERE ${filters.join(' AND ')}
    `).run(...params).changes > 0;
  };

  const resolveEffectiveEnv = ({
    tenantId = null,
    userId,
    baseEnv = {},
    adminUserEnv,
    managedEnv = {},
  }) => {
    const normalizedTenantId = tenantId === null || tenantId === undefined || tenantId === ''
      ? null
      : requirePositiveInteger(tenantId, 'tenantId');
    const normalizedUserId = requirePositiveInteger(userId, 'userId');
    const env = {};
    const sources = {};
    const blockedVariables = [];
    const actualNameByKey = new Map();
    const setEffectiveValue = (name, value, source) => {
      const nameKey = envNameKey(name);
      const previousName = actualNameByKey.get(nameKey);
      if (previousName && previousName !== name) {
        delete env[previousName];
        delete sources[previousName];
      }
      env[name] = value;
      sources[name] = source;
      actualNameByKey.set(nameKey, name);
    };
    const deleteEffectiveValue = (name) => {
      const nameKey = envNameKey(name);
      const actualName = actualNameByKey.get(nameKey);
      if (!actualName) return null;
      const deleted = { name: actualName, source: sources[actualName] };
      delete env[actualName];
      delete sources[actualName];
      actualNameByKey.delete(nameKey);
      return deleted;
    };
    const applyLayer = (layer, source) => {
      for (const [name, value] of Object.entries(copyStringEnvironment(layer))) {
        setEffectiveValue(name, value, source);
      }
    };

    applyLayer(baseEnv, 'baseEnv');
    const legacyAdminEnv = adminUserEnv === undefined
      ? users?.getEnvForUser?.(normalizedUserId) || {}
      : adminUserEnv;

    if (normalizedTenantId !== null) {
      for (const row of listVariableRows({ scopeType: 'tenant', tenantId: normalizedTenantId })) {
        const builtin = findBuiltinBlock(row.name);
        if (builtin) {
          blockedVariables.push({
            name: row.name,
            source: 'tenant',
            code: builtin.code,
            reason: builtin.reason,
            blockedBy: builtin.ownerType,
          });
          continue;
        }
        try {
          setEffectiveValue(row.name, decryptValue(row), 'tenant');
        } catch {
          blockedVariables.push({
            name: row.name,
            source: 'tenant',
            code: 'DECRYPTION_FAILED',
            reason: 'Encrypted value cannot be decrypted',
            blockedBy: 'encryption',
          });
        }
      }
    }

    applyLayer(legacyAdminEnv, 'adminUserEnv');

    const activePersonal = [];
    for (const row of listVariableRows({ scopeType: 'user', userId: normalizedUserId })) {
      let value;
      try {
        value = decryptValue(row);
      } catch {
        blockedVariables.push({
          name: row.name,
          source: 'personal',
          code: 'DECRYPTION_FAILED',
          reason: 'Encrypted value cannot be decrypted',
          blockedBy: 'encryption',
        });
        continue;
      }
      const block = findPersonalBlock(row.name, value);
      if (block) {
        blockedVariables.push({
          name: row.name,
          source: 'personal',
          code: block.code,
          reason: block.reason,
          blockedBy: block.ownerType,
        });
        continue;
      }
      activePersonal.push({ name: row.name, value });
    }

    const activePersonalCredentialKeys = new Set(
      activePersonal
        .map((entry) => envNameKey(entry.name))
        .filter((nameKey) => PERSONAL_CREDENTIAL_ENV_NAME_KEYS.has(nameKey)),
    );
    if (activePersonalCredentialKeys.size > 0) {
      for (const name of PERSONAL_CREDENTIAL_ENV_NAMES) {
        const nameKey = envNameKey(name);
        const deleted = deleteEffectiveValue(nameKey);
        if (deleted && !activePersonalCredentialKeys.has(nameKey)) {
          blockedVariables.push({
            name: deleted.name,
            source: deleted.source,
            code: 'PERSONAL_CREDENTIAL_GROUP_ISOLATION',
            reason: 'Removed to prevent mixing personal and lower-layer Anthropic credentials',
            blockedBy: 'personal',
          });
        }
      }
    }
    for (const entry of activePersonal) {
      setEffectiveValue(entry.name, entry.value, 'personal');
    }

    applyLayer(managedEnv, 'managed');
    return { env, sources, blockedVariables };
  };

  return Object.freeze({
    listPersonal,
    updatePersonal,
    listTenant,
    updateTenant,
    updateTenants,
    listAllowlist,
    replaceAllowlist,
    listBuiltinDenyRules: () => BUILTIN_PERSONAL_ENV_DENY_RULES.map(cloneBuiltinRule),
    listDenyRules,
    createDenyRule,
    updateDenyRule,
    deleteDenyRule,
    resolveEffectiveEnv,
  });
}

export const claudeEnvService = createClaudeEnvService();
