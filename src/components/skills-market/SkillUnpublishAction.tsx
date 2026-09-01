import { Loader2, Trash2 } from 'lucide-react';
import { useCallback, useState } from 'react';

import { api } from '../../utils/api';

type SkillUnpublishActionProps = {
  workspaceId?: number;
  skillName: string;
  disabled?: boolean;
  onError?: (message: string) => void;
  onUnpublished?: (skillName: string) => void | Promise<void>;
};

export default function SkillUnpublishAction({
  workspaceId,
  skillName,
  disabled = false,
  onError,
  onUnpublished,
}: SkillUnpublishActionProps) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleConfirm = useCallback(async () => {
    if (!workspaceId || !skillName || confirmation !== 'yes' || disabled || submitting) return;

    setSubmitting(true);
    try {
      await readApiPayload(
        await api.skillMarket.unpublishSkill(workspaceId, skillName),
        '技能下架失败。',
      );
      setOpen(false);
      setConfirmation('');
      try {
        await onUnpublished?.(skillName);
      } catch (error) {
        onError?.(`技能已从市场下架，但页面刷新失败：${toErrorMessage(error, '请手动刷新后查看最新状态。')}`);
      }
    } catch (error) {
      onError?.(toErrorMessage(error, '技能下架失败。'));
    } finally {
      setSubmitting(false);
    }
  }, [confirmation, disabled, onError, onUnpublished, skillName, submitting, workspaceId]);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setConfirmation('');
          setOpen(true);
        }}
        disabled={disabled || submitting}
        className="inline-flex h-9 items-center gap-2 rounded-md border border-destructive/30 px-3 text-sm font-medium text-destructive transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Trash2 className="h-4 w-4" />
        下架
      </button>

      {open ? (
        <div className="fixed inset-0 z-[10020] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="skill-unpublish-title">
          <div className="w-full max-w-md overflow-hidden rounded-lg border border-border bg-background shadow-2xl">
            <div className="border-b border-border px-5 py-4">
              <h3 id="skill-unpublish-title" className="text-base font-semibold text-foreground">下架 Skill</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                下架后该 Skill 将不再显示在技能市场。请确认需要保留的 Skill 已经导入并保存在本地；本页面不提供保存功能。当前工作区的本地 Skill 文件不会被删除。
              </p>
            </div>
            <div className="px-5 py-4">
              <label className="block text-sm font-medium text-foreground" htmlFor="skill-unpublish-confirmation">
                输入 <span className="font-mono">yes</span> 确认下架
              </label>
              <input
                id="skill-unpublish-confirmation"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                disabled={submitting}
                autoFocus
                className="mt-2 h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20 disabled:opacity-50"
              />
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
              <button type="button" onClick={() => { setOpen(false); setConfirmation(''); }} disabled={submitting} className="h-9 rounded-md border border-border px-3 text-sm hover:bg-accent disabled:opacity-50">取消</button>
              <button type="button" onClick={() => void handleConfirm()} disabled={submitting || confirmation !== 'yes'} className="inline-flex h-9 items-center gap-2 rounded-md bg-destructive px-3 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50">
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                确认下架
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

async function readApiPayload(response: Response, fallbackMessage: string) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || fallbackMessage);
  return payload;
}

function toErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}
