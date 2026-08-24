import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useClaudeEnvironmentSettings } from '../../../hooks/useClaudeEnvironmentSettings';
import { Alert, AlertDescription, Button, Input } from '../../../../../shared/view/ui';
import SettingsCard from '../../SettingsCard';
import SettingsSection from '../../SettingsSection';

import type {
  ClaudeEnvAllowlistEntry,
  ClaudeEnvDenyMatchType,
  ClaudeEnvDenyRule,
  ClaudePersonalEnvVariable,
} from './types';
import { getClaudeEnvDenyRuleId } from './types';

type PersonalVariableDraft = {
  id: string;
  name: string;
  originalName: string | null;
  value: string;
  originalValue: string | null;
  encrypted: boolean;
  originalEncrypted: boolean;
  configured: boolean;
  serverValueAvailable: boolean;
  replacementTouched: boolean;
  nameTouched: boolean;
};

type VariablePolicyValidation = {
  valid: boolean;
  code: 'allowed' | 'required' | 'invalidSyntax' | 'duplicate' | 'builtInDeny' | 'platformDeny' | 'notAllowed';
  allowlistEntry?: ClaudeEnvAllowlistEntry;
  denyRule?: ClaudeEnvDenyRule;
};

type ActionStatus = 'idle' | 'saving' | 'success';

const shellEnvironmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const denyMatchTypeRank: Record<ClaudeEnvDenyMatchType, number> = {
  exact: 0,
  prefix: 1,
  suffix: 2,
  contains: 3,
};
function getActionError(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message || error.message === 'requestFailed') {
    return fallback;
  }
  return error.message;
}

function getUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

let personalVariableDraftSequence = 0;

function createPersonalDraft(variable: ClaudePersonalEnvVariable | null = null): PersonalVariableDraft {
  personalVariableDraftSequence += 1;
  const serverValueAvailable = typeof variable?.value === 'string';
  return {
    id: `personal-environment-variable-${personalVariableDraftSequence}`,
    name: variable?.name || '',
    originalName: variable?.name || null,
    value: serverValueAvailable ? variable.value || '' : '',
    originalValue: serverValueAvailable ? variable.value || '' : null,
    encrypted: variable?.encrypted === true,
    originalEncrypted: variable?.encrypted === true,
    configured: variable?.configured === true,
    serverValueAvailable,
    replacementTouched: variable == null,
    nameTouched: variable != null,
  };
}

function environmentNameKey(value: string): string {
  return value.trim().toUpperCase();
}

function compareNoCaseAscii(left: string, right: string): number {
  const normalizedLeft = left.toUpperCase();
  const normalizedRight = right.toUpperCase();
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  return 0;
}

function compareDenyRuleIds(left: ClaudeEnvDenyRule, right: ClaudeEnvDenyRule): number {
  const leftId = Number(getClaudeEnvDenyRuleId(left));
  const rightId = Number(getClaudeEnvDenyRuleId(right));
  if (Number.isFinite(leftId) && Number.isFinite(rightId)) return leftId - rightId;
  return compareNoCaseAscii(
    String(getClaudeEnvDenyRuleId(left) ?? ''),
    String(getClaudeEnvDenyRuleId(right) ?? ''),
  );
}

function compareDenyRules(left: ClaudeEnvDenyRule, right: ClaudeEnvDenyRule): number {
  return denyMatchTypeRank[left.matchType] - denyMatchTypeRank[right.matchType]
    || right.pattern.length - left.pattern.length
    || compareNoCaseAscii(left.pattern, right.pattern)
    || compareDenyRuleIds(left, right);
}

function denyRuleMatches(name: string, rule: ClaudeEnvDenyRule): boolean {
  if (rule.enabled === false) return false;
  const normalizedName = environmentNameKey(name);
  const normalizedPattern = environmentNameKey(rule.pattern);
  if (!normalizedPattern) return false;
  if (rule.matchType === 'exact') return normalizedName === normalizedPattern;
  if (rule.matchType === 'prefix') return normalizedName.startsWith(normalizedPattern);
  if (rule.matchType === 'suffix') return normalizedName.endsWith(normalizedPattern);
  return normalizedName.includes(normalizedPattern);
}

