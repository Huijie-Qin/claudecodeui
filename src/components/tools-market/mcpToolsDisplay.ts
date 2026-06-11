import type { WorkspaceMcpPreset } from './hooks/useWorkspaceMcpTools';

export type ToolCountFormatter = (count: number) => string;

export type PresetCardBadge = {
  key: 'transport' | 'toolCount';
  label: string;
};

export type PresetToolDetail = {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
};

export function getPresetCardBadges(
  preset: WorkspaceMcpPreset,
  formatToolCount: ToolCountFormatter,
): PresetCardBadge[] {
  return [
    { key: 'transport', label: preset.transport.toUpperCase() },
    { key: 'toolCount', label: formatToolCount(preset.toolCount) },
  ];
}

export function getPresetToolDetails(preset: WorkspaceMcpPreset): PresetToolDetail[] {
  return (preset.tools ?? [])
    .filter((tool) => tool.name.trim().length > 0)
    .map((tool) => ({
      name: tool.name,
      description: tool.description?.trim() ?? '',
      inputSchema: tool.inputSchema,
    }));
}
