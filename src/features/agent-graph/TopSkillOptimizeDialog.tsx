import { useEffect, useState } from 'react';
import { WandSparkles, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../shared/view/ui';

type TopSkillOptimizeDialogProps = {
  open: boolean;
  onClose: () => void;
  onSubmit: (prompt: string) => Promise<void>;
};

export default function TopSkillOptimizeDialog({ open, onClose, onSubmit }: TopSkillOptimizeDialogProps) {
  const { t } = useTranslation('agentGraph');
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPrompt('');
    setSubmitting(false);
    setError(null);
  }, [open]);

  if (!open) return null;

  const handleSubmit = async () => {
    if (!prompt.trim()) {
      setError(t('optimize.required'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(prompt.trim());
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t('optimize.submitFailed'));
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[10040] flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-xl overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-start justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="font-semibold text-foreground">{t('optimize.title')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t('optimize.description')}</p>
          </div>
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onClose} disabled={submitting}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="space-y-3 p-5">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={t('optimize.placeholder')}
            rows={7}
            autoFocus
            className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          />
          {error ? <p className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive">{error}</p> : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
          <Button variant="outline" onClick={onClose} disabled={submitting}>{t('actions.cancel')}</Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting || !prompt.trim()}>
            <WandSparkles className="mr-2 h-4 w-4" />
            {submitting ? t('optimize.submitting') : t('optimize.submit')}
          </Button>
        </div>
      </div>
    </div>
  );
}
