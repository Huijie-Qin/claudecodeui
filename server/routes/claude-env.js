import express from 'express';

import { userDb } from '../database/db.js';
import { multitenancyDb } from '../database/multitenancy-db.js';
import {
  BUILTIN_PERSONAL_ENV_DENY_RULES,
  MAX_CLAUDE_ENV_BATCH_TENANTS,
  claudeEnvService,
} from '../services/claude-env.js';

const USER_KEY_ENV_NAME = 'USER_KEY';

function createHttpError(message, statusCode = 400, code = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function personalDenyRulesDisabledError() {
  return createHttpError(
    'Personal environment deny rules are no longer supported',
    410,
    'PERSONAL_DENY_RULES_DISABLED',
  );
}

function sendError(res, error, fallbackMessage) {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  if (statusCode >= 500) {
    console.error(fallbackMessage, error);
  }
  return res.status(statusCode).json({
    error: error?.message || fallbackMessage,
    ...(error?.code ? { code: error.code } : {}),
    ...(error?.ruleId ? { ruleId: error.ruleId } : {}),
  });
}

function requirePositiveId(value, name) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw createHttpError(`${name} must be a positive integer`);
  }
  return id;
}

function isSystemAdmin(user) {
  return user?.is_system_admin === 1 || user?.is_system_admin === true;
}

function assertTenantAccess(multitenancy, user, tenantId) {
  const canReadTenant = typeof multitenancy.tenants?.getTenantById === 'function';
  const tenant = canReadTenant ? multitenancy.tenants.getTenantById(tenantId) : null;
  if (canReadTenant && !tenant) {
    throw createHttpError('Tenant not found', 404, 'TENANT_NOT_FOUND');
  }
  if (isSystemAdmin(user)) return;
  if (tenant?.status !== undefined && tenant.status !== 'active') {
    throw createHttpError('Tenant access denied', 403, 'TENANT_ACCESS_DENIED');
  }
  const membership = multitenancy.memberships?.getActiveMembership?.(user.id, tenantId);
  if (!membership) {
    throw createHttpError('Tenant access denied', 403, 'TENANT_ACCESS_DENIED');
  }
}

function assertTenantExists(multitenancy, tenantId) {
  const canReadTenant = typeof multitenancy.tenants?.getTenantById === 'function';
  const tenant = canReadTenant ? multitenancy.tenants.getTenantById(tenantId) : { id: tenantId };
  if (!tenant) {
    throw createHttpError('Tenant not found', 404, 'TENANT_NOT_FOUND');
  }
  return tenant;
}

function assertTenantActive(tenant) {
  if (tenant.status !== undefined && tenant.status !== 'active') {
    throw createHttpError('Tenant is not active', 409, 'TENANT_NOT_ACTIVE');
  }
  return tenant;
}

function normalizeMutationBody(body = {}) {
  return {
    upserts: Array.isArray(body?.upserts) ? body.upserts : [],
    deletes: Array.isArray(body?.deletes) ? body.deletes : [],
    actorUserId: body?.actorUserId,
  };
}

function normalizeTenantIds(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw createHttpError('tenantIds must be a non-empty array', 400, 'INVALID_TENANT_IDS');
  }
  if (value.length > MAX_CLAUDE_ENV_BATCH_TENANTS) {
    throw createHttpError(
      `tenantIds cannot contain more than ${MAX_CLAUDE_ENV_BATCH_TENANTS} entries`,
      400,
      'INVALID_TENANT_IDS',
    );
  }
  const seen = new Set();
  const tenantIds = [];
  for (const entry of value) {
    let tenantId;
    try {
      tenantId = requirePositiveId(entry, 'tenantId');
    } catch {
      throw createHttpError(
        'tenantIds must contain only positive integers',
        400,
        'INVALID_TENANT_IDS',
      );
    }
    if (seen.has(tenantId)) continue;
    seen.add(tenantId);
    tenantIds.push(tenantId);
  }
  return tenantIds;
}

function normalizeBatchMutationBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createHttpError(
      'A tenant environment mutation is required',
      400,
      'INVALID_TENANT_ENV_MUTATION',
    );
  }
  if (!Array.isArray(body.upserts)) {
    throw createHttpError('upserts must be provided as an array', 400, 'INVALID_UPSERTS');
  }
  if (!Array.isArray(body.deletes)) {
    throw createHttpError('deletes must be provided as an array', 400, 'INVALID_DELETES');
  }
  return { upserts: body.upserts, deletes: body.deletes };
}

