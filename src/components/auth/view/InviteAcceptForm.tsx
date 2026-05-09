import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { api } from '../../../utils/api';
import { AUTH_ERROR_MESSAGES } from '../constants';
import { useAuth } from '../context/AuthContext';
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
  error?: string;
  message?: string;
};

type InviteFormState = {
  password: string;
  confirmPassword: string;
};

const initialState: InviteFormState = {
  password: '',
  confirmPassword: '',
};

function getHomePath(): string {
  const basename = window.__ROUTER_BASENAME__ || '';
  return basename ? `${basename.replace(/\/$/, '')}/` : '/';
}

function validateInviteForm(formState: InviteFormState): string | null {
  if (!formState.password || !formState.confirmPassword) {
    return 'Please fill in all fields.';
  }

  if (formState.password.length < 6) {
    return 'Password must be at least 6 characters long.';
  }

  if (formState.password !== formState.confirmPassword) {
    return 'Passwords do not match.';
  }

  return null;
}

export default function InviteAcceptForm({ token }: InviteAcceptFormProps) {
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

        if (!response.ok || !payload?.invitation?.username) {
          const message = resolveApiErrorMessage(payload, 'Invitation is invalid or has expired.');
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
          setErrorMessage(AUTH_ERROR_MESSAGES.networkError);
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
  }, [token]);

  const updateField = useCallback((field: keyof InviteFormState, value: string) => {
    setFormState((previous) => ({ ...previous, [field]: value }));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');

      const validationError = validateInviteForm(formState);
      if (validationError) {
        setErrorMessage(validationError);
        return;
      }

      setIsSubmitting(true);
      const result = await acceptInvitation(token, formState.password);
      if (!result.success) {
        setErrorMessage(result.error);
        setIsSubmitting(false);
        return;
      }

      window.location.assign(getHomePath());
    },
    [acceptInvitation, formState, token],
  );

  return (
    <AuthScreenLayout
      title="Accept invitation"
      description="Create your password to finish joining CloudCLI"
      footerText="Your username was set by the administrator."
      logo={<img src="/logo.svg" alt="CloudCLI" className="h-16 w-16" />}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <AuthInputField
          id="invitedUsername"
          name="username"
          label="Username"
          value={isLoadingInvitation ? 'Loading...' : username}
          onChange={() => undefined}
          placeholder="Username"
          isDisabled={isLoadingInvitation || isSubmitting}
          autoComplete="username"
          readOnly
        />

        <AuthInputField
          id="password"
          name="password"
          label="Password"
          value={formState.password}
          onChange={(value) => updateField('password', value)}
          placeholder="Enter your password"
          isDisabled={isLoadingInvitation || isSubmitting || !username}
          type="password"
          autoComplete="new-password"
        />

        <AuthInputField
          id="confirmPassword"
          name="confirmPassword"
          label="Confirm Password"
          value={formState.confirmPassword}
          onChange={(value) => updateField('confirmPassword', value)}
          placeholder="Confirm your password"
          isDisabled={isLoadingInvitation || isSubmitting || !username}
          type="password"
          autoComplete="new-password"
        />

        <AuthErrorAlert errorMessage={errorMessage} />

        <button
          type="submit"
          disabled={isLoadingInvitation || isSubmitting || !username}
          className="w-full rounded-md bg-blue-600 px-4 py-2 font-medium text-white transition-colors duration-200 hover:bg-blue-700 disabled:bg-blue-400"
        >
          {isSubmitting ? 'Creating account...' : 'Set Password and Sign In'}
        </button>
      </form>
    </AuthScreenLayout>
  );
}
