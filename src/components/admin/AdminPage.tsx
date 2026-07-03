import { Suspense } from 'react';
import { AlertTriangle, ArrowLeft, RefreshCw, Shield } from 'lucide-react';
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary';
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

function AdminPanelLoading() {
  const { t } = useTranslation('admin');

  return (
    <div className="flex h-full min-h-[240px] items-center justify-center bg-background px-6 text-sm text-muted-foreground">
      <div className="flex items-center gap-2">
        <RefreshCw className="h-4 w-4 animate-spin" />
        <span>{t('loadingPanel', { defaultValue: '正在加载管理面板...' })}</span>
      </div>
    </div>
  );
}

function AdminPanelErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  const { t } = useTranslation('admin');
  const message = error instanceof Error ? error.message : String(error || '');

  return (
    <div className="flex h-full min-h-[280px] items-center justify-center bg-background px-6">
      <div className="w-full max-w-xl rounded-md border border-destructive/30 bg-destructive/5 p-5 text-destructive">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="min-w-0 flex-1 space-y-2">
            <h2 className="text-sm font-semibold">
              {t('errors.loadAdminPanel', { defaultValue: '管理面板加载失败' })}
            </h2>
            {message ? (
              <pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded bg-background/80 p-3 text-xs text-foreground">
                {message}
              </pre>
            ) : null}
            <Button type="button" variant="outline" size="sm" onClick={resetErrorBoundary}>
              <RefreshCw className="h-4 w-4" />
              {t('common.refresh', { defaultValue: '刷新' })}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

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
        <ErrorBoundary FallbackComponent={AdminPanelErrorFallback}>
          <Suspense fallback={<AdminPanelLoading />}>
            <AdminPanel />
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  );
}
