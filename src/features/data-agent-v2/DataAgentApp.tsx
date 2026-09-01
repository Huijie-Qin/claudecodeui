import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bot,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Code2,
  Database,
  FileText,
  Folder,
  FolderOpen,
  Gauge,
  LogOut,
  Menu,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Plug,
  RefreshCw,
  Search,
  Send,
  Server,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  UsersRound,
  WandSparkles,
  X,
  Zap,
} from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';

import ChatInterface from '../../components/chat/view/ChatInterface';
import ScheduledTasksDialog from '../../components/chat/view/subcomponents/ScheduledTasksDialog';
import { isSkillSlashCommand } from '../../components/chat/hooks/useSlashCommands.utils';
import { useSlashCommands } from '../../components/chat/hooks/useSlashCommands';
import CodeHubPanel from '../../components/codehub/CodeHubPanel';
import { useEditorSidebar } from '../../components/code-editor/hooks/useEditorSidebar';
import EditorSidebar from '../../components/code-editor/view/EditorSidebar';
import FileTree from '../../components/file-tree/view/FileTree';
import {
  createWorkspaceRequest,
  listAgentTemplatesRequest,
} from '../../components/project-creation-wizard/data/workspaceApi';
import type { AgentTemplateOption } from '../../components/project-creation-wizard/types';
import Settings from '../../components/settings/view/Settings';
import MarkdownPreview from '../../components/code-editor/view/subcomponents/markdown/MarkdownPreview';
import RemovalConfirmDialog from '../../components/skills-market/RemovalConfirmDialog';
import SkillFileTree from '../../components/skills-market/SkillFileTree';
import {
  getSkillDisplayName,
  type WorkspaceSkill,
  type WorkspaceSkillEntry,
} from '../../components/skills-market/utils/skillFormatting';
import SqlCheckPanel from '../../components/sql-check/SqlCheckPanel';
import McpToolsPanel from '../../components/tools-market/McpToolsPanel';
import { useWorkspaceMcpTools, type WorkspaceMcpPreset } from '../../components/tools-market/hooks/useWorkspaceMcpTools';
import { dispatchSlashCommandsChangedForPath } from '../../components/chat/utils/slashCommandEvents';
import { dispatchProjectFilesChanged } from '../../components/file-tree/utils/fileTreeEvents';
import { isSystemAdminUser } from '../../components/admin/adminPanelUtils';
import { useAuth } from '../../components/auth/context/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { isProjectUpdateScopedToTenant } from '../../hooks/projectTenantUpdates';
import { useSessionProtection } from '../../hooks/useSessionProtection';
import { useUiPreferences } from '../../hooks/useUiPreferences';
import type { LLMProvider, Project, ProjectScheduledTask, ProjectSession } from '../../types/app';
import { api } from '../../utils/api';
import { resolveSkillFileLink } from '../../utils/skillMarkdownLinks';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  CURSOR_MODELS,
  GEMINI_MODELS,
} from '../../../shared/modelConstants.js';

import './dataAgentV2.css';
import DataAgentFileTabs from './DataAgentFileTabs';
import {
  isProvisionalDataAgentSessionId,
  resolveDataAgentLaunchMessage,
} from './dataAgentLaunchRouting';
import { useFileEditorTabs } from './useFileEditorTabs';
import { useDataAgentFilesSplit } from './useDataAgentFilesSplit';

type PageKind = 'new' | 'conversation' | 'capabilities' | 'automation' | 'files' | 'codehub' | 'sql-check';
type CapabilityTab = 'experts' | 'skills' | 'connectors';

type ScheduledTask = ProjectScheduledTask & {
  prompt?: string;
  intervalMinutes?: number;
  lastError?: string | null;
};

type PendingLaunch = {
  provider: LLMProvider;
  temporarySessionId: string;
  workspaceId?: number;
  prompt: string;
  submittedAt: number;
};

type PendingInitialMessage = {
  sessionId: string;
  provider: LLMProvider;
  content: string;
  timestamp: number;
};

type WorkspaceSkillFile = {
  path: string;
  content?: string;
  contentBase64?: string;
  size?: number;
  isBinary?: boolean;
  mimeType?: string;
};

type SkillMarketEntry = {
  id?: string;
  skillId?: string;
  name: string;
  displayName?: string;
  skillName?: string;
  description?: string;
  version?: number;
  importedVersion?: number;
  imported?: boolean;
  conflict?: boolean;
  remoteDeleted?: boolean;
  updateAvailable?: boolean;
  targetPath?: string;
  nspPath?: string;
  createUserId?: string;
  files?: Array<{
    path: string;
    type?: 'directory' | 'file' | 'symlink';
    size?: number;
    mimeType?: string;
  }>;
};

type SkillMarketState = {
  skills: DataAgentMarketSkill[];
  isLoading: boolean;
  error: string | null;
};

type AgentTemplateState = {
  templates: AgentTemplateOption[];
  isLoading: boolean;
  error: string | null;
};

type DataAgentMarketSkill = WorkspaceSkill & {
  imported: boolean;
  conflict: boolean;
  skillId?: string;
};

type SkillMarketAction = 'import' | 'remove' | 'update';

const WORKSPACE_STORAGE_KEY = 'data-agent-v2-workspace-id';
const LAUNCH_ERROR_STORAGE_KEY = 'data-agent-v2-launch-error';

function getProjectSessions(project: Project): ProjectSession[] {
  const withProvider = (sessions: ProjectSession[] | undefined, provider: LLMProvider) =>
    (sessions ?? []).map((session) => ({
      ...session,
      __provider: provider,
      __projectName: project.name,
      __workspaceId: project.workspaceId,
    }));

  return [
    ...withProvider(project.sessions, 'claude'),
    ...withProvider(project.codexSessions, 'codex'),
    ...withProvider(project.cursorSessions, 'cursor'),
    ...withProvider(project.geminiSessions, 'gemini'),
  ].sort((left, right) => {
    const leftDate = new Date(String(left.updated_at || left.created_at || left.createdAt || 0)).getTime();
    const rightDate = new Date(String(right.updated_at || right.created_at || right.createdAt || 0)).getTime();
    return rightDate - leftDate;
  });
}

function getSessionLabel(session: ProjectSession) {
  return String(session.summary || session.title || session.name || '未命名任务');
}

function getWorkspaceLabel(project: Project | null) {
  return project?.displayName || project?.name || '选择专家';
}