function mapTenantEnvironment(tenant, variables) {
  return {
    tenantId: requirePositiveId(tenant.id, 'tenant.id'),
    ...(tenant.code === undefined ? {} : { code: tenant.code }),
    ...(tenant.name === undefined ? {} : { name: tenant.name }),
    ...(tenant.status === undefined ? {} : { status: tenant.status }),
    ...(tenant.prod_code === undefined && tenant.prodCode === undefined
      ? {}
      : { prodCode: tenant.prod_code ?? tenant.prodCode ?? null }),
    variables,
  };
}

function getRuleId(rule) {
  const id = Number(rule?.id ?? rule?.ruleId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function toPublicSource(source) {
  if (source === 'baseEnv') return 'dotenv';
  if (source === 'adminUserEnv') return 'admin_user';
  return source || null;
}

function envNameKey(name) {
  return String(name).toUpperCase();
}

function findOwnedRule(service, { ruleId, ownerType, ownerUserId = null }) {
  const rules = service.listDenyRules({ ownerType, ownerUserId });
  return rules.find((rule) => getRuleId(rule) === ruleId) || null;
}

function sanitizeEffectivePreview({
  resolved,
  personalVariables,
  tenantVariables,
  adminUserEnv,
  allowlist,
}) {
  const relevantNameByKey = new Map();
  const addRelevantName = (name) => {
    if (!name) return;
    const nameKey = envNameKey(name);
    if (!relevantNameByKey.has(nameKey)) relevantNameByKey.set(nameKey, name);
  };
  for (const entry of personalVariables || []) addRelevantName(entry.name);
  for (const entry of tenantVariables || []) addRelevantName(entry.name);
  for (const name of Object.keys(adminUserEnv || {})) {
    if (envNameKey(name) !== USER_KEY_ENV_NAME) addRelevantName(name);
  }

  const effectiveNameByKey = new Map();
  for (const name of Object.keys(resolved?.sources || {})) {
    effectiveNameByKey.set(envNameKey(name), name);
  }

  const blockedByNameKey = new Map();
  for (const entry of resolved?.blockedVariables || []) {
    const nameKey = envNameKey(entry.name);
    blockedByNameKey.set(nameKey, entry);
    addRelevantName(entry.name);
  }
  for (const field of allowlist || []) {
    const effectiveName = effectiveNameByKey.get(envNameKey(field?.name));
    if (effectiveName && resolved?.sources?.[effectiveName] === 'baseEnv') {
      addRelevantName(field.name);
    }
  }

  const personalByNameKey = new Map(
    (personalVariables || []).map((entry) => [envNameKey(entry.name), entry]),
  );
  const tenantByNameKey = new Map(
    (tenantVariables || []).map((entry) => [envNameKey(entry.name), entry]),
  );

  return Array.from(relevantNameByKey.keys())
    .map((nameKey) => ({
      nameKey,
      name: effectiveNameByKey.get(nameKey) || relevantNameByKey.get(nameKey),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ nameKey, name }) => {
      const effectiveName = effectiveNameByKey.get(nameKey);
      const source = toPublicSource(effectiveName ? resolved?.sources?.[effectiveName] : null);
      const blocked = blockedByNameKey.get(nameKey);
      const personal = personalByNameKey.get(nameKey);
      const tenant = tenantByNameKey.get(nameKey);
      const sourceVariable = source === 'personal'
        ? personal
        : (source === 'tenant' ? tenant : null);
      return {
        name,
        configured: Boolean(source),
        source,
        ...(sourceVariable?.encrypted != null
          ? { encrypted: sourceVariable.encrypted === true }
          : {}),
        ...(blocked ? {
          blocked: true,
          blockedReason: blocked.reason || blocked.code || 'Blocked by policy',
          blockedRuleId: blocked.ruleId || null,
        } : {}),
      };
    });
}

export function createPersonalClaudeEnvRouter({
  service = claudeEnvService,
  multitenancy = multitenancyDb,
  users = userDb,
} = {}) {
  const router = express.Router();

  router.get('/personal', (req, res) => {
    try {
      return res.json({
        variables: service.listPersonal(req.user.id),
        allowlist: service.listAllowlist(),
      });
    } catch (error) {
      return sendError(res, error, 'Failed to load personal environment variables');
    }
  });

  router.patch('/personal', (req, res) => {
    try {
      service.updatePersonal(req.user.id, {
        ...normalizeMutationBody(req.body),
        actorUserId: req.user.id,
      });
      return res.json({
        variables: service.listPersonal(req.user.id),
        allowlist: service.listAllowlist(),
        restartRequired: true,
      });
    } catch (error) {
      return sendError(res, error, 'Failed to update personal environment variables');
    }
  });

  router.get('/effective', (req, res) => {
    try {
      const tenantId = requirePositiveId(req.query?.tenantId, 'tenantId');
      assertTenantAccess(multitenancy, req.user, tenantId);
      const adminUserEnv = users.getEnvForUser?.(req.user.id) || {};
      const personalVariables = service.listPersonal(req.user.id);
      const tenantVariables = service.listTenant(tenantId);
      const allowlist = service.listAllowlist();
      const resolved = service.resolveEffectiveEnv({
        tenantId,
        userId: req.user.id,
        baseEnv: process.env,
        adminUserEnv,
        managedEnv: {},
      });

      return res.json({
        variables: sanitizeEffectivePreview({
          resolved,
          personalVariables,
          tenantVariables,
          adminUserEnv,
          allowlist,
        }),
      });
    } catch (error) {
      return sendError(res, error, 'Failed to resolve effective environment variables');
    }
  });

  router.get('/deny-rules', (req, res) => {
    try {
      return res.json({
        builtInRules: BUILTIN_PERSONAL_ENV_DENY_RULES,
        platformRules: service.listDenyRules({ ownerType: 'platform' }),
        personalRules: [],
        personalRulesSupported: false,
      });
    } catch (error) {
      return sendError(res, error, 'Failed to load environment variable deny rules');
    }
  });

  router.post('/deny-rules', (req, res) => {
    try {
      throw personalDenyRulesDisabledError();
    } catch (error) {
      return sendError(res, error, 'Failed to create environment variable deny rule');
    }
  });

  router.patch('/deny-rules/:ruleId', (req, res) => {
    try {
      throw personalDenyRulesDisabledError();
    } catch (error) {
      return sendError(res, error, 'Failed to update environment variable deny rule');
    }
  });

  router.delete('/deny-rules/:ruleId', (req, res) => {
    try {
      const ruleId = requirePositiveId(req.params.ruleId, 'ruleId');
      if (!findOwnedRule(service, { ruleId, ownerType: 'user', ownerUserId: req.user.id })) {
        throw createHttpError('Deny rule not found', 404, 'DENY_RULE_NOT_FOUND');
      }
      if (!service.deleteDenyRule(ruleId, { ownerType: 'user', ownerUserId: req.user.id })) {
        throw createHttpError('Deny rule not found', 404, 'DENY_RULE_NOT_FOUND');
      }
      return res.json({ success: true });
    } catch (error) {
      return sendError(res, error, 'Failed to delete environment variable deny rule');
    }
  });

  return router;
}

export function createAdminClaudeEnvRouter({
  service = claudeEnvService,
  multitenancy = multitenancyDb,
} = {}) {
  const router = express.Router();

  router.get('/tenants/claude-env', (_req, res) => {
    try {
      if (typeof multitenancy.tenants?.listTenants !== 'function') {
        throw createHttpError('Tenant listing is unavailable', 500, 'TENANT_LIST_UNAVAILABLE');
      }
      const tenants = multitenancy.tenants.listTenants().map((tenant) => (
        mapTenantEnvironment(tenant, service.listTenant(tenant.id))
      ));
      return res.json({ tenants });
    } catch (error) {
      return sendError(res, error, 'Failed to load tenant Claude environments');
    }
  });

  router.patch('/tenants/claude-env', (req, res) => {
    try {
      const tenantIds = normalizeTenantIds(req.body?.tenantIds);
      const mutation = normalizeBatchMutationBody(req.body);
      const tenants = tenantIds.map((tenantId) => assertTenantExists(multitenancy, tenantId));
      tenants.forEach(assertTenantActive);
      service.updateTenants(tenantIds, {
        ...mutation,
        actorUserId: req.user.id,
      });
      return res.json({
        tenants: tenants.map((tenant) => (
          mapTenantEnvironment(tenant, service.listTenant(tenant.id))
        )),
        restartRequired: true,
      });
    } catch (error) {
      return sendError(res, error, 'Failed to update tenant Claude environments');
    }
  });

  router.get('/tenants/:tenantId/claude-env', (req, res) => {
    try {
      const tenantId = requirePositiveId(req.params.tenantId, 'tenantId');
      assertTenantExists(multitenancy, tenantId);
      return res.json({ variables: service.listTenant(tenantId) });
    } catch (error) {
      return sendError(res, error, 'Failed to load tenant Claude environment');
    }
  });

  router.patch('/tenants/:tenantId/claude-env', (req, res) => {
    try {
      const tenantId = requirePositiveId(req.params.tenantId, 'tenantId');
      assertTenantExists(multitenancy, tenantId);
      service.updateTenant(tenantId, {
        ...normalizeMutationBody(req.body),
        actorUserId: req.user.id,
      });
      return res.json({
        variables: service.listTenant(tenantId),
        restartRequired: true,
      });
    } catch (error) {
      return sendError(res, error, 'Failed to update tenant Claude environment');
    }
  });

  router.get('/claude-env/personal-allowlist', (req, res) => {
    try {
      return res.json({ fields: service.listAllowlist() });
    } catch (error) {
      return sendError(res, error, 'Failed to load personal Claude environment allowlist');
    }
  });

  router.put('/claude-env/personal-allowlist', (req, res) => {
    try {
      service.replaceAllowlist(req.body?.fields, { actorUserId: req.user.id });
      return res.json({ fields: service.listAllowlist() });
    } catch (error) {
      return sendError(res, error, 'Failed to update personal Claude environment allowlist');
    }
  });

  router.get('/claude-env/deny-rules', (req, res) => {
    try {
      return res.json({
        builtInRules: BUILTIN_PERSONAL_ENV_DENY_RULES,
        rules: service.listDenyRules({ ownerType: 'platform' }),
      });
    } catch (error) {
      return sendError(res, error, 'Failed to load platform Claude environment deny rules');
    }
  });

  router.post('/claude-env/deny-rules', (req, res) => {
    try {
      const rule = service.createDenyRule({
        ownerType: 'platform',
        matchType: req.body?.matchType,
        pattern: req.body?.pattern,
        reason: req.body?.reason,
        enabled: req.body?.enabled,
        actorUserId: req.user.id,
      });
      return res.status(201).json({ rule });
    } catch (error) {
      return sendError(res, error, 'Failed to create platform Claude environment deny rule');
    }
  });

  router.patch('/claude-env/deny-rules/:ruleId', (req, res) => {
    try {
      const ruleId = requirePositiveId(req.params.ruleId, 'ruleId');
      if (!findOwnedRule(service, { ruleId, ownerType: 'platform' })) {
        throw createHttpError('Deny rule not found', 404, 'DENY_RULE_NOT_FOUND');
      }
      const rule = service.updateDenyRule(ruleId, {
        matchType: req.body?.matchType,
        pattern: req.body?.pattern,
        reason: req.body?.reason,
        enabled: req.body?.enabled,
        actorUserId: req.user.id,
      }, { ownerType: 'platform' });
      return res.json({ rule });
    } catch (error) {
      return sendError(res, error, 'Failed to update platform Claude environment deny rule');
    }
  });

  router.delete('/claude-env/deny-rules/:ruleId', (req, res) => {
    try {
      const ruleId = requirePositiveId(req.params.ruleId, 'ruleId');
      if (!findOwnedRule(service, { ruleId, ownerType: 'platform' })) {
        throw createHttpError('Deny rule not found', 404, 'DENY_RULE_NOT_FOUND');
      }
      if (!service.deleteDenyRule(ruleId, { ownerType: 'platform' })) {
        throw createHttpError('Deny rule not found', 404, 'DENY_RULE_NOT_FOUND');
      }
      return res.json({ success: true });
    } catch (error) {
      return sendError(res, error, 'Failed to delete platform Claude environment deny rule');
    }
  });

  return router;
}
