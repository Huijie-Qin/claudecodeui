import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { parseFrontmatter } from '../utils/frontmatter.js';

import { reconcileWorkspaceSkillsForAgentTurn } from './workspace-skills.js';

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function getEnabledPluginInstallPaths() {
  const homeDir = os.homedir();
  const [settings, installedPlugins] = await Promise.all([
    readJsonFile(path.join(homeDir, '.claude', 'settings.json')),
    readJsonFile(path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json')),
  ]);
  const enabledPlugins = settings?.enabledPlugins || {};
  const hasExplicitEnabledPlugins = Object.keys(enabledPlugins).length > 0;
  const plugins = installedPlugins?.plugins || {};
  const installPaths = [];

  for (const [pluginName, installs] of Object.entries(plugins)) {
    if (hasExplicitEnabledPlugins && enabledPlugins[pluginName] !== true) {
      continue;
    }
    if (!Array.isArray(installs)) {
      continue;
    }
    for (const install of installs) {
      if (typeof install?.installPath === 'string' && install.installPath.trim()) {
        installPaths.push(install.installPath);
      }
    }
  }

  return [...new Set(installPaths)];
}

async function scanSkillsDirectory(dir, namespace) {
  const commands = [];

  async function walk(currentDir) {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'EACCES') {
        throw error;
      }
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || entry.name !== 'SKILL.md') {
        continue;
      }

      const raw = await fs.readFile(fullPath, 'utf8');
      const { data: frontmatter } = parseFrontmatter(raw);
      const skillName = String(frontmatter.name || path.basename(path.dirname(fullPath))).trim();
      if (!skillName) {
        continue;
      }

      commands.push({
        name: `/${skillName.replace(/^\//, '')}`,
        path: fullPath,
        namespace,
      });
    }
  }

  await walk(dir);
  return commands;
}

function parseLeadingSlashInvocation(prompt) {
  const trimmed = typeof prompt === 'string' ? prompt.trimStart() : '';
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const firstWhitespace = trimmed.search(/\s/);
  const commandName = firstWhitespace === -1 ? trimmed : trimmed.slice(0, firstWhitespace);
  const argsText = firstWhitespace === -1 ? '' : trimmed.slice(firstWhitespace).trim();
  return {
    commandName,
    args: argsText ? argsText.split(/\s+/) : [],
  };
}

async function listAvailableSkillCommands({ workspacePath }) {
  const homeDir = os.homedir();
  const commandGroups = [];

  if (workspacePath) {
    commandGroups.push(scanSkillsDirectory(path.join(workspacePath, '.claude', 'skills'), 'project-skill'));
  }

  commandGroups.push(scanSkillsDirectory(path.join(homeDir, '.claude', 'skills'), 'user-skill'));

  const pluginInstallPaths = await getEnabledPluginInstallPaths();
  for (const pluginInstallPath of pluginInstallPaths) {
    commandGroups.push(scanSkillsDirectory(path.join(pluginInstallPath, 'skills'), 'plugin-skill'));
  }

  return (await Promise.all(commandGroups)).flat();
}

async function expandSkillCommand(command, args) {
  const raw = await fs.readFile(command.path, 'utf8');
  const { content } = parseFrontmatter(raw);
  let processedContent = content || '';
  const argsString = args.join(' ');
  const hasArgumentPlaceholder = /\$(?:ARGUMENTS|\d+\b)/.test(processedContent);

  processedContent = processedContent.replace(/\$ARGUMENTS/g, argsString);
  args.forEach((arg, index) => {
    const placeholder = `$${index + 1}`;
    processedContent = processedContent.replace(new RegExp(`\\${placeholder}\\b`, 'g'), arg);
  });

  if (argsString && !hasArgumentPlaceholder) {
    processedContent = `${processedContent.trim()}\n\n## User request\n\n${argsString}\n`;
  }

  return processedContent;
}

export async function expandLeadingSkillCommand({
  prompt,
  workspacePath,
  reconcile = true,
  logger = console,
}) {
  const invocation = parseLeadingSlashInvocation(prompt);
  if (!invocation) {
    return {
      prompt,
      expanded: false,
      skillName: null,
    };
  }

  if (reconcile && workspacePath) {
    await reconcileWorkspaceSkillsForAgentTurn({ workspacePath, logger });
  }

  const commands = await listAvailableSkillCommands({ workspacePath });
  const command = commands.find((candidate) => candidate.name === invocation.commandName);
  if (!command) {
    return {
      prompt,
      expanded: false,
      skillName: null,
    };
  }

  return {
    prompt: await expandSkillCommand(command, invocation.args),
    expanded: true,
    skillName: command.name,
    skillPath: command.path,
    namespace: command.namespace,
  };
}
