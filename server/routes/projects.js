import { promises as fs } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import os from 'os';

import express from 'express';

import { multitenancyDb } from '../database/multitenancy-db.js';
import { userDb } from '../database/db.js';
import { tenantContext } from '../middleware/tenant-context.js';
import { checkOpenApiAgentList } from '../services/openapi-agent.js';
import { agentTemplateService } from '../services/agent-templates.js';
import { skillPresetService } from '../services/skill-presets.js';
import { createWorkspaceMcpToolsService } from '../services/workspace-mcp-tools.js';
import { workspaceAccess } from '../services/workspace-access.js';
import { applyWorkspaceOwnership } from '../services/workspace-ownership.js';
import {
  readWorkspaceAgentInstructions,
  writeWorkspaceAgentInstructions,
} from '../services/workspace-agent-instructions.js';
import { resolveCloneDestinationPath, resolveWorkspaceTarget } from '../services/workspace-projects.js';

const router = express.Router();
const MAX_AGENT_MARKDOWN_BYTES = 1024 * 1024;
const workspaceMcpTools = createWorkspaceMcpToolsService({
  multitenancy: multitenancyDb,
  users: userDb,
});

function sanitizeGitError(message, token) {
  if (!message || !token) return message;
  return message.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '***');
}

// Configure allowed workspace root (defaults to user's home directory)
export const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || os.homedir();

// System-critical paths that should never be used as workspace directories
export const FORBIDDEN_PATHS = [
  // Unix
  '/',
  '/etc',
  '/bin',
  '/sbin',
  '/usr',
  '/dev',
  '/proc',
  '/sys',
  '/var',
  '/boot',
  '/root',
  '/lib',
  '/lib64',
  '/opt',
  '/tmp',
  '/run',
  // Windows
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  'C:\\System Volume Information',
  'C:\\$Recycle.Bin'
];

function createWorkspaceProject(workspace) {
  return {
    name: workspace.slug,
    workspaceId: workspace.id,
    tenantId: workspace.tenant_id,
    ownerUserId: workspace.owner_user_id,
    displayName: workspace.display_name,
    fullPath: workspace.path,
    path: workspace.path,
    accessRole: 'owner',
  };
}

