import { useCallback, useEffect, useState } from 'react';
import { FolderPlus, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useTenant } from '../../contexts/TenantContext';

import AgentTemplatePicker from './components/AgentTemplatePicker';
import ErrorBanner from './components/ErrorBanner';
import { createWorkspaceRequest, listAgentTemplatesRequest } from './data/workspaceApi';
import type { AgentTemplateOption, WizardFormState } from './types';

type ProjectCreationWizardProps = {
  onClose: () => void;
  onProjectCreated?: (project?: Record<string, unknown>) => void;
};

const initialFormState: WizardFormState = {
  workspaceType: 'new',
  workspacePath: '',
  templateId: null,
};

export default function ProjectCreationWizard({
  onClose,
  onProjectCreated,
}: ProjectCreationWizardProps) {
  const { t } = useTranslation();
  const { currentTenant } = useTenant();
  const [formState, setFormState] = useState<WizardFormState>(initialFormState);
  const [templates, setTemplates] = useState<AgentTemplateOption[]>([]);
  const [isLoadingTemplates, setIsLoadingTemplates] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoadingTemplates(true);
    void listAgentTemplatesRequest()
      .then((nextTemplates) => {
        if (cancelled) return;
        setTemplates(nextTemplates);
        setFormState((previous) => ({
          ...previous,
          templateId: previous.templateId != null
            && nextTemplates.some((template) => template.id === previous.templateId)
            ? previous.templateId
            : (nextTemplates[0]?.id ?? null),
        }));
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Agent 模板加载失败');
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoadingTemplates(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentTenant?.id]);

  const handleCreate = useCallback(async () => {
    const agentName = formState.workspacePath.trim();
    if (!agentName) {
      setError('请输入 Agent 名称');
      return;
    }

    setIsCreating(true);
    setError(null);
    try {
      const project = await createWorkspaceRequest({
        workspaceType: 'new',
        path: agentName,
        templateId: formState.templateId,
      });
      onProjectCreated?.(project);
      onClose();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : t('projectWizard.errors.failedToCreate'));
    } finally {
      setIsCreating(false);
    }
  }, [formState.templateId, formState.workspacePath, onClose, onProjectCreated, t]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-0 backdrop-blur-sm sm:p-4">
      <div className="flex h-full w-full flex-col overflow-hidden rounded-none border-0 border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800 sm:h-auto sm:max-h-[92vh] sm:max-w-4xl sm:rounded-xl sm:border">
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-5 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/50">
              <FolderPlus className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            </div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">创建新项目</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            disabled={isCreating}
            aria-label="关闭"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-6">
          {error ? <ErrorBanner message={error} /> : null}

          <div>
            <label htmlFor="agent-name" className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-200">Agent 名称</label>
            <input
              id="agent-name"
              autoFocus
              value={formState.workspacePath}
              onChange={(event) => setFormState((previous) => ({ ...previous, workspacePath: event.target.value }))}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !isCreating) void handleCreate();
              }}
              placeholder="my-agent"
              disabled={isCreating}
              className="h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
            />
            <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">输入 Agent 名称，系统将在默认目录中创建对应的工作区。</p>
          </div>

          <AgentTemplatePicker
            templates={templates}
            selectedTemplateId={formState.templateId}
            tenantName={currentTenant?.name}
            isLoading={isLoadingTemplates}
            disabled={isCreating}
            onChange={(templateId) => setFormState((previous) => ({ ...previous, templateId }))}
          />
        </div>

        <div className="flex justify-end border-t border-gray-200 px-6 py-4 dark:border-gray-700">
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={isCreating || isLoadingTemplates || !formState.workspacePath.trim()}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {isCreating ? '创建中...' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}
