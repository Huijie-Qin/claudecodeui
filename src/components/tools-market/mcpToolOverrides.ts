import type { WorkspaceMcpPreset, WorkspaceMcpTool } from './hooks/useWorkspaceMcpTools';

export const MCP_TOOL_OVERRIDES_FILE = '.claude/mcp-tool-overrides.local.json';

export type McpToolOverrideParam = {
  custom: boolean;
  value?: unknown;
};

export type McpToolOverridesConfig = {
  version: 1;
  mcpServers: Record<string, {
    tools: Record<string, {
      params: Record<string, McpToolOverrideParam>;
    }>;
  }>;
};

export type McpToolParameterKind = 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'object';

export type McpToolParameterField = {
  key: string;
  kind: McpToolParameterKind;
  required: boolean;
  description: string;
  enumValues?: string[];
  defaultValue: unknown;
  exampleValue: unknown;
};

function readObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

function getFieldKind(schema: Record<string, unknown>): McpToolParameterKind {
  const enumValues = readStringArray(schema.enum);
  if (enumValues?.length) return 'enum';

  const type = schema.type;
  if (type === 'integer' || type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'array') return 'array';
  if (type === 'object') return 'object';
  return 'string';
}

function readExampleValue(schema: Record<string, unknown>): unknown {
  const examples = schema.examples;
  if (Array.isArray(examples) && examples.length > 0) {
    return examples[0];
  }
  return schema.example;
}

export function getToolParameterFields(tool: WorkspaceMcpTool | null): McpToolParameterField[] {
  const inputSchema = readObject(tool?.inputSchema);
  const properties = readObject(inputSchema?.properties);
  if (!properties) return [];

  const required = new Set(readStringArray(inputSchema?.required) ?? []);
  return Object.entries(properties)
    .map(([key, value]) => {
      const schema = readObject(value) ?? {};
      return {
        key,
        kind: getFieldKind(schema),
        required: required.has(key),
        description: typeof schema.description === 'string' ? schema.description.trim() : '',
        enumValues: readStringArray(schema.enum),
        defaultValue: schema.default,
        exampleValue: readExampleValue(schema),
      };
    })
    .filter((field) => field.key.trim().length > 0);
}

export function createEmptyOverridesConfig(): McpToolOverridesConfig {
  return {
    version: 1,
    mcpServers: {},
  };
}

export function normalizeOverridesConfig(value: unknown): McpToolOverridesConfig {
  const record = readObject(value);
  if (!record) return createEmptyOverridesConfig();

  const servers = readObject(record.mcpServers) ?? {};
  return {
    version: 1,
    mcpServers: servers as McpToolOverridesConfig['mcpServers'],
  };
}

export function getToolOverrideParams(
  config: McpToolOverridesConfig,
  preset: WorkspaceMcpPreset,
  toolName: string,
): Record<string, McpToolOverrideParam> {
  return config.mcpServers?.[preset.name]?.tools?.[toolName]?.params ?? {};
}

export function withToolOverrideParams(
  config: McpToolOverridesConfig,
  preset: WorkspaceMcpPreset,
  toolName: string,
  params: Record<string, McpToolOverrideParam>,
): McpToolOverridesConfig {
  return {
    version: 1,
    mcpServers: {
      ...config.mcpServers,
      [preset.name]: {
        tools: {
          ...(config.mcpServers[preset.name]?.tools ?? {}),
          [toolName]: {
            params,
          },
        },
      },
    },
  };
}
