import { useEffect, useState } from 'react';
import { Play, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '../../shared/view/ui';

type GraphRunDialogProps = {
  open: boolean;
  graphName: string;
  graphGoal: string;
  starting: boolean;
  onClose: () => void;
  onSubmit: (input: string, maxIterations: number) => Promise<void>;
};

export default function GraphRunDialog({
  open,
  graphName,
  graphGoal,
  starting,
  onClose,
  onSubmit,
}: GraphRunDialogProps) {
  const { t } = useTranslation('agentGraph');
  const [input, setInput] = useState('');
  const [maxIterations, setMaxIterations] = useState(8);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setInput('');
    setMaxIterations(8);
    setError(null);
  }, [open]);

  if (!open) return null;

  const handleSubmit = async () => {
    if (!input.trim()) {
      setError(t('run.validation.input'));
      return;
    }
    setError(null);
    try {
      await onSubmit(input.trim(), maxIterations);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t('run.validation.failed'));
    }
  };

  return (
    <div className="fixed inset-0 z-[10030] flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-start justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="font-semibold text-foreground">{t('run.title', { name: graphName })}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t('run.description')}</p>
          </div>
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onClose} disabled={starting}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="space-y-4 p-5">
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <p className="text-xs font-medium text-foreground">{t('run.graphGoal')}</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{graphGoal}</p>
          </div>
          <label className="block space-y-2">
            <span className="text-sm font-medium text-foreground">{t('run.input')}</span>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={t('run.inputPlaceholder')}
              rows={7}
              autoFocus
              className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            />
          </label>
          <label className="block max-w-48 space-y-2">
            <span className="text-sm font-medium text-foreground">{t('run.maxIterations')}</span>
            <Input
              type="number"
              min={1}
              max={20}
              value={maxIterations}
              onChange={(event) => setMaxIterations(Math.max(1, Math.min(20, Number(event.target.value) || 1)))}
            />
          </label>
          <p className="text-xs text-muted-foreground">{t('run.iterationHint')}</p>
          {error ? <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p> : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
          <Button variant="outline" onClick={onClose} disabled={starting}>{t('actions.cancel')}</Button>
          <Button onClick={() => void handleSubmit()} disabled={starting || !input.trim()}>
            <Play className="mr-2 h-4 w-4" />
            {starting ? t('run.starting') : t('actions.runGraph')}
          </Button>
        </div>
      </div>
    </div>
  );
}