async function installPreinstalledSkillPresetsForWorkspace({ tenant, workspace, user }) {
  try {
    const result = await skillPresetService.installPreinstalledSkillPresets({
      tenantId: tenant.id,
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      userId: user.id,
      tenantCode: tenant.code,
      accountId: user.username,
    });
    if (result.errors?.length > 0) {
      console.warn('Failed to preinstall some Skill presets for workspace:', {
        workspaceId: workspace.id,
        errors: result.errors,
      });
    }
    return result;
  } catch (error) {
    console.warn('Failed to preinstall Skill presets for workspace:', {
      workspaceId: workspace?.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return { installed: [], errors: [{ error: error instanceof Error ? error.message : String(error) }] };
  }
}

async function applyAgentTemplateToWorkspace({ templateId, tenant, workspace, user }) {
  if (templateId == null || templateId === '') return null;

  const snapshot = agentTemplateService.resolveTemplateSnapshot({
    templateId: Number(templateId),
    tenantId: tenant.id,
  });

  const instructions = snapshot.template.agentMarkdown.trim();
  if (instructions) {
    // Agent.md is the platform-managed source of truth. It is injected into
    // the Claude Agent SDK system prompt when a managed workspace session starts.
    await writeWorkspaceAgentInstructions(workspace.path, `${instructions}\n`);
  }

  const installedSkillPresetIds = new Set(
    (multitenancyDb.skillPresetInstalls?.listInstallsForWorkspace?.({ workspaceId: workspace.id }) || [])
      .map((install) => Number(install.preset_id)),
  );
  for (const preset of snapshot.skills) {
    if (installedSkillPresetIds.has(preset.id)) continue;
    const sourceTenant = multitenancyDb.tenants.getTenantById(preset.tenantId);
    await skillPresetService.installWorkspaceSkillPreset({
      tenantId: preset.tenantId,
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      presetId: preset.id,
      userId: user.id,
      tenantCode: sourceTenant?.prod_code || sourceTenant?.code,
      accountId: user.username,
    });
  }

  for (const preset of snapshot.mcps) {
    await workspaceMcpTools.installWorkspaceMcpPreset({
      tenantId: preset.tenantId,
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      workspaceDisplayName: workspace.display_name,
      presetId: preset.id,
      userId: user.id,
    });
    agentTemplateService.markTemplateMcpInstall({
      workspaceId: workspace.id,
      presetId: preset.id,
      templateId: snapshot.template.id,
    });
  }

  agentTemplateService.saveWorkspaceSnapshot({
    workspaceId: workspace.id,
    userId: user.id,
    snapshot,
  });

  return {
    id: snapshot.template.id,
    name: snapshot.template.name,
    guideText: snapshot.template.guideText,
  };
}

function resolveProjectSettingsWorkspace(req, { requireEdit = false } = {}) {
  const tenantId = Number(req.tenant?.id);
  const workspaceId = Number(req.query.workspaceId || req.body?.workspaceId);
  const userId = req.user?.id ?? req.user?.userId;
  if (!tenantId || !workspaceId || !userId) {
    const error = new Error('tenantId and workspaceId are required');
    error.statusCode = 400;
    throw error;
  }

  const resolved = workspaceAccess.requireWorkspace({
    tenantId,
    userId,
    workspaceId,
    requireEdit,
  });
  if (resolved.workspace.slug !== req.params.projectName) {
    const error = new Error('Workspace not found');
    error.statusCode = 404;
    throw error;
  }

  return resolved;
}

router.get('/:projectName/settings', tenantContext, async (req, res) => {
  try {
    const { workspace, accessRole } = resolveProjectSettingsWorkspace(req);
    const instructions = await readWorkspaceAgentInstructions(workspace.path);

    return res.json({
      workspaceId: workspace.id,
      displayName: workspace.display_name,
      agentMarkdown: instructions.content,
      agentMarkdownSource: instructions.source,
      revision: instructions.revision,
      customInstructions: instructions.customInstructions,
      accessRole,
      canEdit: accessRole === 'owner' || accessRole === 'edit',
    });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return res.status(404).json({ error: 'Workspace path not found' });
    }
    return res.status(error?.statusCode || 500).json({ error: error?.message || 'Failed to load project settings' });
  }
});

router.put('/:projectName/settings', tenantContext, async (req, res) => {
  try {
    const { displayName, agentMarkdown, expectedRevision } = req.body || {};
    if (typeof displayName !== 'string' || !displayName.trim()) {
      return res.status(400).json({ error: 'Display name is required' });
    }
    if (typeof agentMarkdown !== 'string') {
      return res.status(400).json({ error: 'Agent.md content is required' });
    }
    if (typeof expectedRevision !== 'string' || !expectedRevision) {
      return res.status(400).json({ error: 'Project settings revision is required' });
    }
    if (displayName.trim().length > 120) {
      return res.status(400).json({ error: 'Display name must not exceed 120 characters' });
    }
    if (Buffer.byteLength(agentMarkdown, 'utf8') > MAX_AGENT_MARKDOWN_BYTES) {
      return res.status(413).json({ error: 'Agent.md content must not exceed 1 MB' });
    }

    const { workspace } = resolveProjectSettingsWorkspace(req, { requireEdit: true });
    const currentInstructions = await readWorkspaceAgentInstructions(workspace.path);
    if (currentInstructions.revision !== expectedRevision) {
      return res.status(409).json({
        error: 'Agent instructions changed after this editor was opened. Reload and try again.',
        code: 'PROJECT_SETTINGS_CONFLICT',
      });
    }
    const written = await writeWorkspaceAgentInstructions(workspace.path, agentMarkdown);
    await applyWorkspaceOwnership({
      workspaceRoot: workspace.path,
      targetPaths: written.paths,
      reason: 'project_settings_update',
      context: { workspaceId: workspace.id },
    });
    const updatedWorkspace = multitenancyDb.workspaces.updateDisplayName({
      workspaceId: workspace.id,
      displayName: displayName.trim(),
    });

    return res.json({
      success: true,
      workspaceId: workspace.id,
      displayName: updatedWorkspace.display_name,
      agentMarkdown: written.content,
      revision: written.revision,
      updatedFiles: ['Agent.md'],
      removedLegacyFiles: written.migration.removed ? ['CLAUDE.md'] : [],
      customInstructions: written.customInstructions,
    });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return res.status(404).json({ error: 'Workspace path not found' });
    }
    return res.status(error?.statusCode || 500).json({ error: error?.message || 'Failed to save project settings' });
  }
});

