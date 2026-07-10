import { useTranslation } from 'react-i18next';

import type { WorkspaceType } from '../types';

import WorkspacePathField from './WorkspacePathField';

type StepConfigurationProps = {
  workspaceType: WorkspaceType;
  workspacePath: string;
  isCreating: boolean;
  onWorkspacePathChange: (workspacePath: string) => void;
  onAdvanceToConfirm: () => void;
};

export default function StepConfiguration({
  workspaceType,
  workspacePath,
  isCreating,
  onWorkspacePathChange,
  onAdvanceToConfirm,
}: StepConfigurationProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {workspaceType === 'existing'
            ? t('projectWizard.step2.existingPath')
            : t('projectWizard.step2.newName', { defaultValue: 'Workspace Name' })}
        </label>

        <WorkspacePathField
          workspaceType={workspaceType}
          value={workspacePath}
          disabled={isCreating}
          onChange={onWorkspacePathChange}
          onAdvanceToConfirm={onAdvanceToConfirm}
        />

        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {workspaceType === 'existing'
            ? t('projectWizard.step2.existingHelp')
            : t('projectWizard.step2.newHelp')}
        </p>
      </div>
    </div>
  );
}
