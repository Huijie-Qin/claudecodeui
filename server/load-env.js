// Load environment variables from .env before other imports execute.
import fs from 'fs';
import os from 'os';
import path from 'path';

import { findAppRoot, getModuleDir } from './utils/runtime-paths.js';
import { applyEnvFileContents } from './utils/env-loader.js';
import {
  applyAuthoritativeDesktopRuntimeEnvironment,
  captureDesktopParentEnvironment,
} from './services/desktop-runtime.js';

const __dirname = getModuleDir(import.meta.url);
// Resolve the repo/app root via the nearest /server folder so this file keeps finding the
// same top-level .env file from both /server/load-env.js and /dist-server/server/load-env.js.
const APP_ROOT = findAppRoot(__dirname);
// The utility-process environment is authoritative. Remember this before loading
// .env because an old OSS configuration must not be able to turn desktop mode off.
const desktopParentEnvironment = captureDesktopParentEnvironment(process.env);
const userHomeFromParent = os.homedir();
const DEFAULT_DATABASE_PATH = path.join(userHomeFromParent, '.cloudcli', 'auth.db');
const DEFAULT_RUNTIME_ROOT = path.join(userHomeFromParent, '.cloudcli', 'runtimes');
const DEFAULT_CLAUDE_CONFIG_PATH = path.join(userHomeFromParent, '.claude');

try {
  const envPath = path.join(APP_ROOT, '.env');
  const envFile = fs.readFileSync(envPath, 'utf8');
  applyEnvFileContents(envFile);
} catch (e) {
  console.log('No .env file found or error reading it:', e.message);
}

// The utility-process environment remains authoritative after loading .env. Desktop
// always uses its private local database and OSS authentication mode; a normal web
// process keeps the exact mode value it had before .env was read.
applyAuthoritativeDesktopRuntimeEnvironment(process.env, {
  parentEnvironment: desktopParentEnvironment,
  databasePath: DEFAULT_DATABASE_PATH,
  runtimeRoot: DEFAULT_RUNTIME_ROOT,
  claudeConfigPath: DEFAULT_CLAUDE_CONFIG_PATH,
});

if (!process.env.DATABASE_PATH) {
  process.env.DATABASE_PATH = DEFAULT_DATABASE_PATH;
}
