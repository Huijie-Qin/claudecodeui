import assert from 'node:assert/strict';
import test from 'node:test';

import type { Project } from '../types/app';

import { projectsHaveChanges } from './projectChangeDetection';

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
