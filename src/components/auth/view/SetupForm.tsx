import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../context/AuthContext';

import AuthErrorAlert from './AuthErrorAlert';
import AuthInputField from './AuthInputField';
import AuthScreenLayout from './AuthScreenLayout';

type SetupFormState = {
  username: string;
  gitEmail: string;
  password: string;
  confirmPassword: string;
};

const initialState: SetupFormState = {
  username: '',
  gitEmail: '',
  password: '',
  confirmPassword: '',
};

/**
 * Validates the account-setup form state.
 * @returns An error message string if validation fails, or `null` when the
 *   form is valid.
 */
function validateSetupForm(formState: SetupFormState, t: TFunction<'auth'>): string | null {
  if (!formState.username.trim() || !formState.gitEmail.trim() || !formState.password || !formState.confirmPassword) {
    return t('register.errors.requiredFields');
  }

  if (formState.username.trim().length < 3) {
    return t('register.errors.usernameMinLength');
  }

  const gitEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!gitEmailPattern.test(formState.gitEmail.trim())) {
    return t('register.errors.invalidGitEmail');
  }

  if (formState.password.length < 6) {
    return t('register.errors.passwordMinLength');
  }

  if (formState.password !== formState.confirmPassword) {
    return t('register.errors.passwordMismatch');
  }

  return null;
}

/**
 * Account setup / registration form.
 * Uses `autoComplete="new-password"` on password fields so that password
 * managers recognise this as a registration flow and offer to save the new
 * credentials after submission.
 */
export default function SetupForm() {
  const { t } = useTranslation('auth');
  const { register } = useAuth();

  const [formState, setFormState] = useState<SetupFormState>(initialState);
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const updateField = useCallback((field: keyof SetupFormState, value: string) => {
    setFormState((previous) => ({ ...previous, [field]: value }));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');

      const validationError = validateSetupForm(formState, t);
      if (validationError) {
        setErrorMessage(validationError);
        return;
      }

      setIsSubmitting(true);
      const result = await register(
        formState.username.trim(),
        formState.password,
        formState.gitEmail.trim(),
      );
      if (!result.success) {
        setErrorMessage(result.error);
      }
      setIsSubmitting(false);
    },
    [formState, register, t],
  );

  return (
    <AuthScreenLayout
      title={t('register.title')}
      description={t('register.description')}
      footerText={t('register.footer')}
      logo={<img src="/logo.svg" alt="CloudCLI" className="h-16 w-16" />}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
      <AuthInputField
        id="username"
        name="username"
        label={t('register.username')}
        value={formState.username}
          onChange={(value) => updateField('username', value)}
          placeholder={t('register.placeholders.username')}
          isDisabled={isSubmitting}
        autoComplete="username"
      />

      <AuthInputField
        id="password"
          name="password"
          label={t('register.password')}
          value={formState.password}
          onChange={(value) => updateField('password', value)}
          placeholder={t('register.placeholders.password')}
          isDisabled={isSubmitting}
          type="password"
          autoComplete="new-password"
        />

        <AuthInputField
          id="confirmPassword"
          name="confirmPassword"
          label={t('register.confirmPassword')}
          value={formState.confirmPassword}
          onChange={(value) => updateField('confirmPassword', value)}
          placeholder={t('register.placeholders.confirmPassword')}
          isDisabled={isSubmitting}
          type="password"
          autoComplete="new-password"
        />

      <AuthInputField
        id="gitEmail"
        name="gitEmail"
        label={t('register.email')}
        value={formState.gitEmail}
        onChange={(value) => updateField('gitEmail', value)}
        placeholder={t('register.placeholders.gitEmail')}
        isDisabled={isSubmitting}
        type="email"
        autoComplete="email"
      />

        <AuthErrorAlert errorMessage={errorMessage} />

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-md bg-blue-600 px-4 py-2 font-medium text-white transition-colors duration-200 hover:bg-blue-700 disabled:bg-blue-400"
        >
          {isSubmitting ? t('register.loading') : t('register.submit')}
        </button>
      </form>
    </AuthScreenLayout>
  );
}
