import { promises as fs } from 'fs';
import path from 'path';

import { userDb as defaultUserDb } from '../database/db.js';
import { multitenancyDb as defaultMultitenancyDb } from '../database/multitenancy-db.js';
import { findAppRoot, getModuleDir } from '../utils/runtime-paths.js';

import { createWorkspaceMcpToolsService } from './workspace-mcp-tools.js';
import { buildTenantWorkspacePath } from './workspace-projects.js';
import { resolveWorkspacesRoot } from './workspace-root.js';

export const ROOT_WORKSPACE_NAME = 'workspace';

const APP_ROOT = findAppRoot(getModuleDir(import.meta.url));
const SOURCE_SKILLS_PATH = path.join(APP_ROOT, 'default_files');

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function copyDefaultSkills(workspacePath) {
  await fs.mkdir(workspacePath, { recursive: true });

  if (await pathExists(SOURCE_SKILLS_PATH)) {
    const entries = await fs.readdir(SOURCE_SKILLS_PATH, { withFileTypes: true });
    await Promise.all(entries.map((entry) => fs.cp(
      path.join(SOURCE_SKILLS_PATH, entry.name),
      path.join(workspacePath, entry.name),
      {
        recursive: true,
        force: true,
      },
    )));
  }
}

async function installPreinstalledMcpPresets(workspaceMcpTools, { tenantId, userId, workspace }) {
  if (typeof workspaceMcpTools?.installPreinstalledWorkspaceMcpPresets !== 'function') {
    return { installed: [], errors: [] };
  }

  const result = await workspaceMcpTools.installPreinstalledWorkspaceMcpPresets({
    tenantId,
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    workspaceDisplayName: workspace.display_name || workspace.slug || String(workspace.id),
    userId,
  });

  if (result.errors?.length > 0) {
    console.warn('Failed to preinstall some MCP presets:', result.errors);
  }

  return result;
}

export async function ensureDefaultRootWorkspace({
  multitenancy = defaultMultitenancyDb,
  users = defaultUserDb,
  workspaceMcpTools = createWorkspaceMcpToolsService({ multitenancy }),
  tenantId,
  userId,
} = {}) {
  const tenant = multitenancy.tenants.getTenantById(tenantId);
  const user = typeof users?.getUserByIdAnyStatus === 'function'
    ? users.getUserByIdAnyStatus(userId)
    : typeof users?.getUserById === 'function'
      ? users.getUserById(userId)
      : null;
  const workspacePath = buildTenantWorkspacePath({
    workspacesRoot: resolveWorkspacesRoot(),
    tenantCode: tenant?.code,
    username: user?.username,
    tenantId,
    userId,
    requestedPath: ROOT_WORKSPACE_NAME,
  });

  await fs.mkdir(workspacePath, { recursive: true });

  const existingWorkspace = multitenancy.workspaces.getWorkspaceByTenantSlug({
    tenantId,
    ownerUserId: userId,
    slug: ROOT_WORKSPACE_NAME,
  });

  const createdDefaultWorkspace = !existingWorkspace;
  const workspace = existingWorkspace || multitenancy.workspaces.createWorkspace({
    tenantId,
    ownerUserId: userId,
    slug: ROOT_WORKSPACE_NAME,
    displayName: ROOT_WORKSPACE_NAME,
    path: workspacePath,
  });

  await copyDefaultSkills(workspace.path);
  if (createdDefaultWorkspace) {
    await installPreinstalledMcpPresets(workspaceMcpTools, { tenantId, userId, workspace });
  }
  return workspace;
}
