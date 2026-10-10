import type { WorkspaceSkill } from '../utils/skillFormatting';

export type NameInsertionItem = {
  name: string;
  label: string;
  description: string;
  source?: string;
};

export type McpInsertionTool = {
  name: string;
  description?: string;
  serverName: string;
  serverDisplayName?: string;
};

export function mySkillInsertionItems(skills: WorkspaceSkill[], currentSkillName: string): NameInsertionItem[] {
  return skills.filter((skill) => skill.kind !== 'system' && skill.name !== currentSkillName)
    .map((skill) => ({ name: skill.name, label: skill.displayName || skill.name, description: skill.description || '' }));
}

export function mcpInsertionItems(tools: McpInsertionTool[]): NameInsertionItem[] {
  return Array.from(new Map(tools.map((tool) => [tool.name, {
    name: tool.name, label: tool.name, description: tool.description || '', source: tool.serverDisplayName || tool.serverName,
  }])).values());
}

export function filterInsertionItems(items: NameInsertionItem[], query: string) {
  const term = query.trim().normalize('NFC').toLowerCase();
  return items.filter((item) => [item.name, item.label, item.description, item.source || '']
    .some((text) => text.normalize('NFC').toLowerCase().includes(term)));
}
