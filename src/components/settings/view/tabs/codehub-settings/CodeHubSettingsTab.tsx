import { CheckCircle2, Eye, EyeOff, FlaskConical, Loader2, Pencil, Plus, Trash2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useCodeHubSettings, type CodeHubRepository } from '../../../hooks/useCodeHubSettings';
import { Badge, Button, Input } from '../../../../../shared/view/ui';
import SettingsCard from '../../SettingsCard';
import SettingsSection from '../../SettingsSection';

function formatDate(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

function statusLabel(repository: CodeHubRepository, message?: string) {
  if (message === 'connected') {
    return 'connected';
  }
  if (message) {
    return 'failed';
  }
  return repository.lastTestStatus || 'untested';
}

export default function CodeHubSettingsTab() {
  const { t } = useTranslation('settings');
  const [showToken, setShowToken] = useState(false);
  const {
    repositories,
    loading,
    saving,
    error,
    form,
    editingId,
    testingIds,
    testMessages,
    updateForm,
    resetForm,
    editRepository,
    saveRepository,
    deleteRepository,
    testRepository,
  } = useCodeHubSettings();

  const canSave = Boolean(
    form.targetRepository.trim()
    && form.privateRepository.trim()
    && (editingId || form.token.trim()),
  );

  if (loading) {
    return <div className="text-muted-foreground">{t('codeHub.loading')}</div>;
  }

  return (
    <div className="space-y-8">
      <SettingsSection title={t('codeHub.title')} description={t('codeHub.description')}>
        <SettingsCard className="p-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="settings-codehub-target" className="mb-2 block text-sm font-medium text-foreground">
                {t('codeHub.form.targetRepository')}
              </label>
              <Input
                id="settings-codehub-target"
                value={form.targetRepository}
                onChange={(event) => updateForm('targetRepository', event.target.value)}
                placeholder={t('codeHub.form.targetPlaceholder')}
              />
            </div>

            <div>
              <label htmlFor="settings-codehub-private" className="mb-2 block text-sm font-medium text-foreground">
                {t('codeHub.form.privateRepository')}
              </label>
              <Input
                id="settings-codehub-private"
                value={form.privateRepository}
                onChange={(event) => updateForm('privateRepository', event.target.value)}
                placeholder={t('codeHub.form.privatePlaceholder')}
              />
            </div>

            <div className="md:col-span-2">
              <label htmlFor="settings-codehub-token" className="mb-2 block text-sm font-medium text-foreground">
                {t('codeHub.form.token')}
              </label>
              <div className="relative">
                <Input
                  id="settings-codehub-token"
                  type={showToken ? 'text' : 'password'}
                  value={form.token}
                  onChange={(event) => updateForm('token', event.target.value)}
                  placeholder={editingId ? t('codeHub.form.tokenUpdatePlaceholder') : t('codeHub.form.tokenPlaceholder')}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowToken((value) => !value)}
                  aria-label={showToken ? t('codeHub.form.hideToken') : t('codeHub.form.showToken')}
                  className="absolute right-3 top-2.5 text-muted-foreground hover:text-foreground"
                >
                  {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{t('codeHub.form.tokenHelp')}</p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button onClick={saveRepository} disabled={!canSave || saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {editingId ? t('codeHub.actions.update') : t('codeHub.actions.add')}
            </Button>
            {editingId && (
              <Button variant="outline" onClick={resetForm} disabled={saving}>
                {t('codeHub.actions.cancel')}
              </Button>
            )}
          </div>

          {error && (
            <p className="mt-3 text-sm text-destructive">{error}</p>
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('codeHub.repositories.title')} description={t('codeHub.repositories.description')}>
        <div className="space-y-3">
          {repositories.length === 0 ? (
            <SettingsCard className="p-4">
              <p className="text-sm text-muted-foreground">{t('codeHub.repositories.empty')}</p>
            </SettingsCard>
          ) : repositories.map((repository) => {
            const testMessage = testMessages[repository.id];
            const status = statusLabel(repository, testMessage);
            const isTesting = testingIds[repository.id] === true;
            const isConnected = status === 'connected';
            const isFailed = status === 'failed';

            return (
              <SettingsCard key={repository.id} className="p-4">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{repository.targetRepository}</span>
                      <Badge variant={isConnected ? 'default' : isFailed ? 'destructive' : 'secondary'}>
                        {isConnected && <CheckCircle2 className="mr-1 h-3 w-3" />}
                        {isFailed && <XCircle className="mr-1 h-3 w-3" />}
                        {t(`codeHub.status.${status}`)}
                      </Badge>
                    </div>
                    <div className="break-all text-sm text-muted-foreground">
                      {t('codeHub.repositories.privateLabel')}: {repository.privateRepository}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>{repository.tokenConfigured ? t('codeHub.repositories.tokenSaved') : t('codeHub.repositories.tokenMissing')}</span>
                      {repository.lastTestedAt && (
                        <span>{t('codeHub.repositories.lastTested')}: {formatDate(repository.lastTestedAt)}</span>
                      )}
                    </div>
                    {testMessage && testMessage !== 'connected' && (
                      <p className="text-xs text-destructive">{testMessage}</p>
                    )}
                    {!testMessage && repository.lastTestError && (
                      <p className="text-xs text-destructive">{repository.lastTestError}</p>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2 md:justify-end">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => testRepository(repository.id)}
                      disabled={isTesting}
                    >
                      {isTesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
                      {isTesting ? t('codeHub.actions.testing') : t('codeHub.actions.test')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => editRepository(repository)}>
                      <Pencil className="h-4 w-4" />
                      {t('codeHub.actions.edit')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => deleteRepository(repository.id, t('codeHub.actions.confirmDelete'))}
                    >
                      <Trash2 className="h-4 w-4" />
                      {t('codeHub.actions.delete')}
                    </Button>
                  </div>
                </div>
              </SettingsCard>
            );
          })}
        </div>
      </SettingsSection>
    </div>
  );
}