function findMatchingDenyRule(name: string, rules: ClaudeEnvDenyRule[]): ClaudeEnvDenyRule | undefined {
  return [...rules].sort(compareDenyRules).find((rule) => denyRuleMatches(name, rule));
}

function isPersonalDraftChanged(draft: PersonalVariableDraft): boolean {
  if (!draft.originalName) return true;
  if (environmentNameKey(draft.name) !== environmentNameKey(draft.originalName)) return true;
  if (draft.encrypted !== draft.originalEncrypted) return true;
  if (!draft.replacementTouched) return false;
  if (!draft.serverValueAvailable) return true;
  return draft.value !== (draft.originalValue || '');
}

function validatePersonalVariableName(
  name: string,
  duplicateNameKeys: Set<string>,
  allowlistByName: Map<string, ClaudeEnvAllowlistEntry>,
  builtInRules: ClaudeEnvDenyRule[],
  platformRules: ClaudeEnvDenyRule[],
): VariablePolicyValidation {
  const trimmedName = name.trim();
  if (!trimmedName) return { valid: false, code: 'required' };
  if (!shellEnvironmentNamePattern.test(trimmedName)) return { valid: false, code: 'invalidSyntax' };
  if (duplicateNameKeys.has(environmentNameKey(trimmedName))) return { valid: false, code: 'duplicate' };

  const builtInRule = findMatchingDenyRule(trimmedName, builtInRules);
  if (builtInRule) return { valid: false, code: 'builtInDeny', denyRule: builtInRule };
  const platformRule = findMatchingDenyRule(trimmedName, platformRules);
  if (platformRule) return { valid: false, code: 'platformDeny', denyRule: platformRule };

  const allowlistEntry = allowlistByName.get(environmentNameKey(trimmedName));
  if (!allowlistEntry) return { valid: false, code: 'notAllowed' };
  return { valid: true, code: 'allowed', allowlistEntry };
}

function VariablePolicyHint({ validation }: { validation: VariablePolicyValidation }) {
  const { t } = useTranslation('settings');
  if (validation.valid || validation.code === 'allowed') return null;

  const messageKey = {
    required: 'claudeEnv.personal.policy.required',
    invalidSyntax: 'claudeEnv.personal.policy.invalidSyntax',
    duplicate: 'claudeEnv.personal.policy.duplicate',
    builtInDeny: 'claudeEnv.personal.policy.builtInDeny',
    platformDeny: 'claudeEnv.personal.policy.platformDeny',
    notAllowed: 'claudeEnv.personal.policy.notAllowed',
  }[validation.code];

  return (
    <p className="flex items-start gap-1 text-xs text-destructive">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
      <span>
        {t(messageKey, { pattern: validation.denyRule?.pattern || '' })}
        {validation.denyRule?.reason ? ` — ${validation.denyRule.reason}` : ''}
      </span>
    </p>
  );
}

