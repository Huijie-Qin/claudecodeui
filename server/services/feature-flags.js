import { appConfigDb } from '../database/db.js';

export const FEATURE_FLAGS = Object.freeze({
  AGENT_GRAPH: 'agentGraph',
});

export const SHOW_EXPERIMENTAL_FEATURES_ENV = 'CCUI_SHOW_EXPERIMENTAL_FEATURES';

const CONFIG_KEYS = Object.freeze({
  [FEATURE_FLAGS.AGENT_GRAPH]: 'feature.agent_graph.enabled',
});

function parseEnabled(value) {
  return value === true || value === 1 || value === 'true' || value === '1';
}

export function shouldShowExperimentalFeatures(env = process.env) {
  return parseEnabled(env[SHOW_EXPERIMENTAL_FEATURES_ENV]);
}

export function createFeatureFlagsService(config = appConfigDb) {
  const isEnabled = (feature) => {
    const configKey = CONFIG_KEYS[feature];
    if (!configKey) return false;
    return parseEnabled(config.get(configKey));
  };

  const getAll = () => ({
    [FEATURE_FLAGS.AGENT_GRAPH]: isEnabled(FEATURE_FLAGS.AGENT_GRAPH),
  });

  const setEnabled = (feature, enabled) => {
    const configKey = CONFIG_KEYS[feature];
    if (!configKey) {
      const error = new Error(`Unknown feature flag: ${feature}`);
      error.statusCode = 400;
      throw error;
    }
    if (typeof enabled !== 'boolean') {
      const error = new Error('enabled must be a boolean');
      error.statusCode = 400;
      throw error;
    }

    config.set(configKey, enabled ? 'true' : 'false');
    return getAll();
  };

  return { getAll, isEnabled, setEnabled };
}

export const featureFlagsService = createFeatureFlagsService();
