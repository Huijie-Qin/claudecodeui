// Keep legacy tenant preinstalls unchanged. Only split records shared by templates.
// Workspace snapshots and installed files are historical data and must not be rewritten.
export function migrateAgentTemplateSkillIsolation(database) {
  return database.transaction(() => {
    const copies = new Map();
    let templatesUpdated = 0;
    const columns = database.prepare('PRAGMA table_info(tenant_skill_presets)').all()
      .map((column) => column.name).filter((name) => name !== 'id');
    const insert = database.prepare(`INSERT INTO tenant_skill_presets
      (${columns.map((name) => `"${name}"`).join(', ')})
      VALUES (${columns.map(() => '?').join(', ')})`);
    const readPreset = database.prepare('SELECT * FROM tenant_skill_presets WHERE tenant_id = ? AND id = ?');
    const findName = database.prepare('SELECT id FROM tenant_skill_presets WHERE tenant_id = ? AND LOWER(name) = LOWER(?)');
    const update = database.prepare('UPDATE agent_templates SET skill_preset_refs_json = ? WHERE id = ?');

    for (const template of database.prepare('SELECT id, skill_preset_refs_json FROM agent_templates').all()) {
      let refs;
      try { refs = JSON.parse(template.skill_preset_refs_json || '[]'); } catch { continue; }
      if (!Array.isArray(refs)) continue;
      let changed = false;
      const isolatedRefs = refs.map((ref) => {
        const tenantId = Number(ref?.tenantId);
        const presetId = Number(ref?.presetId);
        if (!Number.isInteger(tenantId) || !Number.isInteger(presetId)) return ref;
        const preset = readPreset.get(tenantId, presetId);
        if (!preset || preset.preinstall_scope !== 'all_workspaces') return ref;
        if (!copies.has(preset.id)) {
          let name;
          let attempt = 0;
          do {
            const suffix = `-template-${preset.id}${attempt ? `-${attempt}` : ''}`;
            name = `${preset.name.slice(0, 80 - suffix.length)}${suffix}`;
            attempt += 1;
          } while (findName.get(tenantId, name));
          const copy = { ...preset, name, preinstall_scope: 'none' };
          copies.set(preset.id, Number(insert.run(...columns.map((column) => copy[column])).lastInsertRowid));
        }
        changed = true;
        return { ...ref, presetId: copies.get(preset.id) };
      });
      if (changed) {
        update.run(JSON.stringify(isolatedRefs), template.id);
        templatesUpdated += 1;
      }
    }
    return { templatesUpdated, presetsCreated: copies.size };
  })();
}
