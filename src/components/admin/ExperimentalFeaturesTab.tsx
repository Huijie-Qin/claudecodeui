import { useEffect, useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  publishAgentGraphFeatureEnabled,
  refreshAgentGraphFeatureEnabled,
  useAgentGraphFeatureStatus,
} from '../../features/agent-graph/agentGraphFeature';
import { api } from '../../utils/api';
import SettingsToggle from '../settings/view/SettingsToggle';

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { error?: string };
    return payload.error || fallback;
  } catch {
    return fallback;
  }
}

export default function ExperimentalFeaturesTab() {
  const { t } = useTranslation('admin');
  const { enabled, loaded } = useAgentGraphFeatureStatus();
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    void refreshAgentGraphFeatureEnabled(true);
  }, []);

  const updateAgentGraph = async (nextEnabled: boolean) => {
    setIsSaving(true);
    setMessage(null);
    try {
      const response = await api.admin.updateAgentGraphFeature(nextEnabled);
      if (!response.ok) {
        throw new Error(await readError(response, t('experimental.updateError')));
      }
      const payload = await response.json() as { features?: { agentGraph?: boolean } };
      const savedValue = payload.features?.agentGraph === true;
      publishAgentGraphFeatureEnabled(savedValue);
      setMessage({ type: 'success', text: t('experimental.updateSuccess') });
    } catch (error) {
      const text = error instanceof Error ? error.message : t('experimental.updateError');
      setMessage({ type: 'error', text });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
        <div className="flex items-start gap-3">
          <FlaskConical className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div>
            <h2 className="font-medium text-foreground">{t('experimental.warningTitle')}</h2>
            <p className="mt-1 text-muted-foreground">{t('experimental.warningDescription')}</p>
          </div>
        </div>
      </div>

      <section className="rounded-lg border border-border bg-card p-5 shadow-sm">
        <div className="flex items-center justify-between gap-6">
          <div>
            <h3 className="font-medium text-foreground">{t('experimental.agentGraph.label')}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t('experimental.agentGraph.description')}</p>
          </div>
          <SettingsToggle
            checked={enabled}
            onChange={(value) => void updateAgentGraph(value)}
            ariaLabel={t('experimental.agentGraph.label')}
            disabled={!loaded || isSaving}
          />
        </div>
      </section>

      {message ? (
        <div
          role="status"
          className={message.type === 'success'
            ? 'rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300'
            : 'rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive'}
        >
          {message.text}
        </div>
      ) : null}
    </div>
  );
}
