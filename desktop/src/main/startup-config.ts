import type { ProxyConfig } from 'electron';

const HOME_URL_ARGUMENTS = new Set([
  '--desktop-home-url',
  '--DESKTOP_HOME_URL',
]);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

interface ResolveDesktopHomeUrlOptions {
  argv: readonly string[];
  environmentValue?: string;
  builtValue: string;
  production: boolean;
  allowInsecureHttp: boolean;
}

function commandLineHomeUrl(argv: readonly string[]): string | undefined {
  let value: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const separatorIndex = argument.indexOf('=');
    const name = separatorIndex < 0 ? argument : argument.slice(0, separatorIndex);
    if (!HOME_URL_ARGUMENTS.has(name)) {
      continue;
    }

    if (separatorIndex >= 0) {
      value = argument.slice(separatorIndex + 1);
      continue;
    }

    const nextArgument = argv[index + 1];
    if (nextArgument === undefined || nextArgument.startsWith('--')) {
      throw new Error(`${name} requires a URL value.`);
    }
    value = nextArgument;
    index += 1;
  }

  return value;
}

export function resolveDesktopHomeUrl(options: ResolveDesktopHomeUrlOptions): string {
  const value = commandLineHomeUrl(options.argv)
    ?? options.environmentValue
    ?? options.builtValue;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('DESKTOP_HOME_URL must be an absolute URL.');
  }

  if (parsed.username || parsed.password) {
    throw new Error('DESKTOP_HOME_URL must not contain credentials.');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('DESKTOP_HOME_URL must not contain a query or fragment.');
  }

  const developmentLoopback = !options.production
    && parsed.protocol === 'http:'
    && LOOPBACK_HOSTS.has(parsed.hostname);
  const explicitlyAllowedHttp = options.allowInsecureHttp && parsed.protocol === 'http:';
  if (parsed.protocol !== 'https:' && !developmentLoopback && !explicitlyAllowedHttp) {
    throw new Error(
      'DESKTOP_HOME_URL must use HTTPS unless insecure HTTP is enabled for this build.',
    );
  }

  return parsed.href;
}

export function createDirectProxyConfig(): ProxyConfig {
  return {
    mode: 'direct',
  };
}
