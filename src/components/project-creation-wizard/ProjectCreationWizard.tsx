import { useCallback, useState } from 'react';
import { FolderPlus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import ErrorBanner from './components/ErrorBanner';
import StepConfiguration from './components/StepConfiguration';
import StepReview from './components/StepReview';
import StepTypeSelection from './components/StepTypeSelection';
import WizardFooter from './components/WizardFooter';
import WizardProgress from './components/WizardProgress';
import { createWorkspaceRequest } from './data/workspaceApi';
import type { WizardFormState, WizardStep, WorkspaceType } from './types';

type ProjectCreationWizardProps = {
  onClose: () => void;
  onProjectCreated?: (project?: Record<string, unknown>) => void;
};

const initialFormState: WizardFormState = {
  workspaceType: 'new',
  workspacePath: '',
};

export default function ProjectCreationWizard({
  onClose,
  onProjectCreated,
}: ProjectCreationWizardProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<WizardStep>(1);
  const [formState, setFormState] = useState<WizardFormState>(initialFormState);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep cross-step values in this component; local UI state lives in child components.
  const updateField = useCallback(<K extends keyof WizardFormState>(key: K, value: WizardFormState[K]) => {
    setFormState((previous) => ({ ...previous, [key]: value }));
  }, []);

  const updateWorkspaceType = useCallback(
    (workspaceType: WorkspaceType) => updateField('workspaceType', workspaceType),
    [updateField],
  );

  const handleNext = useCallback(() => {
    setError(null);

    if (step === 1) {
      if (!formState.workspaceType) {
        setError(t('projectWizard.errors.selectType'));
        return;
      }
      setStep(2);
      return;
    }

    if (step === 2) {
      if (!formState.workspacePath.trim()) {
        setError(
          formState.workspaceType === 'existing'
            ? t('projectWizard.errors.providePath')
            : t('projectWizard.errors.provideWorkspaceName', {
                defaultValue: 'Please provide a workspace name',
              }),
        );
        return;
      }
      setStep(3);
    }
  }, [formState.workspacePath, formState.workspaceType, step, t]);

  const handleBack = useCallback(() => {
    setError(null);
    setStep((previousStep) => (previousStep > 1 ? ((previousStep - 1) as WizardStep) : previousStep));
  }, []);

  const handleCreate = useCallback(async () => {
    setIsCreating(true);
    setError(null);

    try {
      const project = await createWorkspaceRequest({
        workspaceType: formState.workspaceType,
        path: formState.workspacePath.trim(),
      });

      onProjectCreated?.(project);
      onClose();
    } catch (createError) {
      const errorMessage =
        createError instanceof Error
          ? createError.message
          : t('projectWizard.errors.failedToCreate');
      setError(errorMessage);
    } finally {
      setIsCreating(false);
    }
  }, [formState, onClose, onProjectCreated, t]);

  return (
    <div className="fixed bottom-0 left-0 right-0 top-0 z-[60] flex items-center justify-center bg-black/50 p-0 backdrop-blur-sm sm:p-4">
      <div className="h-full w-full overflow-y-auto rounded-none border-0 border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800 sm:h-auto sm:max-w-2xl sm:rounded-lg sm:border">
        <div className="flex items-center justify-between border-b border-gray-200 p-6 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/50">
              <FolderPlus className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            </div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              {t('projectWizard.title')}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            disabled={isCreating}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <WizardProgress step={step} />

        <div className="min-h-[300px] space-y-6 p-6">
          {error && <ErrorBanner message={error} />}

          {step === 1 && (
            <StepTypeSelection
              workspaceType={formState.workspaceType}
              onWorkspaceTypeChange={updateWorkspaceType}
            />
          )}

          {step === 2 && (
            <StepConfiguration
              workspaceType={formState.workspaceType}
              workspacePath={formState.workspacePath}
              isCreating={isCreating}
              onWorkspacePathChange={(workspacePath) => updateField('workspacePath', workspacePath)}
              onAdvanceToConfirm={() => setStep(3)}
            />
          )}

          {step === 3 && (
            <StepReview
              formState={formState}
            />
          )}
        </div>

        <WizardFooter
          step={step}
          isCreating={isCreating}
          onClose={onClose}
          onBack={handleBack}
          onNext={handleNext}
          onCreate={handleCreate}
        />
      </div>
    </div>
  );
}
