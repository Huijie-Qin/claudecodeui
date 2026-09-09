import { createHash } from 'node:crypto';

import { agentTemplateFolderAssetStore } from '../services/agent-template-folder-assets.js';
import { normalizeTemplateFolders } from '../services/agent-template-folders.js';

/** Workspace history records what was copied; it never points back to mutable template files. */
export function toTemplateFolderAudit(value = []) {
  return normalizeTemplateFolders(value).map((folder) => ({
    name: folder.name,
    directories: folder.directories,
    files: folder.files.map((file) => {
      if (!Object.hasOwn(file, 'contentBase64')) {
        return { path: file.path, size: file.size, sha256: file.sha256 };
      }
      const bytes = Buffer.from(file.contentBase64, 'base64');
      return { path: file.path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    }),
  }));
}

export function needsTemplateFolderStorageMigration(value, {
  folderAssets = agentTemplateFolderAssetStore,
  templateId,
} = {}) {
  const rawFolders = JSON.parse(value || '[]');
  const folders = normalizeTemplateFolders(rawFolders);
  if (folders.length === 0) return false;
  if (rawFolders.some((folder) => Object.hasOwn(folder, 'version'))) return true;
  if (folders.some((folder) => folder.files.some((file) => (
    Object.hasOwn(file, 'contentBase64')
    || file.storagePath !== `templates/${templateId}/folders/${folder.name}/${file.path}`
  )))) return true;
  if (folders.some((folder) => folder.files.length > 0)) return false;
  // Empty legacy folders have no file paths with which to distinguish the old format.
  return !folderAssets.isCurrentTemplate(folders, { templateId });
}

/** Keep the current directory and database row in step, with the SQLite writer lock held. */
export function withAgentTemplateFolderUpdate(database, folderAssets, operation) {
  let change;
  const replaceFolders = (folders, options) => {
    if (change) throw new Error('Only one template folder replacement is allowed per transaction');
    change = folderAssets.beginUpdate(folders, options);
    return change.folders;
  };
  const rollbackFolders = () => {
    if (!change) return;
    change.rollback();
    change = undefined;
  };
  let result;
  try {
    result = database.transaction(() => {
      try {
        return operation({ replaceFolders, rollbackFolders });
      } catch (error) {
        // Restore files before releasing the writer lock, so another process sees a consistent row and directory.
        try {
          rollbackFolders();
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Template save failed and its file rollback also failed');
        }
        throw error;
      }
    }).immediate();
  } catch (error) {
    try {
      rollbackFolders();
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Template save failed and its file rollback also failed');
    }
    throw error;
  }
  // The database has committed. A cleanup failure must not restore obsolete files over its row.
  change?.commit();
  return result;
}

/** Migrate one record at a time; historical snapshots only become audit metadata. */
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
      FROM ${tableName} WHERE ${keyColumn} > ? ORDER BY ${keyColumn} ASC LIMIT 1
    `);
    const update = database.prepare(`
      UPDATE ${tableName} SET claude_folders_json = ?
      WHERE ${keyColumn} = ? AND claude_folders_json = ?
    `);
    let lastId = 0;
    for (let row; (row = next.get(lastId));) {
      lastId = row.migration_id;
      try {
        if (countKey === 'snapshots') {
          const auditJson = JSON.stringify(toTemplateFolderAudit(JSON.parse(row.claude_folders_json || '[]')));
          if (auditJson !== row.claude_folders_json) {
            migrated.snapshots += update.run(auditJson, row.migration_id, row.claude_folders_json).changes;
          }
          continue;
        }
        migrated.templates += withAgentTemplateFolderUpdate(database, folderAssets, ({ replaceFolders, rollbackFolders }) => {
          const current = database.prepare('SELECT id, name, claude_folders_json FROM agent_templates WHERE id = ?')
            .get(row.migration_id);
          if (!current || !needsTemplateFolderStorageMigration(current.claude_folders_json, {
            folderAssets, templateId: current.id,
          })) return 0;
          const metadata = replaceFolders(normalizeTemplateFolders(JSON.parse(current.claude_folders_json)), {
            templateId: current.id, templateName: current.name, trusted: true,
          });
          const result = update.run(JSON.stringify(metadata), current.id, current.claude_folders_json);
          if (result.changes === 0) rollbackFolders();
          return result.changes;
        });
      } catch (cause) {
        const error = new Error(`Failed to migrate Agent template folders in ${tableName} (${row.migration_id}): ${cause.message}`, { cause });
        if (typeof onError !== 'function') throw error;
        onError(error);
      }
    }
  }
  return migrated;
}
