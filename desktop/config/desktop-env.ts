import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DESKTOP_ENV_KEYS = ['DESKTOP_UPDATE_BASE_URL'] as const;

type DesktopEnvKey = (typeof DESKTOP_ENV_KEYS)[number];
type DesktopEnvValues = Partial<Record<DesktopEnvKey, string>>;

export interface DesktopBuildConfig {
  updateBaseUrl: string;
}

const DESKTOP_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function parseDesktopEnvContents(contents: string): DesktopEnvValues {
  const allowedKeys = new Set<string>(DESKTOP_ENV_KEYS);
  const values: DesktopEnvValues = {};

  for (const sourceLine of contents.split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const separatorIndex = line.indexOf('=');
    if (separatorIndex < 1) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    if (allowedKeys.has(key)) {
      values[key as DesktopEnvKey] = unquote(line.slice(separatorIndex + 1));
    }
  }

  return values;
}

function requiredValue(values: DesktopEnvValues, key: DesktopEnvKey): string {
  if (!(key in values)) {
    throw new Error(`Missing required desktop configuration: ${key}.`);
  }
  return values[key] ?? '';
}

export function createDesktopBuildConfig(
  values: DesktopEnvValues,
  _options: { production: boolean },
): DesktopBuildConfig {
  const value = requiredValue(values, 'DESKTOP_UPDATE_BASE_URL');
  let updateUrl: URL;
  try {
    updateUrl = new URL(value);
  } catch {
    throw new Error('DESKTOP_UPDATE_BASE_URL must be an absolute URL.');
  }
  if (updateUrl.protocol !== 'https:') {
    throw new Error('DESKTOP_UPDATE_BASE_URL must use HTTPS.');
  }
  if (updateUrl.username || updateUrl.password) {
    throw new Error('DESKTOP_UPDATE_BASE_URL must not contain credentials.');
  }
  if (updateUrl.search || updateUrl.hash) {
    throw new Error('DESKTOP_UPDATE_BASE_URL must not contain a query or fragment.');
  }

  return { updateBaseUrl: updateUrl.href.replace(/\/+$/u, '') };
}

export function loadDesktopBuildConfig(options: { production: boolean }): DesktopBuildConfig {
  const envPath = resolve(DESKTOP_DIRECTORY, '.env.desktop');
  const fileValues = existsSync(envPath)
    ? parseDesktopEnvContents(readFileSync(envPath, 'utf8'))
    : {};
  const merged: DesktopEnvValues = { ...fileValues };

  for (const key of DESKTOP_ENV_KEYS) {
    if (process.env[key] !== undefined) {
      merged[key] = process.env[key];
    }
  }
  if (!options.production && !('DESKTOP_UPDATE_BASE_URL' in merged)) {
    merged.DESKTOP_UPDATE_BASE_URL = 'https://updates.invalid/api/desktop-updates';
  }
  return createDesktopBuildConfig(merged, options);
}
