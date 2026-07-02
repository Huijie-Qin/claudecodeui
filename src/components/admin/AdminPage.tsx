import { ArrowLeft, Shield } from 'lucide-react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Button } from '../../shared/view/ui';
import { useAuth } from '../auth/context/AuthContext';
import CurrentUserBadge from '../auth/view/CurrentUserBadge';

import AdminPanel from './AdminPanel';
import { isSystemAdminUser } from './adminPanelUtils';

type AdminRouteState = {
  from?: string;
};

export default function AdminPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation(['admin', 'common']);
  const { user } = useAuth();
  const routeState = location.state as AdminRouteState | null;
  const from = routeState?.from && routeState.from !== '/admin'
    ? routeState.from
    : '/';

  if (!isSystemAdminUser(user)) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-background">
      <header className="flex min-h-16 shrink-0 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <Button variant="ghost" className="shrink-0 px-2.5" onClick={() => navigate(from)}>
          <ArrowLeft className="h-4 w-4" />
          <span>{t('common:back')}</span>
        </Button>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Shield className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold text-foreground">{t('title')}</h1>
          <p className="truncate text-xs text-muted-foreground">{t('subtitle')}</p>
        </div>
        <CurrentUserBadge
          className="ml-auto max-w-[34vw] shrink-0 px-2 py-1.5 sm:max-w-[220px] sm:px-2.5"
          textClassName="text-xs sm:text-sm"
        />
      </header>
      <main className="min-h-0 flex-1">
        <AdminPanel />
      </main>
    </div>
  );
}
