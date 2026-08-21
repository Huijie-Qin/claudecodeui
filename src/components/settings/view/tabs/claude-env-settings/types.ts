export type ClaudeEnvAllowlistEntry = {
  name: string;
  maxLength?: number;
};

export type ClaudePersonalEnvVariable = {
  name: string;
  configured: boolean;
  encrypted: boolean;
  value?: string;
};

export type ClaudeEffectiveEnvSource = 'personal' | 'tenant' | 'admin_user' | 'dotenv' | 'managed';

export type ClaudeEffectiveEnvVariable = {
  name: string;
  source: ClaudeEffectiveEnvSource | null;
  configured: boolean;
  encrypted?: boolean;
  blocked?: boolean;
  blockedReason?: string;
  value?: string;
};

export type ClaudeEnvDenyMatchType = 'exact' | 'prefix' | 'suffix' | 'contains';

export type ClaudeEnvDenyRule = {
  id?: number | string;
  ruleId?: number | string;
  matchType: ClaudeEnvDenyMatchType;
  pattern: string;
  reason?: string;
  enabled?: boolean;
};

export type ClaudePersonalEnvResponse = {
  variables?: ClaudePersonalEnvVariable[];
  allowlist?: ClaudeEnvAllowlistEntry[];
  restartRequired?: boolean;
  error?: string;
  message?: string;
};

export type ClaudeEffectiveEnvResponse = {
  variables?: ClaudeEffectiveEnvVariable[];
  error?: string;
  message?: string;
};

export type ClaudeEnvDenyRulesResponse = {
  builtInRules?: ClaudeEnvDenyRule[];
  platformRules?: ClaudeEnvDenyRule[];
  personalRules?: ClaudeEnvDenyRule[];
  rule?: ClaudeEnvDenyRule;
  error?: string;
  message?: string;
};

export type ClaudePersonalEnvPatch = {
  upserts: Array<{
    name: string;
    value: string;
    encrypted: boolean;
  }>;
  deletes: string[];
};

export type ClaudeEnvDenyRuleInput = {
  matchType: ClaudeEnvDenyMatchType;
  pattern: string;
  reason?: string;
  enabled?: boolean;
};

export function getClaudeEnvDenyRuleId(rule: ClaudeEnvDenyRule): number | string | null {
  return rule.id ?? rule.ruleId ?? null;
}
