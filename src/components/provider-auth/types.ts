import type { LLMProvider } from '../../types/app';
import { IS_PLATFORM } from '../../constants/config';

export type ProviderAuthStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error: string | null;
  loading: boolean;
};

const ALL_CLI_PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'codex', 'gemini'];

export type ProviderAuthStatusMap = Record<LLMProvider, ProviderAuthStatus>;

// In platform/remote deployments, only Claude login is exposed in the UI.
export const CLI_PROVIDERS: LLMProvider[] = IS_PLATFORM ? ['claude'] : ALL_CLI_PROVIDERS;

export const PROVIDER_AUTH_STATUS_ENDPOINTS: Record<LLMProvider, string> = {
  claude: '/api/providers/claude/auth/status',
  cursor: '/api/providers/cursor/auth/status',
  codex: '/api/providers/codex/auth/status',
  gemini: '/api/providers/gemini/auth/status',
};

export const createInitialProviderAuthStatusMap = (loading = true): ProviderAuthStatusMap => ({
  claude: { authenticated: false, email: null, method: null, error: null, loading },
  cursor: { authenticated: false, email: null, method: null, error: null, loading },
  codex: { authenticated: false, email: null, method: null, error: null, loading },
  gemini: { authenticated: false, email: null, method: null, error: null, loading },
});
