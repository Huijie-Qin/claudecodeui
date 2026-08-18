export type NavigationDisposition = 'allowed' | 'auth' | 'external' | 'denied';

export interface OriginPolicy {
  allowedOrigins: ReadonlySet<string>;
  authOrigins: ReadonlySet<string>;
}

export function getOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function isExactAllowedOrigin(
  value: string,
  origins: ReadonlySet<string>,
): boolean {
  const origin = getOrigin(value);
  return origin !== null && origins.has(origin);
}

export function classifyNavigation(
  value: string,
  policy: OriginPolicy,
): NavigationDisposition {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'denied';
  }

  if (parsed.username || parsed.password) {
    return 'denied';
  }
  if (parsed.protocol === 'mailto:') {
    return 'external';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'denied';
  }
  if (policy.allowedOrigins.has(parsed.origin)) {
    return 'allowed';
  }
  if (policy.authOrigins.has(parsed.origin)) {
    return 'auth';
  }
  return parsed.protocol === 'https:' ? 'external' : 'denied';
}
