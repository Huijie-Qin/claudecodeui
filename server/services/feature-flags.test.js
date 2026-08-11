import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFeatureFlagsService,
  FEATURE_FLAGS,
  getAgentGraphVisibleUsers,
  getFeatureFlagsForUser,
  isAgentGraphVisibleToUser,
  shouldShowExperimentalFeatures,
} from './feature-flags.js';

function createConfig(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => values.set(key, value),
  };
}

test('Agent Graph defaults to disabled when no global setting exists', () => {
  const service = createFeatureFlagsService(createConfig());
  assert.deepEqual(service.getAll(), { agentGraph: false });
});

test('Agent Graph is persisted as a global boolean feature flag', () => {
  const config = createConfig();
  const service = createFeatureFlagsService(config);

  assert.deepEqual(service.setEnabled(FEATURE_FLAGS.AGENT_GRAPH, true), { agentGraph: true });
  assert.equal(config.get('feature.agent_graph.enabled'), 'true');
  assert.equal(service.isEnabled(FEATURE_FLAGS.AGENT_GRAPH), true);

  service.setEnabled(FEATURE_FLAGS.AGENT_GRAPH, false);
  assert.equal(service.isEnabled(FEATURE_FLAGS.AGENT_GRAPH), false);
});

test('feature flag updates reject non-boolean values', () => {
  const service = createFeatureFlagsService(createConfig());
  assert.throws(
    () => service.setEnabled(FEATURE_FLAGS.AGENT_GRAPH, 'true'),
    /enabled must be a boolean/,
  );
});

test('experimental settings are hidden unless explicitly enabled by environment', () => {
  assert.equal(shouldShowExperimentalFeatures({}), false);
  assert.equal(shouldShowExperimentalFeatures({ CCUI_SHOW_EXPERIMENTAL_FEATURES: 'false' }), false);
  assert.equal(shouldShowExperimentalFeatures({ CCUI_SHOW_EXPERIMENTAL_FEATURES: 'true' }), true);
  assert.equal(shouldShowExperimentalFeatures({ CCUI_SHOW_EXPERIMENTAL_FEATURES: '1' }), true);
});

test('Agent Graph user whitelist accepts usernames, emails, ids, separators, and wildcard', () => {
  const env = { CCUI_AGENT_GRAPH_VISIBLE_USERS: 'Alice; bob@example.com, 42' };
  assert.deepEqual([...getAgentGraphVisibleUsers(env)], ['alice', 'bob@example.com', '42']);
  assert.equal(isAgentGraphVisibleToUser({ username: 'ALICE' }, env), true);
  assert.equal(isAgentGraphVisibleToUser({ email: 'bob@example.com' }, env), true);
  assert.equal(isAgentGraphVisibleToUser({ id: 42 }, env), true);
  assert.equal(isAgentGraphVisibleToUser({ username: 'charlie' }, env), false);
  assert.equal(isAgentGraphVisibleToUser({ username: 'charlie' }, { CCUI_AGENT_GRAPH_VISIBLE_USERS: '*' }), true);
  assert.equal(isAgentGraphVisibleToUser({ username: 'alice' }, {}), false);
});

test('user-facing feature flags require both the global flag and whitelist membership', () => {
  const enabledFlags = { getAll: () => ({ agentGraph: true }) };
  const disabledFlags = { getAll: () => ({ agentGraph: false }) };
  const env = { CCUI_AGENT_GRAPH_VISIBLE_USERS: 'allowed@example.com' };

  assert.deepEqual(
    getFeatureFlagsForUser(enabledFlags, { username: 'allowed@example.com' }, env),
    { agentGraph: true },
  );
  assert.deepEqual(
    getFeatureFlagsForUser(enabledFlags, { username: 'blocked@example.com' }, env),
    { agentGraph: false },
  );
  assert.deepEqual(
    getFeatureFlagsForUser(disabledFlags, { username: 'allowed@example.com' }, env),
    { agentGraph: false },
  );
});
