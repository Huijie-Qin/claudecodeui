import { spawn } from 'child_process';
import path from 'path';

import { scanPlugins, getPluginsConfig, getPluginDir } from './plugin-loader.js';
import { createNodeSpawnSpec } from './runtime-command.js';

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 5_000;

function pluginShutdownError() {
  const error = new Error('Plugin server startup was cancelled because the host is shutting down');
  error.code = 'PLUGIN_HOST_SHUTTING_DOWN';
  return error;
}

export function createPluginProcessManager({
  spawnProcess = spawn,
  scan = scanPlugins,
  readConfig = getPluginsConfig,
  resolvePluginDir = getPluginDir,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  forceKillTimeoutMs = DEFAULT_FORCE_KILL_TIMEOUT_MS,
  logger = console,
} = {}) {
  // Map<pluginName, { process, port }>
  const runningPlugins = new Map();
  // Map<pluginName, { process, promise, stopRequested }>
  const startingPlugins = new Map();
  const pluginProcesses = new Set();
  const stoppingProcesses = new WeakMap();
  let stoppingAll = false;

  function terminateProcess(pluginProcess) {
    if (!pluginProcess) return Promise.resolve();
    const existingStop = stoppingProcesses.get(pluginProcess);
    if (existingStop) return existingStop;

    const stopPromise = new Promise((resolve) => {
      let settled = false;
      let forceKillTimer = null;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        if (forceKillTimer) clearTimeout(forceKillTimer);
        resolve();
      };

      pluginProcess.once('exit', cleanup);
      try {
        if (pluginProcess.exitCode !== null || pluginProcess.kill('SIGTERM') === false) {
          cleanup();
          return;
        }
      } catch {
        cleanup();
        return;
      }

      forceKillTimer = setTimeout(() => {
        try {
          pluginProcess.kill('SIGKILL');
        } catch {
          // The process may have exited between the timer and kill call.
        }
        cleanup();
      }, forceKillTimeoutMs);
    }).finally(() => {
      stoppingProcesses.delete(pluginProcess);
      pluginProcesses.delete(pluginProcess);
    });

    stoppingProcesses.set(pluginProcess, stopPromise);
    return stopPromise;
  }

  /**
   * Start a plugin's server subprocess.
   * The plugin's server entry must print a JSON line with { ready: true, port: <number> }.
   */
  function startPluginServer(name, pluginDir, serverEntry) {
    if (stoppingAll) return Promise.reject(pluginShutdownError());
    if (runningPlugins.has(name)) {
      return Promise.resolve(runningPlugins.get(name).port);
    }

    const existingStart = startingPlugins.get(name);
    if (existingStart) return existingStart.promise;

    const state = {
      process: null,
      promise: null,
      stopRequested: false,
    };
    const startPromise = new Promise((resolve, reject) => {
      const serverPath = path.join(pluginDir, serverEntry);
      const nodeSpec = createNodeSpawnSpec([serverPath], {
        environment: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          USERPROFILE: process.env.USERPROFILE,
          NODE_ENV: process.env.NODE_ENV || 'production',
          PLUGIN_NAME: name,
        },
      });
      const pluginProcess = spawnProcess(nodeSpec.command, nodeSpec.args, {
        cwd: pluginDir,
        env: nodeSpec.environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      state.process = pluginProcess;
      pluginProcesses.add(pluginProcess);

      let settled = false;
      let stdout = '';
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        void terminateProcess(pluginProcess);
        reject(new Error('Plugin server did not report ready within 10 seconds'));
      }, startupTimeoutMs);

      pluginProcess.stdout.on('data', (data) => {
        if (settled) return;
        stdout += data.toString();

        for (const line of stdout.split('\n')) {
          try {
            const message = JSON.parse(line.trim());
            if (!message.ready || typeof message.port !== 'number') continue;

            clearTimeout(timeout);
            settled = true;
            if (state.stopRequested || stoppingAll) {
              void terminateProcess(pluginProcess);
              reject(pluginShutdownError());
              return;
            }

            runningPlugins.set(name, { process: pluginProcess, port: message.port });
            pluginProcess.on('exit', () => {
              const current = runningPlugins.get(name);
              if (current?.process === pluginProcess) runningPlugins.delete(name);
            });

            logger.log(`[Plugins] Server started for "${name}" on port ${message.port}`);
            resolve(message.port);
            return;
          } catch {
            // Not a complete JSON ready line yet, keep buffering.
          }
        }
      });

      pluginProcess.stderr.on('data', (data) => {
        logger.warn(`[Plugin:${name}] ${data.toString().trim()}`);
      });

      pluginProcess.on('error', (error) => {
        clearTimeout(timeout);
        if (settled) return;
        settled = true;
        reject(new Error(`Failed to start plugin server: ${error.message}`));
      });

      pluginProcess.on('exit', (code) => {
        clearTimeout(timeout);
        pluginProcesses.delete(pluginProcess);
        const current = runningPlugins.get(name);
        if (current?.process === pluginProcess) runningPlugins.delete(name);
        if (settled) return;
        settled = true;
        reject(new Error(`Plugin server exited with code ${code} before reporting ready`));
      });
    });

    state.promise = startPromise.finally(() => {
      if (startingPlugins.get(name) === state) startingPlugins.delete(name);
    });
    startingPlugins.set(name, state);
    return state.promise;
  }

  /** Stop a running plugin server and wait until it exits. */
  async function stopPluginServer(name) {
    const entry = runningPlugins.get(name);
    if (!entry) return;

    await terminateProcess(entry.process);
    if (runningPlugins.get(name)?.process === entry.process) runningPlugins.delete(name);
    logger.log(`[Plugins] Server stopped for "${name}"`);
  }

  function getPluginPort(name) {
    return runningPlugins.get(name)?.port ?? null;
  }

  function isPluginRunning(name) {
    return runningPlugins.has(name);
  }

  /** Stop running and in-flight plugin children, and reject any later starts. */
  async function stopAllPlugins() {
    stoppingAll = true;
    const pendingStarts = [...startingPlugins.entries()];
    for (const [, state] of pendingStarts) state.stopRequested = true;

    const stops = [...runningPlugins.keys()].map((name) => stopPluginServer(name));
    stops.push(...[...pluginProcesses].map((pluginProcess) => terminateProcess(pluginProcess)));
    for (const [, state] of pendingStarts) {
      stops.push(Promise.allSettled([
        terminateProcess(state.process),
        state.promise,
      ]));
    }
    await Promise.all(stops);
  }

  /** Start servers for all enabled plugins that have a server entry. */
  async function startEnabledPluginServers() {
    const plugins = scan();
    const config = readConfig();

    for (const plugin of plugins) {
      if (!plugin.server) continue;
      if (config[plugin.name]?.enabled === false) continue;

      const pluginDir = resolvePluginDir(plugin.name);
      if (!pluginDir) continue;

      try {
        await startPluginServer(plugin.name, pluginDir, plugin.server);
      } catch (error) {
        logger.error(`[Plugins] Failed to start server for "${plugin.name}":`, error.message);
      }
    }
  }

  return {
    getPluginPort,
    isPluginRunning,
    startEnabledPluginServers,
    startPluginServer,
    stopAllPlugins,
    stopPluginServer,
  };
}

const pluginProcessManager = createPluginProcessManager();

export const getPluginPort = (...args) => pluginProcessManager.getPluginPort(...args);
export const isPluginRunning = (...args) => pluginProcessManager.isPluginRunning(...args);
export const startEnabledPluginServers = (...args) => pluginProcessManager.startEnabledPluginServers(...args);
export const startPluginServer = (...args) => pluginProcessManager.startPluginServer(...args);
export const stopAllPlugins = (...args) => pluginProcessManager.stopAllPlugins(...args);
export const stopPluginServer = (...args) => pluginProcessManager.stopPluginServer(...args);
