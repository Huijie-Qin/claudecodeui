import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../../utils/api';
import type {
  ClaudeEnvAllowlistEntry,
  ClaudeEnvDenyRule,
  ClaudeEnvDenyRulesResponse,
  ClaudePersonalEnvPatch,
  ClaudePersonalEnvResponse,
  ClaudePersonalEnvVariable,
} from '../view/tabs/claude-env-settings/types';

type UseClaudeEnvironmentSettingsResult = {
  allowlist: ClaudeEnvAllowlistEntry[];
  personalVariables: ClaudePersonalEnvVariable[];
  builtInRules: ClaudeEnvDenyRule[];
  platformRules: ClaudeEnvDenyRule[];
  isLoading: boolean;
  loadError: string | null;
  refresh: () => Promise<void>;
  savePersonalVariables: (patch: ClaudePersonalEnvPatch) => Promise<boolean>;
};

async function readResponse<T extends { error?: string; message?: string }>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as T;
  if (!response.ok) {
    throw new Error(payload.error || payload.message || 'requestFailed');
  }
  return payload;
}

function sortByName<T extends { name: string }>(values: T[] | undefined): T[] {
  return [...(values || [])].sort((left, right) => left.name.localeCompare(right.name));
}

const denyRuleMatchTypeRank: Record<ClaudeEnvDenyRule['matchType'], number> = {
  exact: 0,
  prefix: 1,
  suffix: 2,
  contains: 3,
};

function compareNoCaseAscii(left: string, right: string): number {
  const normalizedLeft = left.toUpperCase();
  const normalizedRight = right.toUpperCase();
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  return 0;
}

function compareDenyRuleIds(left: ClaudeEnvDenyRule, right: ClaudeEnvDenyRule): number {
  const leftId = Number(left.id ?? left.ruleId);
  const rightId = Number(right.id ?? right.ruleId);
  if (Number.isFinite(leftId) && Number.isFinite(rightId)) return leftId - rightId;
  return compareNoCaseAscii(
    String(left.id ?? left.ruleId ?? ''),
    String(right.id ?? right.ruleId ?? ''),
  );
}

function sortDenyRules(values: ClaudeEnvDenyRule[] | undefined): ClaudeEnvDenyRule[] {
  return [...(values || [])].sort((left, right) => (
    denyRuleMatchTypeRank[left.matchType] - denyRuleMatchTypeRank[right.matchType]
      || right.pattern.length - left.pattern.length
      || compareNoCaseAscii(left.pattern, right.pattern)
      || compareDenyRuleIds(left, right)
  ));
}

export function useClaudeEnvironmentSettings(): UseClaudeEnvironmentSettingsResult {
  const [allowlist, setAllowlist] = useState<ClaudeEnvAllowlistEntry[]>([]);
  const [personalVariables, setPersonalVariables] = useState<ClaudePersonalEnvVariable[]>([]);
  const [builtInRules, setBuiltInRules] = useState<ClaudeEnvDenyRule[]>([]);
  const [platformRules, setPlatformRules] = useState<ClaudeEnvDenyRule[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestSequenceRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestSequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestSequence;
    setIsLoading(true);
    setLoadError(null);

    try {
      const [personalResponse, denyRulesResponse] = await Promise.all([
        api.user.claudePersonalEnv(),
        api.user.claudeEnvDenyRules(),
      ]);
      const [personalPayload, denyRulesPayload] = await Promise.all([
        readResponse<ClaudePersonalEnvResponse>(personalResponse),
        readResponse<ClaudeEnvDenyRulesResponse>(denyRulesResponse),
      ]);

      if (requestSequence !== requestSequenceRef.current) {
        return;
      }

      setAllowlist(sortByName(personalPayload.allowlist));
      setPersonalVariables(sortByName(personalPayload.variables));
      setBuiltInRules(sortDenyRules(denyRulesPayload.builtInRules));
      setPlatformRules(sortDenyRules(denyRulesPayload.platformRules));
    } catch (error) {
      if (requestSequence === requestSequenceRef.current) {
        setLoadError(error instanceof Error ? error.message : 'requestFailed');
      }
    } finally {
      if (requestSequence === requestSequenceRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      requestSequenceRef.current += 1;
    };
  }, [refresh]);

  const savePersonalVariables = useCallback(async (patch: ClaudePersonalEnvPatch) => {
    const response = await api.user.updateClaudePersonalEnv(patch);
    const payload = await readResponse<ClaudePersonalEnvResponse>(response);
    setAllowlist(sortByName(payload.allowlist));
    setPersonalVariables(sortByName(payload.variables));
    return payload.restartRequired === true;
  }, []);

  return {
    allowlist,
    personalVariables,
    builtInRules,
    platformRules,
    isLoading,
    loadError,
    refresh,
    savePersonalVariables,
  };
}
