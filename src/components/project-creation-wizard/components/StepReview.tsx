import { useTranslation } from 'react-i18next';

import type { WizardFormState } from '../types';

type StepReviewProps = {
  formState: WizardFormState;
};

export default function StepReview({
  formState,
}: StepReviewProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/50">
        <h4 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">
          {t('projectWizard.step3.reviewConfig')}
        </h4>

        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-gray-600 dark:text-gray-400">
              {t('projectWizard.step3.workspaceType')}
            </span>
            <span className="font-medium text-gray-900 dark:text-white">
              {formState.workspaceType === 'existing'
                ? t('projectWizard.step3.existingWorkspace')
                : t('projectWizard.step3.newWorkspace')}
            </span>
          </div>

          <div className="flex justify-between text-sm">
            <span className="text-gray-600 dark:text-gray-400">
              {formState.workspaceType === 'existing'
                ? t('projectWizard.step3.path')
                : t('projectWizard.step3.workspaceName', { defaultValue: 'Workspace Name:' })}
            </span>
            <span className="break-all font-mono text-xs text-gray-900 dark:text-white">
              {formState.workspacePath}
            </span>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-900/20">
        <p className="text-sm text-blue-800 dark:text-blue-200">
          {formState.workspaceType === 'existing'
            ? t('projectWizard.step3.existingInfo')
            : t('projectWizard.step3.newEmpty')}
        </p>
      </div>
    </div>
  );
}
