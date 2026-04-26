import type { ReactNode } from 'react';
import { IS_PLATFORM } from '../../../constants/config';
import { useTenant } from '../../../contexts/TenantContext';
import { useAuth } from '../context/AuthContext';
import Onboarding from '../../onboarding/view/Onboarding';
import TenantSelection from '../../tenant/TenantSelection';
import AuthLoadingScreen from './AuthLoadingScreen';
import LoginForm from './LoginForm';
import SetupForm from './SetupForm';

type ProtectedRouteProps = {
  children: ReactNode;
};

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isLoading, needsSetup, hasCompletedOnboarding, refreshOnboardingStatus } = useAuth();
  const { isLoadingTenants, needsTenantSelection } = useTenant();

  if (isLoading) {
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
