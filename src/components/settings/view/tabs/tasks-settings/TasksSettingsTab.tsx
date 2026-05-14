import { useTranslation } from 'react-i18next';
import { useTasksSettings } from '../../../../../contexts/TasksSettingsContext';
import SettingsCard from '../../SettingsCard';
import SettingsRow from '../../SettingsRow';
import SettingsSection from '../../SettingsSection';
import SettingsToggle from '../../SettingsToggle';

type TasksSettingsContextValue = {
  tasksEnabled: boolean;
  setTasksEnabled: (enabled: boolean) => void;
  isTaskMasterInstalled: boolean | null;
  isCheckingInstallation: boolean;
};

export default function TasksSettingsTab() {
  const { t } = useTranslation('settings');
  const {
    tasksEnabled,
    setTasksEnabled,
    isTaskMasterInstalled,
    isCheckingInstallation,
  } = useTasksSettings() as TasksSettingsContextValue;

  return (
    <div className="space-y-8">
      <SettingsSection title={t('mainTabs.tasks')}>
        {isCheckingInstallation ? (
          <SettingsCard className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <span className="text-sm text-muted-foreground">{t('tasks.checking')}</span>
            </div>
          </SettingsCard>
        ) : (
          <>
            {!isTaskMasterInstalled && (
              <div className="rounded-xl border border-orange-200 bg-orange-50 p-4 dark:border-orange-800/50 dark:bg-orange-950/30">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-orange-100 dark:bg-orange-900/50">
                    <svg className="h-4 w-4 text-orange-600 dark:text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                    </svg>
                  </div>
                  <div className="flex-1">
                    <div className="mb-2 font-medium text-orange-900 dark:text-orange-100">
                      {t('tasks.notInstalled.title')}
                    </div>
                    <div className="space-y-3 text-sm text-orange-800 dark:text-orange-200">
                      <p>{t('tasks.notInstalled.description')}</p>

                      <div className="rounded-lg bg-orange-100 p-3 font-mono text-sm dark:bg-orange-900/40">
                        <code>{t('tasks.notInstalled.installCommand')}</code>
                      </div>

                      <div className="space-y-2">
                        <p className="font-medium">{t('tasks.notInstalled.afterInstallation')}</p>
                        <ol className="list-inside list-decimal space-y-1 text-xs">
                          <li>{t('tasks.notInstalled.steps.restart')}</li>
                          <li>{t('tasks.notInstalled.steps.autoAvailable')}</li>
                          <li>{t('tasks.notInstalled.steps.initCommand')}</li>
                        </ol>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {isTaskMasterInstalled && (
              <SettingsCard>
                <SettingsRow
                  label={t('tasks.settings.enableLabel')}
                  description={t('tasks.settings.enableDescription')}
                >
                  <SettingsToggle
                    checked={tasksEnabled}
                    onChange={setTasksEnabled}
                    ariaLabel={t('tasks.settings.enableLabel')}
                  />
                </SettingsRow>
              </SettingsCard>
            )}
          </>
        )}
      </SettingsSection>
    </div>
  );
}