router.post('/:projectName/agent-list-check', async (req, res) => {
  try {
    const tenantId = Number(req.query.tenantId || req.headers['x-tenant-id'] || req.body?.tenantId);
    const workspaceId = Number(req.query.workspaceId || req.body?.workspaceId);
    if (!tenantId || !workspaceId || !req.user?.id) {
      return res.status(400).json({ error: 'tenantId and workspaceId are required' });
    }

    const { workspace } = workspaceAccess.requireWorkspace({
      tenantId,
      userId: req.user.id,
      workspaceId,
      requireEdit: false,
    });
    if (workspace.slug !== req.params.projectName) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    const tenant = multitenancyDb.tenants.getTenantById(tenantId);
    const prodCode = tenant?.prod_code;
    const accountId = req.user.username;
    if (!prodCode || !accountId) {
      return res.status(400).json({ error: 'prod_code and username are required' });
    }

    await checkOpenApiAgentList({ tenantCode: prodCode, accountId });
    return res.json({ ok: true });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({ error: error.message });
  }
});

/**
 * Validates that a path is safe for workspace operations
 * @param {string} requestedPath - The path to validate
 * @returns {Promise<{valid: boolean, resolvedPath?: string, error?: string}>}
 */
export async function validateWorkspacePath(requestedPath) {
  try {
    // Resolve to absolute path
    let absolutePath = path.resolve(requestedPath);

    // Check if path is a forbidden system directory
    const normalizedPath = path.normalize(absolutePath);
    if (FORBIDDEN_PATHS.includes(normalizedPath) || normalizedPath === '/') {
      return {
        valid: false,
        error: 'Cannot use system-critical directories as workspace locations'
      };
    }

    // Additional check for paths starting with forbidden directories
    for (const forbidden of FORBIDDEN_PATHS) {
      if (normalizedPath === forbidden ||
          normalizedPath.startsWith(forbidden + path.sep)) {
        // Exception: /var/tmp and similar user-accessible paths might be allowed
        // but /var itself and most /var subdirectories should be blocked
        if (forbidden === '/var' &&
            (normalizedPath.startsWith('/var/tmp') ||
             normalizedPath.startsWith('/var/folders'))) {
          continue; // Allow these specific cases
        }

        return {
          valid: false,
          error: `Cannot create workspace in system directory: ${forbidden}`
        };
      }
    }

    // Try to resolve the real path (following symlinks)
    let realPath;
    try {
      // Check if path exists to resolve real path
      await fs.access(absolutePath);
      realPath = await fs.realpath(absolutePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Path doesn't exist yet - check parent directory
        let parentPath = path.dirname(absolutePath);
        try {
          const parentRealPath = await fs.realpath(parentPath);

          // Reconstruct the full path with real parent
          realPath = path.join(parentRealPath, path.basename(absolutePath));
        } catch (parentError) {
          if (parentError.code === 'ENOENT') {
            // Parent doesn't exist either - use the absolute path as-is
            // We'll validate it's within allowed root
            realPath = absolutePath;
          } else {
            throw parentError;
          }
        }
      } else {
        throw error;
      }
    }

    await fs.mkdir(WORKSPACES_ROOT, { recursive: true });

    // Resolve the workspace root to its real path
    const resolvedWorkspaceRoot = await fs.realpath(WORKSPACES_ROOT);

    // Ensure the resolved path is contained within the allowed workspace root
    if (!realPath.startsWith(resolvedWorkspaceRoot + path.sep) &&
        realPath !== resolvedWorkspaceRoot) {
      return {
        valid: false,
        error: `Workspace path must be within the allowed workspace root: ${WORKSPACES_ROOT}`
      };
    }

    // Additional symlink check for existing paths
    try {
      await fs.access(absolutePath);
      const stats = await fs.lstat(absolutePath);

      if (stats.isSymbolicLink()) {
        // Verify symlink target is also within allowed root
        const linkTarget = await fs.readlink(absolutePath);
        const resolvedTarget = path.resolve(path.dirname(absolutePath), linkTarget);
        const realTarget = await fs.realpath(resolvedTarget);

        if (!realTarget.startsWith(resolvedWorkspaceRoot + path.sep) &&
            realTarget !== resolvedWorkspaceRoot) {
          return {
            valid: false,
            error: 'Symlink target is outside the allowed workspace root'
          };
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      // Path doesn't exist - that's fine for new workspace creation
    }

    return {
      valid: true,
      resolvedPath: realPath
    };

  } catch (error) {
    return {
      valid: false,
      error: `Path validation failed: ${error.message}`
    };
  }
}

/**
 * Create a new workspace
 * POST /api/projects/create-workspace
 *
 * Body:
 * - workspaceType: 'existing' | 'new'
 * - path: string (workspace path)
 * - githubUrl?: string (optional, for new workspaces)
 * - githubTokenId?: number (optional, ID of stored token)
 * - newGithubToken?: string (optional, one-time token)
 */
router.post('/create-workspace', async (req, res) => {
  try {
    const {
      workspaceType,
      path: workspacePath,
      githubUrl,
      githubTokenId,
      newGithubToken,
      templateId = null,
    } = req.body;

    // Validate required fields
    if (!workspaceType || !workspacePath) {
      return res.status(400).json({ error: 'workspaceType and path are required' });
    }

    const tenantId = Number(req.query.tenantId || req.headers['x-tenant-id']);
    if (!tenantId || !req.user?.id) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    const membership = multitenancyDb.memberships.getActiveMembership(req.user.id, tenantId);
    if (!membership) {
      return res.status(403).json({ error: 'Tenant access denied' });
    }
    if (membership.permission !== 'edit') {
      return res.status(403).json({ error: 'Tenant edit permission is required to create workspaces' });
    }

    const tenant = multitenancyDb.tenants.getTenantById(tenantId);
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    if (!['existing', 'new'].includes(workspaceType)) {
      return res.status(400).json({ error: 'workspaceType must be "existing" or "new"' });
    }
    if (templateId != null && templateId !== '' && workspaceType !== 'new') {
      return res.status(400).json({ error: 'Agent templates can only be used for new workspaces' });
    }

    const {
      requestedName,
      workspaceSlug,
      targetPath: targetWorkspacePath,
    } = resolveWorkspaceTarget({
      workspaceType,
      workspacesRoot: WORKSPACES_ROOT,
      tenantCode: tenant.code,
      username: req.user.username,
      tenantId,
      userId: req.user.id,
      requestedPath: workspacePath,
    });
    if (!workspaceSlug) {
      return res.status(400).json({ error: 'Workspace name must contain letters or numbers' });
    }

    // Validate path safety before any operations
    const validation = await validateWorkspacePath(targetWorkspacePath);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Invalid workspace path',
        details: validation.error
      });
    }

    const absolutePath = validation.resolvedPath;

    // Handle existing workspace
    if (workspaceType === 'existing') {
      // Check if the path exists
      try {
        await fs.access(absolutePath);
        const stats = await fs.stat(absolutePath);

        if (!stats.isDirectory()) {
          return res.status(400).json({ error: 'Path exists but is not a directory' });
        }
      } catch (error) {
        if (error.code === 'ENOENT') {
          return res.status(404).json({ error: 'Workspace path does not exist' });
        }
        throw error;
      }

      // Add the existing workspace to the project list
      const workspace = multitenancyDb.workspaces.createWorkspace({
        tenantId,
        ownerUserId: req.user.id,
        slug: workspaceSlug,
        displayName: requestedName || workspaceSlug,
        path: absolutePath,
      });
      await installPreinstalledSkillPresetsForWorkspace({ tenant, workspace, user: req.user });

      return res.json({
        success: true,
        project: createWorkspaceProject(workspace),
        message: 'Existing workspace added successfully'
      });
    }

    // Handle new workspace creation
    if (workspaceType === 'new') {
      // If GitHub URL is provided, clone the repository
      if (githubUrl) {
        let githubToken = null;

        // Get GitHub token if needed
        if (githubTokenId) {
          // Fetch token from database
          const token = await getGithubTokenById(githubTokenId, req.user.id);
          if (!token) {
            return res.status(404).json({ error: 'GitHub token not found' });
          }
          githubToken = token.github_token;
        } else if (newGithubToken) {
          githubToken = newGithubToken;
        }

        // Extract repo name from URL for the clone destination
        const normalizedUrl = githubUrl.replace(/\/+$/, '').replace(/\.git$/, '');
        const repoName = normalizedUrl.split('/').pop() || 'repository';
        const clonePath = resolveCloneDestinationPath({
          workspaceType,
          workspaceRootPath: absolutePath,
          workspaceSlug,
          repoName,
        });

        // Check if clone destination already exists to prevent data loss
        const destination = await validateCloneDestination(clonePath);
        if (!destination.available) {
          return res.status(409).json({
            error: 'Directory already exists',
            details: destination.message,
          });
        }

        await fs.mkdir(path.dirname(clonePath), { recursive: true });

        // Clone the repository into its final workspace path
        try {
          await cloneGitHubRepository(githubUrl, clonePath, githubToken);
        } catch (error) {
          // Only clean up if clone created partial data (check if dir exists and is empty or partial)
          try {
            const stats = await fs.stat(clonePath);
            if (stats.isDirectory()) {
              await fs.rm(clonePath, { recursive: true, force: true });
            }
          } catch (cleanupError) {
            // Directory doesn't exist or cleanup failed - ignore
          }
          throw new Error(`Failed to clone repository: ${error.message}`);
        }

        // Add the cloned repo path to the project list
        const workspace = multitenancyDb.workspaces.createWorkspace({
          tenantId,
          ownerUserId: req.user.id,
          slug: workspaceSlug,
          displayName: requestedName || workspaceSlug,
          path: clonePath,
        });
        await installPreinstalledSkillPresetsForWorkspace({ tenant, workspace, user: req.user });
        const agentTemplate = await applyAgentTemplateToWorkspace({
          templateId,
          tenant,
          workspace,
          user: req.user,
        });
        await applyWorkspaceOwnership({
          workspaceRoot: workspace.path,
          targetPaths: [workspace.path],
          recursive: true,
          includeParents: false,
          reason: 'workspace_clone',
          context: { tenantId, userId: req.user.id, workspaceId: workspace.id },
        });

        return res.json({
          success: true,
          project: createWorkspaceProject(workspace),
          agentTemplate,
          message: 'New workspace created and repository cloned successfully'
        });
      }

      // Add the new workspace to the project list (no clone)
      await fs.mkdir(absolutePath, { recursive: true });
      const workspace = multitenancyDb.workspaces.createWorkspace({
        tenantId,
        ownerUserId: req.user.id,
        slug: workspaceSlug,
        displayName: requestedName || workspaceSlug,
        path: absolutePath,
      });
      await installPreinstalledSkillPresetsForWorkspace({ tenant, workspace, user: req.user });
      const agentTemplate = await applyAgentTemplateToWorkspace({
        templateId,
        tenant,
        workspace,
        user: req.user,
      });
      await applyWorkspaceOwnership({
        workspaceRoot: workspace.path,
        targetPaths: [workspace.path],
        recursive: true,
        includeParents: false,
        reason: 'workspace_create',
        context: { tenantId, userId: req.user.id, workspaceId: workspace.id },
      });

      return res.json({
        success: true,
        project: createWorkspaceProject(workspace),
        agentTemplate,
        message: 'New workspace created successfully'
      });
    }

  } catch (error) {
    console.error('Error creating workspace:', error);
    res.status(error?.statusCode || 500).json({
      error: error.message || 'Failed to create workspace',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

/**
 * Helper function to get GitHub token from database
 */
async function getGithubTokenById(tokenId, userId) {
  const { db } = await import('../database/db.js');

  const credential = db.prepare(
    'SELECT * FROM user_credentials WHERE id = ? AND user_id = ? AND credential_type = ? AND is_active = 1'
  ).get(tokenId, userId, 'github_token');

  // Return in the expected format (github_token field for compatibility)
  if (credential) {
    return {
      ...credential,
      github_token: credential.credential_value
    };
  }

  return null;
}

async function validateCloneDestination(clonePath) {
  try {
    const stats = await fs.stat(clonePath);
    if (!stats.isDirectory()) {
      return {
        available: false,
        message: `The destination path "${clonePath}" exists but is not a directory. Please choose a different location.`
      };
    }

    const entries = await fs.readdir(clonePath);
    if (entries.length > 0) {
      return {
        available: false,
        message: `The destination path "${clonePath}" is not empty. Please choose a different location or remove the existing directory.`
      };
    }

    return { available: true };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { available: true };
    }
    throw error;
  }
}

/**
 * Clone repository with progress streaming (SSE)
 * GET /api/projects/clone-progress
 */
router.get('/clone-progress', async (req, res) => {
  const {
    path: workspacePath,
    githubUrl,
    githubTokenId,
    newGithubToken,
    workspaceType = 'new',
  } = req.query;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  try {
    if (!workspacePath || !githubUrl) {
      sendEvent('error', { message: 'workspacePath and githubUrl are required' });
      res.end();
      return;
    }

    if (!['existing', 'new'].includes(workspaceType)) {
      sendEvent('error', { message: 'workspaceType must be "existing" or "new"' });
      res.end();
      return;
    }

    const tenantId = Number(req.query.tenantId || req.headers['x-tenant-id']);
    if (!tenantId || !req.user?.id) {
      sendEvent('error', { message: 'tenantId is required' });
      res.end();
      return;
    }

    const membership = multitenancyDb.memberships.getActiveMembership(req.user.id, tenantId);
    if (!membership) {
      sendEvent('error', { message: 'Tenant access denied' });
      res.end();
      return;
    }
    if (membership.permission !== 'edit') {
      sendEvent('error', { message: 'Tenant edit permission is required to create workspaces' });
      res.end();
      return;
    }

    const tenant = multitenancyDb.tenants.getTenantById(tenantId);
    if (!tenant) {
      sendEvent('error', { message: 'Tenant not found' });
      res.end();
      return;
    }

    const {
      requestedName,
      workspaceSlug,
      targetPath: targetWorkspacePath,
    } = resolveWorkspaceTarget({
      workspaceType,
      workspacesRoot: WORKSPACES_ROOT,
      tenantCode: tenant.code,
      username: req.user.username,
      tenantId,
      userId: req.user.id,
      requestedPath: workspacePath,
    });
    if (!workspaceSlug) {
      sendEvent('error', { message: 'Workspace name must contain letters or numbers' });
      res.end();
      return;
    }

    const validation = await validateWorkspacePath(targetWorkspacePath);
    if (!validation.valid) {
      sendEvent('error', { message: validation.error });
      res.end();
      return;
    }

    const absolutePath = validation.resolvedPath;

    let githubToken = null;
    if (githubTokenId) {
      const token = await getGithubTokenById(parseInt(githubTokenId), req.user.id);
      if (!token) {
        sendEvent('error', { message: 'GitHub token not found' });
        res.end();
        return;
      }
      githubToken = token.github_token;
    } else if (newGithubToken) {
      githubToken = newGithubToken;
    }

    const normalizedUrl = githubUrl.replace(/\/+$/, '').replace(/\.git$/, '');
    const repoName = normalizedUrl.split('/').pop() || 'repository';
    const clonePath = resolveCloneDestinationPath({
      workspaceType,
      workspaceRootPath: absolutePath,
      workspaceSlug,
      repoName,
    });

    // Check if clone destination already exists to prevent data loss
    const destination = await validateCloneDestination(clonePath);
    if (!destination.available) {
      sendEvent('error', { message: destination.message });
      res.end();
      return;
    }

    await fs.mkdir(path.dirname(clonePath), { recursive: true });

    let cloneUrl = githubUrl;
    if (githubToken) {
      try {
        const url = new URL(githubUrl);
        url.username = githubToken;
        url.password = '';
        cloneUrl = url.toString();
      } catch (error) {
        // SSH URL or invalid - use as-is
      }
    }

    sendEvent('progress', { message: `Cloning into '${repoName}'...` });

    const gitProcess = spawn('git', ['clone', '--progress', cloneUrl, clonePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0'
      }
    });

    let lastError = '';

    gitProcess.stdout.on('data', (data) => {
      const message = data.toString().trim();
      if (message) {
        sendEvent('progress', { message });
      }
    });

    gitProcess.stderr.on('data', (data) => {
      const message = data.toString().trim();
      lastError = message;
      if (message) {
        sendEvent('progress', { message });
      }
    });

    gitProcess.on('close', async (code) => {
      if (code === 0) {
        try {
          const workspace = multitenancyDb.workspaces.createWorkspace({
            tenantId,
            ownerUserId: req.user.id,
            slug: workspaceSlug,
            displayName: requestedName || workspaceSlug,
            path: clonePath,
          });
          await installPreinstalledSkillPresetsForWorkspace({ tenant, workspace, user: req.user });
          await applyWorkspaceOwnership({
            workspaceRoot: workspace.path,
            targetPaths: [workspace.path],
            recursive: true,
            includeParents: false,
            reason: 'workspace_clone_progress',
            context: { tenantId, userId: req.user.id, workspaceId: workspace.id },
          });
          const project = createWorkspaceProject(workspace);
          sendEvent('complete', { project, message: 'Repository cloned successfully' });
        } catch (error) {
          sendEvent('error', { message: `Clone succeeded but failed to add project: ${error.message}` });
        }
      } else {
        const sanitizedError = sanitizeGitError(lastError, githubToken);
        let errorMessage = 'Git clone failed';
        if (lastError.includes('Authentication failed') || lastError.includes('could not read Username')) {
          errorMessage = 'Authentication failed. Please check your credentials.';
        } else if (lastError.includes('Repository not found')) {
          errorMessage = 'Repository not found. Please check the URL and ensure you have access.';
        } else if (lastError.includes('already exists')) {
          errorMessage = 'Directory already exists';
        } else if (sanitizedError) {
          errorMessage = sanitizedError;
        }
        try {
          await fs.rm(clonePath, { recursive: true, force: true });
        } catch (cleanupError) {
          console.error('Failed to clean up after clone failure:', sanitizeGitError(cleanupError.message, githubToken));
        }
        sendEvent('error', { message: errorMessage });
      }
      res.end();
    });

    gitProcess.on('error', (error) => {
      if (error.code === 'ENOENT') {
        sendEvent('error', { message: 'Git is not installed or not in PATH' });
      } else {
        sendEvent('error', { message: error.message });
      }
      res.end();
    });

    req.on('close', () => {
      gitProcess.kill();
    });

  } catch (error) {
    sendEvent('error', { message: error.message });
    res.end();
  }
});

/**
 * Helper function to clone a GitHub repository
 */
function cloneGitHubRepository(githubUrl, destinationPath, githubToken = null) {
  return new Promise((resolve, reject) => {
    let cloneUrl = githubUrl;

    if (githubToken) {
      try {
        const url = new URL(githubUrl);
        url.username = githubToken;
        url.password = '';
        cloneUrl = url.toString();
      } catch (error) {
        // SSH URL - use as-is
      }
    }

    const gitProcess = spawn('git', ['clone', '--progress', cloneUrl, destinationPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0'
      }
    });

    let stdout = '';
    let stderr = '';

    gitProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    gitProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    gitProcess.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        let errorMessage = 'Git clone failed';

        if (stderr.includes('Authentication failed') || stderr.includes('could not read Username')) {
          errorMessage = 'Authentication failed. Please check your GitHub token.';
        } else if (stderr.includes('Repository not found')) {
          errorMessage = 'Repository not found. Please check the URL and ensure you have access.';
        } else if (stderr.includes('already exists')) {
          errorMessage = 'Directory already exists';
        } else if (stderr) {
          errorMessage = stderr;
        }

        reject(new Error(errorMessage));
      }
    });

    gitProcess.on('error', (error) => {
      if (error.code === 'ENOENT') {
        reject(new Error('Git is not installed or not in PATH'));
      } else {
        reject(error);
      }
    });
  });
}

export default router;
