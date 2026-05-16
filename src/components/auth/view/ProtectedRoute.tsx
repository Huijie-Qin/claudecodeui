import type { ReactNode } from 'react';

import { useTenant } from '../../../contexts/TenantContext';
import TenantSelection from '../../tenant/TenantSelection';
import { shouldShowTenantLoadingScreen } from '../../tenant/tenantSelectionHelper';
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
  const { user, isLoading, needsSetup } = useAuth();
  const { currentTenant, isLoadingTenants, needsTenantSelection } = useTenant();
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

  if (shouldShowTenantLoadingScreen(isLoadingTenants, currentTenant)) {
    return <AuthLoadingScreen />;
  }

  if (needsTenantSelection) {
    return <TenantSelection />;
  }

  return <>{children}</>;
}
