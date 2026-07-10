import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { api } from '../../../utils/api';
import { useAuth } from '../context/AuthContext';
import { parseJsonSafely, resolveApiErrorMessage } from '../utils';

import AuthErrorAlert from './AuthErrorAlert';
import AuthInputField from './AuthInputField';
import AuthScreenLayout from './AuthScreenLayout';

type PasswordResetFormProps = {
  token: string;
};

type PasswordResetPayload = {
  passwordReset?: {
    username?: string;
    expires_at?: string;
  };
  error?: string;
  message?: string;
};

type ResetFormState = {
  password: string;
  confirmPassword: string;
};

const initialState: ResetFormState = {
  password: '',
  confirmPassword: '',
};

function getHomePath(): string {
  const basename = window.__ROUTER_BASENAME__ || '';
  return basename ? `${basename.replace(/\/$/, '')}/` : '/';
}

function validateResetForm(formState: ResetFormState, t: TFunction<'auth'>): string | null {
  if (!formState.password || !formState.confirmPassword) {
    return t('reset.errors.requiredFields');
  }

  if (formState.password.length < 6) {
    return t('reset.errors.passwordMinLength');
  }

  if (formState.password !== formState.confirmPassword) {
    return t('reset.errors.passwordMismatch');
  }

  return null;
}

export default function PasswordResetForm({ token }: PasswordResetFormProps) {
  const { t } = useTranslation('auth');
  const { resetPassword } = useAuth();
  const [username, setUsername] = useState('');
  const [formState, setFormState] = useState<ResetFormState>(initialState);
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoadingReset, setIsLoadingReset] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let isCancelled = false;

    const loadPasswordReset = async () => {
      setIsLoadingReset(true);
      setErrorMessage('');

      try {
        const response = await api.auth.passwordReset(token);
        const payload = await parseJsonSafely<PasswordResetPayload>(response);

        if (!response.ok || !payload?.passwordReset?.username) {
          const message = resolveApiErrorMessage(payload, t('reset.errors.invalidLink'));
          if (!isCancelled) {
            setErrorMessage(message);
          }
          return;
        }

        if (!isCancelled) {
          setUsername(payload.passwordReset.username);
        }
      } catch (caughtError) {
        console.error('Password reset lookup error:', caughtError);
        if (!isCancelled) {
          setErrorMessage(t('errors.networkError'));
        }
      } finally {
        if (!isCancelled) {
          setIsLoadingReset(false);
        }
      }
    };

    void loadPasswordReset();

    return () => {
      isCancelled = true;
    };
  }, [t, token]);

  const updateField = useCallback((field: keyof ResetFormState, value: string) => {
    setFormState((previous) => ({ ...previous, [field]: value }));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');

      const validationError = validateResetForm(formState, t);
      if (validationError) {
        setErrorMessage(validationError);
        return;
      }

      setIsSubmitting(true);
      const result = await resetPassword(token, formState.password);
      if (!result.success) {
        setErrorMessage(result.error);
        setIsSubmitting(false);
        return;
      }

      window.location.assign(getHomePath());
    },
    [formState, resetPassword, t, token],
  );

  return (
    <AuthScreenLayout
      title={t('reset.title')}
      description={t('reset.description')}
      footerText={t('reset.footer')}
      logo={<img src="/logo.svg" alt="CloudCLI" className="h-16 w-16" />}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <AuthInputField
          id="resetUsername"
          name="username"
          label={t('reset.username')}
          value={isLoadingReset ? t('reset.loadingUsername') : username}
          onChange={() => undefined}
          placeholder={t('reset.username')}
          isDisabled={isLoadingReset || isSubmitting}
          autoComplete="username"
          readOnly
        />

        <AuthInputField
          id="resetPassword"
          name="password"
          label={t('reset.password')}
          value={formState.password}
          onChange={(value) => updateField('password', value)}
          placeholder={t('reset.placeholders.password')}
          isDisabled={isLoadingReset || isSubmitting || !username}
          type="password"
          autoComplete="new-password"
        />

        <AuthInputField
          id="resetConfirmPassword"
          name="confirmPassword"
          label={t('reset.confirmPassword')}
          value={formState.confirmPassword}
          onChange={(value) => updateField('confirmPassword', value)}
          placeholder={t('reset.placeholders.confirmPassword')}
          isDisabled={isLoadingReset || isSubmitting || !username}
          type="password"
          autoComplete="new-password"
        />

        <AuthErrorAlert errorMessage={errorMessage} />

        <button
          type="submit"
          disabled={isLoadingReset || isSubmitting || !username}
          className="w-full rounded-md bg-blue-600 px-4 py-2 font-medium text-white transition-colors duration-200 hover:bg-blue-700 disabled:bg-blue-400"
        >
          {isSubmitting ? t('reset.loading') : t('reset.submit')}
        </button>
      </form>
    </AuthScreenLayout>
  );
}
