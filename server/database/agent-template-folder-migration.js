import { agentTemplateFolderAssetStore } from '../services/agent-template-folder-assets.js';
import { normalizeTemplateFolders } from '../services/agent-template-folders.js';

/** Return migrated metadata, or null when the record already contains no inline files. */
export function migrateStoredTemplateFolderJson(value, {
  folderAssets = agentTemplateFolderAssetStore,
} = {}) {
  const folders = JSON.parse(value || '[]');
  const hasInlineContent = Array.isArray(folders) && folders.some((folder) => (
    Array.isArray(folder?.files) && folder.files.some((file) => (
      file !== null && typeof file === 'object' && Object.hasOwn(file, 'contentBase64')
    ))
  ));
  if (!hasInlineContent) return null;
  return folderAssets.persistFolders(normalizeTemplateFolders(folders), { trusted: true });
}

/** Migrate one record at a time so historical snapshots never load as one large batch. */
export function migrateAgentTemplateFolderStorage(database, {
  folderAssets = agentTemplateFolderAssetStore,
  onError,
} = {}) {
  const migrated = { templates: 0, snapshots: 0 };
  for (const [tableName, keyColumn, countKey] of [
    ['agent_templates', 'id', 'templates'],
    ['workspace_agent_template_snapshots', 'workspace_id', 'snapshots'],
  ]) {
    const columns = database.prepare(`PRAGMA table_info(${tableName})`).all();
    if (!columns.some((column) => column.name === 'claude_folders_json')) continue;
    const next = database.prepare(`
      SELECT ${keyColumn} AS migration_id, claude_folders_json
      FROM ${tableName}
      WHERE ${keyColumn} > ?
      ORDER BY ${keyColumn} ASC LIMIT 1
    `);
    const update = database.prepare(`
      UPDATE ${tableName} SET claude_folders_json = ?
      WHERE ${keyColumn} = ? AND claude_folders_json = ?
    `);
    let lastId = 0;
    for (let row; (row = next.get(lastId));) {
      lastId = row.migration_id;
      try {
        const metadata = migrateStoredTemplateFolderJson(row.claude_folders_json, { folderAssets });
        if (metadata === null) continue;
        // Persisting all bytes must succeed before replacing the only inline copy.
        const result = update.run(JSON.stringify(metadata), row.migration_id, row.claude_folders_json);
        migrated[countKey] += result.changes;
      } catch (cause) {
        const error = new Error(`Failed to migrate Agent template folders in ${tableName} (${row.migration_id}): ${cause.message}`, { cause });
        if (typeof onError !== 'function') throw error;
        // Server startup reports a bad row but can still migrate healthy rows and other schemas.
        onError(error);
      }
    }
  }
  return migrated;
}
