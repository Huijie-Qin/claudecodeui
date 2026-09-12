import { useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useUiPreferences } from '../../hooks/useUiPreferences';

import UserHookExecutionDetails from './UserHookExecutionDetails';
import { getHookProcessVisibility } from './hookProcessVisibility';

type Props = {
  isExecution: boolean;
  hasPostActions: boolean;
  defaultOpen?: boolean;
  workspaceId?: number;
  hookId?: string;
  hookName: string;
  executionId?: string;
  executionStatus: string;
  children: ReactNode;
};

// One entry for the execution chain. The preference only gates script data;
// post-actions must remain available even without access to the audit record.
export default function HookExecutionProcess({
  isExecution, hasPostActions, defaultOpen = false, workspaceId,
  hookId, hookName, executionId, executionStatus, children,
}: Props) {
  const { t } = useTranslation('chat');
  const { preferences } = useUiPreferences();
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  const { showProcess, showScript, showPostActions } = getHookProcessVisibility({
    isExecution,
    hasPostActions,
    showScriptPreference: preferences.showHookExecutionDetails,
    hasExecutionContext: Boolean(workspaceId && hookId && executionId),
  });

  if (!isExecution) return <>{children}</>;
  if (!showProcess) return null;

  return (
    <section className="mt-2 border-t border-violet-200/70 pt-2 dark:border-violet-900/70" data-hook-process>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        aria-label={t(open ? 'hookActivity.collapseProcess' : 'hookActivity.expandProcess')}
        data-hook-process-toggle
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-xs font-medium text-violet-700 outline-none transition-colors hover:bg-violet-100/70 focus-visible:ring-2 focus-visible:ring-violet-400/60 dark:text-violet-300 dark:hover:bg-violet-900/30"
      >
        <span>{t('hookActivity.executionProcess')}</span>
        <span className="ml-auto text-[10px] font-normal text-muted-foreground">
          {t(open ? 'hookActivity.collapseProcess' : 'hookActivity.expandProcess')}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open ? (
        <div id={contentId} className="mt-2 space-y-3" data-hook-process-content>
          {showScript ? (
            <UserHookExecutionDetails
              inline
              workspaceId={workspaceId!}
              hookId={hookId!}
              hookName={hookName}
              executionId={executionId!}
              executionStatus={executionStatus}
            />
          ) : null}
          {showPostActions ? (
            <section data-hook-post-actions>
              <h4 className="mb-2 text-xs font-semibold text-violet-700 dark:text-violet-300">{t('hookActivity.postActions')}</h4>
              {children}
            </section>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
