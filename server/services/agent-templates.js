import { db } from '../database/db.js';

const TEMPLATE_STATUSES = new Set(['draft', 'published', 'disabled']);
const GLOBAL_TENANT_CODES = new Set(['dataagent', 'dataagent-admin', 'dataagent-management']);

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
          skill_preset_refs_json, mcp_preset_refs_json, global_visible,
          status, created_by_user_id, updated_by_user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
      `).run(
        values.name,
        values.category,
        values.summary,
        values.claudeMarkdown,
        values.guideText,
        JSON.stringify(values.tenantIds),
        JSON.stringify(values.skillPresetRefs),
        JSON.stringify(values.mcpPresetRefs),
        values.globalVisible ? 1 : 0,
        normalizedUserId,
        normalizedUserId,
      );
      return getTemplate(result.lastInsertRowid);
    }

    database.prepare(`
      UPDATE agent_templates SET
        name = ?, category = ?, summary = ?, agent_markdown = ?, guide_text = ?,
        tenant_ids_json = ?, skill_preset_refs_json = ?, mcp_preset_refs_json = ?,
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
      values.globalVisible ? 1 : 0,
      normalizedUserId,
      existing.id,
    );
    return getTemplate(existing.id);
  };

  const publishTemplate = ({ templateId, userId }) => {
    const template = getTemplate(templateId);
    if (!template) throw createHttpError('Agent template not found', 404);
    limitedRequiredString(template.category, 'category', 50);
    validateTenantSelection(template.tenantIds);
    resolveSkillRows(template.skillPresetRefs, { requirePublished: true });
    resolveMcpRows(template.mcpPresetRefs, { requirePublished: true });
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
      unavailableCapabilities,
    };
  };

  return {
    getTemplate,
    getWorkspaceTemplateInfo,
    listAdminTemplates: ({ tenantId } = {}) => {
      const templates = database.prepare(`
        SELECT * FROM agent_templates ORDER BY updated_at DESC, id DESC
      `).all().map(hydrateTemplate).map((template) => ({
        ...template,
        unavailableCapabilities: getUnavailableCapabilities(template),
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
    listAvailableTemplates,
    resolveTemplateSnapshot,
    saveWorkspaceSnapshot: ({ workspaceId, userId, snapshot }) => {
      database.prepare(`
        INSERT INTO workspace_agent_template_snapshots (
          workspace_id, template_id, template_name, template_updated_at,
          agent_markdown, guide_text, skill_presets_json, mcp_presets_json,
          created_by_user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        positiveInteger(workspaceId, 'workspaceId'),
        snapshot.template.id,
        snapshot.template.name,
        snapshot.template.updatedAt,
        snapshot.template.claudeMarkdown ?? snapshot.template.agentMarkdown,
        snapshot.template.guideText,
        JSON.stringify(snapshot.skills),
        JSON.stringify(snapshot.mcps),
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
