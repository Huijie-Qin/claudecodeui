import { db } from '../database/db.js';

const TEMPLATE_STATUSES = new Set(['draft', 'published', 'disabled']);
const GLOBAL_TENANT_CODES = new Set(['dataagent', 'dataagent-admin', 'dataagent-management']);
const MAX_TEMPLATE_HOOKS = 20;
const HOOK_CAPABILITY_LABELS = Object.freeze({
  call_mcp_tool: 'MCP',
  mcp_loop_run: 'MCP 循环',
  write_record: '写记录',
  invoke_skill: 'Skill',
  send_agent_message: 'Agent 消息',
});

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw createHttpError(`${name} must be a positive integer`);
  }
  return parsed;
}

function requiredString(value, name) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw createHttpError(`${name} is required`);
  return normalized;
}

function optionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function limitedRequiredString(value, name, maxLength) {
  const normalized = requiredString(value, name);
  if (normalized.length > maxLength) {
    throw createHttpError(`${name} must not exceed ${maxLength} characters`);
  }
  return normalized;
}

function parseJson(value, fallback = []) {
  try {
    const parsed = JSON.parse(value || '');
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function normalizeIds(values, name) {
  if (!Array.isArray(values)) throw createHttpError(`${name} must be an array`);
  return [...new Set(values.map((value) => positiveInteger(value, name)))];
}

function normalizePresetRefs(values, name) {
  if (!Array.isArray(values)) throw createHttpError(`${name} must be an array`);
  const refs = values.map((value) => ({
    tenantId: positiveInteger(value?.tenantId ?? value?.tenant_id, `${name}.tenantId`),
    presetId: positiveInteger(value?.presetId ?? value?.preset_id ?? value, `${name}.presetId`),
  }));
  return [...new Map(refs.map((ref) => [`${ref.tenantId}:${ref.presetId}`, ref])).values()];
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getMcpToolDefinitions(row) {
  return parseJson(row?.tools_json, []).filter((tool) => (
    isPlainObject(tool) && typeof tool.name === 'string' && tool.name.trim()
  ));
}

function normalizeMcpToolSettings(value, row, name) {
  if (value == null) return undefined;
  if (!isPlainObject(value)) throw createHttpError(`${name} must be an object`);

  const tools = getMcpToolDefinitions(row);
  const toolsByName = new Map(tools.map((tool) => [tool.name.trim(), tool]));
  const rawAllowedToolNames = value.allowedToolNames;
  if (rawAllowedToolNames != null && !Array.isArray(rawAllowedToolNames)) {
    throw createHttpError(`${name}.allowedToolNames must be an array`);
  }
  const allowedToolNames = [...new Set((rawAllowedToolNames ?? tools.map((tool) => tool.name))
    .map((toolName) => requiredString(toolName, `${name}.allowedToolNames`)))];
  const unknownAllowedTools = allowedToolNames.filter((toolName) => !toolsByName.has(toolName));
  if (unknownAllowedTools.length > 0) {
    throw createHttpError(`Unknown MCP tools in ${name}: ${unknownAllowedTools.join(', ')}`);
  }

  const rawTools = value.tools ?? {};
  if (!isPlainObject(rawTools)) throw createHttpError(`${name}.tools must be an object`);
  const normalizedTools = Object.create(null);
  for (const [toolName, toolSettings] of Object.entries(rawTools)) {
    const tool = toolsByName.get(toolName);
    if (!tool) throw createHttpError(`Unknown MCP tool in ${name}: ${toolName}`);
    if (!isPlainObject(toolSettings)) throw createHttpError(`${name}.tools.${toolName} must be an object`);
    const rawParams = toolSettings.params ?? {};
    if (!isPlainObject(rawParams)) throw createHttpError(`${name}.tools.${toolName}.params must be an object`);

    const inputSchema = isPlainObject(tool.inputSchema)
      ? tool.inputSchema
      : isPlainObject(tool.input_schema)
        ? tool.input_schema
        : {};
    const properties = isPlainObject(inputSchema.properties) ? inputSchema.properties : {};
    const params = {};
    for (const [paramName, entry] of Object.entries(rawParams)) {
      if (!Object.hasOwn(properties, paramName)) {
        throw createHttpError(`Unknown MCP parameter in ${name}: ${toolName}.${paramName}`);
      }
      if (!isPlainObject(entry)) {
        throw createHttpError(`${name}.tools.${toolName}.params.${paramName} must be an object`);
      }
      const mode = entry.mode === 'default' || entry.mode === 'force'
        ? entry.mode
        : entry.custom === true
          ? 'force'
          : null;
      if (!mode) {
        throw createHttpError(`Invalid MCP parameter strategy in ${name}: ${toolName}.${paramName}`);
      }
      if (!Object.hasOwn(entry, 'value')) {
        throw createHttpError(`MCP parameter value is required in ${name}: ${toolName}.${paramName}`);
      }
      params[paramName] = { mode, value: entry.value };
    }
    if (Object.keys(params).length > 0) normalizedTools[toolName] = { params };
  }

  const normalized = { allowedToolNames, tools: normalizedTools };
  if (JSON.stringify(normalized).length > 64 * 1024) {
    throw createHttpError(`${name} must not exceed 64 KiB`);
  }
  return normalized;
}

function normalizeMcpPresetRefs(values, name) {
  if (!Array.isArray(values)) throw createHttpError(`${name} must be an array`);
  const refs = values.map((value) => ({
    tenantId: positiveInteger(value?.tenantId ?? value?.tenant_id, `${name}.tenantId`),
    presetId: positiveInteger(value?.presetId ?? value?.preset_id ?? value, `${name}.presetId`),
    ...(value?.toolSettings != null ? { toolSettings: value.toolSettings } : {}),
  }));
  return [...new Map(refs.map((ref) => [`${ref.tenantId}:${ref.presetId}`, ref])).values()];
}

function normalizeHookRefs(values, name) {
  if (!Array.isArray(values)) throw createHttpError(`${name} must be an array`);
  if (values.length > MAX_TEMPLATE_HOOKS) {
    throw createHttpError(`${name} supports at most ${MAX_TEMPLATE_HOOKS} Hooks`);
  }
  const seen = new Set();
  return values.map((value, index) => {
    const hookId = limitedRequiredString(value?.hookId ?? value?.hook_id, `${name}.hookId`, 200);
    if (seen.has(hookId)) throw createHttpError(`Hook ${hookId} is selected more than once`);
    seen.add(hookId);
    const rawVersion = value?.version;
    const version = rawVersion == null || rawVersion === ''
      ? null
      : positiveInteger(rawVersion, `${name}.version`);
    const rawOrder = Number(value?.order ?? (index + 1) * 10);
    if (!Number.isSafeInteger(rawOrder) || rawOrder < 0) {
      throw createHttpError(`${name}.order must be a non-negative integer`);
    }
    const defaultEnabled = value?.defaultEnabled !== false;
    const allowUserDisable = value?.allowUserDisable !== false;
    if (!defaultEnabled && !allowUserDisable) {
      throw createHttpError(`${name} cannot disable a mandatory Hook by default`);
    }
    return {
      hookId,
      version,
      defaultEnabled,
      showInChat: value?.showInChat !== false,
      allowUserDisable,
      order: rawOrder,
    };
  }).sort((left, right) => left.order - right.order || left.hookId.localeCompare(right.hookId));
}

function getHookPostActions(row) {
  return parseJson(row?.post_actions_json, []).filter(isPlainObject);
}

function getHookCapabilityTags(row) {
  const tags = new Set(getHookPostActions(row)
    .map((action) => HOOK_CAPABILITY_LABELS[action.type])
    .filter(Boolean));
  if (parseJson(row?.extension_logic_json, null)?.code) tags.add('执行脚本');
  if (Object.keys(parseJson(row?.claude_response_json, { bindings: {} })?.bindings || {}).length > 0) {
    tags.add('响应控制');
  }
  return [...tags];
}

function getHookDependencies(row) {
  const skills = new Map();
  const mcpTools = new Map();
  for (const action of getHookPostActions(row)) {
    if (action.type === 'invoke_skill') {
      const id = String(action.config?.skillId || '').trim();
      if (id) skills.set(id, {
        id,
        name: String(action.config?.skillName || id).trim(),
      });
    } else if (action.type === 'call_mcp_tool') {
      const name = String(action.config?.toolName || '').trim();
      if (name) mcpTools.set(name, {
        name,
        serverId: String(action.config?.mcpServerId || '').trim() || null,
      });
    } else if (action.type === 'mcp_loop_run') {
      const name = String(parseJson(row?.matcher_json, {})?.value || '').trim();
      if (name) mcpTools.set(name, { name, serverId: null });
    }
  }
  return { skills: [...skills.values()], mcpTools: [...mcpTools.values()] };
}

function normalizeHookResourceCatalog(catalog) {
  if (!catalog) return null;
  const mcpServersById = new Map((catalog.mcpServers || []).map((server) => [
    String(server.id || ''),
    server,
  ]));
  for (const tool of catalog.mcpTools || []) {
    const serverId = String(tool.mcpServerId || '');
    if (!serverId || mcpServersById.has(serverId)) continue;
    mcpServersById.set(serverId, {
      id: serverId,
      contentHash: tool.mcpServerContentHash || null,
    });
  }
  return {
    skillsById: new Map((catalog.skills || []).map((skill) => [String(skill.skillId || skill.id || ''), skill])),
    mcpToolsByName: new Map((catalog.mcpTools || []).map((tool) => [String(tool.name || ''), tool])),
    mcpServersById,
  };
}

function inspectHookResources(row, resourceCatalog) {
  const dependencies = getHookDependencies(row);
  const normalizedCatalog = normalizeHookResourceCatalog(resourceCatalog);
  if (!normalizedCatalog) {
    return { dependencies, unavailable: [], available: true };
  }
  const unavailable = [];
  for (const skill of dependencies.skills) {
    const candidate = normalizedCatalog.skillsById.get(skill.id);
    if (!candidate || String(candidate.name || '') !== skill.name) {
      unavailable.push({ type: 'skill', id: skill.id, name: skill.name });
    }
  }
  for (const tool of dependencies.mcpTools) {
    const candidate = normalizedCatalog.mcpToolsByName.get(tool.name);
    if (!candidate || (tool.serverId && String(candidate.mcpServerId || '') !== tool.serverId)) {
      unavailable.push({ type: 'mcp', id: tool.name, name: tool.name });
    }
  }
  const publishedRefs = parseJson(row?.resource_refs_json, {});
  for (const expectedSkill of Array.isArray(publishedRefs.skills) ? publishedRefs.skills : []) {
    const skillId = typeof expectedSkill === 'string'
      ? expectedSkill
      : String(expectedSkill?.skillId || '');
    if (!skillId) continue;
    const candidate = normalizedCatalog.skillsById.get(skillId);
    if (!candidate) continue;
    const expectedVersion = typeof expectedSkill === 'object' && expectedSkill != null
      ? Number(expectedSkill.version)
      : NaN;
    const expectedHash = typeof expectedSkill === 'object' && expectedSkill != null
      ? String(expectedSkill.contentHash || '')
      : '';
    if (
      (Number.isFinite(expectedVersion) && expectedVersion > 0 && Number(candidate.version) !== expectedVersion)
      || (expectedHash && String(candidate.contentHash || '') !== expectedHash)
    ) {
      unavailable.push({ type: 'skill_version', id: skillId, name: skillId });
    }
  }
  for (const expectedServer of Array.isArray(publishedRefs.mcpServers) ? publishedRefs.mcpServers : []) {
    const serverId = typeof expectedServer === 'string'
      ? expectedServer
      : String(expectedServer?.id || '');
    if (!serverId) continue;
    const candidate = normalizedCatalog.mcpServersById.get(serverId);
    const expectedHash = typeof expectedServer === 'object' && expectedServer != null
      ? String(expectedServer.contentHash || '')
      : '';
    if (!candidate || (expectedHash && String(candidate.contentHash || '') !== expectedHash)) {
      unavailable.push({ type: 'mcp_version', id: serverId, name: serverId });
    }
  }
  return { dependencies, unavailable, available: unavailable.length === 0 };
}

function hydrateTemplate(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    category: row.category || '',
    summary: row.summary || '',
    claudeMarkdown: row.agent_markdown || '',
    // Compatibility alias for templates saved by earlier clients.
    agentMarkdown: row.agent_markdown || '',
    guideText: row.guide_text || '',
    tenantIds: parseJson(row.tenant_ids_json, []),
    skillPresetRefs: parseJson(row.skill_preset_refs_json, []),
    mcpPresetRefs: parseJson(row.mcp_preset_refs_json, []),
    hookRefs: parseJson(row.hook_refs_json, []),
    globalVisible: row.global_visible === 1,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isGlobalTenant(tenant) {
  const code = String(tenant?.code || '').trim().toLowerCase();
  const name = String(tenant?.name || '').replace(/\s+/g, '').toLowerCase();
  return GLOBAL_TENANT_CODES.has(code) || name === 'dataagent管理';
}

function buildPresetSnapshot(rows) {
  return rows.map((row) => ({
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    name: row.display_name || row.name,
    version: Number(row.version || 0),
    updatedAt: row.updated_at || null,
  }));
}

function buildMcpPresetSnapshot(inspections) {
  return inspections.map(({ row, ref }) => ({
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    name: row.display_name || row.name,
    serverName: row.name,
    version: Number(row.version || 0),
    updatedAt: row.updated_at || null,
    ...(ref.toolSettings ? { toolSettings: ref.toolSettings } : {}),
  }));
}

function buildHookSnapshot(inspections) {
  return inspections.map(({ row, ref }) => {
    const resourceInspection = inspectHookResources(row, null);
    return {
      id: row.id,
      name: row.name,
      description: row.description || '',
      version: Number(row.version || 0),
      eventName: row.event_name,
      defaultEnabled: ref.defaultEnabled,
      showInChat: ref.showInChat,
      allowUserDisable: ref.allowUserDisable,
      order: ref.order,
      capabilityTags: getHookCapabilityTags(row),
      dependencies: resourceInspection.dependencies,
      publishedAt: row.published_at || null,
      updatedAt: row.updated_at || null,
    };
  });
}

export function createAgentTemplateService(database = db) {
  const getTemplate = (templateId) => hydrateTemplate(database.prepare(`
    SELECT * FROM agent_templates WHERE id = ?
  `).get(positiveInteger(templateId, 'templateId')));

  const getWorkspaceTemplateInfo = ({ workspaceId }) => {
    const row = database.prepare(`
      SELECT template_id, template_name, guide_text
      FROM workspace_agent_template_snapshots
      WHERE workspace_id = ?
    `).get(positiveInteger(workspaceId, 'workspaceId'));

    if (!row) return null;
    return {
      id: Number(row.template_id),
      name: row.template_name,
      guideText: row.guide_text || '',
    };
  };

  const getCategoryByName = (name) => database.prepare(`
    SELECT id, name, created_by_user_id, created_at
    FROM agent_template_categories
    WHERE name = ? COLLATE NOCASE
  `).get(name);

  const ensureCategory = ({ name, userId }) => {
    const normalizedName = limitedRequiredString(name, 'category', 50);
    database.prepare(`
      INSERT OR IGNORE INTO agent_template_categories (name, created_by_user_id)
      VALUES (?, ?)
    `).run(normalizedName, positiveInteger(userId, 'userId'));
    return getCategoryByName(normalizedName);
  };

  const createCategory = ({ name, userId }) => {
    const normalizedName = limitedRequiredString(name, 'category', 50);
    if (getCategoryByName(normalizedName)) {
      throw createHttpError(`Agent 模板分类“${normalizedName}”已存在，请使用其他名称`, 409);
    }
    database.prepare(`
      INSERT INTO agent_template_categories (name, created_by_user_id)
      VALUES (?, ?)
    `).run(normalizedName, positiveInteger(userId, 'userId'));
    return getCategoryByName(normalizedName);
  };

  const assertUniqueTemplateName = (name, excludedTemplateId = null) => {
    const duplicate = database.prepare(`
      SELECT id FROM agent_templates
      WHERE name = ? COLLATE NOCASE
        AND (? IS NULL OR id != ?)
      LIMIT 1
    `).get(name, excludedTemplateId, excludedTemplateId);
    if (duplicate) {
      throw createHttpError(`Agent 模板“${name}”已存在，请使用其他名称`, 409);
    }
  };

  const loadTenants = (tenantIds) => {
    if (tenantIds.length === 0) return [];
    const placeholders = tenantIds.map(() => '?').join(', ');
    return database.prepare(`
      SELECT id, code, name, status FROM tenants WHERE id IN (${placeholders})
    `).all(...tenantIds);
  };

  const validateTenantSelection = (tenantIds) => {
    if (tenantIds.length === 0) throw createHttpError('At least one visible tenant is required');
    const tenants = loadTenants(tenantIds);
    if (tenants.length !== tenantIds.length || tenants.some((tenant) => tenant.status !== 'active')) {
      throw createHttpError('Visible tenants must exist and be active');
    }
    return tenants;
  };

  const tableExists = (tableName) => Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(tableName));

  const loadHookTenantIds = (hookId) => {
    if (!tableExists('hook_tenant_bindings')) return [];
    return database.prepare(`
      SELECT tenant_id FROM hook_tenant_bindings WHERE hook_id = ?
      ORDER BY tenant_id ASC
    `).all(hookId).map((binding) => Number(binding.tenant_id));
  };

  const hookIsVisibleToTenants = (hookId, tenantIds) => {
    const boundTenantIds = loadHookTenantIds(hookId);
    // Existing Hooks predate tenant-scoped template distribution. An empty
    // binding set therefore remains globally eligible for backwards compatibility.
    if (boundTenantIds.length === 0) return true;
    const boundTenants = loadTenants(boundTenantIds);
    if (boundTenants.some(isGlobalTenant)) return true;
    const allowed = new Set(boundTenantIds);
    return tenantIds.every((tenantId) => allowed.has(Number(tenantId)));
  };

  const getHookRow = (hookId) => {
    if (!tableExists('hooks')) return null;
    return database.prepare('SELECT * FROM hooks WHERE id = ?').get(String(hookId));
  };

  const getPublishedHookDefinitionRow = (hookId, version) => {
    if (!tableExists('hook_published_versions') || version == null) return null;
    const published = database.prepare(`
      SELECT * FROM hook_published_versions
      WHERE hook_id = ? AND version = ?
    `).get(String(hookId), Number(version));
    if (!published) return null;
    const config = parseJson(published.config_json, {});
    return {
      id: published.hook_id,
      name: config.name || published.hook_id,
      description: config.description || '',
      status: 'published',
      binding_controller: config.bindingController === 'sql_check' ? 'sql_check' : 'admin',
      event_name: config.eventName || '',
      matcher_json: JSON.stringify(config.matcher || {}),
      extension_logic_json: JSON.stringify(config.extensionLogic || null),
      post_actions_json: JSON.stringify(config.postActions || []),
      claude_response_json: JSON.stringify(config.claudeResponse || { bindings: {} }),
      resource_refs_json: published.resource_refs_json || '{}',
      version: Number(published.version || 0),
      published_at: published.published_at || null,
      updated_at: published.published_at || null,
      revoked_at: published.revoked_at || null,
    };
  };

  const inspectHookRefs = (refs, { tenantIds = [], resourceCatalog = null } = {}) => refs.map((ref) => {
    const hookRow = getHookRow(ref.hookId);
    const requestedVersion = ref.version ?? Number(hookRow?.version || 0);
    const publishedVersionRow = getPublishedHookDefinitionRow(ref.hookId, requestedVersion);
    // This fallback is only for databases that have not run the immutable-version
    // backfill yet. Normal production reads use hook_published_versions.
    const row = publishedVersionRow || (
      hookRow && Number(hookRow.version || 0) === Number(requestedVersion) ? hookRow : null
    );
    let unavailableReason = '';
    if (!hookRow) unavailableReason = '已删除';
    else if (hookRow.binding_controller !== 'admin') unavailableReason = '由 SQL Check 独立管理';
    else if (hookRow.status === 'disabled') unavailableReason = '已下线';
    else if (hookRow.status === 'draft' && !publishedVersionRow) unavailableReason = '未发布';
    else if (!['published', 'draft'].includes(hookRow.status)) unavailableReason = '未发布';
    else if (!row) unavailableReason = '版本不可用';
    else if (row.revoked_at) unavailableReason = '版本已紧急撤销';
    else if (row.binding_controller !== 'admin') unavailableReason = '由 SQL Check 独立管理';
    else if (!hookIsVisibleToTenants(hookRow.id, tenantIds)) {
      unavailableReason = '不适用于模板的可见租户';
    }
    const resourceInspection = row
      ? inspectHookResources(row, resourceCatalog)
      : { dependencies: { skills: [], mcpTools: [] }, unavailable: [], available: false };
    if (!unavailableReason && !resourceInspection.available) {
      unavailableReason = `依赖能力不可用：${resourceInspection.unavailable.map((item) => item.name).join('、')}`;
    }
    return {
      ref,
      row,
      hookRow,
      available: !unavailableReason,
      unavailableReason,
      resourceInspection,
    };
  });

  const requireSelectableHooks = (refs, tenantIds) => inspectHookRefs(refs, { tenantIds }).map((inspection) => {
    if (!inspection.hookRow) throw createHttpError(`Hook ${inspection.ref.hookId} was not found`, 404);
    if (!inspection.available) {
      throw createHttpError(`Hook ${inspection.row?.name || inspection.hookRow.name || inspection.ref.hookId} 不可用：${inspection.unavailableReason}`);
    }
    return {
      ...inspection.ref,
      version: Number(inspection.row.version || 0),
    };
  });

  const buildHookCatalogItem = (row, resourceCatalog = null) => {
    const publishedRow = getPublishedHookDefinitionRow(row.id, Number(row.version || 0));
    const definitionRow = publishedRow || row;
    const resourceInspection = inspectHookResources(definitionRow, resourceCatalog);
    const postActionTypes = [...new Set(getHookPostActions(definitionRow).map((action) => action.type).filter(Boolean))];
    return {
      id: row.id,
      name: row.name,
      description: row.description || '',
      eventName: row.event_name,
      version: Number(row.version || 0),
      status: row.status,
      bindingController: row.binding_controller === 'sql_check' ? 'sql_check' : 'admin',
      postActionTypes,
      capabilityTags: getHookCapabilityTags(definitionRow),
      dependencies: resourceInspection.dependencies,
      dependencySummary: {
        skillCount: resourceInspection.dependencies.skills.length,
        mcpCount: resourceInspection.dependencies.mcpTools.length,
        unavailableCount: resourceInspection.unavailable.length,
        available: resourceInspection.available,
        capabilityTags: getHookCapabilityTags(definitionRow),
      },
      available: resourceInspection.available,
      unavailableReason: resourceInspection.available
        ? undefined
        : `依赖能力不可用：${resourceInspection.unavailable.map((item) => item.name).join('、')}`,
      publishedAt: row.published_at || null,
      updatedAt: row.updated_at || null,
    };
  };

  const resolveSkillRows = (refs, { requirePublished = false } = {}) => refs.map((ref) => {
    const row = database.prepare(`
      SELECT * FROM tenant_skill_presets WHERE tenant_id = ? AND id = ?
    `).get(ref.tenantId, ref.presetId);
    if (!row) throw createHttpError(`Skill preset ${ref.presetId} was not found`, 404);
    if (requirePublished && row.status !== 'published') {
      throw createHttpError(`Skill preset ${row.display_name || row.name} is not published`);
    }
    return row;
  });

  const inspectSkillRefs = (refs) => refs.map((ref) => {
    const row = database.prepare(`
      SELECT * FROM tenant_skill_presets WHERE tenant_id = ? AND id = ?
    `).get(ref.tenantId, ref.presetId);
    return {
      ref,
      row,
      available: row?.status === 'published',
      unavailableReason: !row ? '已删除' : row.status === 'disabled' ? '已下线' : '未发布',
    };
  });

  const resolveMcpRows = (refs, { requirePublished = false } = {}) => refs.map((ref) => {
    const row = database.prepare(`
      SELECT * FROM mcp_server_presets WHERE tenant_id = ? AND id = ?
    `).get(ref.tenantId, ref.presetId);
    if (!row) throw createHttpError(`MCP preset ${ref.presetId} was not found`, 404);
    if (requirePublished && (
      row.status !== 'published'
      || row.last_test_status !== 'healthy'
      || Number(row.tool_count || 0) <= 0
    )) {
      throw createHttpError(`MCP preset ${row.display_name || row.name} is not ready to publish`);
    }
    return row;
  });

  const inspectMcpRefs = (refs) => refs.map((ref) => {
    const row = database.prepare(`
      SELECT * FROM mcp_server_presets WHERE tenant_id = ? AND id = ?
    `).get(ref.tenantId, ref.presetId);
    const available = Boolean(
      row
      && row.status === 'published'
      && row.last_test_status === 'healthy'
      && Number(row.tool_count || 0) > 0,
    );
    let unavailableReason = '';
    if (!row) unavailableReason = '已删除';
    else if (row.status === 'disabled') unavailableReason = '已下线';
    else if (row.status !== 'published') unavailableReason = '未发布';
    else if (row.last_test_status !== 'healthy') unavailableReason = '当前不可用';
    else if (Number(row.tool_count || 0) <= 0) unavailableReason = '暂无可用工具';
    return { ref, row, available, unavailableReason };
  });

  const toCapability = (inspection, type) => ({
    id: Number(inspection.row?.id || inspection.ref.presetId),
    name: inspection.row?.display_name || inspection.row?.name || `${type} #${inspection.ref.presetId}`,
    available: inspection.available,
    unavailableReason: inspection.available ? undefined : inspection.unavailableReason,
  });

  const getUnavailableCapabilities = (template) => [
    ...inspectSkillRefs(template.skillPresetRefs).filter((inspection) => !inspection.available).map((inspection) => ({
      type: 'skill',
      ...toCapability(inspection, 'Skill'),
    })),
    ...inspectMcpRefs(template.mcpPresetRefs).filter((inspection) => !inspection.available).map((inspection) => ({
      type: 'mcp',
      ...toCapability(inspection, 'MCP'),
    })),
    ...inspectHookRefs(template.hookRefs, { tenantIds: template.tenantIds })
      .filter((inspection) => !inspection.available)
      .map((inspection) => ({
        type: 'hook',
        id: inspection.row?.id || inspection.hookRow?.id || inspection.ref.hookId,
        name: inspection.row?.name || inspection.hookRow?.name || `Hook #${inspection.ref.hookId}`,
        available: false,
        unavailableReason: inspection.unavailableReason,
      })),
  ];

  const normalizeInput = (input, existing = null) => {
    const tenantIds = normalizeIds(input.tenantIds ?? existing?.tenantIds ?? [], 'tenantIds');
    const tenants = validateTenantSelection(tenantIds);
    if (tenants.some(isGlobalTenant) && tenants.some((tenant) => !isGlobalTenant(tenant))) {
      throw createHttpError('DataAgent管理 cannot be combined with other visible tenants');
    }
    const skillPresetRefs = normalizePresetRefs(
      input.skillPresetRefs ?? existing?.skillPresetRefs ?? [],
      'skillPresetRefs',
    );
    let mcpPresetRefs = normalizeMcpPresetRefs(
      input.mcpPresetRefs ?? existing?.mcpPresetRefs ?? [],
      'mcpPresetRefs',
    );
    let hookRefs = normalizeHookRefs(
      input.hookRefs ?? existing?.hookRefs ?? [],
      'hookRefs',
    );
    const allowedTenantIds = new Set(tenantIds);
    for (const ref of [...skillPresetRefs, ...mcpPresetRefs]) {
      if (!allowedTenantIds.has(ref.tenantId)) {
        throw createHttpError('Preset tenant must be included in visible tenants');
      }
    }
    resolveSkillRows(skillPresetRefs);
    const mcpRows = resolveMcpRows(mcpPresetRefs);
    mcpPresetRefs = mcpPresetRefs.map((ref, index) => ({
      tenantId: ref.tenantId,
      presetId: ref.presetId,
      ...(ref.toolSettings != null
        ? { toolSettings: normalizeMcpToolSettings(ref.toolSettings, mcpRows[index], `mcpPresetRefs[${index}].toolSettings`) }
        : {}),
    }));
    hookRefs = requireSelectableHooks(hookRefs, tenantIds);
    const legacyAgentMarkdownWasEdited = existing
      && input.agentMarkdown !== undefined
      && input.agentMarkdown !== existing.agentMarkdown
      && input.claudeMarkdown === existing.claudeMarkdown;
    const claudeMarkdownInput = legacyAgentMarkdownWasEdited
      ? input.agentMarkdown
      : input.claudeMarkdown ?? input.agentMarkdown ?? existing?.claudeMarkdown ?? existing?.agentMarkdown;
    return {
      name: requiredString(input.name ?? existing?.name, 'name'),
      category: limitedRequiredString(input.category ?? existing?.category, 'category', 50),
      summary: optionalString(input.summary ?? existing?.summary),
      claudeMarkdown: optionalString(claudeMarkdownInput),
      guideText: optionalString(input.guideText ?? existing?.guideText),
      tenantIds,
      skillPresetRefs,
      mcpPresetRefs,
      hookRefs,
      globalVisible: tenants.some(isGlobalTenant),
    };
  };

  const saveTemplate = ({ templateId = null, input, userId }) => {
    const normalizedUserId = positiveInteger(userId, 'userId');
    const existing = templateId == null ? null : getTemplate(templateId);
    if (templateId != null && !existing) throw createHttpError('Agent template not found', 404);
    const values = normalizeInput(input || {}, existing);
    assertUniqueTemplateName(values.name, existing?.id ?? null);
    values.category = ensureCategory({ name: values.category, userId: normalizedUserId }).name;

    if (!existing) {
      const result = database.prepare(`
        INSERT INTO agent_templates (
          name, category, summary, agent_markdown, guide_text, tenant_ids_json,
          skill_preset_refs_json, mcp_preset_refs_json, hook_refs_json, global_visible,
          status, created_by_user_id, updated_by_user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
      `).run(
        values.name,
        values.category,
        values.summary,
        values.claudeMarkdown,
        values.guideText,
        JSON.stringify(values.tenantIds),
        JSON.stringify(values.skillPresetRefs),
        JSON.stringify(values.mcpPresetRefs),
        JSON.stringify(values.hookRefs),
        values.globalVisible ? 1 : 0,
        normalizedUserId,
        normalizedUserId,
      );
      return getTemplate(result.lastInsertRowid);
    }

    database.prepare(`
      UPDATE agent_templates SET
        name = ?, category = ?, summary = ?, agent_markdown = ?, guide_text = ?,
        tenant_ids_json = ?, skill_preset_refs_json = ?, mcp_preset_refs_json = ?, hook_refs_json = ?,
        global_visible = ?, status = 'draft', updated_by_user_id = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      values.name,
      values.category,
      values.summary,
      values.claudeMarkdown,
      values.guideText,
      JSON.stringify(values.tenantIds),
      JSON.stringify(values.skillPresetRefs),
      JSON.stringify(values.mcpPresetRefs),
      JSON.stringify(values.hookRefs),
      values.globalVisible ? 1 : 0,
      normalizedUserId,
      existing.id,
    );
    return getTemplate(existing.id);
  };

  const publishTemplate = ({ templateId, userId, hookResourceCatalog = null }) => {
    const template = getTemplate(templateId);
    if (!template) throw createHttpError('Agent template not found', 404);
    limitedRequiredString(template.category, 'category', 50);
    validateTenantSelection(template.tenantIds);
    resolveSkillRows(template.skillPresetRefs, { requirePublished: true });
    resolveMcpRows(template.mcpPresetRefs, { requirePublished: true });
    const hookInspections = inspectHookRefs(template.hookRefs, {
      tenantIds: template.tenantIds,
      resourceCatalog: hookResourceCatalog,
    });
    const unavailableHook = hookInspections.find((inspection) => !inspection.available);
    if (unavailableHook) {
      throw createHttpError(`Hook ${unavailableHook.row?.name || unavailableHook.ref.hookId} 不可用：${unavailableHook.unavailableReason}`);
    }
    database.prepare(`
      UPDATE agent_templates
      SET status = 'published', updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(positiveInteger(userId, 'userId'), template.id);
    return getTemplate(template.id);
  };

  const listAvailableTemplates = ({ tenantId }) => {
    const normalizedTenantId = positiveInteger(tenantId, 'tenantId');
    const visibleTemplates = database.prepare(`
      SELECT * FROM agent_templates
      WHERE status = 'published'
      ORDER BY updated_at DESC, id DESC
    `).all()
      .map(hydrateTemplate)
      .filter((template) => template.globalVisible || template.tenantIds.includes(normalizedTenantId));
    return visibleTemplates.map((template) => ({
      id: template.id,
      name: template.name,
      category: template.category,
      summary: template.summary,
      guideText: template.guideText,
      skills: inspectSkillRefs(template.skillPresetRefs)
        .filter((inspection) => inspection.available)
        .map((inspection) => ({ id: Number(inspection.row.id), name: inspection.row.display_name || inspection.row.name })),
      mcps: inspectMcpRefs(template.mcpPresetRefs)
        .filter((inspection) => inspection.available)
        .map((inspection) => ({ id: Number(inspection.row.id), name: inspection.row.display_name || inspection.row.name })),
      hooks: inspectHookRefs(template.hookRefs, { tenantIds: template.tenantIds })
        .filter((inspection) => inspection.available)
        .map((inspection) => ({
          id: inspection.row.id,
          name: inspection.row.name,
          eventName: inspection.row.event_name,
          version: Number(inspection.row.version || 0),
          capabilityTags: getHookCapabilityTags(inspection.row),
        })),
      updatedAt: template.updatedAt,
    }));
  };

  const resolveTemplateSnapshot = ({ templateId, tenantId }) => {
    const template = getTemplate(templateId);
    const normalizedTenantId = positiveInteger(tenantId, 'tenantId');
    if (!template || template.status !== 'published') {
      throw createHttpError('Agent template is not available', 404);
    }
    if (!template.globalVisible && !template.tenantIds.includes(normalizedTenantId)) {
      throw createHttpError('Agent template is not visible to this tenant', 403);
    }
    const skillInspections = inspectSkillRefs(template.skillPresetRefs);
    const mcpInspections = inspectMcpRefs(template.mcpPresetRefs);
    const unavailableCapabilities = getUnavailableCapabilities(template);
    return {
      template,
      skills: buildPresetSnapshot(skillInspections.filter((inspection) => inspection.available).map((inspection) => inspection.row)),
      mcps: buildMcpPresetSnapshot(mcpInspections.filter((inspection) => inspection.available)),
      hooks: buildHookSnapshot(
        inspectHookRefs(template.hookRefs, { tenantIds: template.tenantIds })
          .filter((inspection) => inspection.available),
      ),
      unavailableCapabilities,
    };
  };

  return {
    getTemplate,
    getWorkspaceTemplateInfo,
    listAdminTemplates: ({ tenantId, hookResourceCatalog = null } = {}) => {
      const templates = database.prepare(`
        SELECT * FROM agent_templates ORDER BY updated_at DESC, id DESC
      `).all().map(hydrateTemplate).map((template) => ({
        ...template,
        unavailableCapabilities: [
          ...getUnavailableCapabilities(template).filter((capability) => capability.type !== 'hook'),
          ...inspectHookRefs(template.hookRefs, {
            tenantIds: template.tenantIds,
            resourceCatalog: hookResourceCatalog,
          }).filter((inspection) => !inspection.available).map((inspection) => ({
            type: 'hook',
            id: inspection.row?.id || inspection.hookRow?.id || inspection.ref.hookId,
            name: inspection.row?.name || inspection.hookRow?.name || `Hook #${inspection.ref.hookId}`,
            available: false,
            unavailableReason: inspection.unavailableReason,
          })),
        ],
      }));
      if (tenantId == null || tenantId === '') return templates;
      const normalizedTenantId = positiveInteger(tenantId, 'tenantId');
      return templates.filter((template) => template.tenantIds.includes(normalizedTenantId));
    },
    listCategories: () => database.prepare(`
      SELECT
        category.id,
        category.name,
        category.created_at AS createdAt,
        COUNT(template.id) AS templateCount
      FROM agent_template_categories category
      LEFT JOIN agent_templates template
        ON template.category = category.name COLLATE NOCASE
      GROUP BY category.id, category.name, category.created_at
      ORDER BY category.name COLLATE NOCASE ASC, category.id ASC
    `).all().map((category) => ({
      ...category,
      id: Number(category.id),
      templateCount: Number(category.templateCount || 0),
    })),
    createCategory,
    deleteCategory: ({ categoryId }) => {
      const normalizedCategoryId = positiveInteger(categoryId, 'categoryId');
      const category = database.prepare(`
        SELECT id, name FROM agent_template_categories WHERE id = ?
      `).get(normalizedCategoryId);
      if (!category) throw createHttpError('Agent template category not found', 404);
      const templateCount = Number(database.prepare(`
        SELECT COUNT(*) AS count FROM agent_templates
        WHERE category = ? COLLATE NOCASE
      `).get(category.name)?.count || 0);
      if (templateCount > 0) {
        throw createHttpError('Agent template category is still used by templates', 409);
      }
      database.prepare('DELETE FROM agent_template_categories WHERE id = ?').run(normalizedCategoryId);
      return { id: normalizedCategoryId, name: category.name };
    },
    saveTemplate,
    publishTemplate,
    disableTemplate: ({ templateId, userId }) => {
      const result = database.prepare(`
        UPDATE agent_templates SET status = 'disabled', updated_by_user_id = ?,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(positiveInteger(userId, 'userId'), positiveInteger(templateId, 'templateId'));
      if (result.changes === 0) throw createHttpError('Agent template not found', 404);
      return getTemplate(templateId);
    },
    deleteTemplate: ({ templateId }) => {
      const normalizedTemplateId = positiveInteger(templateId, 'templateId');
      const template = getTemplate(normalizedTemplateId);
      if (!template) throw createHttpError('Agent template not found', 404);
      if (template.status !== 'disabled') {
        throw createHttpError('Agent template must be disabled before deletion', 409);
      }
      database.prepare('DELETE FROM agent_templates WHERE id = ?').run(normalizedTemplateId);
      return { id: normalizedTemplateId, name: template.name };
    },
    listPresetCatalog: ({ tenantId }) => {
      const normalizedTenantId = positiveInteger(tenantId, 'tenantId');
      return {
        skills: database.prepare(`
          SELECT id, tenant_id AS tenantId, name, display_name AS displayName, description, version
          FROM tenant_skill_presets WHERE tenant_id = ? AND status = 'published'
          ORDER BY display_name ASC, id ASC
        `).all(normalizedTenantId),
        mcps: database.prepare(`
          SELECT id, tenant_id AS tenantId, name, display_name AS displayName, description,
            tool_count AS toolCount, tools_json AS toolsJson
          FROM mcp_server_presets
          WHERE tenant_id = ? AND status = 'published'
            AND last_test_status = 'healthy' AND tool_count > 0
          ORDER BY display_name ASC, id ASC
        `).all(normalizedTenantId).map((preset) => ({
          ...preset,
          tools: parseJson(preset.toolsJson, []),
        })),
      };
    },
    listHookCatalog: ({ tenantId, resourceCatalog = null }) => {
      const normalizedTenantId = positiveInteger(tenantId, 'tenantId');
      validateTenantSelection([normalizedTenantId]);
      if (!tableExists('hooks')) return [];
      return database.prepare(`
        SELECT * FROM hooks
        WHERE status = 'published' AND binding_controller = 'admin'
        ORDER BY name COLLATE NOCASE ASC, updated_at DESC, id ASC
      `).all()
        .filter((row) => hookIsVisibleToTenants(row.id, [normalizedTenantId]))
        .map((row) => buildHookCatalogItem(row, resourceCatalog));
    },
    listAvailableTemplates,
    resolveTemplateSnapshot,
    saveWorkspaceSnapshot: ({ workspaceId, userId, snapshot }) => {
      database.prepare(`
        INSERT INTO workspace_agent_template_snapshots (
          workspace_id, template_id, template_name, template_updated_at,
          agent_markdown, guide_text, skill_presets_json, mcp_presets_json, hooks_json,
          created_by_user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        positiveInteger(workspaceId, 'workspaceId'),
        snapshot.template.id,
        snapshot.template.name,
        snapshot.template.updatedAt,
        snapshot.template.claudeMarkdown ?? snapshot.template.agentMarkdown,
        snapshot.template.guideText,
        JSON.stringify(snapshot.skills),
        JSON.stringify(snapshot.mcps),
        JSON.stringify(snapshot.hooks || []),
        positiveInteger(userId, 'userId'),
      );
    },
    markTemplateMcpInstall: ({ workspaceId, presetId, templateId }) => {
      database.prepare(`
        INSERT OR REPLACE INTO workspace_agent_template_mcp_installs
          (workspace_id, preset_id, template_id)
        VALUES (?, ?, ?)
      `).run(
        positiveInteger(workspaceId, 'workspaceId'),
        positiveInteger(presetId, 'presetId'),
        positiveInteger(templateId, 'templateId'),
      );
    },
  };
}

export const agentTemplateService = createAgentTemplateService();
