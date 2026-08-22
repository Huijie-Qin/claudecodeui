import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
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
  Info,
  LogOut,
  Menu,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Plus,
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
import ProjectCreationWizard from '../../components/project-creation-wizard';
import Settings from '../../components/settings/view/Settings';
import SkillsPanel from '../../components/skills-market/SkillsPanel';
import { useWorkspaceSkills } from '../../components/skills-market/hooks/useWorkspaceSkills';
import { getSkillDisplayName, type WorkspaceSkill } from '../../components/skills-market/utils/skillFormatting';
import SqlCheckPanel from '../../components/sql-check/SqlCheckPanel';
import McpToolsPanel from '../../components/tools-market/McpToolsPanel';
import { useWorkspaceMcpTools, type WorkspaceMcpPreset } from '../../components/tools-market/hooks/useWorkspaceMcpTools';
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
import { useAgentGraphs } from '../agent-graph/useAgentGraphs';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  CURSOR_MODELS,
  GEMINI_MODELS,
} from '../../../shared/modelConstants.js';

import './dataAgentV2.css';
import DataAgentFileTabs from './DataAgentFileTabs';
import { useFileEditorTabs } from './useFileEditorTabs';
import { useDataAgentFilesSplit } from './useDataAgentFilesSplit';

const AgentGraphStudio = React.lazy(() => import('../agent-graph/AgentGraphStudio'));

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
};

const WORKSPACE_STORAGE_KEY = 'data-agent-v2-workspace-id';

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
  return project?.displayName || project?.name || '选择工作区';
}

