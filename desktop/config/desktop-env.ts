import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DESKTOP_ENV_KEYS = [
  'DESKTOP_HOME_URL',
  'DESKTOP_UPDATE_BASE_URL',
  'DESKTOP_ALLOWED_ORIGINS',
  'DESKTOP_AUTH_ORIGINS',
  'DESKTOP_ALLOW_INSECURE_HTTP',
] as const;

type DesktopEnvKey = (typeof DESKTOP_ENV_KEYS)[number];
type DesktopEnvValues = Partial<Record<DesktopEnvKey, string>>;

export interface DesktopBuildConfig {
  homeUrl: string;
  updateBaseUrl: string;
  allowedOrigins: string[];
  authOrigins: string[];
  allowInsecureHttp: boolean;
}

const DESKTOP_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

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
    if (!allowedKeys.has(key)) {
      continue;
    }

    values[key as DesktopEnvKey] = unquote(line.slice(separatorIndex + 1));
  }

  return values;
}

interface UrlPolicy {
  production: boolean;
  allowInsecureHttp: boolean;
  updateSource?: boolean;
}

function parseUrl(value: string, key: DesktopEnvKey, policy: UrlPolicy): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${key} must be an absolute URL.`);
  }

  if (parsed.username || parsed.password) {
    throw new Error(`${key} must not contain credentials.`);
  }

  const secure = parsed.protocol === 'https:';
  const developmentLoopback = !policy.updateSource
    && !policy.production
    && parsed.protocol === 'http:'
    && LOOPBACK_HOSTS.has(parsed.hostname);
  const explicitlyAllowedHttp = !policy.updateSource
    && policy.allowInsecureHttp
    && parsed.protocol === 'http:';
  if (!secure && !developmentLoopback && !explicitlyAllowedHttp) {
    const developmentHint = policy.updateSource || policy.production
      ? ''
      : ' (or loopback HTTP in development)';
    const insecureHint = policy.updateSource
      ? ''
      : ' unless DESKTOP_ALLOW_INSECURE_HTTP=true';
    throw new Error(`${key} must use HTTPS${developmentHint}${insecureHint}.`);
  }

  return parsed;
}

function parseOriginList(
  value: string,
  key: 'DESKTOP_ALLOWED_ORIGINS' | 'DESKTOP_AUTH_ORIGINS',
  policy: UrlPolicy,
): string[] {
  if (!value.trim()) {
    return [];
  }

  const origins = value.split(',').map((entry) => {
    const parsed = parseUrl(entry.trim(), key, policy);
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error(`${key} entries must be origins without paths, queries, or fragments.`);
    }
    return parsed.origin;
  });

  return [...new Set(origins)];
}

function optionalBooleanValue(
  values: DesktopEnvValues,
  key: 'DESKTOP_ALLOW_INSECURE_HTTP',
): boolean {
  const value = values[key];
  if (value === undefined) {
    return false;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`${key} must be exactly true or false.`);
}

function requiredValue(values: DesktopEnvValues, key: DesktopEnvKey): string {
  if (!(key in values)) {
    throw new Error(`Missing required desktop configuration: ${key}.`);
  }
  return values[key] ?? '';
}

export function createDesktopBuildConfig(
  values: DesktopEnvValues,
  options: { production: boolean },
): DesktopBuildConfig {
  const homeValue = requiredValue(values, 'DESKTOP_HOME_URL');
  const updateValue = requiredValue(values, 'DESKTOP_UPDATE_BASE_URL');
  const allowedValue = requiredValue(values, 'DESKTOP_ALLOWED_ORIGINS');
  const authValue = requiredValue(values, 'DESKTOP_AUTH_ORIGINS');
  const allowInsecureHttp = optionalBooleanValue(values, 'DESKTOP_ALLOW_INSECURE_HTTP');
  const applicationUrlPolicy: UrlPolicy = {
    production: options.production,
    allowInsecureHttp,
  };

  const homeUrl = parseUrl(homeValue, 'DESKTOP_HOME_URL', applicationUrlPolicy);
  if (homeUrl.search || homeUrl.hash) {
    throw new Error('DESKTOP_HOME_URL must not contain a query or fragment.');
  }

  const updateUrl = parseUrl(updateValue, 'DESKTOP_UPDATE_BASE_URL', {
    production: options.production,
    allowInsecureHttp: false,
    updateSource: true,
  });
  if (updateUrl.search || updateUrl.hash) {
    throw new Error('DESKTOP_UPDATE_BASE_URL must not contain a query or fragment.');
  }

  const allowedOrigins = parseOriginList(
    allowedValue,
    'DESKTOP_ALLOWED_ORIGINS',
    applicationUrlPolicy,
  );
  allowedOrigins.push(homeUrl.origin);
  const uniqueAllowedOrigins = [...new Set(allowedOrigins)];
  const authOrigins = parseOriginList(
    authValue,
    'DESKTOP_AUTH_ORIGINS',
    applicationUrlPolicy,
  );
  const overlappingOrigin = authOrigins.find((origin) => uniqueAllowedOrigins.includes(origin));
  if (overlappingOrigin) {
    throw new Error(
      `DESKTOP_AUTH_ORIGINS must not overlap DESKTOP_ALLOWED_ORIGINS or DESKTOP_HOME_URL: ${overlappingOrigin}.`,
    );
  }

  return {
    homeUrl: homeUrl.href,
    updateBaseUrl: updateUrl.href.replace(/\/+$/u, ''),
    allowedOrigins: uniqueAllowedOrigins,
    authOrigins,
    allowInsecureHttp,
  };
}

export function assertDesktopSigningPolicy(
  config: DesktopBuildConfig,
  options: { requireSigning: boolean },
): void {
  if (options.requireSigning && config.allowInsecureHttp) {
    throw new Error(
      'DESKTOP_ALLOW_INSECURE_HTTP=true is not permitted when DESKTOP_REQUIRE_SIGNING=true.',
    );
  }
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

  if (!options.production && !('DESKTOP_HOME_URL' in merged)) {
    merged.DESKTOP_HOME_URL = 'http://127.0.0.1:5173/';
  }
  if (!options.production && !('DESKTOP_UPDATE_BASE_URL' in merged)) {
    merged.DESKTOP_UPDATE_BASE_URL = 'https://updates.invalid/api/desktop-updates';
  }
  if (!options.production && !('DESKTOP_ALLOWED_ORIGINS' in merged)) {
    merged.DESKTOP_ALLOWED_ORIGINS = 'http://127.0.0.1:5173';
  }
  if (!options.production && !('DESKTOP_AUTH_ORIGINS' in merged)) {
    merged.DESKTOP_AUTH_ORIGINS = '';
  }

  return createDesktopBuildConfig(merged, options);
}
