import { useId, useState } from 'react';

import type { HookUserVariable } from '../../../admin/hook-config/types';
import { Button, Dialog, DialogContent, DialogTitle, Input } from '../../../../shared/view/ui';

export default function HookUserVariablesDialog({ hook, busy, error, onClose, onSave }: {
  hook: { name: string; enabled: boolean; userVariables?: HookUserVariable[]; configuredUserVariables?: string[] };
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (values: Record<string, string>) => void;
}) {
  const fieldIdPrefix = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const configured = new Set(hook.configuredUserVariables || []);
  const variables = hook.userVariables || [];
  const missing = variables.some((variable) => variable.required
    && !values[variable.name]?.trim() && !configured.has(variable.name));
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent portalClassName="z-[10000]" className="max-h-[85vh] w-[calc(100%-2rem)] overflow-y-auto p-5" aria-labelledby="hook-user-variables-title">
        <DialogTitle id="hook-user-variables-title" className="not-sr-only text-base font-semibold">{hook.name} · 个人变量</DialogTitle>
        <form className="mt-4 space-y-4" onSubmit={(event) => {
          event.preventDefault();
          if (busy || missing) return;
          onSave(Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim())));
        }}>
          {variables.map((variable) => (
            <div key={variable.name} className="space-y-1.5">
              <label htmlFor={`${fieldIdPrefix}-${variable.name}`} className="block text-sm font-medium">
                {variable.label}
              </label>
              {variable.description ? (
                <p id={`${fieldIdPrefix}-${variable.name}-description`} className="whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{variable.description}</p>
              ) : null}
              <Input
                id={`${fieldIdPrefix}-${variable.name}`}
                aria-describedby={variable.description ? `${fieldIdPrefix}-${variable.name}-description` : undefined}
                type={variable.secret ? 'password' : 'text'}
                value={values[variable.name] || ''}
                disabled={busy}
                required={variable.required && !configured.has(variable.name)}
                maxLength={8192}
                autoComplete="off"
                spellCheck={false}
                placeholder={configured.has(variable.name) ? '留空保留已保存的值' : `请输入${variable.label}`}
                onChange={(event) => {
                  setValues((current) => ({ ...current, [variable.name]: event.target.value }));
                }}
              />
            </div>
          ))}
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>
            <Button type="submit" disabled={busy || missing}>{busy ? '正在保存…' : hook.enabled ? '保存' : '保存并启用'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
