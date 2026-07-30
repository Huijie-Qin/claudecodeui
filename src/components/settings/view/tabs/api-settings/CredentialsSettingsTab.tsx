import { Check, KeyRound, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../../shared/view/ui';
import { copyTextToClipboard } from '../../../../../utils/clipboard';
import { authenticatedFetch } from '../../../../../utils/api';
import SettingsCard from '../../SettingsCard';

type PersonalKeyResponse = {
  success?: boolean;
  personalKey?: string;
};

type CopyStatus = 'idle' | 'loading' | 'copied' | 'error';

export default function CredentialsSettingsTab() {
  const { t } = useTranslation('settings');
  const [status, setStatus] = useState<CopyStatus>('idle');
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
    }
  }, []);

  const getPersonalKey = async () => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    setStatus('loading');

    try {
      const response = await authenticatedFetch('/api/settings/personal-key');
      const payload = await response.json() as PersonalKeyResponse;

      if (!response.ok || !payload.success || !payload.personalKey) {
        setStatus('error');
        return;
      }

      const copied = await copyTextToClipboard(payload.personalKey);
      if (!copied) {
        setStatus('error');
        return;
      }

      setStatus('copied');
      resetTimerRef.current = window.setTimeout(() => {
        setStatus('idle');
        resetTimerRef.current = null;
      }, 2000);
    } catch {
      setStatus('error');
    }
  };

  return (
    <div className="space-y-3">
      <SettingsCard>
        <div className="flex items-center justify-between gap-4 p-4">
          <div className="flex min-w-0 items-center gap-3">
            <KeyRound className="h-5 w-5 flex-shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="font-medium text-foreground">{t('personalKey.label')}</div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t('personalKey.description')}
              </p>
            </div>
          </div>
          <Button
            size="sm"
            onClick={() => void getPersonalKey()}
            disabled={status === 'loading'}
            aria-live="polite"
          >
            {status === 'loading' && <Loader2 className="animate-spin" />}
            {status === 'copied' && <Check />}
            {status === 'loading'
              ? t('personalKey.loading')
              : status === 'copied'
                ? t('personalKey.copySuccess')
                : t('personalKey.get')}
          </Button>
        </div>
      </SettingsCard>
      {status === 'error' && (
        <p className="text-sm text-destructive" role="alert">
          {t('personalKey.error')}
        </p>
      )}
    </div>
  );
}
