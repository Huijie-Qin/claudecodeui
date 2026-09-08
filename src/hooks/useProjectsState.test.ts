import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import ts from 'typescript';

import { resolveSupportedWorkspaceTab } from '../components/main-content/utils/mainContentAccess';
import type { AppTab, Project, ProjectsUpdatedMessage } from '../types/app';

import { projectsHaveChanges } from './projectChangeDetection';
import { isProjectUpdateScopedToTenant } from './projectTenantUpdates';

type ProjectsState = ReturnType<typeof import('./useProjectsState').useProjectsState>;
type ProjectsStateArgs = Parameters<typeof import('./useProjectsState').useProjectsState>[0];
type Dependencies = readonly unknown[];

const hookSource = ts.transpileModule(
  readFileSync(new URL('./useProjectsState.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
).outputText;

// Exercise the actual hook without introducing a browser/renderer dependency into the
// Node suite. State updates and dependency-based effects run until the hook settles.
function createProjectsHarness(initialProjects: Project[], persistedTab: AppTab) {
  const slots: Array<{
    value?: unknown;
    dependencies?: Dependencies;
    setValue?: (value: unknown) => void;
    cleanup?: () => void;
  }> = [];
  const effects: Array<() => void> = [];
  const storage = new Map<string, string>([['activeTab', persistedTab]]);
  const navigations: string[] = [];
  const currentTenant = { id: 1, code: 'default', name: 'Default' };
  let projectResponse = initialProjects;
  let index = 0;
  let dirty = true;
  let state: ProjectsState;
  const args: ProjectsStateArgs = {
    navigate: (to: unknown) => { navigations.push(String(to)); },
    latestMessage: null,
    isMobile: false,
    activeSessions: new Set(),
  };
  const dependenciesMatch = (left?: Dependencies, right?: Dependencies) => (
    Boolean(left && right && left.length === right.length
      && left.every((value, position) => Object.is(value, right[position]))
    )
  );
  const memo = <T>(factory: () => T, dependencies: Dependencies): T => {
    const slotIndex = index++;
    const previous = slots[slotIndex];
    if (!previous || !dependenciesMatch(previous.dependencies, dependencies)) {
      slots[slotIndex] = { value: factory(), dependencies };
    }
    return slots[slotIndex].value as T;
  };
  const react = {
    useState: <T>(initial: T | (() => T)) => {
      const slotIndex = index++;
      if (!slots[slotIndex]) {
        slots[slotIndex] = {
          value: typeof initial === 'function' ? (initial as () => T)() : initial,
          setValue: (next) => {
            const slot = slots[slotIndex];
            const value = typeof next === 'function' ? next(slot.value) : next;
            if (!Object.is(slot.value, value)) {
              slot.value = value;
              dirty = true;
            }
          },
        };
      }
      return [slots[slotIndex].value, slots[slotIndex].setValue];
    },
    useRef: <T>(initial: T) => memo(() => ({ current: initial }), []),
    useMemo: memo,
    useCallback: <T>(callback: T, dependencies: Dependencies) => memo(() => callback, dependencies),
    useEffect: (effect: () => void | (() => void), dependencies?: Dependencies) => {
      const slotIndex = index++;
      const previous = slots[slotIndex];
      if (!previous || !dependenciesMatch(previous.dependencies, dependencies)) {
        const slot = { dependencies, cleanup: previous?.cleanup };
        slots[slotIndex] = slot;
        effects.push(() => {
          slot.cleanup?.();
          slot.cleanup = effect() || undefined;
        });
      }
    },
  };
  const dependencies: Record<string, unknown> = {
    react,
    '../contexts/TenantContext': { useTenant: () => ({ currentTenant }) },
    '../utils/api': { api: { projects: async () => ({ json: async () => projectResponse }) } },
    '../components/main-content/utils/mainContentAccess': { resolveSupportedWorkspaceTab },
    '../features/agent-graph/agentGraphFeature': { readAgentGraphFeatureEnabled: () => false },
    './projectTenantUpdates': { isProjectUpdateScopedToTenant },
    './projectChangeDetection': { projectsHaveChanges },
  };
  const exports: { useProjectsState?: typeof import('./useProjectsState').useProjectsState } = {};
  runInNewContext(hookSource, {
    exports,
    require: (name: string) => {
      assert.ok(name in dependencies, `Unexpected hook dependency: ${name}`);
      return dependencies[name];
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    sessionStorage: { setItem: () => {} },
    setTimeout,
    clearTimeout,
    console,
  });
  assert.ok(exports.useProjectsState);
  const evaluateHook = exports.useProjectsState;
  const render = () => {
    let renders = 0;
    while (dirty) {
      assert.ok(renders++ < 50, 'Hook did not settle');
      dirty = false;
      index = 0;
      state = evaluateHook(args);
      for (const effect of effects.splice(0)) effect();
    }
  };
  return {
    get state() { return state; },
    storage,
    navigations,
    setProjectResponse(next: Project[]) { projectResponse = next; },
    deliverProjectUpdate(message: ProjectsUpdatedMessage) {
      args.latestMessage = message;
      dirty = true;
    },
    async flush() {
      render();
      // Let the async projects()/json() chain finish before running its next effects.
      await new Promise<void>((resolve) => setImmediate(resolve));
      render();
    },
    dispose() { for (const slot of slots) slot.cleanup?.(); },
  };
}

const project: Project = {
  name: 'workspace',
  displayName: 'Workspace',
  fullPath: '/workspace',
  workspaceId: 1,
  sessions: [],
  scheduledTasks: [],
};

test('project refresh detects newly created scheduled task folders', () => {
  const refreshedProject: Project = {
    ...project,
    scheduledTasks: [{
      id: 42,
      name: 'Billing check',
      enabled: true,
      provider: 'claude',
      sessionMode: 'new',
    }],
  };

  assert.equal(projectsHaveChanges([project], [refreshedProject], true), true);
});

for (const previousTab of ['skills', 'mcp-tools', 'files'] as const) {
  test(`selecting a project from ${previousTab} opens a fresh chat`, async (context) => {
    const secondProject = { ...project, name: 'new-project', workspaceId: 2 };
    const harness = createProjectsHarness([project, secondProject], previousTab);
    context.after(() => harness.dispose());
    await harness.flush();
    assert.equal(harness.state.activeTab, previousTab);

    harness.state.handleProjectSelect(project);
    await harness.flush();
    harness.state.handleSessionSelect({ id: 'old-session', title: 'Old session' });
    harness.state.setActiveTab(previousTab);
    await harness.flush();
    assert.equal(harness.state.selectedSession?.id, 'old-session');

    harness.state.handleProjectSelect(secondProject);
    await harness.flush();

    assert.equal(harness.state.selectedProject?.workspaceId, 2);
    assert.equal(harness.state.selectedSession, null);
    assert.equal(harness.state.activeTab, 'chat');
    assert.equal(harness.storage.get('activeTab'), 'chat');
    assert.equal(harness.navigations.at(-1), '/');
  });

  test(`auto-selecting the only project ignores persisted ${previousTab}`, async (context) => {
    const harness = createProjectsHarness([project], previousTab);
    context.after(() => harness.dispose());
    await harness.flush();

    assert.equal(harness.state.selectedProject?.workspaceId, project.workspaceId);
    assert.equal(harness.state.activeTab, 'chat');
    assert.equal(harness.storage.get('activeTab'), 'chat');
  });

  test(`project metadata refreshes preserve an intentionally opened ${previousTab}`, async (context) => {
    const tenantProject = { ...project, tenantId: 1 };
    const harness = createProjectsHarness([tenantProject], 'chat');
    context.after(() => harness.dispose());
    await harness.flush();
    harness.state.setActiveTab(previousTab);
    await harness.flush();

    const refreshedProject = { ...tenantProject, displayName: 'Updated workspace' };
    harness.setProjectResponse([refreshedProject]);
    await harness.state.refreshProjectsSilently();
    await harness.flush();
    assert.equal(harness.state.projects[0].displayName, 'Updated workspace');
    assert.equal(harness.state.activeTab, previousTab);

    await harness.state.handleSidebarRefresh();
    await harness.flush();
    assert.equal(harness.state.selectedProject?.displayName, 'Updated workspace');
    assert.equal(harness.state.activeTab, previousTab);

    harness.deliverProjectUpdate({
      type: 'projects_updated',
      tenantId: 1,
      projects: [{ ...refreshedProject, displayName: 'WebSocket update' }],
    });
    await harness.flush();
    assert.equal(harness.state.selectedProject?.displayName, 'WebSocket update');
    assert.equal(harness.state.activeTab, previousTab);
    assert.equal(harness.storage.get('activeTab'), previousTab);
  });
}
