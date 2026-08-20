import assert from 'node:assert/strict';
import test from 'node:test';

import { createProviderCommandActivity } from './provider-command-activity.js';

test('provider command activity leaves the registry as soon as a reusable stream becomes idle', () => {
  const registry = new Map();
  const activity = createProviderCommandActivity({
    registry,
    key: 'claude:one',
    value: { provider: 'claude' },
  });

  assert.equal(activity.activate(), true);
  assert.equal(registry.size, 1);
  assert.equal(activity.deactivate(), true);
  assert.equal(registry.size, 0);
  assert.equal(activity.isActive(), false);
});

test('provider command activity can resume and final cleanup is idempotent', () => {
  const registry = new Map();
  const activity = createProviderCommandActivity({
    registry,
    key: 'claude:one',
    value: { provider: 'claude' },
  });

  activity.activate();
  activity.deactivate();
  assert.equal(activity.activate(), true);
  assert.equal(activity.activate(), false);
  assert.equal(registry.size, 1);
  assert.equal(activity.deactivate(), true);
  assert.equal(activity.deactivate(), false);
  assert.equal(registry.size, 0);
});
