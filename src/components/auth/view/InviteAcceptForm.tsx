import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { api } from '../../../utils/api';
import { useAuth } from '../context/AuthContext';
import { shouldRedirectAcceptedInvitation } from '../invitationNavigation';
import { parseJsonSafely, resolveApiErrorMessage } from '../utils';

import AuthErrorAlert from './AuthErrorAlert';
import AuthInputField from './AuthInputField';
import AuthScreenLayout from './AuthScreenLayout';

type InviteAcceptFormProps = {
  token: string;
};

type InvitationPayload = {
  invitation?: {
    username?: string;
    expires_at?: string;
  };
  code?: string;
  error?: string;
  message?: string;
};

type InviteFormState = {
  password: string;
  confirmPassword: string;
  gitEmail: string;
};

const initialState: InviteFormState = {
  password: '',
  confirmPassword: '',
  gitEmail: '',
};

function getHomePath(): string {
  const basename = window.__ROUTER_BASENAME__ || '';
  return basename ? `${basename.replace(/\/$/, '')}/` : '/';
}

function validateInviteForm(formState: InviteFormState, t: TFunction<'auth'>): string | null {
  if (!formState.password || !formState.confirmPassword || !formState.gitEmail.trim()) {
    return t('invite.errors.requiredFields');
  }

  if (formState.password.length < 6) {
    return t('invite.errors.passwordMinLength');
  }

  if (formState.password !== formState.confirmPassword) {
    return t('invite.errors.passwordMismatch');
  }

  const gitEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!gitEmailPattern.test(formState.gitEmail.trim())) {
    return t('invite.errors.invalidGitEmail');
  }

  return null;
}

export default function InviteAcceptForm({ token }: InviteAcceptFormProps) {
  const { t } = useTranslation('auth');
  const { acceptInvitation } = useAuth();
  const [username, setUsername] = useState('');
  const [formState, setFormState] = useState<InviteFormState>(initialState);
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoadingInvitation, setIsLoadingInvitation] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let isCancelled = false;

    const loadInvitation = async () => {
      setIsLoadingInvitation(true);
      setErrorMessage('');

      try {
        const response = await api.auth.invitation(token);
        const payload = await parseJsonSafely<InvitationPayload>(response);

        if (shouldRedirectAcceptedInvitation(response.status, payload)) {
          window.location.replace(getHomePath());
          return;
        }

        if (!response.ok || !payload?.invitation?.username) {
          const message = resolveApiErrorMessage(payload, t('invite.errors.invalidInvitation'));
          if (!isCancelled) {
            setErrorMessage(message);
          }
          return;
        }

        if (!isCancelled) {
          setUsername(payload.invitation.username);
        }
      } catch (caughtError) {
        console.error('Invitation lookup error:', caughtError);
        if (!isCancelled) {
          setErrorMessage(t('errors.networkError'));
        }
      } finally {
        if (!isCancelled) {
          setIsLoadingInvitation(false);
        }
      }
    };

    void loadInvitation();

    return () => {
      isCancelled = true;
    };
  }, [t, token]);

  const updateField = useCallback((field: keyof InviteFormState, value: string) => {
    setFormState((previous) => ({ ...previous, [field]: value }));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');

      const validationError = validateInviteForm(formState, t);
      if (validationError) {
        setErrorMessage(validationError);
        return;
      }

      setIsSubmitting(true);
      const result = await acceptInvitation(token, formState.password, formState.gitEmail.trim());
      if (!result.success) {
        setErrorMessage(result.error);
        setIsSubmitting(false);
        return;
      }

      window.location.assign(getHomePath());
    },
    [acceptInvitation, formState, t, token],
  );

  return (
    <AuthScreenLayout
      title={t('invite.title')}
      description={t('invite.description')}
      footerText={t('invite.footer')}
      logo={<img src="/logo.svg" alt="CloudCLI" className="h-16 w-16" />}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <AuthInputField
          id="invitedUsername"
          name="username"
          label={t('invite.username')}
          value={isLoadingInvitation ? t('invite.loadingUsername') : username}
          onChange={() => undefined}
          placeholder={t('invite.username')}
          isDisabled={isLoadingInvitation || isSubmitting}
          autoComplete="username"
          readOnly
        />

        <AuthInputField
          id="password"
          name="password"
          label={t('invite.password')}
          value={formState.password}
          onChange={(value) => updateField('password', value)}
          placeholder={t('invite.placeholders.password')}
          isDisabled={isLoadingInvitation || isSubmitting || !username}
          type="password"
          autoComplete="new-password"
        />

        <AuthInputField
          id="confirmPassword"
          name="confirmPassword"
          label={t('invite.confirmPassword')}
          value={formState.confirmPassword}
          onChange={(value) => updateField('confirmPassword', value)}
          placeholder={t('invite.placeholders.confirmPassword')}
          isDisabled={isLoadingInvitation || isSubmitting || !username}
          type="password"
          autoComplete="new-password"
        />

        <AuthInputField
          id="gitEmail"
          name="gitEmail"
          label={t('invite.email')}
          value={formState.gitEmail}
          onChange={(value) => updateField('gitEmail', value)}
          placeholder={t('invite.placeholders.gitEmail')}
          isDisabled={isLoadingInvitation || isSubmitting || !username}
          type="email"
          autoComplete="email"
        />

        <AuthErrorAlert errorMessage={errorMessage} />

        <button
          type="submit"
          disabled={isLoadingInvitation || isSubmitting || !username}
          className="w-full rounded-md bg-blue-600 px-4 py-2 font-medium text-white transition-colors duration-200 hover:bg-blue-700 disabled:bg-blue-400"
        >
          {isSubmitting ? t('invite.loading') : t('invite.submit')}
        </button>
      </form>
    </AuthScreenLayout>
  );
}
