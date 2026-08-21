import { Box, Check, Minus, Plug, Sparkles } from 'lucide-react';

import { cn } from '../../../lib/utils';
import type { AgentTemplateOption } from '../types';

type AgentTemplatePickerProps = {
  templates: AgentTemplateOption[];
  selectedTemplateId: number | null;
  tenantName?: string;
  isLoading: boolean;
  disabled: boolean;
  onChange: (templateId: number | null) => void;
};

export default function AgentTemplatePicker({
  templates,
  selectedTemplateId,
  tenantName,
  isLoading,
  disabled,
  onChange,
}: AgentTemplatePickerProps) {
  const selected = templates.find((template) => template.id === selectedTemplateId) || null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <label className="text-sm font-medium text-gray-700 dark:text-gray-200">
          Agent 模板 <span className="font-normal text-gray-400">可选</span>
        </label>
        {tenantName ? (
          <span className="text-xs text-gray-500 dark:text-gray-400">当前租户：{tenantName}</span>
        ) : null}
      </div>

      <div className="grid min-h-[300px] overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 md:grid-cols-[220px_minmax(0,1fr)]">
        <div className="space-y-2 border-b border-gray-200 p-3 dark:border-gray-700 md:border-b-0 md:border-r">
          {isLoading ? (
            <div className="px-3 py-8 text-center text-sm text-gray-500">正在加载模板...</div>
          ) : (
            <>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(null)}
                className={cn(
                  'flex w-full items-start gap-3 rounded-lg border px-3 py-3 text-left transition-colors',
                  selectedTemplateId == null
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30'
                    : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-700/50',
                )}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300">
                  <Minus className="h-4 w-4" />
                </span>
                <span>
                  <span className="block text-sm font-medium text-gray-900 dark:text-white">使用默认空白Agent</span>
                  <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">从默认 Agent 开始</span>
                </span>
              </button>

              <div className="my-2 border-t border-gray-200 dark:border-gray-700" />

              {templates.map((template) => {
                const active = selectedTemplateId === template.id;
                return (
                  <button
                    key={template.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => onChange(template.id)}
                    className={cn(
                      'flex w-full items-start gap-3 rounded-lg border px-3 py-3 text-left transition-colors',
                      active
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30'
                        : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-700/50',
                    )}
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-300">
                      <Sparkles className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-gray-900 dark:text-white">{template.name}</span>
                      <span className="mt-0.5 line-clamp-2 block text-xs text-gray-500 dark:text-gray-400">{template.summary}</span>
                    </span>
                    {active ? <Check className="mt-1 h-4 w-4 text-blue-600" /> : null}
                  </button>
                );
              })}
            </>
          )}
        </div>

        <div className="p-4">
          {selected ? (
            <div className="space-y-5">
              <div className="flex gap-3 rounded-xl bg-gray-50 p-4 dark:bg-gray-900/40">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-300">
                  <Sparkles className="h-6 w-6" />
                </span>
                <div>
                  <h4 className="font-semibold text-gray-900 dark:text-white">{selected.name}</h4>
                  <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">{selected.summary}</p>
                </div>
              </div>

              <div>
                <h5 className="mb-2 text-sm font-medium text-gray-900 dark:text-white">已配置能力</h5>
                <div className="grid gap-2 sm:grid-cols-2">
                  {selected.skills.map((skill) => (
                    <div key={`skill-${skill.id}`} className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2.5 dark:border-gray-700">
                      <Box className="h-4 w-4 text-blue-600" />
                      <div><div className="text-sm font-medium text-gray-800 dark:text-gray-100">{skill.name}</div><div className="text-xs text-gray-500">Skill</div></div>
                    </div>
                  ))}
                  {selected.mcps.map((mcp) => (
                    <div key={`mcp-${mcp.id}`} className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2.5 dark:border-gray-700">
                      <Plug className="h-4 w-4 text-emerald-600" />
                      <div><div className="text-sm font-medium text-gray-800 dark:text-gray-100">{mcp.name}</div><div className="text-xs text-gray-500">MCP</div></div>
                    </div>
                  ))}
                  {selected.skills.length === 0 && selected.mcps.length === 0 ? (
                    <div className="col-span-full rounded-lg border border-dashed border-gray-200 px-3 py-5 text-center text-sm text-gray-500 dark:border-gray-700">该模板未配置 Skill 或 MCP</div>
                  ) : null}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-full min-h-[250px] flex-col items-center justify-center text-center">
              <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-gray-100 text-gray-400 dark:bg-gray-700"><Minus className="h-5 w-5" /></span>
              <h4 className="text-sm font-medium text-gray-900 dark:text-white">使用默认空白Agent</h4>
              <p className="mt-1 max-w-sm text-sm text-gray-500 dark:text-gray-400">创建普通 Agent，只安装租户默认 Skill，不会自动安装 MCP。</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
