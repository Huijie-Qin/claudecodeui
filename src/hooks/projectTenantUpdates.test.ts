import assert from 'node:assert/strict';
import test from 'node:test';

import type { Project, ProjectsUpdatedMessage } from '../types/app';

import { createProjectUpdateTracker, isProjectUpdateScopedToTenant } from './projectTenantUpdates';

test('isProjectUpdateScopedToTenant accepts updates for the selected tenant', () => {
  assert.equal(isProjectUpdateScopedToTenant([
    { name: 'alpha', displayName: 'Alpha', fullPath: '/tmp/alpha', tenantId: 2 },
    { name: 'beta', displayName: 'Beta', fullPath: '/tmp/beta', tenantId: 2 },
  ], 2), true);
});

test('isProjectUpdateScopedToTenant rejects legacy or cross-tenant updates', () => {
  assert.equal(isProjectUpdateScopedToTenant([
    { name: 'legacy', displayName: 'Legacy', fullPath: '/tmp/legacy' },
  ], 2), false);
  assert.equal(isProjectUpdateScopedToTenant([
    { name: 'other', displayName: 'Other', fullPath: '/tmp/other', tenantId: 1 },
  ], 2), false);
  assert.equal(isProjectUpdateScopedToTenant([], 2), false);
  assert.equal(isProjectUpdateScopedToTenant([], 2, 1), false);
});

test('isProjectUpdateScopedToTenant accepts an explicitly scoped empty update', () => {
  assert.equal(isProjectUpdateScopedToTenant([], 2, 2), true);
});

test('isProjectUpdateScopedToTenant allows updates when no tenant is selected', () => {
  assert.equal(isProjectUpdateScopedToTenant([
    { name: 'legacy', displayName: 'Legacy', fullPath: '/tmp/legacy' },
  ], null), true);
});

test('a retained project event cannot erase a new fork or refresh the parent again on navigation', () => {
  const tracker = createProjectUpdateTracker();
  const parent = { id: 'parent' };
  const fork = { id: 'fork', parentSessionId: parent.id };
  const project: Project = {
    name: 'workspace', displayName: 'Workspace', fullPath: '/workspace', workspaceId: 4,
    tenantId: 2, sessions: [parent],
  };
  const staleEvent: ProjectsUpdatedMessage = {
    type: 'projects_updated', tenantId: 2, projects: [project], changedFile: 'parent.jsonl',
  };
  let projects: Project[] = [];
  let selectedSessionId = parent.id;
  let refreshes = 0;
  const receive = (event: ProjectsUpdatedMessage) => {
    if (!tracker.consume(event, 2)) return;
    projects = event.projects;
    if (event.changedFile?.includes(selectedSessionId)) refreshes += 1;
    if (!projects.some(candidate => candidate.sessions?.some(session => session.id === selectedSessionId))) {
      selectedSessionId = '';
    }
  };

  receive(staleEvent);
  assert.equal(refreshes, 1);
  projects = [{ ...project, sessions: [fork, parent] }];
  selectedSessionId = fork.id;
  receive(staleEvent); // Classic selection effect / DataAgent route effect reruns.
  assert.equal(selectedSessionId, fork.id);
  assert.deepEqual(projects[0].sessions?.map(session => session.id), [fork.id, parent.id]);
  selectedSessionId = parent.id;
  receive(staleEvent);
  assert.equal(refreshes, 1, 'Returning to the original chat must not replay its old changedFile event');

  receive({ ...staleEvent, projects: [{ ...project, sessions: [fork, { ...parent, summary: 'Fresh title' }] }] });
  assert.equal(projects[0].sessions?.[1].summary, 'Fresh title', 'A newly received object remains authoritative');
  assert.equal(refreshes, 2);
});

test('project update consumption rejects invalid and foreign events without swallowing a later valid delivery', () => {
  const tracker = createProjectUpdateTracker();
  const event: ProjectsUpdatedMessage = { type: 'projects_updated', tenantId: 2, projects: [] };
  assert.equal(tracker.consume(event, 1), false);
  assert.equal(tracker.consume(event, 2), true);
  assert.equal(tracker.consume(event, 2), false);
  assert.equal(tracker.consume({ ...event }, 2), true, 'Do not suppress a distinct server event with the same payload');
  assert.equal(tracker.consume(null, 2), false);
  assert.equal(tracker.consume({ type: 'projects_updated', tenantId: 2, projects: null }, 2), false);
  assert.equal(tracker.consume({ type: 'status', projects: [] }, 2), false);
});
