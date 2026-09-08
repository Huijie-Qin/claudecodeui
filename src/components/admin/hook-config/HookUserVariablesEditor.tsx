import { Plus, Trash2 } from 'lucide-react';

import { Button, Input } from '../../../shared/view/ui';

import type { HookUserVariable } from './types';

export default function HookUserVariablesEditor({
  variables,
  onChange,
}: {
  variables: HookUserVariable[];
  onChange: (variables: HookUserVariable[]) => void;
}) {
  const update = (index: number, patch: Partial<HookUserVariable>) => onChange(
    variables.map((variable, candidate) => candidate === index ? { ...variable, ...patch } : variable),
  );
  return (
    <div className="mt-5 space-y-3 border-t border-border pt-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold">用户个人变量</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            配置需要用户在辅助功能中填写的变量，例如个人 Token、账号或项目标识。必填项填写后才能启用 Hook。
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={variables.length >= 20} onClick={() => {
          let suffix = variables.length + 1;
          while (variables.some((variable) => variable.name === `variable_${suffix}`)) suffix += 1;
          onChange([...variables, { name: `variable_${suffix}`, label: '个人变量', description: '', required: true, secret: false }]);
        }}>
          <Plus className="mr-1 h-3.5 w-3.5" />添加变量
        </Button>
      </div>
      {variables.map((variable, index) => (
        <div key={index} className="space-y-3 rounded-xl border border-border bg-muted/20 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs">
              <span>变量名</span>
              <Input value={variable.name} maxLength={64} placeholder="personal_token" onChange={(event) => update(index, { name: event.target.value })} />
            </label>
            <label className="space-y-1 text-xs">
              <span>显示名称</span>
              <Input value={variable.label} maxLength={100} placeholder="个人 Token" onChange={(event) => update(index, { label: event.target.value })} />
            </label>
            <label className="space-y-1 text-xs sm:col-span-2">
              <span>填写说明</span>
              <Input value={variable.description} maxLength={1000} placeholder="说明用途或获取方式" onChange={(event) => update(index, { description: event.target.value })} />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-xs">
            <label className="flex items-center gap-2"><input type="checkbox" checked={variable.required} onChange={(event) => update(index, { required: event.target.checked })} />必填</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={variable.secret} onChange={(event) => update(index, { secret: event.target.checked })} />敏感值（如 Token、密码）</label>
            <Button type="button" variant="ghost" size="sm" className="ml-auto" aria-label={`删除变量 ${variable.label}`} onClick={() => onChange(variables.filter((_, candidate) => candidate !== index))}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
          <p className="break-all text-[11px] leading-5 text-muted-foreground">
            模板：<code>{`{{ccui.env.userVariables.${variable.name}}}`}</code>
            <br />
            Skill Shell 环境变量：<code>{`\${${variable.name}}`}</code>（启用后自动注入，下次执行生效）
          </p>
        </div>
      ))}
      {variables.length > 0 ? <p className="text-xs leading-5 text-muted-foreground">变量值按用户和工作区分别加密保存。敏感值在输入和执行记录中隐藏；被引用时仍会传递给对应脚本、Skill 或工具。</p> : null}
    </div>
  );
}