function readSelectedWorkspaceId() {
  const stored = localStorage.getItem(WORKSPACE_STORAGE_KEY);
  const parsed = stored ? Number(stored) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveRoute(pathname: string): { page: PageKind; sessionId?: string; tab?: CapabilityTab } {
  const sessionMatch = pathname.match(/^\/data-agent\/session\/([^/]+)$/);
  if (sessionMatch) return { page: 'conversation', sessionId: decodeURIComponent(sessionMatch[1]) };
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

function DataAgentWorkspaceSelect({
  projects,
  selectedProject,
  onSelect,
  compact = false,
}: {
  projects: Project[];
  selectedProject: Project | null;
  onSelect: (project: Project) => void;
  compact?: boolean;
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
        aria-label="选择工作区"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <FolderOpen size={15} aria-hidden="true" />
        {!compact && <span className="da-workspace-select-label">工作区</span>}
        <strong className="da-workspace-name">{getWorkspaceLabel(selectedProject)}</strong>
        <ChevronDown className={open ? 'is-open' : ''} size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="da-workspace-menu" role="menu" aria-label="选择工作区">
          <div className="da-menu-label">选择工作区</div>
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
                    <small>{project.fullPath || project.path || '本地工作区'}</small>
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
  onCreateWorkspace,
  onRefreshWorkspaces,
  onOpenSettings,
}: {
  page: PageKind;
  projects: Project[];
  selectedSession: ProjectSession | null;
  processingSessions: Map<string, number>;
  onNavigate: (path: string) => void;
  onCreateTask: (project: Project) => void;
  onCreateWorkspace: () => void;
  onRefreshWorkspaces: () => Promise<void>;
  onOpenSettings: () => void;
}) {
  const { user, logout } = useAuth();
  const { tenants, currentTenant, selectTenant } = useTenant();
  const [moreOpen, setMoreOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [refreshingWorkspaces, setRefreshingWorkspaces] = useState(false);
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

  const refreshWorkspaces = async () => {
    if (refreshingWorkspaces) return;
    setRefreshingWorkspaces(true);
    try {
      await Promise.all([
        onRefreshWorkspaces(),
        new Promise((resolve) => window.setTimeout(resolve, 320)),
      ]);
    } finally {
      setRefreshingWorkspaces(false);
    }
  };

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
          <div className="da-history-heading">
            <span>工作区</span>
            <div className="da-history-actions">
              <button
                type="button"
                className="da-history-action da-history-create"
                aria-label="新增或绑定工作区"
                title="新增或绑定工作区"
                onClick={onCreateWorkspace}
              >
                <Plus size={13} />
              </button>
              <button
                type="button"
                className="da-history-action da-history-refresh"
                aria-label="刷新工作区"
                title="刷新工作区"
                disabled={refreshingWorkspaces}
                onClick={() => void refreshWorkspaces()}
              >
                <RefreshCw className={refreshingWorkspaces ? 'da-spin' : ''} size={13} />
              </button>
            </div>
          </div>
          <div className="da-history-scroll">
            {projects.map((project) => {
              const sessions = getProjectSessions(project).slice(0, 8);
              const projectKey = getWorkspaceGroupKey(project);
              const isExpanded = !collapsedWorkspaces.has(projectKey);
              const sessionListId = `da-workspace-sessions-${String(project.workspaceId ?? project.name).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
              return (
                <section key={projectKey} className="da-project-group">
                  <div className="da-project-row">
                    <button
                      type="button"
                      className="da-project-toggle"
                      aria-expanded={isExpanded}
                      aria-controls={sessionListId}
                      onClick={() => toggleWorkspaceGroup(project)}
                    >
                      <ChevronRight className={isExpanded ? 'is-open' : ''} size={13} />
                      <span className="da-project-mark">{getWorkspaceLabel(project).slice(0, 1).toUpperCase()}</span>
                      <strong>{getWorkspaceLabel(project)}</strong>
                    </button>
                    <button
                      type="button"
                      className="da-project-new-task"
                      aria-label={`在 ${getWorkspaceLabel(project)} 中新建任务`}
                      title="在此工作区新建任务"
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
}: {
  title: string;
  subtitle: string;
  projects: Project[];
  selectedProject: Project | null;
  onSelectWorkspace: (project: Project) => void;
  action?: React.ReactNode;
  showWorkspace?: boolean;
}) {
  return (
    <header className="da-page-header">
      <div className="da-page-title">
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </div>
      <div className="da-page-actions">
        {showWorkspace && <DataAgentWorkspaceSelect projects={projects} selectedProject={selectedProject} onSelect={onSelectWorkspace} compact />}
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
  onOpenCapabilities,
}: {
  projects: Project[];
  selectedProject: Project | null;
  onSelectWorkspace: (project: Project) => void;
  onStart: (prompt: string) => void;
  pending: boolean;
  error: string | null;
  onOpenAutomation: () => void;
  onOpenCapabilities: () => void;
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
        subtitle="在当前工作区开始一个 AI 会话"
        projects={projects}
        selectedProject={selectedProject}
        onSelectWorkspace={onSelectWorkspace}
        showWorkspace={false}
      />
      <div className="da-new-inner">
        <div className="da-new-intro">
          <span className="da-intro-icon"><WandSparkles size={20} /></span>
          <h1>今天想完成什么？</h1>
          <p>描述目标，DataAgent 会在所选工作区中规划并执行。</p>
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
                    <span><strong>{command.name}</strong><small>{command.description || '工作区技能'}</small></span>
                  </button>
                )) : <div className="da-popover-empty">当前工作区还没有可用技能</div>}
              </div>
            </div>
          )}

          <div className="da-capability-strip">
            <button type="button" className="da-capability-chip" onClick={onOpenCapabilities}>
              <Sparkles size={12} /> 添加能力
            </button>
          </div>

          <div className="da-composer-footer">
            <div className="da-composer-tools">
              <button ref={skillTriggerRef} type="button" className="da-tool-button" onClick={handleToggleCommandMenu} title="选择技能" aria-expanded={showCommandMenu}>
                <TerminalSquare size={16} />
                <span>{slashCommandsCount}</span>
              </button>
              <DataAgentWorkspaceSelect projects={projects} selectedProject={selectedProject} onSelect={onSelectWorkspace} />
              <button type="button" className="da-tool-button" onClick={onOpenAutomation} title="管理当前工作区的自动化">
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
  projects,
  selectedProject,
  onSelectWorkspace,
  onNavigate,
}: {
  tab: CapabilityTab;
  projects: Project[];
  selectedProject: Project | null;
  onSelectWorkspace: (project: Project) => void;
  onNavigate: (path: string) => void;
}) {
  const [showStudio, setShowStudio] = useState(false);
  const [managerOpen, setManagerOpen] = useState<'skills' | 'connectors' | null>(null);
  const [query, setQuery] = useState('');
  const [capabilityFilter, setCapabilityFilter] = useState('全部');
  const graphState = useAgentGraphs(selectedProject?.workspaceId);
  const skillState = useWorkspaceSkills(selectedProject?.workspaceId);
  const connectorState = useWorkspaceMcpTools(selectedProject?.workspaceId);

  useEffect(() => {
    setShowStudio(false);
    setManagerOpen(null);
    setQuery('');
    setCapabilityFilter('全部');
  }, [selectedProject?.workspaceId, tab]);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleGraphs = graphState.graphs.filter((graph) => !normalizedQuery || [
    graph.name,
    graph.goal,
    ...graph.agents.map((agent) => agent.name),
  ].filter(Boolean).join(' ').toLowerCase().includes(normalizedQuery));
  const skills = skillState.data?.skills ?? [];
  const skillKinds = Array.from(new Set(skills.map((skill) => skill.kind)));
  const visibleSkills = skills.filter((skill) => {
    const matchesQuery = !normalizedQuery || [
      skill.name,
      skill.displayName,
      skill.description,
      skill.sourceType,
    ].filter(Boolean).join(' ').toLowerCase().includes(normalizedQuery);
    return matchesQuery && (capabilityFilter === '全部' || skill.kind === capabilityFilter);
  });
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

  const introTitle = tab === 'experts' ? '安装并管理专家' : tab === 'skills' ? '工作区技能市场' : '管理工作区连接器';
  const introDescription = tab === 'experts'
    ? `专家配置归属于 ${getWorkspaceLabel(selectedProject)}，底层沿用 Agent Graph。`
    : tab === 'skills'
      ? `浏览并管理 ${getWorkspaceLabel(selectedProject)} 中可用的工作区技能。`
      : `管理 ${getWorkspaceLabel(selectedProject)} 使用的 MCP Servers、Tools 与预设。`;

  return (
    <section className="da-page">
      <DataAgentPageHeader
        title="专家 · 技能 · 连接器"
        subtitle="按工作区管理 DataAgent 能力"
        projects={projects}
        selectedProject={selectedProject}
        onSelectWorkspace={onSelectWorkspace}
        action={<button type="button" className="da-icon-button" aria-label="能力映射说明" title="专家对应 Agent Graph，技能对应 Workspace Skills，连接器对应 MCP"><Info size={16} /></button>}
      />
      <div className="da-capability-page">
        <div className="da-content-inner">
          <div className="da-capability-intro">
            <div>
              <h1>{introTitle}</h1>
              <p>{introDescription}</p>
            </div>
            {tab === 'connectors' && <button className="da-secondary-button da-intro-action" type="button" onClick={() => setManagerOpen('connectors')}><Server size={14} />MCP 预设</button>}
          </div>
          <div className="da-tabs" role="tablist">
            <button className={tab === 'experts' ? 'is-active' : ''} onClick={() => onNavigate('/data-agent/capabilities/experts')}>专家</button>
            <button className={tab === 'skills' ? 'is-active' : ''} onClick={() => onNavigate('/data-agent/capabilities/skills')}>技能</button>
            <button className={tab === 'connectors' ? 'is-active' : ''} onClick={() => onNavigate('/data-agent/capabilities/connectors')}>连接器</button>
          </div>

          {!selectedProject && <DataAgentEmpty title="选择一个工作区" description="能力配置需要绑定到具体工作区。" />}
          {selectedProject && !showStudio && (
            <div className="da-capability-toolbar">
              <label className="da-search-box">
                <Search size={14} />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`搜索${tab === 'experts' ? '专家' : tab === 'skills' ? '技能' : '连接器'}`} />
              </label>
              {tab === 'skills' && (
                <select value={capabilityFilter} onChange={(event) => setCapabilityFilter(event.target.value)} aria-label="筛选技能来源">
                  <option>全部</option>
                  {skillKinds.map((kind) => <option key={kind} value={kind}>{kind === 'managed' ? '已托管' : kind === 'system' ? '系统' : '工作区'}</option>)}
                </select>
              )}
              {tab === 'connectors' && (
                <select value={capabilityFilter} onChange={(event) => setCapabilityFilter(event.target.value)} aria-label="筛选连接状态">
                  <option>全部</option><option>已连接</option><option>未连接</option>
                </select>
              )}
              <span className="da-toolbar-count">
                {tab === 'experts' && `${graphState.graphs.length} 个 Agent Graph 配置`}
                {tab === 'skills' && `已启用 ${skills.filter((skill) => skill.enabled).length} / ${skills.length}`}
                {tab === 'connectors' && `已连接 ${presets.filter((preset) => preset.installed).length} / ${presets.length}`}
              </span>
            </div>
          )}

          {selectedProject && tab === 'experts' && (
            <div className="da-capability-body">
            {showStudio ? (
              <div className="da-studio-shell">
                <div className="da-studio-toolbar">
                  <button type="button" className="da-secondary-button" onClick={() => setShowStudio(false)}><ChevronRight className="da-back-icon" size={15} />返回专家列表</button>
                  <span>工作区：{getWorkspaceLabel(selectedProject)}</span>
                </div>
                <div className="da-studio-content">
                  <Suspense fallback={<DataAgentLoading label="正在加载专家配置…" />}>
                    <AgentGraphStudio selectedProject={selectedProject} readOnly={selectedProject.accessRole === 'view'} />
                  </Suspense>
                </div>
              </div>
            ) : (
              graphState.isLoading ? <DataAgentLoading label="正在加载专家…" /> : graphState.error ? (
                  <DataAgentEmpty title="专家加载失败" description={graphState.error} action={<button className="da-secondary-button" onClick={() => void graphState.reload()}>重试</button>} />
                ) : visibleGraphs.length ? (
                  <div className="da-card-grid">
                    {visibleGraphs.map((graph) => (
                      <article className="da-capability-card" key={graph.id}>
                        <div className="da-card-title-row"><span className="da-card-icon purple"><Bot size={18} /></span><div><h2>{graph.name}</h2><p>Agent Graph · {graph.agents.length} 个执行节点</p></div></div>
                        <p className="da-card-description">{graph.goal || '通过多个执行节点协作完成工作区任务。'}</p>
                        <div className="da-tag-row">
                          {graph.agents.slice(0, 4).map((agent) => <span key={agent.id}>{agent.name}</span>)}
                        </div>
                        <div className="da-card-footer"><span>{graph.relations.length} 个协作关系</span><button className="da-secondary-button da-small-button" onClick={() => setShowStudio(true)}>查看配置</button></div>
                      </article>
                    ))}
                  </div>
                ) : <DataAgentEmpty title={query ? '没有匹配的专家' : '还没有专家'} description={query ? '尝试使用其他关键词搜索。' : '当前工作区尚未配置 Agent Graph。'} action={!query && graphState.canManage ? <button className="da-primary-button" onClick={() => setShowStudio(true)}>创建专家</button> : undefined} />
            )}
            </div>
          )}

          {selectedProject && tab === 'skills' && (
            <CapabilityCardsState loading={skillState.isLoading} error={skillState.error} emptyTitle={query ? '没有匹配的技能' : '当前工作区还没有技能'} onReload={skillState.reload}>
              {visibleSkills.map((skill) => <WorkspaceSkillCard key={`${skill.kind}:${skill.name}`} skill={skill} onManage={() => setManagerOpen('skills')} />)}
            </CapabilityCardsState>
          )}

          {selectedProject && tab === 'connectors' && (
            <CapabilityCardsState loading={connectorState.isLoading} error={connectorState.error} emptyTitle={query ? '没有匹配的连接器' : '当前工作区还没有连接器预设'} onReload={connectorState.reload}>
              {visiblePresets.map((preset) => (
                <WorkspaceConnectorCard
                  key={preset.id}
                  preset={preset}
                  busy={connectorState.installingPresetIds.has(preset.id) || connectorState.removingPresetIds.has(preset.id)}
                  canManage={selectedProject.accessRole !== 'view' && connectorState.data?.canManage !== false}
                  onManage={() => setManagerOpen('connectors')}
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
      {managerOpen && selectedProject && (
        <div className="da-modal-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setManagerOpen(null); }}>
          <section className="da-manager-modal" role="dialog" aria-modal="true" aria-label={managerOpen === 'skills' ? '管理工作区技能' : '管理工作区连接器'}>
            <header><div><strong>{managerOpen === 'skills' ? '管理工作区技能' : '管理工作区连接器'}</strong><span>{getWorkspaceLabel(selectedProject)}</span></div><button type="button" className="da-icon-button" onClick={() => setManagerOpen(null)} aria-label="关闭"><X size={16} /></button></header>
            <div className="da-manager-body">
              {managerOpen === 'skills'
                ? <SkillsPanel selectedProject={selectedProject} isReadOnly={selectedProject.accessRole === 'view'} />
                : <McpToolsPanel selectedProject={selectedProject} isReadOnly={selectedProject.accessRole === 'view'} />}
            </div>
          </section>
        </div>
      )}
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
  if (loading) return <DataAgentLoading label="正在加载工作区能力…" />;
  if (error) return <DataAgentEmpty title="能力加载失败" description={error} action={<button className="da-secondary-button" onClick={onReload}>重试</button>} />;
  if (!items.length) return <DataAgentEmpty title={emptyTitle} description="可以调整筛选条件，或打开管理面板安装工作区能力。" />;
  return <div className="da-card-grid da-capability-body">{items}</div>;
}

function WorkspaceSkillCard({ skill, onManage }: { skill: WorkspaceSkill; onManage: () => void }) {
  const isEnabled = skill.status === 'enabled' || skill.enabled;
  const statusLabel = isEnabled ? '已启用' : skill.status === 'invalid' ? '无效' : '未启用';
  return (
    <article className="da-capability-card">
      <div className="da-card-title-row">
        <span className="da-card-icon blue"><Sparkles size={18} /></span>
        <div><h2>{getSkillDisplayName(skill)}</h2><p>/{skill.name} · {skill.sourceType}</p></div>
        <span className={`da-connection-badge ${isEnabled ? 'is-connected' : ''}`}>{statusLabel}</span>
      </div>
      <p className="da-card-description">{skill.description || '由当前工作区提供的可复用技能。'}</p>
      <div className="da-tag-row"><span>{skill.kind === 'managed' ? '已托管' : skill.kind === 'system' ? '系统技能' : '工作区技能'}</span><span>{skill.status}</span></div>
      <div className="da-card-footer"><span>{skill.manageable ? '可管理' : '只读'}</span><button className="da-secondary-button da-small-button" onClick={onManage}>查看详情</button></div>
    </article>
  );
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
        <div><h2>{preset.displayName || preset.name}</h2><p>MCP · {preset.toolCount} 个工具</p></div>
        <span className={`da-connection-badge ${preset.installed ? 'is-connected' : ''}`}>{preset.installed ? '已连接' : '未连接'}</span>
      </div>
      <p className="da-card-description">{preset.description || '为当前工作区提供 MCP 工具。'}</p>
      <div className="da-tag-row">{(preset.tools ?? []).slice(0, 3).map((tool) => <span key={tool.name}>{tool.name}</span>)}</div>
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
        subtitle="按工作区管理 Scheduled Tasks"
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
            <div><h1>让重复任务按计划运行</h1><p>当前查看 {getWorkspaceLabel(selectedProject)} 的自动化；运行会话仍在该工作区的任务历史中查看。</p></div>
          </div>
          <div className="da-automation-toolbar">
            {([['all', '全部'], ['enabled', '已启用'], ['paused', '已暂停'], ['failed', '失败']] as const).map(([value, label]) => (
              <button key={value} type="button" className={filter === value ? 'is-active' : ''} onClick={() => setFilter(value)}>{label}</button>
            ))}
            <span>{visibleTasks.length} / {tasks.length} 个自动化</span>
          </div>
          {error && <div className="da-inline-error">{error}</div>}
          {loading ? <DataAgentLoading label="正在加载自动化…" /> : !selectedProject ? (
            <DataAgentEmpty title="选择一个工作区" description="自动化按工作区隔离管理。" />
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
              )) : <div className="da-automation-empty"><DataAgentEmpty title={tasks.length ? '当前筛选下没有自动化' : '还没有自动化'} description={tasks.length ? '切换筛选条件查看其他自动化。' : '为当前工作区创建第一个定时任务。'} action={!tasks.length && selectedProject.accessRole !== 'view' ? <button className="da-primary-button" onClick={() => setDialog({ provider: 'claude', mode: 'create' })}>创建自动化</button> : undefined} /></div>}
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
      <DataAgentPageHeader title="文件" subtitle="浏览并编辑当前工作区文件" projects={projects} selectedProject={selectedProject} onSelectWorkspace={onSelectWorkspace} />
      <DataAgentEmpty title="选择一个工作区" description="文件浏览需要绑定到具体工作区。" />
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
        subtitle="浏览并编辑当前工作区文件"
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
      <DataAgentPageHeader title={title} subtitle={`复用既有 ${title} 工作区能力`} projects={projects} selectedProject={selectedProject} onSelectWorkspace={onSelectWorkspace} />
      {!selectedProject ? <DataAgentEmpty title="选择一个工作区" description={`${title} 需要绑定到具体工作区。`} /> : (
        <div className="da-existing-tool-layout">
          <div className={editor.editorExpanded ? 'da-existing-tool is-hidden' : 'da-existing-tool'}>
            {kind === 'codehub' ? (
              <CodeHubPanel selectedProject={selectedProject} isReadOnly={selectedProject.accessRole === 'view'} onFileOpen={(path) => editor.handleFileOpen(path, null, 'files')} />
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
        subtitle={`${getWorkspaceLabel(selectedProject)} · 复用既有对话详情`}
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
            onShowAllTasks={null}
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
  const [workspaceWizardOpen, setWorkspaceWizardOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [pendingLaunch, setPendingLaunch] = useState<PendingLaunch | null>(null);
  const pendingLaunchRef = useRef<PendingLaunch | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [pendingSession, setPendingSession] = useState<ProjectSession | null>(null);
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

  const fetchProjects = useCallback(async () => {
    if (!currentTenant) {
      setProjects([]);
      setLoadingProjects(false);
      return;
    }
    try {
      const response = await api.projects();
      const payload = await response.json();
      setProjects(Array.isArray(payload) ? payload : []);
    } catch (error) {
      console.error('Failed to load DataAgent workspaces:', error);
      setProjects([]);
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
      && isProjectUpdateScopedToTenant(latestMessage.projects, currentTenant?.id)
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
    setMobileSidebarOpen(false);
    if (route.page === 'conversation') navigate('/data-agent/new');
  }, [navigate, route.page]);

  const createTaskInWorkspace = useCallback((project: Project) => {
    selectWorkspace(project);
    navigate('/data-agent/new');
  }, [navigate, selectWorkspace]);

  useEffect(() => {
    window.refreshProjects = fetchProjects;
    return () => {
      if (window.refreshProjects === fetchProjects) delete window.refreshProjects;
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
      if (!pending || message?.kind !== 'session_created' || message?.scheduledTaskId != null) return;
      if (message.provider && message.provider !== pending.provider) return;
      const newSessionId = String(message.newSessionId || message.sessionId || '');
      if (!newSessionId) return;

      pendingLaunchRef.current = null;
      setPendingLaunch(null);
      replaceTemporarySession(newSessionId);
      sessionStorage.setItem('pendingSessionId', newSessionId);
      setPendingSession({ id: newSessionId, __provider: pending.provider });
      void fetchProjects();
      navigate(`/data-agent/session/${encodeURIComponent(newSessionId)}`);
    });

    if (isConnected) sendMessage({ type: 'get-active-sessions' });
    return unsubscribe;
  }, [fetchProjects, isConnected, navigate, replaceTemporarySession, sendMessage, subscribeMessage, syncProcessingSessions]);

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
    const launch = { provider, temporarySessionId, workspaceId: selectedProject.workspaceId };
    pendingLaunchRef.current = launch;
    setPendingLaunch(launch);
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

  const page = loadingProjects ? <DataAgentLoading label="正在加载工作区…" /> : (() => {
    switch (route.page) {
      case 'capabilities':
        return <DataAgentCapabilities tab={route.tab || 'experts'} projects={projects} selectedProject={selectedProject} onSelectWorkspace={selectWorkspace} onNavigate={go} />;
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
          />
        );
      default:
        return <DataAgentNewTask projects={projects} selectedProject={selectedProject} onSelectWorkspace={selectWorkspace} onStart={startTask} pending={Boolean(pendingLaunch)} error={launchError} onOpenAutomation={() => go('/data-agent/automation')} onOpenCapabilities={() => go('/data-agent/capabilities/skills')} />;
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
          onCreateWorkspace={() => setWorkspaceWizardOpen(true)}
          onRefreshWorkspaces={fetchProjects}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      </div>
      <main className="da-main">{page}</main>
      <Settings isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {workspaceWizardOpen && (
        <ProjectCreationWizard
          onClose={() => setWorkspaceWizardOpen(false)}
          onProjectCreated={() => void fetchProjects()}
        />
      )}
    </div>
  );
}