function readSelectedWorkspaceId() {
  const stored = localStorage.getItem(WORKSPACE_STORAGE_KEY);
  const parsed = stored ? Number(stored) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveRoute(pathname: string): { page: PageKind; sessionId?: string; tab?: CapabilityTab; skillName?: string } {
  const sessionMatch = pathname.match(/^\/data-agent\/session\/([^/]+)$/);
  if (sessionMatch) return { page: 'conversation', sessionId: decodeURIComponent(sessionMatch[1]) };
  const skillMatch = pathname.match(/^\/data-agent\/capabilities\/skills\/([^/]+)$/);
  if (skillMatch) return { page: 'capabilities', tab: 'skills', skillName: decodeURIComponent(skillMatch[1]) };
  if (pathname.startsWith('/data-agent/capabilities/skills')) return { page: 'capabilities', tab: 'skills' };
  if (pathname.startsWith('/data-agent/capabilities/connectors')) return { page: 'capabilities', tab: 'connectors' };
  if (pathname.startsWith('/data-agent/capabilities')) return { page: 'capabilities', tab: 'experts' };
  if (pathname.startsWith('/data-agent/automation')) return { page: 'automation' };
  if (pathname.startsWith('/data-agent/files')) return { page: 'files' };
  if (pathname.startsWith('/data-agent/codehub')) return { page: 'codehub' };
  if (pathname.startsWith('/data-agent/sql-check')) return { page: 'sql-check' };
  return { page: 'new' };
}

function formatRelativeTime(value?: string) {
  if (!value) return '';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return '';
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  if (elapsed < 172_800_000) return '昨天';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(timestamp);
}

function parseJsonSettings(key: string) {
  try {
    const stored = localStorage.getItem(key);
    if (stored) return JSON.parse(stored);
  } catch {
    // Keep the same defaults as the existing conversation composer.
  }
  return { allowedTools: [], disallowedTools: [], skipPermissions: false };
}

function normalizeSkillMarketEntry(entry: SkillMarketEntry, canManage = false): DataAgentMarketSkill {
  const imported = entry.imported === true;
  return {
    name: entry.name,
    displayName: entry.displayName || entry.skillName || entry.name,
    description: entry.description || '',
    kind: 'managed',
    status: entry.remoteDeleted ? 'invalid' : imported ? 'enabled' : 'available',
    enabled: imported,
    imported,
    conflict: entry.conflict === true,
    skillId: entry.skillId || entry.id,
    manageable: canManage,
    sourceType: '技能市场 API',
    sourcePath: entry.nspPath,
    origin: 'market',
    targetPath: entry.targetPath,
    localVersion: entry.importedVersion,
    marketVersion: entry.version,
    updateAvailable: entry.updateAvailable,
    remoteDeleted: entry.remoteDeleted,
    createUserId: entry.createUserId,
    files: (entry.files ?? []).map((file) => ({
      path: file.path,
      type: file.type === 'directory' || file.type === 'symlink' ? file.type : 'file',
      size: file.size,
      mimeType: file.mimeType,
    })),
  };
}

function useDataAgentSkillMarket(workspaceId?: number) {
  const [state, setState] = useState<SkillMarketState>({
    skills: [],
    isLoading: false,
    error: null,
  });

  const load = useCallback(async () => {
    if (!workspaceId) {
      setState({ skills: [], isLoading: false, error: null });
      return;
    }

    setState((current) => ({ ...current, isLoading: true, error: null }));
    try {
      const payload = await readSkillResponse(
        await api.skillMarket.list(workspaceId, { page: 1, pageSize: 100 }),
        '技能市场加载失败。',
      );
      const canManage = payload.canManage !== false;
      setState({
        skills: ((payload.skills ?? []) as SkillMarketEntry[]).map((entry) => normalizeSkillMarketEntry(entry, canManage)),
        isLoading: false,
        error: null,
      });
    } catch (marketError) {
      setState({
        skills: [],
        isLoading: false,
        error: marketError instanceof Error ? marketError.message : '技能市场加载失败。',
      });
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { ...state, reload: load };
}

function useDataAgentTemplates(tenantId?: number) {
  const [state, setState] = useState<AgentTemplateState>({
    templates: [],
    isLoading: false,
    error: null,
  });

  const load = useCallback(async () => {
    if (!tenantId) {
      setState({ templates: [], isLoading: false, error: null });
      return;
    }

    setState((current) => ({ ...current, isLoading: true, error: null }));
    try {
      const templates = await listAgentTemplatesRequest();
      setState({ templates, isLoading: false, error: null });
    } catch (loadError) {
      setState({
        templates: [],
        isLoading: false,
        error: loadError instanceof Error ? loadError.message : '专家加载失败。',
      });
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { ...state, reload: load };
}

function DataAgentWorkspaceSelect({
  projects,
  selectedProject,
  onSelect,
  compact = false,
  label = '专家',
}: {
  projects: Project[];
  selectedProject: Project | null;
  onSelect: (project: Project) => void;
  compact?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={pickerRef} className={`da-workspace-select ${compact ? 'is-compact' : ''}`}>
      <button
        type="button"
        className={`da-workspace-trigger ${open ? 'is-open' : ''}`}
        aria-label={`选择${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <FolderOpen size={15} aria-hidden="true" />
        {!compact && <span className="da-workspace-select-label">{label}</span>}
        <strong className="da-workspace-name">{getWorkspaceLabel(selectedProject)}</strong>
        <ChevronDown className={open ? 'is-open' : ''} size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="da-workspace-menu" role="menu" aria-label={`选择${label}`}>
          <div className="da-menu-label">选择{label}</div>
          <div className="da-workspace-options">
            {projects.map((project) => {
              const selected = project.workspaceId === selectedProject?.workspaceId
                && project.name === selectedProject?.name;
              return (
                <button
                  key={`${project.workspaceId ?? 'local'}:${project.name}`}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  className={`da-workspace-option ${selected ? 'is-selected' : ''}`}
                  onClick={() => {
                    onSelect(project);
                    setOpen(false);
                  }}
                >
                  <span className="da-workspace-mark">{getWorkspaceLabel(project).slice(0, 1).toUpperCase()}</span>
                  <span className="da-workspace-option-copy">
                    <strong>{getWorkspaceLabel(project)}</strong>
                    <small>{project.fullPath || project.path || '本地专家'}</small>
                  </span>
                  {selected && <Check size={14} aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function DataAgentSidebar({
  page,
  projects,
  selectedSession,
  processingSessions,
  onNavigate,
  onCreateTask,
  onOpenSettings,
}: {
  page: PageKind;
  projects: Project[];
  selectedSession: ProjectSession | null;
  processingSessions: Map<string, number>;
  onNavigate: (path: string) => void;
  onCreateTask: (project: Project) => void;
  onOpenSettings: () => void;
}) {
  const { user, logout } = useAuth();
  const { tenants, currentTenant, selectTenant } = useTenant();
  const [moreOpen, setMoreOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(() => new Set());
  const moreRef = useRef<HTMLDivElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);
  const isAdmin = isSystemAdminUser(user);

  const getWorkspaceGroupKey = useCallback(
    (project: Project) => `${project.workspaceId ?? 'local'}:${project.name}`,
    [],
  );

  useEffect(() => {
    if (!selectedSession) return;
    const currentProject = projects.find((project) => (
      getProjectSessions(project).some((session) => session.id === selectedSession.id)
    ));
    if (!currentProject) return;
    const currentKey = getWorkspaceGroupKey(currentProject);
    setCollapsedWorkspaces((previous) => {
      if (!previous.has(currentKey)) return previous;
      const next = new Set(previous);
      next.delete(currentKey);
      return next;
    });
  }, [getWorkspaceGroupKey, projects, selectedSession]);

  const toggleWorkspaceGroup = (project: Project) => {
    const key = getWorkspaceGroupKey(project);
    setCollapsedWorkspaces((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  useEffect(() => {
    if (!moreOpen && !accountOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (moreOpen && !moreRef.current?.contains(target)) setMoreOpen(false);
      if (accountOpen && !accountRef.current?.contains(target)) setAccountOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMoreOpen(false);
        setAccountOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [accountOpen, moreOpen]);

  const navItems = [
    { key: 'new', label: '新建任务', icon: MessageSquarePlus, path: '/data-agent/new' },
    { key: 'capabilities', label: '专家 · 技能 · 连接器', icon: Sparkles, path: '/data-agent/capabilities/experts' },
    { key: 'automation', label: '自动化', icon: CalendarClock, path: '/data-agent/automation' },
    { key: 'files', label: '文件', icon: FileText, path: '/data-agent/files' },
  ] as const;

  return (
    <aside className="da-sidebar">
      <div className="da-window-drag" aria-hidden="true" />
      <div className="da-brand-row">
        <button className="da-brand" type="button" onClick={() => onNavigate('/data-agent/new')} aria-label="DataAgent 首页">
          <span className="da-brand-mark">D</span>
          <span>DataAgent</span>
        </button>
      </div>

      <nav className="da-sidebar-nav" aria-label="主要导航">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              type="button"
              className={`da-nav-button ${page === item.key ? 'is-active' : ''}`}
              onClick={() => {
                setMoreOpen(false);
                onNavigate(item.path);
              }}
            >
              <Icon size={17} />
              <span>{item.label}</span>
            </button>
          );
        })}

        <div ref={moreRef} className="da-more-wrap">
          <button
            type="button"
            className={`da-nav-button ${page === 'codehub' || page === 'sql-check' ? 'is-active' : ''}`}
            aria-expanded={moreOpen}
            onClick={() => {
              setAccountOpen(false);
              setMoreOpen((current) => !current);
            }}
          >
            <MoreHorizontal size={17} />
            <span>更多</span>
          </button>
          {moreOpen && (
            <div className="da-more-menu">
              <button type="button" onClick={() => onNavigate('/data-agent/codehub')}><Code2 size={15} />CodeHub</button>
              <button type="button" onClick={() => onNavigate('/data-agent/sql-check')}><Database size={15} />SQL Check</button>
              {isAdmin && <button type="button" onClick={() => onNavigate('/admin')}><ShieldCheck size={15} />管理后台</button>}
              <button type="button" onClick={() => onNavigate('/')}><Gauge size={15} />返回经典版</button>
            </div>
          )}
        </div>
      </nav>

      <div className="da-workspace-history">
        <div className="da-history-scroll">
          {projects.map((project) => {
              const sessions = getProjectSessions(project).slice(0, 8);
              const projectKey = getWorkspaceGroupKey(project);
              const isExpanded = !collapsedWorkspaces.has(projectKey);
              const expertName = project.agentTemplate?.name?.trim();
              const sessionListId = `da-workspace-sessions-${String(project.workspaceId ?? project.name).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
              return (
                <section key={projectKey} className="da-project-group">
                  <div className="da-project-row">
                    <button
                      type="button"
                      className="da-project-toggle"
                      aria-label={expertName ? `${getWorkspaceLabel(project)}，来源专家：${expertName}` : getWorkspaceLabel(project)}
                      aria-expanded={isExpanded}
                      aria-controls={sessionListId}
                      onClick={() => toggleWorkspaceGroup(project)}
                    >
                      <ChevronRight className={isExpanded ? 'is-open' : ''} size={13} />
                      <span className="da-project-mark">{getWorkspaceLabel(project).slice(0, 1).toUpperCase()}</span>
                      <span className={`da-project-title ${expertName ? 'has-expert-source' : ''}`}>
                        <strong>{getWorkspaceLabel(project)}</strong>
                        {expertName && (
                          <span className="da-project-expert-tooltip" role="tooltip" aria-hidden="true">
                            <span>来源专家</span>
                            <span>{expertName}</span>
                          </span>
                        )}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="da-project-new-task"
                      aria-label={`在 ${getWorkspaceLabel(project)} 中新建任务`}
                      title="在此专家中新建任务"
                      onClick={() => onCreateTask(project)}
                    >
                      <MessageSquarePlus size={14} />
                    </button>
                  </div>
                  {isExpanded && <div id={sessionListId} className="da-session-list">
                  {sessions.map((session) => {
                    const isProcessing = processingSessions.has(session.id);
                    return (
                      <button
                        type="button"
                        key={`${session.__provider}:${session.id}`}
                        className={`da-session-row ${selectedSession?.id === session.id ? 'is-selected' : ''}`}
                        onClick={() => onNavigate(`/data-agent/session/${encodeURIComponent(session.id)}`)}
                      >
                        <span className={`da-status-dot ${isProcessing ? 'is-processing' : 'is-idle'}`} />
                        <span className="da-session-title">{getSessionLabel(session)}</span>
                        <span className="da-session-time">{formatRelativeTime(String(session.updated_at || session.created_at || session.createdAt || ''))}</span>
                      </button>
                    );
                  })}
                  {sessions.length === 0 && <div className="da-sidebar-empty">还没有任务</div>}
                  </div>}
                </section>
              );
          })}
        </div>
      </div>

      <footer className="da-sidebar-footer">
        <button className="da-nav-button" type="button" onClick={onOpenSettings}>
          <SettingsIcon size={17} />
          <span>设置</span>
        </button>
        <div ref={accountRef} className="da-account-wrap">
          <button className="da-account-button" type="button" onClick={() => {
            setMoreOpen(false);
            setAccountOpen((current) => !current);
          }} aria-expanded={accountOpen}>
            <span className="da-avatar">{user?.username?.slice(0, 2).toUpperCase() || 'DA'}</span>
            <span className="da-account-copy">
              <strong>{user?.username || 'DataAgent 用户'}</strong>
              <small>{currentTenant?.name || '未选择团队'} · 已连接</small>
            </span>
            <ChevronDown size={13} />
          </button>
          {accountOpen && (
            <div className="da-account-menu">
              {tenants.length > 0 && <div className="da-menu-label">切换团队</div>}
              {tenants.map((tenant) => (
                <button key={tenant.id} type="button" onClick={() => { selectTenant(tenant); setAccountOpen(false); }}>
                  <UsersRound size={15} />
                  <span>{tenant.name}</span>
                  {tenant.id === currentTenant?.id && <Check size={14} />}
                </button>
              ))}
              <button type="button" onClick={logout}><LogOut size={15} /><span>退出登录</span></button>
            </div>
          )}
        </div>
      </footer>
    </aside>
  );
}

function DataAgentPageHeader({
  title,
  subtitle,
  projects,
  selectedProject,
  onSelectWorkspace,
  action,
  showWorkspace = true,
  workspaceLabel = '专家',
}: {
  title: string;
  subtitle: string;
  projects: Project[];
  selectedProject: Project | null;
  onSelectWorkspace: (project: Project) => void;
  action?: React.ReactNode;
  showWorkspace?: boolean;
  workspaceLabel?: string;
}) {
  return (
    <header className="da-page-header">
      <div className="da-page-title">
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </div>
      <div className="da-page-actions">
        {showWorkspace && <DataAgentWorkspaceSelect projects={projects} selectedProject={selectedProject} onSelect={onSelectWorkspace} compact label={workspaceLabel} />}
        {action}
      </div>
    </header>
  );
}

function DataAgentNewTask({
  projects,
  selectedProject,
  onSelectWorkspace,
  onStart,
  pending,
  error,
  onOpenAutomation,
}: {
  projects: Project[];
  selectedProject: Project | null;
  onSelectWorkspace: (project: Project) => void;
  onStart: (prompt: string) => void;
  pending: boolean;
  error: string | null;
  onOpenAutomation: () => void;
}) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const skillPopoverRef = useRef<HTMLDivElement>(null);
  const skillTriggerRef = useRef<HTMLButtonElement>(null);
  const {
    slashCommandsCount,
    filteredCommands,
    showCommandMenu,
    selectedCommandIndex,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
    resetCommandMenuState,
  } = useSlashCommands({
    selectedProject,
    input,
    setInput,
    textareaRef,
    commandFilter: isSkillSlashCommand,
  });

  useEffect(() => {
    setInput('');
    resetCommandMenuState();
  }, [selectedProject?.workspaceId, resetCommandMenuState]);

  useEffect(() => {
    if (!showCommandMenu) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!skillPopoverRef.current?.contains(target) && !skillTriggerRef.current?.contains(target)) {
        resetCommandMenuState();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') resetCommandMenuState();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [resetCommandMenuState, showCommandMenu]);

  const submit = () => {
    if (!pending && input.trim() && selectedProject) onStart(input.trim());
  };

  return (
    <section className="da-page da-new-page">
      <DataAgentPageHeader
        title="新建任务"
        subtitle="在当前专家中开始一个 AI 会话"
        projects={projects}
        selectedProject={selectedProject}
        onSelectWorkspace={onSelectWorkspace}
        showWorkspace={false}
      />
      <div className="da-new-inner">
        <div className="da-new-intro">
          <span className="da-intro-icon"><WandSparkles size={20} /></span>
          <h1>今天想完成什么？</h1>
          <p>描述目标，DataAgent 会由所选专家规划并执行。</p>
        </div>

        <div className={`da-composer-card ${pending ? 'is-pending' : ''}`}>
          <textarea
            ref={textareaRef}
            value={input}
            disabled={pending}
            placeholder="例如：分析当前分支的登录模块改动，并给出可执行的修复建议…"
            onChange={(event) => {
              setInput(event.target.value);
              handleCommandInputChange(event.target.value, event.target.selectionStart);
            }}
            onKeyDown={(event) => {
              if (handleCommandMenuKeyDown(event)) return;
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
          />

          {showCommandMenu && (
            <div ref={skillPopoverRef} className="da-skill-popover">
              <div className="da-popover-heading">选择技能 <span>{slashCommandsCount}</span></div>
              <div className="da-popover-list">
                {filteredCommands.length ? filteredCommands.map((command, index) => (
                  <button
                    type="button"
                    key={`${command.namespace || 'skill'}:${command.name}`}
                    className={index === selectedCommandIndex ? 'is-active' : ''}
                    onMouseEnter={() => handleCommandSelect(command, index, true)}
                    onClick={() => handleCommandSelect(command, index, false)}
                  >
                    <Zap size={15} />
                    <span><strong>{command.name}</strong><small>{command.description || '专家技能'}</small></span>
                  </button>
                )) : <div className="da-popover-empty">当前专家还没有可用技能</div>}
              </div>
            </div>
          )}

          <div className="da-composer-footer">
            <div className="da-composer-tools">
              <button ref={skillTriggerRef} type="button" className="da-tool-button" onClick={handleToggleCommandMenu} title="选择技能" aria-expanded={showCommandMenu}>
                <TerminalSquare size={16} />
                <span>{slashCommandsCount}</span>
              </button>
              <DataAgentWorkspaceSelect projects={projects} selectedProject={selectedProject} onSelect={onSelectWorkspace} label="专家" />
              <button type="button" className="da-tool-button" onClick={onOpenAutomation} title="管理当前专家的自动化">
                <Clock3 size={16} />
              </button>
            </div>
            <button
              type="button"
              className="da-send-button"
              disabled={!input.trim() || !selectedProject || pending}
              onClick={submit}
              aria-label="开始任务"
            >
              {pending ? <RefreshCw className="da-spin" size={17} /> : <Send size={17} />}
            </button>
          </div>
        </div>
        {error && <div className="da-inline-error">{error}</div>}
      </div>
    </section>
  );
}

function DataAgentCapabilities({
  tab,
  skillName,
  projects,
  selectedProject,
  onSelectWorkspace,
  onNavigate,
  onExpertCreated,
}: {
  tab: CapabilityTab;
  skillName?: string;
  projects: Project[];
  selectedProject: Project | null;
  onSelectWorkspace: (project: Project) => void;
  onNavigate: (path: string) => void;
  onExpertCreated: (project: Project) => Promise<void>;
}) {
  const { currentTenant } = useTenant();
  const [connectorManagerOpen, setConnectorManagerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [capabilityFilter, setCapabilityFilter] = useState('全部');
  const [expertCategory, setExpertCategory] = useState('全部');
  const [summonTemplate, setSummonTemplate] = useState<AgentTemplateOption | null>(null);
  const [summonName, setSummonName] = useState('');
  const [summonBusy, setSummonBusy] = useState(false);
  const [summonError, setSummonError] = useState<string | null>(null);
  const [skillAction, setSkillAction] = useState<{ action: SkillMarketAction; name: string } | null>(null);
  const [skillActionError, setSkillActionError] = useState<string | null>(null);
  const [skillRemovalTarget, setSkillRemovalTarget] = useState<DataAgentMarketSkill | null>(null);
  const [skillMutationVersion, setSkillMutationVersion] = useState(0);
  const templateState = useDataAgentTemplates(currentTenant?.id);
  const skillState = useDataAgentSkillMarket(selectedProject?.workspaceId);
  const connectorState = useWorkspaceMcpTools(selectedProject?.workspaceId);

  useEffect(() => {
    setConnectorManagerOpen(false);
    setQuery('');
    setCapabilityFilter('全部');
    setExpertCategory('全部');
    setSummonTemplate(null);
    setSummonName('');
    setSummonError(null);
    setSkillAction(null);
    setSkillActionError(null);
    setSkillRemovalTarget(null);
  }, [selectedProject?.workspaceId, tab]);

  const normalizedQuery = query.trim().toLowerCase();
  const expertCategories = useMemo(() => {
    const counts = new Map<string, number>();
    templateState.templates.forEach((template) => {
      const category = template.category?.trim() || '未分类';
      counts.set(category, (counts.get(category) || 0) + 1);
    });
    return [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
      .map(([name, count]) => ({ name, count }));
  }, [templateState.templates]);

  useEffect(() => {
    if (expertCategory !== '全部' && !expertCategories.some((category) => category.name === expertCategory)) {
      setExpertCategory('全部');
    }
  }, [expertCategories, expertCategory]);

  const visibleTemplates = templateState.templates.filter((template) => {
    const category = template.category?.trim() || '未分类';
    const matchesCategory = expertCategory === '全部' || category === expertCategory;
    const matchesQuery = !normalizedQuery || [
      template.name,
      category,
      template.summary,
      ...template.skills.map((skill) => skill.name),
      ...template.mcps.map((mcp) => mcp.name),
    ].filter(Boolean).join(' ').toLowerCase().includes(normalizedQuery);
    return matchesCategory && matchesQuery;
  });
  const skills = skillState.skills;
  const visibleSkills = skills.filter((skill) => {
    const matchesQuery = !normalizedQuery || [
      skill.name,
      skill.displayName,
      skill.description,
      skill.sourceType,
    ].filter(Boolean).join(' ').toLowerCase().includes(normalizedQuery);
    const matchesFilter = capabilityFilter === '全部'
      || (capabilityFilter === '已安装' && skill.enabled)
      || (capabilityFilter === '未安装' && !skill.enabled);
    return matchesQuery && matchesFilter;
  });
  const selectedSkill = skillName
    ? skills.find((skill) => skill.name === skillName) || null
    : null;
  const showingSkillDetail = tab === 'skills' && Boolean(skillName);
  const presets = connectorState.data?.presets ?? [];
  const visiblePresets = presets.filter((preset) => {
    const matchesQuery = !normalizedQuery || [
      preset.name,
      preset.displayName,
      preset.description,
      ...(preset.tools ?? []).map((tool) => tool.name),
    ].filter(Boolean).join(' ').toLowerCase().includes(normalizedQuery);
    const matchesFilter = capabilityFilter === '全部'
      || (capabilityFilter === '已连接' && preset.installed)
      || (capabilityFilter === '未连接' && !preset.installed);
    return matchesQuery && matchesFilter;
  });

  const runSkillMarketAction = async (skill: DataAgentMarketSkill, action: SkillMarketAction) => {
    const workspaceId = selectedProject?.workspaceId;
    if (!workspaceId || skillAction) return false;
    setSkillAction({ action, name: skill.name });
    setSkillActionError(null);
    try {
      const response = action === 'import'
        ? await api.skillMarket.importSkill(workspaceId, skill.name)
        : action === 'update'
          ? await api.skillMarket.updateImport(workspaceId, skill.name)
          : await api.skillMarket.remove(workspaceId, skill.name);
      const payload = await readSkillResponse(
        response,
        action === 'import' ? '技能导入失败。' : action === 'update' ? '技能更新失败。' : '技能移除失败。',
      );
      const changedSkillName = payload.skill?.name || skill.name;
      const changedPath = `.claude/skills/${changedSkillName}`;
      const reason = `skill-market-${action}`;
      dispatchProjectFilesChanged({
        projectName: selectedProject.name,
        workspaceId,
        changedPath,
        reason,
      });
      dispatchSlashCommandsChangedForPath(changedPath, {
        projectName: selectedProject.name,
        workspaceId,
        reason,
      });
      await skillState.reload();
      setSkillMutationVersion((version) => version + 1);
      return true;
    } catch (actionError) {
      setSkillActionError(actionError instanceof Error ? actionError.message : '技能操作失败。');
      return false;
    } finally {
      setSkillAction(null);
    }
  };

  const requestSkillMarketAction = (skill: DataAgentMarketSkill, action: SkillMarketAction) => {
    if (action === 'remove') {
      setSkillRemovalTarget(skill);
      return;
    }
    void runSkillMarketAction(skill, action);
  };

  const confirmSkillRemoval = async () => {
    if (!skillRemovalTarget) return;
    const removed = await runSkillMarketAction(skillRemovalTarget, 'remove');
    if (removed) setSkillRemovalTarget(null);
  };

  const openSummonDialog = (template: AgentTemplateOption) => {
    setSummonTemplate(template);
    setSummonName('');
    setSummonError(null);
  };

  const summonExpert = async () => {
    if (!summonTemplate || summonBusy) return;
    const expertName = summonName.trim();
    if (!expertName) {
      setSummonError('请为专家起一个名字。');
      return;
    }
    if (currentTenant?.permission !== 'edit') {
      setSummonError('当前租户为只读，无法召唤专家。');
      return;
    }

    setSummonBusy(true);
    setSummonError(null);
    try {
      const created = await createWorkspaceRequest({
        workspaceType: 'new',
        path: expertName,
        templateId: summonTemplate.id,
      });
      if (!created) throw new Error('专家创建成功，但未返回专家信息。');
      await onExpertCreated(created as unknown as Project);
      setSummonTemplate(null);
      setSummonName('');
    } catch (createError) {
      setSummonError(createError instanceof Error ? createError.message : '召唤专家失败。');
    } finally {
      setSummonBusy(false);
    }
  };

  const introTitle = tab === 'experts'
    ? '选择并召唤专家'
    : showingSkillDetail ? '技能详情' : tab === 'skills' ? '专家技能市场' : '管理专家连接器';
  const introDescription = tab === 'experts'
    ? `浏览 ${currentTenant?.name || '当前租户'} 可用的专家；召唤后会创建一个独立专家。`
    : showingSkillDetail
      ? '查看技能说明与文件内容。'
      : tab === 'skills'
      ? `浏览技能市场，并查看 ${getWorkspaceLabel(selectedProject)} 的安装状态。`
      : `管理 ${getWorkspaceLabel(selectedProject)} 使用的 MCP Servers、Tools 与预设。`;

  return (
    <section className="da-page">
      <DataAgentPageHeader
        title="专家 · 技能 · 连接器"
        subtitle={tab === 'experts' ? '创建和管理当前租户的专家' : '按专家管理 DataAgent 能力'}
        projects={projects}
        selectedProject={selectedProject}
        onSelectWorkspace={onSelectWorkspace}
        showWorkspace={tab !== 'experts'}
        workspaceLabel="专家"
      />
      <div className="da-capability-page">
        <div className="da-content-inner">
          <div className="da-capability-intro">
            <div>
              <h1>{introTitle}</h1>
              <p>{introDescription}</p>
            </div>
            {tab === 'connectors' && <button className="da-secondary-button da-intro-action" type="button" onClick={() => setConnectorManagerOpen(true)}><Server size={14} />MCP 预设</button>}
          </div>
          <div className="da-tabs" role="tablist">
            <button className={tab === 'experts' ? 'is-active' : ''} onClick={() => onNavigate('/data-agent/capabilities/experts')}>专家</button>
            <button className={tab === 'skills' ? 'is-active' : ''} onClick={() => onNavigate('/data-agent/capabilities/skills')}>技能</button>
            <button className={tab === 'connectors' ? 'is-active' : ''} onClick={() => onNavigate('/data-agent/capabilities/connectors')}>连接器</button>
          </div>
          {skillActionError && tab === 'skills' && <div className="da-inline-error da-capability-action-error">{skillActionError}<button type="button" onClick={() => setSkillActionError(null)} aria-label="关闭错误"><X size={13} /></button></div>}

          {!selectedProject && tab !== 'experts' && <DataAgentEmpty title="选择一个专家" description="能力配置需要绑定到具体专家。" />}
          {(tab === 'experts' || selectedProject) && !showingSkillDetail && (
            <div className="da-capability-toolbar">
              <label className="da-search-box">
                <Search size={14} />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`搜索${tab === 'experts' ? '专家' : tab === 'skills' ? '技能' : '连接器'}`} />
              </label>
              {tab === 'skills' && (
                <select value={capabilityFilter} onChange={(event) => setCapabilityFilter(event.target.value)} aria-label="筛选技能安装状态">
                  <option>全部</option><option>已安装</option><option>未安装</option>
                </select>
              )}
              {tab === 'connectors' && (
                <select value={capabilityFilter} onChange={(event) => setCapabilityFilter(event.target.value)} aria-label="筛选连接状态">
                  <option>全部</option><option>已连接</option><option>未连接</option>
                </select>
              )}
              <span className="da-toolbar-count">
                {tab === 'experts' && `${visibleTemplates.length} 位可召唤专家`}
                {tab === 'skills' && `已安装 ${skills.filter((skill) => skill.enabled).length} / ${skills.length}`}
                {tab === 'connectors' && `已连接 ${presets.filter((preset) => preset.installed).length} / ${presets.length}`}
              </span>
            </div>
          )}

          {tab === 'experts' && !templateState.isLoading && !templateState.error && templateState.templates.length > 0 && (
            <div className="da-expert-category-filter" role="group" aria-label="按分类筛选专家">
              <button
                type="button"
                className={expertCategory === '全部' ? 'is-active' : ''}
                aria-pressed={expertCategory === '全部'}
                aria-label={`全部，${templateState.templates.length} 位专家`}
                title={`${templateState.templates.length} 位专家`}
                onClick={() => setExpertCategory('全部')}
              >
                全部
              </button>
              {expertCategories.map((category) => (
                <button
                  key={category.name}
                  type="button"
                  className={expertCategory === category.name ? 'is-active' : ''}
                  aria-pressed={expertCategory === category.name}
                  aria-label={`${category.name}，${category.count} 位专家`}
                  title={`${category.count} 位专家`}
                  onClick={() => setExpertCategory(category.name)}
                >
                  {category.name}
                </button>
              ))}
            </div>
          )}

          {tab === 'experts' && (
            <div className="da-capability-body">
              {templateState.isLoading ? <DataAgentLoading label="正在加载专家…" /> : templateState.error ? (
                  <DataAgentEmpty title="专家加载失败" description={templateState.error} action={<button className="da-secondary-button" onClick={() => void templateState.reload()}>重试</button>} />
                ) : visibleTemplates.length ? (
                  <div className="da-card-grid">
                    {visibleTemplates.map((template) => {
                      const templateProjects = projects.filter((project) => project.agentTemplate?.id === template.id);
                      const category = template.category?.trim() || '未分类';
                      return (
                        <article className="da-capability-card da-expert-card" key={template.id}>
                          <div className="da-card-title-row"><span className="da-card-icon purple"><Bot size={18} /></span><div><div className="da-expert-card-title-line"><h2 title={template.name}>{template.name}</h2><span className="da-expert-category-badge" title={category}>{category}</span></div><p title={`专家能力 · ${template.skills.length} 个技能 · ${template.mcps.length} 个连接器`}>专家能力 · {template.skills.length} 技能 · {template.mcps.length} 连接器</p></div></div>
                          <p className="da-card-description" title={template.summary || '可召唤为独立专家，并在专属空间中持续对话。'}>{template.summary || '可召唤为独立专家，并在专属空间中持续对话。'}</p>
                          <div className="da-card-footer da-expert-card-footer">
                            <span>已召唤 {templateProjects.length} 位专家</span>
                            <button className="da-primary-button da-small-button" type="button" disabled={currentTenant?.permission !== 'edit'} title={currentTenant?.permission === 'edit' ? '召唤此专家' : '当前租户为只读'} onClick={() => openSummonDialog(template)}><WandSparkles size={13} />召唤</button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ) : <DataAgentEmpty title={normalizedQuery || expertCategory !== '全部' ? '没有匹配的专家' : '还没有可用的专家'} description={expertCategory !== '全部' ? '当前分类下没有符合搜索条件的专家，请调整关键词或切换分类。' : normalizedQuery ? '尝试使用其他关键词搜索。' : '请联系管理员为当前租户配置专家。'} />}
            </div>
          )}

          {selectedProject && tab === 'skills' && (
            showingSkillDetail ? (
              <WorkspaceSkillDetail
                workspaceId={selectedProject.workspaceId}
                requestedName={skillName}
                skill={selectedSkill}
                loading={skillState.isLoading}
                error={skillState.error}
                actionVersion={skillMutationVersion}
                actionBusy={skillAction?.name === (selectedSkill?.name || skillName)}
                onBack={() => onNavigate('/data-agent/capabilities/skills')}
                onAction={requestSkillMarketAction}
                onReload={skillState.reload}
              />
            ) : (
              <CapabilityCardsState loading={skillState.isLoading} error={skillState.error} emptyTitle={query ? '没有匹配的技能' : '当前专家还没有技能'} onReload={skillState.reload}>
                {visibleSkills.map((skill) => (
                  <WorkspaceSkillCard
                    key={`${skill.kind}:${skill.name}`}
                    skill={skill}
                    busy={skillAction?.name === skill.name}
                    onAction={requestSkillMarketAction}
                    onDetails={() => onNavigate(`/data-agent/capabilities/skills/${encodeURIComponent(skill.name)}`)}
                  />
                ))}
              </CapabilityCardsState>
            )
          )}

          {selectedProject && tab === 'connectors' && (
            <CapabilityCardsState loading={connectorState.isLoading} error={connectorState.error} emptyTitle={query ? '没有匹配的连接器' : '当前专家还没有连接器预设'} onReload={connectorState.reload}>
              {visiblePresets.map((preset) => (
                <WorkspaceConnectorCard
                  key={preset.id}
                  preset={preset}
                  busy={connectorState.installingPresetIds.has(preset.id) || connectorState.removingPresetIds.has(preset.id)}
                  canManage={selectedProject.accessRole !== 'view' && connectorState.data?.canManage !== false}
                  onManage={() => setConnectorManagerOpen(true)}
                  onToggle={() => {
                    const action = preset.installed ? connectorState.removePreset(preset.id) : connectorState.installPreset(preset.id);
                    void action.catch(() => undefined);
                  }}
                />
              ))}
            </CapabilityCardsState>
          )}
        </div>
      </div>
      {connectorManagerOpen && selectedProject && (
        <div className="da-modal-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setConnectorManagerOpen(false); }}>
          <section className="da-manager-modal" role="dialog" aria-modal="true" aria-label="管理专家连接器">
            <header><div><strong>管理专家连接器</strong><span>{getWorkspaceLabel(selectedProject)}</span></div><button type="button" className="da-icon-button" onClick={() => setConnectorManagerOpen(false)} aria-label="关闭"><X size={16} /></button></header>
            <div className="da-manager-body">
              <McpToolsPanel selectedProject={selectedProject} isReadOnly={selectedProject.accessRole === 'view'} />
            </div>
          </section>
        </div>
      )}
      {summonTemplate && (
        <ExpertSummonDialog
          template={summonTemplate}
          name={summonName}
          busy={summonBusy}
          error={summonError}
          projects={projects.filter((project) => project.agentTemplate?.id === summonTemplate.id)}
          onNameChange={setSummonName}
          onClose={() => { if (!summonBusy) setSummonTemplate(null); }}
          onSubmit={() => void summonExpert()}
          onOpenSession={(project, sessionId) => {
            onSelectWorkspace(project);
            setSummonTemplate(null);
            onNavigate(`/data-agent/session/${encodeURIComponent(sessionId)}`);
          }}
          onStartConversation={(project) => {
            onSelectWorkspace(project);
            setSummonTemplate(null);
            onNavigate('/data-agent/new');
          }}
        />
      )}
      {skillRemovalTarget && (
        <RemovalConfirmDialog
          busy={skillAction?.action === 'remove' && skillAction.name === skillRemovalTarget.name}
          onCancel={() => { if (!skillAction) setSkillRemovalTarget(null); }}
          onConfirm={() => void confirmSkillRemoval()}
          target={{
            title: '移除技能',
            description: '这会从当前专家移除已导入的技能，技能市场中的远程内容不会被删除。',
            path: `.claude/skills/${skillRemovalTarget.name}`,
          }}
        />
      )}
    </section>
  );
}

function ExpertSummonDialog({
  template,
  name,
  busy,
  error,
  projects,
  onNameChange,
  onClose,
  onSubmit,
  onOpenSession,
  onStartConversation,
}: {
  template: AgentTemplateOption;
  name: string;
  busy: boolean;
  error: string | null;
  projects: Project[];
  onNameChange: (name: string) => void;
  onClose: () => void;
  onSubmit: () => void;
  onOpenSession: (project: Project, sessionId: string) => void;
  onStartConversation: (project: Project) => void;
}) {
  return (
    <div className="da-modal-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section className="da-manager-modal da-expert-summon-modal" role="dialog" aria-modal="true" aria-labelledby="da-expert-summon-title">
        <header>
          <div className="da-expert-dialog-title">
            <span className="da-card-icon purple"><Bot size={17} /></span>
            <div><strong id="da-expert-summon-title">{template.name}</strong><span>召唤专家，或继续已有对话</span></div>
          </div>
          <button type="button" className="da-icon-button" onClick={onClose} disabled={busy} aria-label="关闭"><X size={16} /></button>
        </header>
        <div className="da-expert-dialog-body">
          <form className="da-expert-summon-form" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
            <div className="da-expert-create-copy">
              <span>召唤专家</span>
              <h2>给专家起个别名</h2>
              <p>{template.summary || '创建一个独立专家空间，用于持续处理同类任务和对话。'}</p>
            </div>
            <label htmlFor="da-expert-name">专家别名</label>
            <input
              id="da-expert-name"
              autoFocus
              value={name}
              onChange={(event) => onNameChange(event.target.value)}
              placeholder="例如：数据分析顾问"
              disabled={busy}
            />
            <p className="da-expert-name-help">创建后可在右侧继续对话，也会出现在任务列表中。</p>
            {error && <div className="da-inline-error" role="alert">{error}</div>}
            <button type="submit" className="da-primary-button da-expert-submit" disabled={busy || !name.trim()}>
              {busy ? <RefreshCw className="da-spin" size={14} /> : <WandSparkles size={14} />}
              {busy ? '正在召唤…' : '召唤专家'}
            </button>
          </form>
          <ExpertHistoryList
            projects={projects}
            onOpenSession={onOpenSession}
            onStartConversation={onStartConversation}
          />
        </div>
      </section>
    </div>
  );
}

function ExpertHistoryList({
  projects,
  onOpenSession,
  onStartConversation,
}: {
  projects: Project[];
  onOpenSession: (project: Project, sessionId: string) => void;
  onStartConversation: (project: Project) => void;
}) {
  const conversationCount = projects.reduce((count, project) => count + getProjectSessions(project).length, 0);

  return (
    <section className="da-expert-history-section" aria-labelledby="da-expert-history-title">
      <div className="da-expert-history-section-title">
        <div><strong id="da-expert-history-title">已召唤专家</strong><span>选择专家继续工作</span></div>
        <span>{projects.length ? `${projects.length} 位 · ${conversationCount} 个对话` : '尚未召唤'}</span>
      </div>
      <div className="da-expert-history-body">
          {projects.length ? projects.map((project) => {
            const sessions = getProjectSessions(project);
            return (
              <section className="da-expert-history-group" key={`${project.workspaceId ?? 'local'}:${project.name}`}>
                <div className="da-expert-history-heading">
                  <div><span className="da-project-mark">{getWorkspaceLabel(project).slice(0, 1).toUpperCase()}</span><div><strong>{getWorkspaceLabel(project)}</strong><small>{sessions.length} 个对话</small></div></div>
                  <button type="button" className="da-secondary-button da-small-button" onClick={() => onStartConversation(project)}><MessageSquarePlus size={13} />新对话</button>
                </div>
                {sessions.length ? (
                  <div className="da-expert-history-sessions">
                    {sessions.map((session) => (
                      <button type="button" key={`${session.__provider}:${session.id}`} onClick={() => onOpenSession(project, session.id)}>
                        <span className="da-status-dot is-idle" />
                        <span>{getSessionLabel(session)}</span>
                        <small>{formatRelativeTime(String(session.updated_at || session.lastActivity || session.created_at || session.createdAt || ''))}</small>
                        <ChevronRight size={14} />
                      </button>
                    ))}
                  </div>
                ) : <div className="da-expert-history-empty">还没有对话，可以从这里开始第一次交流。</div>}
              </section>
            );
          }) : (
            <div className="da-expert-history-zero">
              <span><Bot size={19} /></span>
              <strong>还没有已召唤的专家</strong>
              <p>在左侧完成命名并召唤后，可以从这里继续对话。</p>
            </div>
          )}
      </div>
    </section>
  );
}

function CapabilityCardsState({
  loading,
  error,
  emptyTitle,
  onReload,
  children,
}: {
  loading: boolean;
  error: string | null;
  emptyTitle: string;
  onReload: () => void;
  children: React.ReactNode;
}) {
  const items = React.Children.toArray(children);
  if (loading) return <DataAgentLoading label="正在加载专家能力…" />;
  if (error) return <DataAgentEmpty title="能力加载失败" description={error} action={<button className="da-secondary-button" onClick={onReload}>重试</button>} />;
  if (!items.length) return <DataAgentEmpty title={emptyTitle} description="可以调整筛选条件，或打开管理面板安装专家能力。" />;
  return <div className="da-card-grid da-capability-body">{items}</div>;
}

function WorkspaceSkillCard({
  skill,
  busy,
  onAction,
  onDetails,
}: {
  skill: DataAgentMarketSkill;
  busy: boolean;
  onAction: (skill: DataAgentMarketSkill, action: SkillMarketAction) => void;
  onDetails: () => void;
}) {
  return (
    <article className="da-capability-card">
      <div className="da-card-title-row">
        <span className="da-card-icon blue"><Sparkles size={18} /></span>
        <div><h2 title={getSkillDisplayName(skill)}>{getSkillDisplayName(skill)}</h2><p title={`/${skill.name}`}>/{skill.name}</p></div>
      </div>
      <p className="da-card-description" title={skill.description || '由技能市场提供的可复用技能。'}>{skill.description || '由技能市场提供的可复用技能。'}</p>
      <div className="da-card-footer da-card-actions-footer">
        <SkillMarketActionButtons skill={skill} busy={busy} compact onAction={onAction} />
        <button className="da-secondary-button da-small-button" onClick={onDetails}>详情</button>
      </div>
    </article>
  );
}

function SkillMarketActionButtons({
  skill,
  busy,
  compact = false,
  onAction,
}: {
  skill: DataAgentMarketSkill;
  busy: boolean;
  compact?: boolean;
  onAction: (skill: DataAgentMarketSkill, action: SkillMarketAction) => void;
}) {
  const buttonClass = compact ? 'da-small-button' : '';
  const disabled = busy || !skill.manageable;

  return (
    <div className="da-skill-action-buttons">
      {!skill.imported && !skill.remoteDeleted && (
        <button type="button" className={`da-primary-button ${buttonClass}`} disabled={disabled || skill.conflict} onClick={() => onAction(skill, 'import')}>{busy ? '处理中' : '导入'}</button>
      )}
      {skill.imported && skill.updateAvailable && !skill.remoteDeleted && (
        <button type="button" className={`da-primary-button ${buttonClass}`} disabled={disabled} onClick={() => onAction(skill, 'update')}>{busy ? '处理中' : '更新'}</button>
      )}
      {skill.imported && (
        <button type="button" className={`da-secondary-button da-danger-button ${buttonClass}`} disabled={disabled} onClick={() => onAction(skill, 'remove')}>{busy ? '处理中' : '移除'}</button>
      )}
    </div>
  );
}

function WorkspaceSkillDetail({
  workspaceId,
  requestedName,
  skill,
  loading,
  error,
  actionBusy,
  actionVersion,
  onBack,
  onAction,
  onReload,
}: {
  workspaceId?: number;
  requestedName?: string;
  skill: DataAgentMarketSkill | null;
  loading: boolean;
  error: string | null;
  actionBusy: boolean;
  actionVersion: number;
  onBack: () => void;
  onAction: (skill: DataAgentMarketSkill, action: SkillMarketAction) => void;
  onReload: () => void;
}) {
  const skillName = skill?.name || requestedName;
  const [detail, setDetail] = useState<DataAgentMarketSkill | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedEntryPath, setSelectedEntryPath] = useState<string | null>(null);
  const [file, setFile] = useState<WorkspaceSkillFile | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState(true);
  const [reloadVersion, setReloadVersion] = useState(0);
  const detailRequestRef = useRef(0);
  const fileRequestRef = useRef(0);

  const loadFile = useCallback(async (filePath: string) => {
    if (!workspaceId || !skillName) return;
    const requestId = ++fileRequestRef.current;
    setSelectedFilePath(filePath);
    setSelectedEntryPath(filePath);
    setPreviewMode(isSkillMarkdownFile(filePath));
    setFileLoading(true);
    setFileError(null);
    try {
      const payload = await readSkillResponse(
        await api.skillMarket.file(workspaceId, skillName, filePath),
        '技能文件加载失败。',
      );
      if (requestId !== fileRequestRef.current) return;
      setFile((payload.file ?? payload) as WorkspaceSkillFile);
    } catch (fileLoadError) {
      if (requestId !== fileRequestRef.current) return;
      setFile(null);
      setFileError(fileLoadError instanceof Error ? fileLoadError.message : '技能文件加载失败。');
    } finally {
      if (requestId === fileRequestRef.current) setFileLoading(false);
    }
  }, [skillName, workspaceId]);

  useEffect(() => {
    const requestId = ++detailRequestRef.current;
    fileRequestRef.current += 1;
    setDetail(null);
    setDetailError(null);
    setSelectedFilePath(null);
    setSelectedEntryPath(null);
    setFile(null);
    setFileError(null);

    if (!workspaceId || !skillName) {
      setDetailLoading(false);
      setFileLoading(false);
      return undefined;
    }

    setDetailLoading(true);
    void (async () => {
      try {
        const payload = await readSkillResponse(
          await api.skillMarket.detail(workspaceId, skillName),
          '技能详情加载失败。',
        );
        if (requestId !== detailRequestRef.current) return;
        const nextDetail = normalizeSkillMarketEntry(
          (payload.skill ?? payload) as SkillMarketEntry,
          payload.canManage !== false,
        );
        setDetail(nextDetail);
        const initialFile = findSkillPreviewFile(nextDetail.files ?? []);
        if (initialFile) void loadFile(initialFile.path);
      } catch (detailLoadError) {
        if (requestId !== detailRequestRef.current) return;
        setDetailError(detailLoadError instanceof Error ? detailLoadError.message : '技能详情加载失败。');
        const fallbackFile = findSkillPreviewFile(skill?.files ?? []);
        if (fallbackFile) void loadFile(fallbackFile.path);
      } finally {
        if (requestId === detailRequestRef.current) setDetailLoading(false);
      }
    })();

    return () => {
      if (requestId === detailRequestRef.current) detailRequestRef.current += 1;
      fileRequestRef.current += 1;
    };
  }, [actionVersion, loadFile, reloadVersion, skill, skillName, workspaceId]);

  const reloadDetail = () => {
    onReload();
    setReloadVersion((version) => version + 1);
  };

  const resolvedSkill = detail ?? skill;
  if (!resolvedSkill) {
    if (loading || detailLoading) return <DataAgentLoading label="正在从技能市场加载详情…" />;
    if (detailError || error) return <DataAgentEmpty title="技能详情加载失败" description={detailError || error || '技能详情加载失败。'} action={<button className="da-secondary-button" onClick={reloadDetail}>重试</button>} />;
    return <DataAgentEmpty title="找不到该技能" description="该技能可能已从技能市场移除。" action={<button className="da-secondary-button" onClick={onBack}>返回技能列表</button>} />;
  }

  const skillFiles = resolvedSkill.files ?? [];

  return (
    <div className="da-skill-detail">
      <button type="button" className="da-detail-back" onClick={onBack}><ArrowLeft size={15} />返回技能列表</button>
      <article className="da-skill-detail-card">
        <div className="da-skill-detail-hero">
          <span className="da-card-icon blue"><Sparkles size={20} /></span>
          <div>
            <h2>{getSkillDisplayName(resolvedSkill)}</h2>
            <p>/{resolvedSkill.name}</p>
          </div>
          <div className="da-skill-detail-header-actions">
            <SkillMarketActionButtons skill={resolvedSkill} busy={actionBusy} onAction={onAction} />
          </div>
        </div>
        <p className="da-skill-detail-description">{resolvedSkill.description || '由技能市场提供的可复用技能。'}</p>

        {detailError && <div className="da-skill-detail-warning"><strong>完整详情加载失败</strong><span>{detailError}</span><button type="button" onClick={reloadDetail}>重新加载</button></div>}

        <section className="da-skill-detail-section da-skill-content-section">
          <h3>技能内容 <span>{skillFiles.filter((entry) => entry.type === 'file').length} 个文件</span></h3>
          {detailLoading && !skillFiles.length ? <DataAgentLoading label="正在读取技能内容…" /> : skillFiles.length ? (
            <div className="da-skill-preview-layout">
              <SkillFileTree
                busy={fileLoading}
                editable={false}
                entries={skillFiles}
                onCreateEntry={async () => false}
                onMoveEntry={async () => false}
                onRenameEntry={async () => false}
                onRequestRemove={() => undefined}
                onSelectEntry={setSelectedEntryPath}
                onSelectFile={(filePath) => void loadFile(filePath)}
                selectedEntryPath={selectedEntryPath}
                targetPath={resolvedSkill.targetPath || resolvedSkill.runtimePath || `.claude/skills/${resolvedSkill.name}`}
                treeKey={`${workspaceId}:${resolvedSkill.name}`}
              />
              <div className="da-skill-file-viewer">
                <header>
                  <span>{selectedFilePath || '选择文件查看内容'}</span>
                  {selectedFilePath && isSkillMarkdownFile(selectedFilePath) && !file?.isBinary && (
                    <div className="da-skill-preview-toggle" role="group" aria-label="切换技能文件显示方式">
                      <button type="button" className={previewMode ? 'is-active' : ''} onClick={() => setPreviewMode(true)}>预览</button>
                      <button type="button" className={!previewMode ? 'is-active' : ''} onClick={() => setPreviewMode(false)}>源码</button>
                    </div>
                  )}
                </header>
                <div className="da-skill-file-content">
                  {fileLoading ? <DataAgentLoading label="正在加载文件…" /> : fileError ? (
                    <DataAgentEmpty title="文件加载失败" description={fileError} action={selectedFilePath ? <button className="da-secondary-button" onClick={() => void loadFile(selectedFilePath)}>重试</button> : undefined} />
                  ) : file ? (
                    <WorkspaceSkillFilePreview
                      file={file}
                      files={skillFiles}
                      onSelectFile={(filePath) => void loadFile(filePath)}
                      previewMode={previewMode}
                    />
                  ) : <div className="da-skill-file-empty"><FileText size={20} /><span>从左侧选择文件查看内容</span></div>}
                </div>
              </div>
            </div>
          ) : <p className="da-skill-detail-empty">当前技能没有可预览的文件。</p>}
        </section>
      </article>
    </div>
  );
}

function WorkspaceSkillFilePreview({ file, files, onSelectFile, previewMode }: { file: WorkspaceSkillFile; files: WorkspaceSkillEntry[]; onSelectFile: (filePath: string) => void; previewMode: boolean }) {
  if (file.isBinary) {
    if (file.mimeType?.startsWith('image/') && file.contentBase64) {
      return <div className="da-skill-image-preview"><img src={`data:${file.mimeType};base64,${file.contentBase64}`} alt={file.path} /></div>;
    }
    return <div className="da-skill-file-empty"><FileText size={20} /><span>该二进制文件暂不支持预览</span></div>;
  }

  const content = file.content ?? '';
  if (previewMode && isSkillMarkdownFile(file.path)) {
    return (
      <div className="da-skill-markdown-preview prose prose-sm dark:prose-invert">
        <MarkdownPreview
          content={content}
          resolveLink={(href) => resolveSkillFileLink(href, file.path, files)}
          onResolvedLinkClick={onSelectFile}
        />
      </div>
    );
  }
  return <pre className="da-skill-source-preview"><code>{content}</code></pre>;
}

function findSkillPreviewFile(files: WorkspaceSkillEntry[]) {
  const fileEntries = files.filter((entry) => entry.type === 'file');
  return fileEntries.find((entry) => entry.path === 'SKILL.md') ?? fileEntries[0];
}

function isSkillMarkdownFile(filePath: string) {
  return /\.md(?:own)?$/i.test(filePath);
}

async function readSkillResponse(response: Response, fallback: string) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || fallback);
  return payload;
}

function WorkspaceConnectorCard({
  preset,
  busy,
  canManage,
  onManage,
  onToggle,
}: {
  preset: WorkspaceMcpPreset;
  busy: boolean;
  canManage: boolean;
  onManage: () => void;
  onToggle: () => void;
}) {
  return (
    <article className="da-capability-card">
      <div className="da-card-title-row">
        <span className="da-card-icon green"><Plug size={18} /></span>
        <div><h2 title={preset.displayName || preset.name}>{preset.displayName || preset.name}</h2><p title={`MCP · ${preset.toolCount} 个工具`}>MCP · {preset.toolCount} 个工具</p></div>
      </div>
      <p className="da-card-description" title={preset.description || '为当前专家提供 MCP 工具。'}>{preset.description || '为当前专家提供 MCP 工具。'}</p>
      <div className="da-card-footer">
        <span>{preset.lastTestedAt ? `最近测试 ${formatRelativeTime(preset.lastTestedAt)}` : '尚未测试'}</span>
        <button className="da-secondary-button da-small-button" onClick={onManage}>工具列表</button>
        {canManage && <button className={preset.installed ? 'da-secondary-button da-small-button' : 'da-primary-button da-small-button'} disabled={busy} onClick={onToggle}>{busy ? '处理中' : preset.installed ? '断开' : '连接'}</button>}
      </div>
    </article>
  );
}

function DataAgentAutomation({
  projects,
  selectedProject,
  onSelectWorkspace,
  onNavigate,
}: {
  projects: Project[];
  selectedProject: Project | null;
  onSelectWorkspace: (project: Project) => void;
  onNavigate: (path: string) => void;
}) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'enabled' | 'paused' | 'failed'>('all');
  const [dialog, setDialog] = useState<{ taskId?: number; provider: LLMProvider; mode: 'create' | 'manage' } | null>(null);

  const loadTasks = useCallback(async () => {
    if (!selectedProject?.workspaceId) {
      setTasks([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await api.scheduledTasks.list(selectedProject.workspaceId);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || '无法加载自动化');
      setTasks(payload.tasks || []);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : '无法加载自动化');
    } finally {
      setLoading(false);
    }
  }, [selectedProject?.workspaceId]);

  useEffect(() => { void loadTasks(); }, [loadTasks]);

  const visibleTasks = tasks.filter((task) => {
    if (filter === 'all') return true;
    if (filter === 'enabled') return task.enabled && !task.lastError;
    if (filter === 'paused') return !task.enabled;
    return Boolean(task.lastError);
  });

  const toggleTask = async (task: ScheduledTask) => {
    setError(null);
    try {
      const response = await api.scheduledTasks.update(task.id, { enabled: !task.enabled });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || '更新自动化失败');
      await loadTasks();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : '更新自动化失败');
    }
  };

  return (
    <section className="da-page">
      <DataAgentPageHeader
        title="自动化"
        subtitle="按专家管理 Scheduled Tasks"
        projects={projects}
        selectedProject={selectedProject}
        onSelectWorkspace={onSelectWorkspace}
        action={selectedProject && selectedProject.accessRole !== 'view' ? (
          <button className="da-primary-button" type="button" onClick={() => setDialog({ provider: 'claude', mode: 'create' })}><MessageSquarePlus size={15} />创建自动化</button>
        ) : undefined}
      />
      <div className="da-standard-content">
        <div className="da-content-inner">
          <div className="da-content-heading">
            <div><h1>让重复任务按计划运行</h1><p>当前查看 {getWorkspaceLabel(selectedProject)} 的自动化；运行会话仍在该专家的任务历史中查看。</p></div>
          </div>
          <div className="da-automation-toolbar">
            {([['all', '全部'], ['enabled', '已启用'], ['paused', '已暂停'], ['failed', '失败']] as const).map(([value, label]) => (
              <button key={value} type="button" className={filter === value ? 'is-active' : ''} onClick={() => setFilter(value)}>{label}</button>
            ))}
            <span>{visibleTasks.length} / {tasks.length} 个自动化</span>
          </div>
          {error && <div className="da-inline-error">{error}</div>}
          {loading ? <DataAgentLoading label="正在加载自动化…" /> : !selectedProject ? (
            <DataAgentEmpty title="选择一个专家" description="自动化按专家隔离管理。" />
          ) : (
            <div className="da-automation-list">
              {visibleTasks.length ? visibleTasks.map((task) => (
                <article className="da-automation-row" key={task.id}>
                  <div className="da-automation-name">
                    <span className="da-automation-icon"><CalendarClock size={15} /></span>
                    <span><strong>{task.name}</strong><small>Scheduled Task · {getWorkspaceLabel(selectedProject)}</small></span>
                  </div>
                  <div className="da-automation-cell">
                    {task.scheduleType === 'cron' ? 'Cron 定时' : `每 ${task.intervalMinutes || 0} 分钟`}
                    <small>{task.scheduleType === 'cron' ? task.scheduleCron || '未配置' : task.provider}</small>
                  </div>
                  <div className="da-automation-cell">
                    <span className={`da-state-badge ${task.lastError ? 'is-failed' : task.enabled ? 'is-enabled' : 'is-paused'}`}>{task.lastError ? '失败' : task.enabled ? '已启用' : '已暂停'}</span>
                    <small>{task.lastRunAt ? formatRelativeTime(task.lastRunAt) : '尚未运行'}</small>
                  </div>
                  <div className="da-automation-actions">
                    {task.lastSessionId && <button type="button" className="da-icon-button" onClick={() => onNavigate(`/data-agent/session/${encodeURIComponent(task.lastSessionId || '')}`)} aria-label="查看最近结果"><FileText size={15} /></button>}
                    <button type="button" className="da-icon-button" onClick={() => setDialog({ taskId: task.id, provider: task.provider || 'claude', mode: 'manage' })} aria-label="编辑自动化"><Pencil size={15} /></button>
                    {selectedProject.accessRole !== 'view' && <button type="button" className={`da-switch ${task.enabled ? 'is-on' : ''}`} onClick={() => void toggleTask(task)} aria-label={task.enabled ? '暂停自动化' : '启用自动化'} aria-pressed={task.enabled} />}
                  </div>
                </article>
              )) : <div className="da-automation-empty"><DataAgentEmpty title={tasks.length ? '当前筛选下没有自动化' : '还没有自动化'} description={tasks.length ? '切换筛选条件查看其他自动化。' : '为当前专家创建第一个定时任务。'} action={!tasks.length && selectedProject.accessRole !== 'view' ? <button className="da-primary-button" onClick={() => setDialog({ provider: 'claude', mode: 'create' })}>创建自动化</button> : undefined} /></div>}
            </div>
          )}
        </div>
      </div>
      {dialog && selectedProject && (
        <ScheduledTasksDialog
          open
          selectedProject={selectedProject}
          provider={dialog.provider}
          initialTaskId={dialog.taskId ?? null}
          mode={dialog.mode === 'manage' ? 'manage' : 'create'}
          terminology="expert"
          onClose={() => { setDialog(null); void loadTasks(); }}
        />
      )}
    </section>
  );
}

function DataAgentFiles({
  projects,
  selectedProject,
  onSelectWorkspace,
  isMobile,
}: {
  projects: Project[];
  selectedProject: Project | null;
  onSelectWorkspace: (project: Project) => void;
  isMobile: boolean;
}) {
  if (selectedProject) {
    const workspaceKey = String(selectedProject.workspaceId ?? selectedProject.name ?? selectedProject.path);
    return (
      <DataAgentFilesWorkspace
        key={workspaceKey}
        projects={projects}
        selectedProject={selectedProject}
        onSelectWorkspace={onSelectWorkspace}
        isMobile={isMobile}
      />
    );
  }

  return (
    <section className="da-page">
      <DataAgentPageHeader title="文件" subtitle="浏览并编辑当前专家文件" projects={projects} selectedProject={selectedProject} onSelectWorkspace={onSelectWorkspace} />
      <DataAgentEmpty title="选择一个专家" description="文件浏览需要绑定到具体专家。" />
    </section>
  );
}

function DataAgentFilesWorkspace({
  projects,
  selectedProject,
  onSelectWorkspace,
  isMobile,
}: {
  projects: Project[];
  selectedProject: Project;
  onSelectWorkspace: (project: Project) => void;
  isMobile: boolean;
}) {
  const tabs = useFileEditorTabs(selectedProject);
  const split = useDataAgentFilesSplit();
  const [editorExpanded, setEditorExpanded] = useState(false);
  const isReadOnly = selectedProject.accessRole === 'view';

  useEffect(() => {
    if (!tabs.tabs.length) setEditorExpanded(false);
  }, [tabs.tabs.length]);

  const selectWorkspace = useCallback(async (project: Project) => {
    if (project.workspaceId === selectedProject.workspaceId && project.name === selectedProject.name) return;
    const saved = await tabs.beforeFileMutation(['/workspace']);
    if (saved) onSelectWorkspace(project);
  }, [onSelectWorkspace, selectedProject.name, selectedProject.workspaceId, tabs]);

  return (
    <section className="da-page">
      <DataAgentPageHeader
        title="文件"
        subtitle="浏览并编辑当前专家文件"
        projects={projects}
        selectedProject={selectedProject}
        onSelectWorkspace={(project) => void selectWorkspace(project)}
      />
      <div className="da-files-content">
        <div
          ref={split.containerRef}
          className={`da-files-layout ${tabs.activeTab ? 'has-editor' : ''} ${editorExpanded ? 'is-editor-expanded' : ''}`}
        >
          <div
            className={`da-file-tree ${editorExpanded ? 'is-hidden' : ''}`}
            style={!isMobile && !editorExpanded && split.paneWidth ? { width: split.paneWidth, flexBasis: split.paneWidth } : undefined}
          >
            <FileTree
              selectedProject={selectedProject}
              onFileOpen={tabs.openFile}
              activePath={tabs.activeTab?.displayPath}
              beforeFileMutation={tabs.beforeFileMutation}
              isReadOnly={isReadOnly}
              presentation="data-agent"
            />
          </div>
          {!isMobile && !editorExpanded && (
            <div
              className={`da-files-resizer ${split.isResizing ? 'is-resizing' : ''}`}
              onPointerDown={split.onResizeStart}
              role="separator"
              aria-orientation="vertical"
              aria-label="调整文件列表宽度"
            />
          )}
          <DataAgentFileTabs
            manager={tabs}
            project={selectedProject}
            isReadOnly={isReadOnly}
            isMobile={isMobile}
            expanded={editorExpanded}
            onToggleExpand={() => setEditorExpanded((current) => !current)}
          />
        </div>
      </div>
    </section>
  );
}

function DataAgentExistingWorkspacePanel({
  kind,
  projects,
  selectedProject,
  onSelectWorkspace,
}: {
  kind: 'codehub' | 'sql-check';
  projects: Project[];
  selectedProject: Project | null;
  onSelectWorkspace: (project: Project) => void;
}) {
  const editor = useEditorSidebar({ selectedProject, isMobile: false });
  const title = kind === 'codehub' ? 'CodeHub' : 'SQL Check';
  return (
    <section className="da-page">
      <DataAgentPageHeader title={title} subtitle={`复用既有 ${title} 专家能力`} projects={projects} selectedProject={selectedProject} onSelectWorkspace={onSelectWorkspace} />
      {!selectedProject ? <DataAgentEmpty title="选择一个专家" description={`${title} 需要绑定到具体专家。`} /> : (
        <div className="da-existing-tool-layout">
          <div className={editor.editorExpanded ? 'da-existing-tool is-hidden' : 'da-existing-tool'}>
            {kind === 'codehub' ? (
              <CodeHubPanel selectedProject={selectedProject} isReadOnly={selectedProject.accessRole === 'view'} onFileOpen={(path) => editor.handleFileOpen(path, null, 'files')} terminology="expert" />
            ) : <SqlCheckPanel selectedProject={selectedProject} />}
          </div>
          {kind === 'codehub' && (
            <EditorSidebar
              editingFile={editor.editingFile}
              isMobile={false}
              editorExpanded={editor.editorExpanded}
              editorWidth={editor.editorWidth}
              isResizing={editor.isResizing}
              hasManualWidth={editor.hasManualWidth}
              resizeHandleRef={editor.resizeHandleRef}
              onResizeStart={editor.handleResizeStart}
              onCloseEditor={editor.handleCloseEditor}
              onToggleEditorExpand={editor.handleToggleEditorExpand}
              projectPath={selectedProject.path}
              isReadOnly={selectedProject.accessRole === 'view'}
              fillSpace
              onOpenFile={(path) => editor.handleFileOpen(path, null, 'files')}
            />
          )}
        </div>
      )}
    </section>
  );
}

function DataAgentConversation({
  selectedProject,
  selectedSession,
  projects,
  onSelectWorkspace,
  ws,
  sendMessage,
  latestMessage,
  isMobile,
  processingSessions,
  markSessionAsActive,
  markSessionAsInactive,
  markSessionAsProcessing,
  markSessionAsNotProcessing,
  replaceTemporarySession,
  onNavigate,
  onOpenSettings,
  externalMessageUpdate,
  initialUserMessage,
}: {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  projects: Project[];
  onSelectWorkspace: (project: Project) => void;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  latestMessage: unknown;
  isMobile: boolean;
  processingSessions: Map<string, number>;
  markSessionAsActive: (id?: string | null) => void;
  markSessionAsInactive: (id?: string | null) => void;
  markSessionAsProcessing: (id?: string | null) => void;
  markSessionAsNotProcessing: (id?: string | null) => void;
  replaceTemporarySession: (id?: string | null) => void;
  onNavigate: (path: string) => void;
  onOpenSettings: () => void;
  externalMessageUpdate: number;
  initialUserMessage: PendingInitialMessage | null;
}) {
  const editor = useEditorSidebar({ selectedProject, isMobile });
  const { preferences } = useUiPreferences();

  if (!selectedProject) {
    return <section className="da-page"><DataAgentEmpty title="找不到任务" description="该任务可能已被删除，或不属于当前团队。" action={<button className="da-primary-button" onClick={() => onNavigate('/data-agent/new')}>返回新建任务</button>} /></section>;
  }

  return (
    <section className="da-page">
      <DataAgentPageHeader
        title={selectedSession ? getSessionLabel(selectedSession) : '任务对话'}
        subtitle={`${getWorkspaceLabel(selectedProject)} · 对话详情`}
        projects={projects}
        selectedProject={selectedProject}
        onSelectWorkspace={onSelectWorkspace}
      />
      <div className="da-conversation-layout">
        <div className={editor.editorExpanded ? 'da-chat-shell is-hidden' : 'da-chat-shell'}>
          <ChatInterface
            selectedProject={selectedProject}
            selectedSession={selectedSession}
            ws={ws}
            sendMessage={sendMessage}
            latestMessage={latestMessage}
            onFileOpen={(filePath, diffInfo) => editor.handleFileOpen(filePath, diffInfo ?? null, 'chat')}
            onSessionActive={markSessionAsActive}
            onSessionInactive={markSessionAsInactive}
            onSessionProcessing={markSessionAsProcessing}
            onSessionNotProcessing={markSessionAsNotProcessing}
            processingSessions={processingSessions}
            onReplaceTemporarySession={replaceTemporarySession}
            onNavigateToSession={(id) => onNavigate(`/data-agent/session/${encodeURIComponent(id)}`)}
            onShowSettings={onOpenSettings}
            autoExpandTools={preferences.autoExpandTools}
            hideToolMessages={preferences.hideToolMessages}
            showRawParameters={preferences.showRawParameters}
            showThinking={preferences.showThinking}
            autoScrollToBottom={preferences.autoScrollToBottom}
            sendByCtrlEnter={preferences.sendByCtrlEnter}
            externalMessageUpdate={externalMessageUpdate}
            initialUserMessage={initialUserMessage ?? undefined}
            onShowAllTasks={null}
            workspaceTerminology="expert"
          />
        </div>
        <EditorSidebar
          editingFile={editor.editingFile}
          isMobile={isMobile}
          editorExpanded={editor.editorExpanded}
          editorWidth={editor.editorWidth}
          isResizing={editor.isResizing}
          hasManualWidth={editor.hasManualWidth}
          resizeHandleRef={editor.resizeHandleRef}
          onResizeStart={editor.handleResizeStart}
          onCloseEditor={editor.handleCloseEditor}
          onToggleEditorExpand={editor.handleToggleEditorExpand}
          projectPath={selectedProject.path}
          isReadOnly={selectedProject.accessRole === 'view'}
          onOpenFile={(path) => editor.handleFileOpen(path, null, 'files')}
        />
      </div>
    </section>
  );
}

function DataAgentLoading({ label }: { label: string }) {
  return <div className="da-loading"><RefreshCw className="da-spin" size={18} /><span>{label}</span></div>;
}

function DataAgentEmpty({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return <div className="da-empty"><span className="da-empty-icon"><Folder size={22} /></span><h2>{title}</h2><p>{description}</p>{action}</div>;
}

export default function DataAgentApp() {
  const location = useLocation();
  const navigate = useNavigate();
  const route = useMemo(() => resolveRoute(location.pathname), [location.pathname]);
  const { currentTenant } = useTenant();
  const { ws, sendMessage, subscribeMessage, latestMessage, isConnected } = useWebSocket();
  const { isMobile } = useDeviceSettings({ trackPWA: false, mobileBreakpoint: 960 });
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<number | null>(readSelectedWorkspaceId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [pendingLaunch, setPendingLaunch] = useState<PendingLaunch | null>(null);
  const pendingLaunchRef = useRef<PendingLaunch | null>(null);
  const pendingFailureSessionIdRef = useRef<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [pendingSession, setPendingSession] = useState<ProjectSession | null>(null);
  const [pendingInitialMessage, setPendingInitialMessage] = useState<PendingInitialMessage | null>(null);
  const [externalMessageUpdate, setExternalMessageUpdate] = useState(0);
  const previousConnectionRef = useRef(false);

  const {
    processingSessions,
    markSessionAsActive,
    markSessionAsInactive,
    markSessionAsProcessing,
    markSessionAsNotProcessing,
    syncProcessingSessions,
    replaceTemporarySession,
  } = useSessionProtection();

  const fetchProjects = useCallback(async (): Promise<Project[]> => {
    if (!currentTenant) {
      setProjects([]);
      setLoadingProjects(false);
      return [];
    }
    try {
      const response = await api.projects();
      const payload = await response.json();
      const nextProjects = (Array.isArray(payload) ? payload : []) as Project[];
      setProjects(nextProjects);
      return nextProjects;
    } catch (error) {
      console.error('Failed to load DataAgent workspaces:', error);
      setProjects([]);
      return [];
    } finally {
      setLoadingProjects(false);
    }
  }, [currentTenant]);

  useEffect(() => {
    setLoadingProjects(true);
    void fetchProjects();
  }, [fetchProjects]);

  useEffect(() => {
    if (
      latestMessage?.type === 'projects_updated'
      && Array.isArray(latestMessage.projects)
      && isProjectUpdateScopedToTenant(latestMessage.projects, currentTenant?.id, latestMessage.tenantId)
    ) {
      setProjects(latestMessage.projects);
    }
    if (latestMessage?.type === 'projects_updated' && route.sessionId && latestMessage.changedFile?.includes(route.sessionId)) {
      setExternalMessageUpdate((value) => value + 1);
    }
  }, [currentTenant?.id, latestMessage, route.sessionId]);

  const routeSessionMatch = useMemo(() => {
    if (!route.sessionId) return null;
    for (const project of projects) {
      const session = getProjectSessions(project).find((candidate) => candidate.id === route.sessionId);
      if (session) return { project, session };
    }
    return null;
  }, [projects, route.sessionId]);

  const selectedProject = useMemo(() => {
    if (routeSessionMatch) return routeSessionMatch.project;
    return projects.find((project) => project.workspaceId === selectedWorkspaceId) || projects[0] || null;
  }, [projects, routeSessionMatch, selectedWorkspaceId]);

  const selectedSession = routeSessionMatch?.session
    || (pendingSession?.id === route.sessionId ? pendingSession : null);

  useEffect(() => {
    if (route.page !== 'conversation' || !isProvisionalDataAgentSessionId(route.sessionId)) return;

    const recoveryMessage = '任务启动失败，未能建立有效会话，请重试。';
    pendingLaunchRef.current = null;
    pendingFailureSessionIdRef.current = null;
    setPendingLaunch(null);
    setPendingSession(null);
    setPendingInitialMessage(null);
    setLaunchError(recoveryMessage);
    sessionStorage.setItem(LAUNCH_ERROR_STORAGE_KEY, recoveryMessage);
    navigate('/data-agent/new', { replace: true });
  }, [navigate, route.page, route.sessionId]);

  useEffect(() => {
    if (route.page !== 'new') return;
    const storedError = sessionStorage.getItem(LAUNCH_ERROR_STORAGE_KEY);
    if (!storedError) return;
    sessionStorage.removeItem(LAUNCH_ERROR_STORAGE_KEY);
    setLaunchError(storedError);
  }, [route.page]);

  useEffect(() => {
    if (selectedProject?.workspaceId == null) return;
    if (selectedWorkspaceId !== selectedProject.workspaceId) setSelectedWorkspaceId(selectedProject.workspaceId);
    localStorage.setItem(WORKSPACE_STORAGE_KEY, String(selectedProject.workspaceId));
  }, [selectedProject?.workspaceId, selectedWorkspaceId]);

  const selectWorkspace = useCallback((project: Project) => {
    if (project.workspaceId != null) {
      setSelectedWorkspaceId(project.workspaceId);
      localStorage.setItem(WORKSPACE_STORAGE_KEY, String(project.workspaceId));
    }
    setPendingSession(null);
    setPendingInitialMessage(null);
    setMobileSidebarOpen(false);
    if (route.page === 'conversation') navigate('/data-agent/new');
  }, [navigate, route.page]);

  const createTaskInWorkspace = useCallback((project: Project) => {
    selectWorkspace(project);
    navigate('/data-agent/new');
  }, [navigate, selectWorkspace]);

  const handleExpertCreated = useCallback(async (project: Project) => {
    const latestProjects = await fetchProjects();
    const createdPath = project.fullPath || project.path;
    const createdWorkspace = latestProjects.find((candidate) => (
      project.workspaceId != null && candidate.workspaceId === project.workspaceId
    )) || latestProjects.find((candidate) => (
      Boolean(createdPath) && (candidate.fullPath === createdPath || candidate.path === createdPath)
    )) || project;

    if (createdWorkspace.workspaceId == null) {
      throw new Error('专家创建成功，但未能定位对应专家，请刷新后重试。');
    }

    setProjects((current) => current.some((candidate) => candidate.workspaceId === createdWorkspace.workspaceId)
      ? current
      : [...current, createdWorkspace]);
    selectWorkspace(createdWorkspace);
    navigate('/data-agent/new');
  }, [fetchProjects, navigate, selectWorkspace]);

  useEffect(() => {
    const refreshProjects = async () => {
      await fetchProjects();
    };
    window.refreshProjects = refreshProjects;
    return () => {
      if (window.refreshProjects === refreshProjects) delete window.refreshProjects;
    };
  }, [fetchProjects]);

  useEffect(() => {
    const unsubscribe = subscribeMessage((message) => {
      if (message?.type === 'active-sessions') {
        const providerSessions = message.sessions || {};
        const ids = ['claude', 'cursor', 'codex', 'gemini'].flatMap((provider) => {
          const sessions = Array.isArray(providerSessions[provider]) ? providerSessions[provider] : [];
          return sessions.map((session: unknown) => typeof session === 'string' ? session : String((session as { id?: string })?.id || '')).filter(Boolean);
        });
        syncProcessingSessions(ids);
      }

      const pending = pendingLaunchRef.current;
      if (!pending) return;
      const launchOutcome = resolveDataAgentLaunchMessage(
        message || {},
        pending.provider,
        pendingFailureSessionIdRef.current,
      );

      if (launchOutcome.type === 'ignore') return;
      if (launchOutcome.type === 'await-error') {
        pendingFailureSessionIdRef.current = launchOutcome.sessionId;
        return;
      }
      if (launchOutcome.type === 'failed') {
        pendingLaunchRef.current = null;
        pendingFailureSessionIdRef.current = null;
        setPendingLaunch(null);
        setPendingSession(null);
        setPendingInitialMessage(null);
        setLaunchError(launchOutcome.message);
        markSessionAsInactive(pending.temporarySessionId);
        markSessionAsNotProcessing(pending.temporarySessionId);
        return;
      }

      const newSessionId = launchOutcome.sessionId;

      pendingLaunchRef.current = null;
      pendingFailureSessionIdRef.current = null;
      setPendingLaunch(null);
      replaceTemporarySession(newSessionId);
      sessionStorage.setItem('pendingSessionId', newSessionId);
      setPendingSession({ id: newSessionId, summary: pending.prompt.replace(/\s+/g, ' ').slice(0, 80), __provider: pending.provider });
      setPendingInitialMessage({
        sessionId: newSessionId,
        provider: pending.provider,
        content: pending.prompt,
        timestamp: pending.submittedAt,
      });
      void fetchProjects();
      navigate(`/data-agent/session/${encodeURIComponent(newSessionId)}`);
    });

    if (isConnected) sendMessage({ type: 'get-active-sessions' });
    return unsubscribe;
  }, [fetchProjects, isConnected, markSessionAsInactive, markSessionAsNotProcessing, navigate, replaceTemporarySession, sendMessage, subscribeMessage, syncProcessingSessions]);

  useEffect(() => {
    const reconnected = isConnected && !previousConnectionRef.current;
    previousConnectionRef.current = isConnected;
    if (reconnected && route.sessionId) sendMessage({ type: 'get-pending-permissions', sessionId: route.sessionId });
  }, [isConnected, route.sessionId, sendMessage]);

  const startTask = useCallback((prompt: string) => {
    if (!selectedProject) return;
    if (!isConnected) {
      setLaunchError('当前连接不可用，请稍后重试。');
      return;
    }

    const provider = (localStorage.getItem('selected-provider') as LLMProvider) || 'claude';
    const temporarySessionId = `new-session-${Date.now()}`;
    const launch = { provider, temporarySessionId, workspaceId: selectedProject.workspaceId, prompt, submittedAt: Date.now() };
    pendingLaunchRef.current = launch;
    pendingFailureSessionIdRef.current = null;
    setPendingLaunch(launch);
    setPendingInitialMessage(null);
    setLaunchError(null);
    markSessionAsActive(temporarySessionId);
    markSessionAsProcessing(temporarySessionId);

    const resolvedProjectPath = selectedProject.fullPath || selectedProject.path || '';
    const sessionSummary = prompt.replace(/\s+/g, ' ').slice(0, 80);
    const permissionMode = 'default';

    if (provider === 'cursor') {
      const toolsSettings = parseJsonSettings('cursor-tools-settings');
      sendMessage({ type: 'cursor-command', command: prompt, sessionId: null, options: { cwd: resolvedProjectPath, projectPath: resolvedProjectPath, workspaceId: selectedProject.workspaceId, sessionId: null, resume: false, model: localStorage.getItem('cursor-model') || CURSOR_MODELS.DEFAULT, skipPermissions: toolsSettings.skipPermissions || false, sessionSummary, toolsSettings } });
    } else if (provider === 'codex') {
      sendMessage({ type: 'codex-command', command: prompt, sessionId: null, options: { cwd: resolvedProjectPath, projectPath: resolvedProjectPath, workspaceId: selectedProject.workspaceId, sessionId: null, resume: false, model: localStorage.getItem('codex-model') || CODEX_MODELS.DEFAULT, sessionSummary, permissionMode } });
    } else if (provider === 'gemini') {
      const toolsSettings = parseJsonSettings('gemini-settings');
      sendMessage({ type: 'gemini-command', command: prompt, sessionId: null, options: { cwd: resolvedProjectPath, projectPath: resolvedProjectPath, workspaceId: selectedProject.workspaceId, sessionId: null, resume: false, model: localStorage.getItem('gemini-model') || GEMINI_MODELS.DEFAULT, sessionSummary, permissionMode, toolsSettings } });
    } else {
      sendMessage({ type: 'claude-command', command: prompt, options: { projectName: selectedProject.name, projectPath: resolvedProjectPath, cwd: resolvedProjectPath, workspaceId: selectedProject.workspaceId, sessionId: null, resume: false, toolsSettings: parseJsonSettings('claude-settings'), permissionMode, model: localStorage.getItem('claude-model') || CLAUDE_MODELS.DEFAULT, sessionSummary } });
    }
  }, [isConnected, markSessionAsActive, markSessionAsProcessing, selectedProject, sendMessage]);

  useEffect(() => {
    if (!pendingLaunch) return;
    const timeout = window.setTimeout(() => {
      if (pendingLaunchRef.current?.temporarySessionId !== pendingLaunch.temporarySessionId) return;
      pendingLaunchRef.current = null;
      pendingFailureSessionIdRef.current = null;
      setPendingLaunch(null);
      markSessionAsInactive(pendingLaunch.temporarySessionId);
      markSessionAsNotProcessing(pendingLaunch.temporarySessionId);
      setLaunchError('任务启动超时，请重试。');
    }, 30_000);
    return () => window.clearTimeout(timeout);
  }, [markSessionAsInactive, markSessionAsNotProcessing, pendingLaunch]);

  const go = useCallback((path: string) => {
    setMobileSidebarOpen(false);
    if (path === '/admin') {
      navigate(path, {
        state: {
          from: `${location.pathname}${location.search}${location.hash}`,
        },
      });
      return;
    }
    navigate(path);
  }, [location.hash, location.pathname, location.search, navigate]);

  const page = loadingProjects ? <DataAgentLoading label="正在加载专家…" /> : (() => {
    switch (route.page) {
      case 'capabilities':
        return <DataAgentCapabilities tab={route.tab || 'experts'} skillName={route.skillName} projects={projects} selectedProject={selectedProject} onSelectWorkspace={selectWorkspace} onNavigate={go} onExpertCreated={handleExpertCreated} />;
      case 'automation':
        return <DataAgentAutomation projects={projects} selectedProject={selectedProject} onSelectWorkspace={selectWorkspace} onNavigate={go} />;
      case 'files':
        return <DataAgentFiles projects={projects} selectedProject={selectedProject} onSelectWorkspace={selectWorkspace} isMobile={isMobile} />;
      case 'codehub':
        return <DataAgentExistingWorkspacePanel kind="codehub" projects={projects} selectedProject={selectedProject} onSelectWorkspace={selectWorkspace} />;
      case 'sql-check':
        return <DataAgentExistingWorkspacePanel kind="sql-check" projects={projects} selectedProject={selectedProject} onSelectWorkspace={selectWorkspace} />;
      case 'conversation':
        return (
          <DataAgentConversation
            selectedProject={selectedProject}
            selectedSession={selectedSession}
            projects={projects}
            onSelectWorkspace={selectWorkspace}
            ws={ws}
            sendMessage={sendMessage}
            latestMessage={latestMessage}
            isMobile={isMobile}
            processingSessions={processingSessions}
            markSessionAsActive={markSessionAsActive}
            markSessionAsInactive={markSessionAsInactive}
            markSessionAsProcessing={markSessionAsProcessing}
            markSessionAsNotProcessing={markSessionAsNotProcessing}
            replaceTemporarySession={replaceTemporarySession}
            onNavigate={go}
            onOpenSettings={() => setSettingsOpen(true)}
            externalMessageUpdate={externalMessageUpdate}
            initialUserMessage={pendingInitialMessage?.sessionId === route.sessionId ? pendingInitialMessage : null}
          />
        );
      default:
        return <DataAgentNewTask projects={projects} selectedProject={selectedProject} onSelectWorkspace={selectWorkspace} onStart={startTask} pending={Boolean(pendingLaunch)} error={launchError} onOpenAutomation={() => go('/data-agent/automation')} />;
    }
  })();

  return (
    <div className="data-agent-v2">
      {isMobile && (
        <button type="button" className="da-mobile-menu-button" onClick={() => setMobileSidebarOpen(true)} aria-label="打开导航"><Menu size={19} /></button>
      )}
      <div className={`da-sidebar-layer ${mobileSidebarOpen ? 'is-open' : ''}`}>
        {isMobile && <button type="button" className="da-mobile-backdrop" onClick={() => setMobileSidebarOpen(false)} aria-label="关闭导航" />}
        <DataAgentSidebar
          page={route.page}
          projects={projects}
          selectedSession={selectedSession}
          processingSessions={processingSessions}
          onNavigate={go}
          onCreateTask={createTaskInWorkspace}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      </div>
      <main className="da-main">{page}</main>
      <Settings isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} workspaceTerminology="expert" />
    </div>
  );
}
