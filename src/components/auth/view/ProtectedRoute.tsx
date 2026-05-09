import type { ReactNode } from 'react';

import { IS_PLATFORM } from '../../../constants/config';
import { useTenant } from '../../../contexts/TenantContext';
import Onboarding from '../../onboarding/view/Onboarding';
import TenantSelection from '../../tenant/TenantSelection';
import { useAuth } from '../context/AuthContext';

import AuthLoadingScreen from './AuthLoadingScreen';
import InviteAcceptForm from './InviteAcceptForm';
import LoginForm from './LoginForm';
import SetupForm from './SetupForm';

type ProtectedRouteProps = {
  children: ReactNode;
};

function getInvitationTokenFromLocation(): string | null {
  const basename = window.__ROUTER_BASENAME__ || '';
  const pathname = basename && window.location.pathname.startsWith(basename)
    ? window.location.pathname.slice(basename.length) || '/'
    : window.location.pathname;
  const match = pathname.match(/^\/invite\/([^/?#]+)/);
  if (!match?.[1]) return null;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isLoading, needsSetup, hasCompletedOnboarding, refreshOnboardingStatus } = useAuth();
  const { isLoadingTenants, needsTenantSelection } = useTenant();
  const invitationToken = getInvitationTokenFromLocation();

  if (isLoading) {
    return <AuthLoadingScreen />;
  }

  if (invitationToken && !user) {
    return <InviteAcceptForm token={invitationToken} />;
  }

  if (invitationToken && user) {
    window.location.replace(`${window.__ROUTER_BASENAME__ || ''}/`);
    return <AuthLoadingScreen />;
  }

  if (needsSetup) {
    return <SetupForm />;
  }

  if (!user) {
    return <LoginForm />;
  }

  if (isLoadingTenants) {
    return <AuthLoadingScreen />;
  }

  if (needsTenantSelection) {
    return <TenantSelection />;
  }

  if (IS_PLATFORM) {
    if (!hasCompletedOnboarding) {
      return <Onboarding onComplete={refreshOnboardingStatus} />;
    }

    return <>{children}</>;
  }

  if (!hasCompletedOnboarding) {
    return <Onboarding onComplete={refreshOnboardingStatus} />;
  }

  return <>{children}</>;
}
