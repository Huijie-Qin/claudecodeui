import { Check, Loader2 } from 'lucide-react';
import { useCallback, useMemo, useEffect, useState } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import { useAuth } from '../../auth/context/AuthContext';
import GitConfigurationStep from './subcomponents/GitConfigurationStep';
import {
  gitEmailPattern,
  readErrorMessageFromResponse,
} from './utils';

type OnboardingProps = {
  onComplete?: () => void | Promise<void>;
};

export default function Onboarding({ onComplete }: OnboardingProps) {
  const { user } = useAuth();
  const [gitName, setGitName] = useState('');
  const [gitEmail, setGitEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const defaultGitName = useMemo(() => user?.username?.trim() || '', [user?.username]);

  const loadGitConfig = useCallback(async () => {
    try {
      const response = await authenticatedFetch('/api/user/git-config');
      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as { gitName?: string; gitEmail?: string };
      setGitName(payload.gitName || defaultGitName);
      setGitEmail(payload.gitEmail || '');
    } catch (caughtError) {
      console.error('Error loading git config:', caughtError);
    }
  }, [defaultGitName]);

  useEffect(() => {
    setGitName(defaultGitName);
    setGitEmail('');
  }, [defaultGitName]);

  useEffect(() => {
    void loadGitConfig();
  }, [loadGitConfig]);

  const handleCompleteSetup = async () => {
    setErrorMessage('');

    if (!gitName.trim() || !gitEmail.trim()) {
      setErrorMessage('Both git name and email are required.');
      return;
    }

    if (!gitEmailPattern.test(gitEmail)) {
      setErrorMessage('Please enter a valid email address.');
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await authenticatedFetch('/api/user/git-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gitName, gitEmail }),
      });

      if (!response.ok) {
        const message = await readErrorMessageFromResponse(response, 'Failed to save git configuration');
        throw new Error(message);
      }

      const finishResponse = await authenticatedFetch('/api/user/complete-onboarding', { method: 'POST' });
      if (!finishResponse.ok) {
        const message = await readErrorMessageFromResponse(finishResponse, 'Failed to complete onboarding');
        throw new Error(message);
      }

      await onComplete?.();
    } catch (caughtError) {
      setErrorMessage(caughtError instanceof Error ? caughtError.message : 'Failed to complete onboarding');
    } finally {
      setIsSubmitting(false);
    }
  };
  const isCurrentStepValid = Boolean(gitName.trim() && gitEmail.trim() && gitEmailPattern.test(gitEmail));

  return (
    <>
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="w-full max-w-2xl">
          <div className="rounded-lg border border-border bg-card p-8 shadow-lg">
            <GitConfigurationStep
              gitName={gitName}
              gitEmail={gitEmail}
              isSubmitting={isSubmitting}
              onGitNameChange={setGitName}
              onGitEmailChange={setGitEmail}
            />

            {errorMessage && (
              <div className="mt-6 rounded-lg border border-red-300 bg-red-100 p-4 dark:border-red-800 dark:bg-red-900/20">
                <p className="text-sm text-red-700 dark:text-red-400">{errorMessage}</p>
              </div>
            )}

            <div className="mt-8 flex items-center justify-between border-t border-border pt-6">
              <span className="text-sm text-muted-foreground">
                Step 1 / 1
              </span>
              <button
                onClick={handleCompleteSetup}
                disabled={!isCurrentStepValid || isSubmitting}
                className="flex items-center gap-2 rounded-lg bg-green-600 px-6 py-3 font-medium text-white transition-colors duration-200 hover:bg-green-700 disabled:cursor-not-allowed disabled:bg-green-400"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Completing...
                  </>
                ) : (
                  <>
                    <Check className="h-4 w-4" />
                    Complete Setup
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