export default function ClaudeEnvironmentSettingsTab() {
  const { t } = useTranslation('settings');
  const {
    allowlist,
    personalVariables,
    builtInRules,
    platformRules,
    isLoading,
    loadError,
    refresh,
    savePersonalVariables,
  } = useClaudeEnvironmentSettings();

  const [personalDrafts, setPersonalDrafts] = useState<PersonalVariableDraft[]>([]);
  const [personalStatus, setPersonalStatus] = useState<ActionStatus>('idle');
  const [deletingVariableName, setDeletingVariableName] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const allowlistByName = useMemo(() => new Map(
    allowlist.map((entry) => [environmentNameKey(entry.name), entry]),
  ), [allowlist]);

  const duplicateNameKeys = useMemo(() => {
    const nameCounts = new Map<string, number>();
    for (const draft of personalDrafts) {
      const nameKey = environmentNameKey(draft.name);
      if (nameKey) nameCounts.set(nameKey, (nameCounts.get(nameKey) || 0) + 1);
    }
    return new Set(
      [...nameCounts.entries()]
        .filter(([, count]) => count > 1)
        .map(([nameKey]) => nameKey),
    );
  }, [personalDrafts]);

  const personalValidations = useMemo(() => new Map(personalDrafts.map((draft) => [
    draft.id,
    validatePersonalVariableName(
      draft.name,
      duplicateNameKeys,
      allowlistByName,
      builtInRules,
      platformRules,
    ),
  ])), [allowlistByName, builtInRules, duplicateNameKeys, personalDrafts, platformRules]);

  const hasPersonalChanges = personalDrafts.some((draft) => isPersonalDraftChanged(draft));
  const isPersonalMutating = personalStatus === 'saving' || deletingVariableName !== null;

  const addPersonalVariable = () => {
    setPersonalDrafts((drafts) => [...drafts, createPersonalDraft()]);
    setPersonalStatus('idle');
    setRestartRequired(false);
    setActionError(null);
  };

  const updatePersonalDraft = (id: string, patch: Partial<PersonalVariableDraft>) => {
    setPersonalDrafts((drafts) => drafts.map((draft) => (
      draft.id === id ? { ...draft, ...patch } : draft
    )));
    setPersonalStatus('idle');
    setRestartRequired(false);
    setActionError(null);
  };

  const finishEditingPersonalName = (draft: PersonalVariableDraft) => {
    const trimmedName = draft.name.trim();
    const nameKey = environmentNameKey(trimmedName);
    const canonicalName = draft.originalName && nameKey === environmentNameKey(draft.originalName)
      ? draft.originalName
      : allowlistByName.get(nameKey)?.name || trimmedName;
    updatePersonalDraft(draft.id, { name: canonicalName, nameTouched: true });
  };

  const removePersonalVariable = (draft: PersonalVariableDraft) => {
    setPersonalDrafts((drafts) => drafts.filter((item) => item.id !== draft.id));
    setPersonalStatus('idle');
    setRestartRequired(false);
    setActionError(null);
  };

  const savePersonal = async () => {
    setPersonalDrafts((drafts) => drafts.map((draft) => ({ ...draft, nameTouched: true })));

    const upsertDrafts = personalDrafts;
    const invalidDraft = upsertDrafts.find((draft) => !personalValidations.get(draft.id)?.valid);
    if (invalidDraft) {
      setActionError(t('claudeEnv.errors.fixVariablePolicy'));
      return;
    }

    const missingReplacement = upsertDrafts.find((draft) => (
      draft.configured
      && !draft.serverValueAvailable
      && !draft.replacementTouched
    ));
    if (missingReplacement) {
      setActionError(t('claudeEnv.personal.replacementRequired', { name: missingReplacement.name }));
      return;
    }

    const tooLong = upsertDrafts.find((draft) => {
      const maxLength = personalValidations.get(draft.id)?.allowlistEntry?.maxLength;
      return typeof maxLength === 'number' && getUtf8ByteLength(draft.value) > maxLength;
    });
    if (tooLong) {
      const maxLength = personalValidations.get(tooLong.id)?.allowlistEntry?.maxLength;
      setActionError(t('claudeEnv.personal.valueTooLong', {
        name: tooLong.name,
        maxLength,
      }));
      return;
    }

    const containsNul = upsertDrafts.find((draft) => draft.value.includes('\0'));
    if (containsNul) {
      setActionError(t('claudeEnv.personal.valueContainsNul', { name: containsNul.name }));
      return;
    }

    const upserts = upsertDrafts.map((draft) => ({
      name: personalValidations.get(draft.id)?.allowlistEntry?.name || draft.name.trim(),
      value: draft.value,
      encrypted: draft.encrypted,
    }));

    setPersonalStatus('saving');
    setActionError(null);
    try {
      const needsRestart = await savePersonalVariables({
        upserts,
        deletes: [],
      });
      setPersonalDrafts([]);
      setRestartRequired(needsRestart);
      setPersonalStatus('success');
    } catch (error) {
      setPersonalStatus('idle');
      setActionError(getActionError(error, t('claudeEnv.errors.savePersonal')));
    }
  };

  const deleteConfiguredVariable = async (variable: ClaudePersonalEnvVariable) => {
    if (!window.confirm(t('claudeEnv.personal.deleteConfiguredConfirm', { name: variable.name }))) return;

    setDeletingVariableName(variable.name);
    setPersonalStatus('idle');
    setActionError(null);
    try {
      const needsRestart = await savePersonalVariables({
        upserts: [],
        deletes: [variable.name],
      });
      setRestartRequired(needsRestart);
    } catch (error) {
      setActionError(getActionError(error, t('claudeEnv.errors.savePersonal')));
    } finally {
      setDeletingVariableName(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {t('claudeEnv.loading')}
      </div>
    );
  }

  if (loadError) {
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
          <span>{getActionError(new Error(loadError), t('claudeEnv.errors.load'))}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => void refresh()}>
            <RefreshCw />
            {t('claudeEnv.retry')}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-8">
      <SettingsSection
        title={t('claudeEnv.personal.title')}
        description={t('claudeEnv.personal.description')}
      >
        <SettingsCard className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/20 p-4">
            <p className="text-xs text-muted-foreground">{t('claudeEnv.personal.globalHelp')}</p>
            <div className="flex flex-wrap items-center gap-2">
              {personalStatus === 'success' ? (
                <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                  <Check className="h-4 w-4" />
                  {t('claudeEnv.personal.saved')}
                </span>
              ) : null}
              <Button
                type="button"
                variant="outline"
                onClick={addPersonalVariable}
                disabled={isPersonalMutating}
              >
                <Plus />
                {t('claudeEnv.personal.add')}
              </Button>
              <Button
                type="button"
                onClick={() => void savePersonal()}
                disabled={!hasPersonalChanges || isPersonalMutating}
              >
                {personalStatus === 'saving' ? <Loader2 className="animate-spin" /> : <Save />}
                {personalStatus === 'saving' ? t('claudeEnv.personal.saving') : t('claudeEnv.personal.save')}
              </Button>
            </div>
          </div>
          <div>
            <table className="w-full table-fixed text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="w-[28%] px-2 py-2 text-left font-medium sm:px-3">{t('claudeEnv.personal.name')}</th>
                  <th className="px-2 py-2 text-left font-medium sm:px-3">{t('claudeEnv.personal.value')}</th>
                  <th className="w-14 px-2 py-2 text-center font-medium sm:w-20">{t('claudeEnv.personal.encrypted')}</th>
                  <th className="w-14 px-2 py-2 text-center font-medium sm:w-16">{t('claudeEnv.personal.deleteColumn')}</th>
                </tr>
              </thead>
              <tbody>
                {personalDrafts.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-8 text-center text-sm text-muted-foreground">
                      {t('claudeEnv.personal.empty')}
                    </td>
                  </tr>
                ) : personalDrafts.map((draft) => {
                  const validation = personalValidations.get(draft.id) as VariablePolicyValidation;
                  const maxLength = validation.allowlistEntry?.maxLength;
                  const needsReplacement = draft.configured
                    && !draft.serverValueAvailable
                    && !draft.replacementTouched;
                  const valueTooLong = validation.valid
                    && typeof maxLength === 'number'
                    && getUtf8ByteLength(draft.value) > maxLength;
                  const valueContainsNul = validation.valid && draft.value.includes('\0');
                  return (
                    <tr key={draft.id} className="border-t border-border align-top">
                      <td className="space-y-1.5 px-2 py-3 sm:px-3">
                        <Input
                          value={draft.name}
                          disabled={isPersonalMutating}
                          className={draft.nameTouched && !validation.valid ? 'border-destructive focus-visible:ring-destructive' : undefined}
                          placeholder={t('claudeEnv.personal.namePlaceholder')}
                          autoCapitalize="none"
                          autoComplete="off"
                          spellCheck={false}
                          onChange={(event) => updatePersonalDraft(draft.id, {
                            name: event.target.value,
                            nameTouched: false,
                          })}
                          onBlur={() => finishEditingPersonalName(draft)}
                        />
                        {draft.nameTouched ? <VariablePolicyHint validation={validation} /> : null}
                      </td>
                      <td className="space-y-1.5 px-2 py-3 sm:px-3">
                        <Input
                          type={draft.encrypted ? 'password' : 'text'}
                          value={draft.value}
                          disabled={isPersonalMutating}
                          className={valueTooLong || valueContainsNul ? 'border-destructive focus-visible:ring-destructive' : undefined}
                          autoComplete="new-password"
                          spellCheck={false}
                          placeholder={needsReplacement
                            ? t('claudeEnv.personal.replacePlaceholder')
                            : t('claudeEnv.personal.valuePlaceholder')}
                          onChange={(event) => updatePersonalDraft(draft.id, {
                            value: event.target.value,
                            replacementTouched: true,
                          })}
                        />
                        {needsReplacement ? (
                          <p className="text-xs text-muted-foreground">{t('claudeEnv.personal.encryptedConfiguredHelp')}</p>
                        ) : valueTooLong ? (
                          <p className="text-xs text-destructive">
                            {t('claudeEnv.personal.valueTooLong', { name: draft.name, maxLength })}
                          </p>
                        ) : valueContainsNul ? (
                          <p className="text-xs text-destructive">
                            {t('claudeEnv.personal.valueContainsNul', { name: draft.name })}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-2 py-3 text-center align-middle">
                        <label className="inline-flex cursor-pointer items-center justify-center">
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-input accent-primary"
                            checked={draft.encrypted}
                            disabled={isPersonalMutating}
                            aria-label={t('claudeEnv.personal.encryptedFor', { name: draft.name })}
                            onChange={(event) => updatePersonalDraft(draft.id, { encrypted: event.target.checked })}
                          />
                        </label>
                      </td>
                      <td className="px-2 py-3 text-center align-middle">
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="text-muted-foreground hover:text-destructive"
                          disabled={isPersonalMutating}
                          aria-label={t('claudeEnv.personal.delete', { name: draft.name })}
                          onClick={() => removePersonalVariable(draft)}
                        >
                          <Trash2 />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </SettingsCard>

        <SettingsCard className="overflow-hidden">
          <div className="border-b border-border bg-muted/20 p-4">
            <h3 className="text-sm font-medium text-foreground">
              {t('claudeEnv.personal.configuredTitle')}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('claudeEnv.personal.configuredDescription')}
            </p>
          </div>
          <table className="w-full table-fixed text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="w-[28%] px-2 py-2 text-left font-medium sm:px-3">{t('claudeEnv.personal.name')}</th>
                <th className="px-2 py-2 text-left font-medium sm:px-3">{t('claudeEnv.personal.value')}</th>
                <th className="w-14 px-2 py-2 text-center font-medium sm:w-20">{t('claudeEnv.personal.encrypted')}</th>
                <th className="w-14 px-2 py-2 text-center font-medium sm:w-16">{t('claudeEnv.personal.deleteColumn')}</th>
              </tr>
            </thead>
            <tbody>
              {personalVariables.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-8 text-center text-sm text-muted-foreground">
                    {t('claudeEnv.personal.configuredEmpty')}
                  </td>
                </tr>
              ) : personalVariables.map((variable) => {
                const isDeleting = deletingVariableName != null
                  && environmentNameKey(deletingVariableName) === environmentNameKey(variable.name);
                return (
                  <tr key={variable.name} className="border-t border-border align-middle">
                    <td className="min-w-0 px-2 py-3 sm:px-3">
                      <div className="truncate font-mono text-foreground">{variable.name}</div>
                    </td>
                    <td className="min-w-0 px-2 py-3 sm:px-3">
                      <div className="break-all text-muted-foreground">
                        {variable.encrypted
                          ? '••••••••'
                          : typeof variable.value === 'string'
                            ? variable.value
                            : t('claudeEnv.personal.configuredValueHidden')}
                      </div>
                    </td>
                    <td className="px-2 py-3 text-center align-middle">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-input accent-primary"
                        checked={variable.encrypted}
                        disabled
                        readOnly
                        aria-label={t('claudeEnv.personal.encryptedFor', { name: variable.name })}
                      />
                    </td>
                    <td className="px-2 py-3 text-center align-middle">
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive"
                        disabled={isPersonalMutating}
                        aria-label={t('claudeEnv.personal.deleteConfigured', { name: variable.name })}
                        onClick={() => void deleteConfiguredVariable(variable)}
                      >
                        {isDeleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </SettingsCard>
        {restartRequired ? (
          <Alert>
            <RefreshCw />
            <AlertDescription>{t('claudeEnv.personal.restartRequired')}</AlertDescription>
          </Alert>
        ) : null}
      </SettingsSection>

      {actionError ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
