import { Check, Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGitSettings } from '../../../hooks/useGitSettings';
import { Button, Input } from '../../../../../shared/view/ui';
import SettingsCard from '../../SettingsCard';
import SettingsSection from '../../SettingsSection';

const GIT_TOKEN_MASK_PLACEHOLDER = '**********';

export default function GitSettingsTab() {
  const { t } = useTranslation('settings');
  const [showGitToken, setShowGitToken] = useState(false);
  const {
    gitName,
    setGitName,
    gitEmail,
    setGitEmail,
    gitToken,
    setGitToken,
    gitTokenConfigured,
    isLoading,
    isSaving,
    saveStatus,
    saveGitConfig,
  } = useGitSettings();

  return (
    <div className="space-y-8">
      <SettingsSection
        title={t('git.title')}
        description={t('git.description')}
      >
        <SettingsCard className="p-4">
          <div className="space-y-4">
            <div>
              <label htmlFor="settings-git-name" className="mb-2 block text-sm font-medium text-foreground">
                {t('git.name.label')}
              </label>
              <Input
                id="settings-git-name"
                type="text"
                value={gitName}
                onChange={(event) => setGitName(event.target.value)}
                placeholder="John Doe"
                disabled={isLoading}
                className="w-full"
              />
              <p className="mt-1 text-xs text-muted-foreground">{t('git.name.help')}</p>
            </div>

            <div>
              <label htmlFor="settings-git-email" className="mb-2 block text-sm font-medium text-foreground">
                {t('git.email.label')}
              </label>
              <Input
                id="settings-git-email"
                type="email"
                value={gitEmail}
                onChange={(event) => setGitEmail(event.target.value)}
                placeholder="john@example.com"
                disabled={isLoading}
                className="w-full"
              />
              <p className="mt-1 text-xs text-muted-foreground">{t('git.email.help')}</p>
            </div>

            <div>
              <label htmlFor="settings-git-token" className="mb-2 block text-sm font-medium text-foreground">
                {t('git.token.label')}
              </label>
              <div className="relative">
                <Input
                  id="settings-git-token"
                  type={showGitToken ? 'text' : 'password'}
                  value={gitToken}
                  onChange={(event) => setGitToken(event.target.value)}
                  placeholder={GIT_TOKEN_MASK_PLACEHOLDER}
                  disabled={isLoading}
                  autoComplete="off"
                  className="w-full pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowGitToken((value) => !value)}
                  disabled={isLoading}
                  aria-label={showGitToken ? t('git.token.hide') : t('git.token.show')}
                  className="absolute right-3 top-2.5 text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  {showGitToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {gitTokenConfigured ? t('git.token.configured') : t('git.token.help')}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Button
                onClick={saveGitConfig}
                disabled={isSaving || !gitName.trim() || !gitEmail.trim()}
              >
                {isSaving ? t('git.actions.saving') : t('git.actions.save')}
              </Button>

              {saveStatus === 'success' && (
                <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                  <Check className="h-4 w-4" />
                  {t('git.status.success')}
                </div>
              )}
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
