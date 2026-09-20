import express from 'express';
import { db } from '../database/db.js';
import { createAiUsageAccessService, positiveId } from '../services/ai-usage-access.js';
import { hookConfigService } from '../services/hook-configs.js';
import { agentTemplateService } from '../services/agent-templates.js';
import { createHookSkillCatalogService } from '../services/hook-skill-catalog.js';

// Separate from /admin: every operation checks the live membership, and every
// mutable resource has an immutable owner independent of its distribution list.
export function createTenantManagementRouter({ database = db, hooks = hookConfigService,
  templates = agentTemplateService, skills = createHookSkillCatalogService() } = {}) {
  const router = express.Router();
  const access = createAiUsageAccessService({ db: database });
  const authorize = (req) => access.resolve({ userId: req.user?.id, tenantId: req.params.tenantId, scope: 'tenant' });
  const owned = (req, table, id) => {
    const context = authorize(req);
    // Admin-created configurations remain platform-owned (NULL), even when
    // distributed to this tenant. Availability/reference rights never grant
    // mutation rights; only the server-stored owner is authoritative.
    const row = database.prepare(`SELECT id FROM ${table} WHERE id = ? AND owner_tenant_id = ?`).get(id, context.tenantId);
    if (!row) throw Object.assign(new Error('配置不存在或不属于当前租户'), { statusCode: 404 });
    return context;
  };
  const route = (handler) => async (req, res) => {
    try {
      const context = authorize(req);
      const payload = await handler(req, context);
      // Catalog loading can yield. Do not return data after access was revoked.
      authorize(req);
      res.json(payload);
    } catch (error) {
      res.status(error.statusCode || 400).json({ error: error.message || '租户管理请求失败' });
    }
  };
  const resourceCatalog = async () => {
    const resources = hooks.getResources();
    try {
      const catalog = await skills.listConfigurationSkills();
      return { ...resources, skills: catalog.skills || [] };
    } catch {
      return { ...resources, skills: [] };
    }
  };
  const templateInput = (req, context) => {
    const input = req.body || {};
    if (input.globalVisible || !Array.isArray(input.tenantIds) || input.tenantIds.length !== 1
      || Number(input.tenantIds[0]) !== context.tenantId
      || ['skillPresetRefs', 'mcpPresetRefs'].some((key) => (input[key] || []).some((ref) => Number(ref.tenantId) !== context.tenantId))) {
      throw Object.assign(new Error('模板及其资源只能配置到当前租户'), { statusCode: 403 });
    }
    return { ...input, tenantIds: [context.tenantId], globalVisible: false };
  };
  router.get('/:tenantId/capabilities', route((_req, context) => ({ tenantId: context.tenantId, canManageHooks: true, canViewAiUsage: true, canManageTemplates: true })));
  router.get('/:tenantId/hooks/resources', route(() => resourceCatalog()));
  router.get('/:tenantId/hooks', route((_req, context) => ({
    hooks: database.prepare('SELECT id FROM hooks WHERE owner_tenant_id = ? ORDER BY updated_at DESC').all(context.tenantId).map((row) => hooks.getHook(row.id)),
  })));
  router.post('/:tenantId/hooks', route((req, context) => ({ hook: hooks.createHook({ input: req.body, userId: context.userId, ownerTenantId: context.tenantId }) })));
  router.put('/:tenantId/hooks/:hookId', route((req) => {
    const context = owned(req, 'hooks', req.params.hookId);
    return { hook: hooks.updateHook({ hookId: req.params.hookId, input: req.body, userId: context.userId }) };
  }));
  router.post('/:tenantId/hooks/:hookId/publish', route(async (req) => {
    owned(req, 'hooks', req.params.hookId);
    const draft = hooks.getHook(req.params.hookId);
    const signature = JSON.stringify(draft);
    const validatedSkills = draft.postActions.some((action) => action.type === 'invoke_skill')
      ? await skills.validateHookSkills({ hook: draft }) : [];
    const context = owned(req, 'hooks', req.params.hookId);
    if (signature !== JSON.stringify(hooks.getHook(req.params.hookId))) {
      throw Object.assign(new Error('Hook 已被修改，请刷新后重新发布'), { statusCode: 409 });
    }
    return database.transaction(() => {
      hooks.publishHook({ hookId: draft.id, userId: context.userId, validatedSkills });
      hooks.replaceHookBindings({ hookId: draft.id, scope: 'tenants', tenantIds: [context.tenantId],
        userIds: [], defaultEnabled: req.body?.defaultEnabled ?? draft.defaultEnabled,
        defaultShowInChat: true, boundBy: context.userId });
      return { hook: hooks.getHook(draft.id) };
    })();
  }));
  router.delete('/:tenantId/hooks/:hookId', route((req) => {
    owned(req, 'hooks', req.params.hookId);
    hooks.deleteHook(req.params.hookId);
    return { success: true };
  }));
  router.get('/:tenantId/agent-templates', route(async (req) => {
    const hookResourceCatalog = await resourceCatalog();
    const context = authorize(req);
    return { templates: templates.listAdminTemplates({ ownerTenantId: context.tenantId, hookResourceCatalog }) };
  }));
  router.get('/:tenantId/agent-template-categories', route(() => ({ categories: templates.listCategories().map(({ id, name }) => ({ id, name })) })));
  router.get('/:tenantId/agent-templates/preset-catalog', route((_req, context) => templates.listPresetCatalog({ tenantId: context.tenantId })));
  router.get('/:tenantId/agent-templates/hook-catalog', route(async (req) => {
    const resourceCatalogValue = await resourceCatalog();
    const context = authorize(req);
    return { hooks: templates.listHookCatalog({ tenantId: context.tenantId, resourceCatalog: resourceCatalogValue }) };
  }));
  router.get('/:tenantId/agent-templates/:templateId', route((req) => {
    const id = positiveId(req.params.templateId, 'templateId');
    owned(req, 'agent_templates', id);
    return { template: templates.getTemplate(id) };
  }));
  router.post('/:tenantId/agent-templates', route((req, context) => ({ template: templates.saveTemplate({
    input: templateInput(req, context), userId: context.userId, ownerTenantId: context.tenantId,
  }) })));
  router.put('/:tenantId/agent-templates/:templateId', route((req) => {
    const id = positiveId(req.params.templateId, 'templateId');
    const context = owned(req, 'agent_templates', id);
    return { template: templates.saveTemplate({ templateId: id, input: templateInput(req, context), userId: context.userId }) };
  }));
  router.post('/:tenantId/agent-templates/:templateId/publish', route(async (req) => {
    const id = positiveId(req.params.templateId, 'templateId');
    owned(req, 'agent_templates', id);
    const hookResourceCatalog = await resourceCatalog();
    const context = owned(req, 'agent_templates', id);
    return { template: templates.publishTemplate({ templateId: id, userId: context.userId, hookResourceCatalog }) };
  }));
  router.post('/:tenantId/agent-templates/:templateId/disable', route((req) => {
    const id = positiveId(req.params.templateId, 'templateId');
    const context = owned(req, 'agent_templates', id);
    return { template: templates.disableTemplate({ templateId: id, userId: context.userId }) };
  }));
  router.delete('/:tenantId/agent-templates/:templateId', route((req) => {
    const id = positiveId(req.params.templateId, 'templateId');
    owned(req, 'agent_templates', id);
    return { template: templates.deleteTemplate({ templateId: id }) };
  }));
  return router;
}

export default createTenantManagementRouter();
