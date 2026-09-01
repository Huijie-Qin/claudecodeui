import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../../utils/api';
import { Button, Input } from '../../shared/view/ui';

type AdminTenant = {
  id: number;
  code: string;
  name: string;
  status: string;
};

type EnvVariable = {
  name: string;
  value?: string;
  encrypted?: boolean;
  configured?: boolean;
};

type TenantEnvCollectionEntry = {
  tenantId: number;
  code?: string;
  name?: string;
  status?: string;
  variables: EnvVariable[];
};

type TenantEnvCollectionPayload = {
  tenants?: TenantEnvCollectionEntry[];
  error?: string;
  message?: string;
  restartRequired?: boolean;
};

type BatchDeleteDraft = {
  id: string;
  name: string;
};

type EnvDraft = {
  id: string;
  name: string;
  originalName: string | null;
  value: string;
  encrypted: boolean;
  configured: boolean;
  serverValueAvailable: boolean;
  replacementTouched: boolean;
  dirty: boolean;
  deleted: boolean;
};

type AllowlistField = {
  id: string;
  name: string;
  maxLength: number;
};

type AllowlistFieldPayload = Omit<AllowlistField, 'id'>;

type DenyRule = {
  id?: number;
  ruleId?: number;
  matchType: 'exact' | 'prefix' | 'suffix' | 'contains';
  pattern: string;
  reason?: string;
  enabled?: boolean;
};

const denyMatchTypes: DenyRule['matchType'][] = ['exact', 'prefix', 'suffix', 'contains'];
const MAX_BATCH_TENANTS = 500;

type ClaudeEnvManagementProps = {
  tenants: AdminTenant[];
  view: ManagementMode;
};

type ManagementMode = 'tenant' | 'policy';

let draftSequence = 0;
let deleteDraftSequence = 0;
let allowlistFieldSequence = 0;

function createDraft(variable: EnvVariable | null = null): EnvDraft {
  draftSequence += 1;
  const encrypted = variable?.encrypted === true;
  return {
    id: `tenant-claude-env-${draftSequence}`,
    name: variable?.name || '',
    originalName: variable?.name || null,
    value: encrypted ? '' : variable?.value || '',
    encrypted,
    configured: variable?.configured !== false && Boolean(variable?.name),
    serverValueAvailable: !encrypted && typeof variable?.value === 'string',
    replacementTouched: variable == null,
    dirty: variable == null,
    deleted: false,
  };
}

function createDeleteDraft(): BatchDeleteDraft {
  deleteDraftSequence += 1;
  return { id: `tenant-claude-env-delete-${deleteDraftSequence}`, name: '' };
}

function createAllowlistField(field: AllowlistFieldPayload | null = null): AllowlistField {
  allowlistFieldSequence += 1;
  return {
    id: `claude-env-allowlist-${allowlistFieldSequence}`,
    name: field?.name || '',
    maxLength: field ? Number(field.maxLength) || 1 : 1024,
  };
}

async function readPayload<T>(response: Response): Promise<T> {
  return response.json().catch(() => ({} as T)) as Promise<T>;
}

function ruleId(rule: DenyRule): number | null {
  const value = Number(rule.id ?? rule.ruleId);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function collectionTenantId(entry: TenantEnvCollectionEntry): number | null {
  const value = Number(entry.tenantId);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export default function ClaudeEnvManagement({ tenants, view }: ClaudeEnvManagementProps) {
  const { t } = useTranslation('admin');
  const [selectedTenantIds, setSelectedTenantIds] = useState<string[]>([]);
  const [tenantRows, setTenantRows] = useState<EnvDraft[]>([]);
  const [batchRows, setBatchRows] = useState<EnvDraft[]>([]);
  const [batchDeleteRows, setBatchDeleteRows] = useState<BatchDeleteDraft[]>([]);
  const [loadedTenantId, setLoadedTenantId] = useState<string | null>(null);
  const [tenantOverview, setTenantOverview] = useState<TenantEnvCollectionEntry[]>([]);
  const [allowlist, setAllowlist] = useState<AllowlistField[]>([]);
  const [allowlistDrafts, setAllowlistDrafts] = useState<AllowlistField[]>([]);
  const [builtInRules, setBuiltInRules] = useState<DenyRule[]>([]);
  const [platformRules, setPlatformRules] = useState<DenyRule[]>([]);
  const [newRule, setNewRule] = useState<DenyRule>({
    matchType: 'exact',
    pattern: '',
    reason: '',
    enabled: true,
  });
  const [isTenantLoading, setIsTenantLoading] = useState(false);
  const [isOverviewLoading, setIsOverviewLoading] = useState(false);
  const [isPolicyLoading, setIsPolicyLoading] = useState(false);
  const [isPolicyLoaded, setIsPolicyLoaded] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isTenantPickerOpen, setIsTenantPickerOpen] = useState(false);
  const [deletingTenantVariableKey, setDeletingTenantVariableKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const tenantRequestSequenceRef = useRef(0);
  const overviewRequestSequenceRef = useRef(0);
  const tenantSelectionInitializedRef = useRef(false);
  const tenantPickerRef = useRef<HTMLDivElement | null>(null);
  const tenantPickerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const tenantEditorContextRef = useRef<{ selectedTenantIds: string[]; loadedTenantId: string | null }>({
    selectedTenantIds: [],
    loadedTenantId: null,
  });
  const tenantPickerPanelId = useId();

  const activeTenants = useMemo(
    () => tenants.filter((tenant) => tenant.status === 'active'),
    [tenants],
  );

  const tenantId = selectedTenantIds.length === 1 ? selectedTenantIds[0] : '';
  const isBatchMode = selectedTenantIds.length > 1;
  tenantEditorContextRef.current = { selectedTenantIds, loadedTenantId };

  useEffect(() => {
    if (!isTenantPickerOpen) return undefined;

    const handlePointerDown = (event: PointerEvent) => {
      const container = tenantPickerRef.current;
      if (!container || !(event.target instanceof Node) || container.contains(event.target)) return;
      setIsTenantPickerOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setIsTenantPickerOpen(false);
      tenantPickerTriggerRef.current?.focus();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isTenantPickerOpen]);

  useEffect(() => {
    if (view !== 'tenant' || isSaving) setIsTenantPickerOpen(false);
  }, [isSaving, view]);

  useEffect(() => {
    if (view !== 'tenant') return;
    const activeIds = new Set(activeTenants.map((tenant) => String(tenant.id)));
    const stillActive = selectedTenantIds.filter((selectedId) => activeIds.has(selectedId));
    let nextSelection = stillActive;
    if (activeTenants.length > 0) {
      if (!tenantSelectionInitializedRef.current || (selectedTenantIds.length > 0 && stillActive.length === 0)) {
        nextSelection = [String(activeTenants[0].id)];
      }
      tenantSelectionInitializedRef.current = true;
    }
    if (
      nextSelection.length === selectedTenantIds.length
      && nextSelection.every((selectedId, index) => selectedId === selectedTenantIds[index])
    ) return;

    tenantRequestSequenceRef.current += 1;
    setSelectedTenantIds(nextSelection);
    setTenantRows([]);
    setBatchRows([]);
    setBatchDeleteRows([]);
    setLoadedTenantId(null);
    setIsTenantLoading(false);
    setError(null);
    setMessage(null);
  }, [activeTenants, selectedTenantIds, view]);

  const loadTenantVariables = useCallback(async () => {
    const requestSequence = tenantRequestSequenceRef.current + 1;
    tenantRequestSequenceRef.current = requestSequence;
    if (!tenantId) {
      setTenantRows([]);
      setLoadedTenantId(null);
      setIsTenantLoading(false);
      return;
    }
    const requestedTenantId = tenantId;
    setTenantRows([]);
    setLoadedTenantId(null);
    setIsTenantLoading(true);
    setError(null);
    setMessage(null);
    try {
      const response = await api.admin.tenantClaudeEnv(requestedTenantId);
      const payload = await readPayload<{ variables?: EnvVariable[]; error?: string }>(response);
      if (!response.ok) throw new Error(payload.error || t('claudeEnvV2.errors.loadTenant', { defaultValue: 'Failed to load tenant environment variables' }));
      if (requestSequence === tenantRequestSequenceRef.current) {
        setTenantRows((payload.variables || []).map((entry) => createDraft(entry)));
        setLoadedTenantId(requestedTenantId);
      }
    } catch (caughtError) {
      if (requestSequence === tenantRequestSequenceRef.current) {
        setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
      }
    } finally {
      if (requestSequence === tenantRequestSequenceRef.current) {
        setIsTenantLoading(false);
      }
    }
  }, [t, tenantId]);

  const loadTenantOverview = useCallback(async () => {
    const requestSequence = overviewRequestSequenceRef.current + 1;
    overviewRequestSequenceRef.current = requestSequence;
    setIsOverviewLoading(true);
    setOverviewError(null);
    try {
      const response = await api.admin.tenantClaudeEnvOverview();
      const payload = await readPayload<TenantEnvCollectionPayload>(response);
      if (!response.ok) {
        throw new Error(payload.error || payload.message || t('claudeEnvV2.errors.loadOverview', {
          defaultValue: 'Failed to load tenant environment overview',
        }));
      }
      if (requestSequence === overviewRequestSequenceRef.current) {
        setTenantOverview((payload.tenants || []).filter((entry) => collectionTenantId(entry) != null));
      }
    } catch (caughtError) {
      if (requestSequence === overviewRequestSequenceRef.current) {
        setOverviewError(caughtError instanceof Error ? caughtError.message : String(caughtError));
      }
    } finally {
      if (requestSequence === overviewRequestSequenceRef.current) {
        setIsOverviewLoading(false);
      }
    }
  }, [t]);

  const deleteTenantOverviewVariable = async (
    targetTenantId: number,
    targetTenantName: string,
    variableName: string,
  ) => {
    if (deletingTenantVariableKey != null || isSaving || isOverviewLoading || hasTenantDraftChanges) return;
    if (!window.confirm(t('claudeEnvV2.tenant.confirmDeleteConfigured', {
      name: variableName,
      tenant: targetTenantName,
      defaultValue: 'Delete {{name}} from {{tenant}}?',
    }))) return;

    const deletionKey = `${targetTenantId}:${variableName}`;
    overviewRequestSequenceRef.current += 1;
    setIsOverviewLoading(false);
    setDeletingTenantVariableKey(deletionKey);
    setOverviewError(null);
    setMessage(null);
    try {
      const response = await api.admin.updateTenantClaudeEnv(targetTenantId, {
        upserts: [],
        deletes: [variableName],
      });
      const payload = await readPayload<{ variables?: EnvVariable[]; error?: string; message?: string }>(response);
      if (!response.ok) {
        throw new Error(payload.error || payload.message || t('claudeEnvV2.errors.deleteTenantVariable', {
          defaultValue: 'Failed to delete tenant environment variable',
        }));
      }

      const variableNameKey = variableName.toUpperCase();
      setTenantOverview((current) => current.map((entry) => (
        collectionTenantId(entry) === targetTenantId
          ? {
            ...entry,
            variables: payload.variables || entry.variables.filter((variable) => variable.name.toUpperCase() !== variableNameKey),
          }
          : entry
      )));

      const editorContext = tenantEditorContextRef.current;
      if (
        editorContext.selectedTenantIds.length === 1
        && editorContext.selectedTenantIds[0] === String(targetTenantId)
        && editorContext.loadedTenantId === String(targetTenantId)
      ) {
        setTenantRows((rows) => rows.filter((row) => (
          row.dirty
          || !row.originalName
          || row.originalName.toUpperCase() !== variableNameKey
        )));
      }

      setMessage(t('claudeEnvV2.tenant.deleteConfiguredSuccess', {
        name: variableName,
        tenant: targetTenantName,
        defaultValue: 'Deleted {{name}} from {{tenant}}.',
      }));
      await loadTenantOverview();
    } catch (caughtError) {
      setOverviewError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    } finally {
      setDeletingTenantVariableKey(null);
    }
  };

  const loadPolicies = useCallback(async () => {
    setIsPolicyLoading(true);
    setError(null);
    try {
      const [allowlistResponse, denyRulesResponse] = await Promise.all([
        api.admin.claudeEnvAllowlist(),
        api.admin.claudeEnvDenyRules(),
      ]);
      const allowlistPayload = await readPayload<{ fields?: AllowlistFieldPayload[]; error?: string }>(allowlistResponse);
      const denyPayload = await readPayload<{ builtInRules?: DenyRule[]; rules?: DenyRule[]; error?: string }>(denyRulesResponse);
      if (!allowlistResponse.ok) throw new Error(allowlistPayload.error || t('claudeEnvV2.errors.loadPolicy', { defaultValue: 'Failed to load personal environment policy' }));
      if (!denyRulesResponse.ok) throw new Error(denyPayload.error || t('claudeEnvV2.errors.loadPolicy', { defaultValue: 'Failed to load personal environment policy' }));
      setAllowlist((allowlistPayload.fields || []).map((field) => createAllowlistField(field)));
      setBuiltInRules(denyPayload.builtInRules || []);
      setPlatformRules(denyPayload.rules || []);
      setIsPolicyLoaded(true);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    } finally {
      setIsPolicyLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (view !== 'tenant') return;
    void loadTenantVariables();
  }, [loadTenantVariables, view]);

  useEffect(() => {
    if (view !== 'tenant') return;
    void loadTenantOverview();
  }, [loadTenantOverview, view]);

  useEffect(() => {
    if (view !== 'policy') return;
    tenantRequestSequenceRef.current += 1;
    void loadPolicies();
  }, [loadPolicies, view]);

  const singleTenantReady = Boolean(tenantId)
    && loadedTenantId === tenantId
    && !isTenantLoading;
  const batchTenantReady = isBatchMode && !isTenantLoading;
  const tenantReady = (singleTenantReady || batchTenantReady) && deletingTenantVariableKey == null;
  const policyReady = isPolicyLoaded && !isPolicyLoading;
  const hasBatchChanges = batchRows.some((row) => !row.deleted) || batchDeleteRows.length > 0;
  const hasSingleTenantChanges = tenantRows.some((row) => row.dirty);
  const hasTenantDraftChanges = isBatchMode ? hasBatchChanges : hasSingleTenantChanges;

  const changeTenantSelection = (nextTenantIds: string[], truncateToLimit = false) => {
    if (isSaving) return;
    const activeIds = new Set(activeTenants.map((tenant) => String(tenant.id)));
    const requestedTenantIds = Array.from(new Set(nextTenantIds.filter((selectedId) => activeIds.has(selectedId))));
    const exceedsLimit = requestedTenantIds.length > MAX_BATCH_TENANTS;
    if (exceedsLimit && !truncateToLimit) {
      setError(t('claudeEnvV2.errors.batchTenantLimit', {
        defaultValue: 'Select no more than {{count}} tenants per batch',
        count: MAX_BATCH_TENANTS,
      }));
      return;
    }
    const uniqueNextIds = exceedsLimit
      ? requestedTenantIds.slice(0, MAX_BATCH_TENANTS)
      : requestedTenantIds;
    if (
      uniqueNextIds.length === selectedTenantIds.length
      && uniqueNextIds.every((selectedId, index) => selectedId === selectedTenantIds[index])
    ) return;
    tenantRequestSequenceRef.current += 1;
    setSelectedTenantIds(uniqueNextIds);
    setTenantRows([]);
    setBatchRows([]);
    setBatchDeleteRows([]);
    setLoadedTenantId(null);
    setIsTenantLoading(uniqueNextIds.length === 1);
    setError(exceedsLimit ? t('claudeEnvV2.errors.batchTenantLimit', {
      defaultValue: 'Select no more than {{count}} tenants per batch',
      count: MAX_BATCH_TENANTS,
    }) : null);
    setMessage(null);
  };

  const toggleTenantSelection = (nextTenantId: string, selected: boolean) => {
    changeTenantSelection(selected
      ? [...selectedTenantIds, nextTenantId]
      : selectedTenantIds.filter((selectedId) => selectedId !== nextTenantId));
  };

  const updateTenantRow = (id: string, patch: Partial<EnvDraft>) => {
    if (!singleTenantReady || isSaving || deletingTenantVariableKey != null) return;
    setTenantRows((rows) => rows.map((row) => (
      row.id === id ? { ...row, ...patch, dirty: true } : row
    )));
  };

  const updateBatchRow = (id: string, patch: Partial<EnvDraft>) => {
    if (!batchTenantReady || isSaving || deletingTenantVariableKey != null) return;
    setBatchRows((rows) => rows.map((row) => (
      row.id === id ? { ...row, ...patch, dirty: true } : row
    )));
  };

  const saveTenantVariables = async () => {
    if (!tenantReady || isSaving || deletingTenantVariableKey != null) return;
    const savingTenantIds = selectedTenantIds.map(Number).filter((id) => Number.isInteger(id) && id > 0);
    if (savingTenantIds.length !== selectedTenantIds.length) return;
    const requestSequence = tenantRequestSequenceRef.current + 1;
    tenantRequestSequenceRef.current = requestSequence;
    setIsSaving(true);
    setError(null);
    setMessage(null);
    try {
      const activeRows = (isBatchMode ? batchRows : tenantRows).filter((row) => !row.deleted);
      const names = activeRows.map((row) => row.name.trim());
      if (names.some((name) => !name)) {
        throw new Error(t('claudeEnvV2.errors.nameRequired', { defaultValue: 'Environment variable name is required' }));
      }
      if (new Set(names.map((name) => name.toUpperCase())).size !== names.length) {
        throw new Error(t('claudeEnvV2.errors.duplicateName', { defaultValue: 'Environment variable names must be unique' }));
      }
      const missingReplacement = isBatchMode ? null : activeRows.find((row) => (
        row.dirty && row.configured && !row.serverValueAvailable && !row.replacementTouched
      ));
      if (missingReplacement) {
        throw new Error(t('claudeEnvV2.errors.replacementRequired', {
          defaultValue: `Enter a replacement value for ${missingReplacement.name}`,
          name: missingReplacement.name,
        }));
      }

      const deletes = new Set<string>();
      if (isBatchMode) {
        const deleteNames = batchDeleteRows.map((row) => row.name.trim());
        if (deleteNames.some((name) => !name)) {
          throw new Error(t('claudeEnvV2.errors.deleteNameRequired', {
            defaultValue: 'Enter every environment variable name to delete',
          }));
        }
        if (new Set(deleteNames.map((name) => name.toUpperCase())).size !== deleteNames.length) {
          throw new Error(t('claudeEnvV2.errors.duplicateDeleteName', {
            defaultValue: 'Environment variable names to delete must be unique',
          }));
        }
        deleteNames.forEach((name) => deletes.add(name));
      } else {
        for (const row of tenantRows) {
          if (row.deleted && row.originalName) deletes.add(row.originalName);
          if (!row.deleted && row.originalName && row.originalName !== row.name.trim()) {
            deletes.add(row.originalName);
          }
        }
      }
      const upserts = activeRows
        .filter((row) => isBatchMode || row.dirty)
        .map((row) => ({ name: row.name.trim(), value: row.value, encrypted: row.encrypted }));

      if (isBatchMode && upserts.length === 0 && deletes.size === 0) {
        throw new Error(t('claudeEnvV2.errors.batchChangesRequired', {
          defaultValue: 'Add at least one update or deletion',
        }));
      }

      if (!isBatchMode) {
        const savingTenantId = String(savingTenantIds[0]);
        const response = await api.admin.updateTenantClaudeEnv(savingTenantId, {
          upserts,
          deletes: Array.from(deletes),
        });
        const payload = await readPayload<{ variables?: EnvVariable[]; error?: string; message?: string }>(response);
        if (!response.ok) throw new Error(payload.error || payload.message || t('claudeEnvV2.errors.saveTenant', { defaultValue: 'Failed to save tenant environment variables' }));
        if (requestSequence === tenantRequestSequenceRef.current) {
          setTenantRows((payload.variables || []).map((entry) => createDraft(entry)));
          setLoadedTenantId(savingTenantId);
          setMessage(t('claudeEnvV2.tenant.saved', { defaultValue: 'Tenant variables saved. New Claude sessions will use them.' }));
        }
        await loadTenantOverview();
        return;
      }

      const response = await api.admin.updateTenantClaudeEnvBatch({
        tenantIds: savingTenantIds,
        upserts,
        deletes: Array.from(deletes),
      });
      const payload = await readPayload<TenantEnvCollectionPayload>(response);
      if (!response.ok) {
        throw new Error(payload.error || payload.message || t('claudeEnvV2.errors.saveTenant', { defaultValue: 'Failed to save tenant environment variables' }));
      }

      await loadTenantOverview();
      if (requestSequence === tenantRequestSequenceRef.current) {
        setBatchRows([]);
        setBatchDeleteRows([]);
        setMessage(t('claudeEnvV2.tenant.batchSaved', {
          defaultValue: 'Applied environment variable changes to {{count}} tenants. New Claude sessions will use them.',
          count: savingTenantIds.length,
        }));
      }
    } catch (caughtError) {
      if (requestSequence === tenantRequestSequenceRef.current) {
        setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
      }
    } finally {
      setIsSaving(false);
    }
  };

  const saveAllowlist = async () => {
    if (!policyReady || isSaving || allowlistDrafts.length === 0) return;
    setIsSaving(true);
    setError(null);
    setMessage(null);
    try {
      const drafts = allowlistDrafts.map(({ name, maxLength }) => ({
        name: name.trim(),
        maxLength,
      }));
      if (drafts.some((field) => !field.name)) {
        throw new Error(t('claudeEnvV2.errors.nameRequired', { defaultValue: 'Environment variable name is required' }));
      }
      const fields = [
        ...allowlist.map(({ name, maxLength }) => ({ name, maxLength })),
        ...drafts,
      ];
      const canonicalNames = fields.map((field) => field.name.toUpperCase());
      if (new Set(canonicalNames).size !== canonicalNames.length) {
        throw new Error(t('claudeEnvV2.errors.duplicateName', { defaultValue: 'Environment variable names must be unique' }));
      }
      const response = await api.admin.updateClaudeEnvAllowlist({
        fields,
      });
      const payload = await readPayload<{ fields?: AllowlistFieldPayload[]; error?: string }>(response);
      if (!response.ok) throw new Error(payload.error || t('claudeEnvV2.errors.savePolicy', { defaultValue: 'Failed to save personal environment allowlist' }));
      setAllowlist((payload.fields || []).map((field) => createAllowlistField(field)));
      setAllowlistDrafts([]);
      setMessage(t('claudeEnvV2.policy.allowlistSaved', { defaultValue: 'Allowlist entries saved.' }));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    } finally {
      setIsSaving(false);
    }
  };

  const removeAllowlistField = async (field: AllowlistField) => {
    if (!policyReady || isSaving) return;
    if (!window.confirm(t('claudeEnvV2.policy.confirmDeleteAllowlist', {
      defaultValue: 'Delete {{name}} from the allowlist?',
      name: field.name,
    }))) return;
    setIsSaving(true);
    setError(null);
    setMessage(null);
    try {
      const targetName = field.name.toUpperCase();
      const fields = allowlist
        .filter((item) => item.name.toUpperCase() !== targetName)
        .map(({ name, maxLength }) => ({ name, maxLength }));
      const response = await api.admin.updateClaudeEnvAllowlist({ fields });
      const payload = await readPayload<{ fields?: AllowlistFieldPayload[]; error?: string }>(response);
      if (!response.ok) throw new Error(payload.error || t('claudeEnvV2.errors.deleteAllowlist', { defaultValue: 'Failed to delete allowlist entry' }));
      setAllowlist((payload.fields || []).map((entry) => createAllowlistField(entry)));
      setMessage(t('claudeEnvV2.policy.allowlistDeleted', {
        defaultValue: 'Deleted {{name}} from the allowlist.',
        name: field.name,
      }));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    } finally {
      setIsSaving(false);
    }
  };

  const createPlatformRule = async () => {
    if (!policyReady || isSaving) return;
    setIsSaving(true);
    setError(null);
    try {
      const response = await api.admin.createClaudeEnvDenyRule(newRule);
      const payload = await readPayload<{ rule?: DenyRule; error?: string }>(response);
      if (!response.ok) throw new Error(payload.error || t('claudeEnvV2.errors.createRule', { defaultValue: 'Failed to create deny rule' }));
      setNewRule({ matchType: 'exact', pattern: '', reason: '', enabled: true });
      await loadPolicies();
      setMessage(t('claudeEnvV2.policy.denyRuleSaved', { defaultValue: 'Denylist rule saved.' }));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    } finally {
      setIsSaving(false);
    }
  };

  const removePlatformRule = async (rule: DenyRule) => {
    const id = ruleId(rule);
    if (!id || !policyReady || isSaving) return;
    if (!window.confirm(t('claudeEnvV2.policy.confirmDeleteDenyRule', {
      defaultValue: 'Delete denylist rule {{pattern}}?',
      pattern: rule.pattern,
    }))) return;
    setIsSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await api.admin.deleteClaudeEnvDenyRule(id);
      const payload = await readPayload<{ error?: string }>(response);
      if (!response.ok) throw new Error(payload.error || t('claudeEnvV2.errors.deleteRule', { defaultValue: 'Failed to delete deny rule' }));
      await loadPolicies();
      setMessage(t('claudeEnvV2.policy.denyRuleDeleted', {
        defaultValue: 'Deleted denylist rule {{pattern}}.',
        pattern: rule.pattern,
      }));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    } finally {
      setIsSaving(false);
    }
  };

  const tenantOverviewCards = useMemo(() => {
    const entriesByTenantId = new Map<number, TenantEnvCollectionEntry>();
    tenantOverview.forEach((entry) => {
      const entryTenantId = collectionTenantId(entry);
      if (entryTenantId != null) entriesByTenantId.set(entryTenantId, entry);
    });
    const knownTenantIds = new Set(tenants.map((tenant) => tenant.id));
    const cards = tenants.map((tenant) => ({
      tenantId: tenant.id,
      code: tenant.code,
      name: tenant.name,
      status: tenant.status,
      snapshot: entriesByTenantId.get(tenant.id),
    }));
    tenantOverview.forEach((entry) => {
      const entryTenantId = collectionTenantId(entry);
      if (entryTenantId == null || knownTenantIds.has(entryTenantId)) return;
      cards.push({
        tenantId: entryTenantId,
        code: entry.code || String(entryTenantId),
        name: entry.name || entry.code || String(entryTenantId),
        status: entry.status || '',
        snapshot: entry,
      });
    });
    return cards;
  }, [tenantOverview, tenants]);

  const editableTenantRows = isBatchMode ? batchRows : tenantRows;
  const selectedSingleTenant = selectedTenantIds.length === 1
    ? activeTenants.find((tenant) => String(tenant.id) === selectedTenantIds[0])
    : null;
  const selectClassName = 'h-10 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

  return (
    <section className="space-y-4">
      {view === 'tenant' ? (
        <div className="space-y-6">
          <div className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <div ref={tenantPickerRef} className="relative min-w-72">
                  <button
                    ref={tenantPickerTriggerRef}
                    type="button"
                    className={`${selectClassName} flex w-full cursor-pointer items-center justify-between gap-3 disabled:cursor-not-allowed disabled:opacity-50`}
                    disabled={isSaving}
                    aria-haspopup="dialog"
                    aria-expanded={isTenantPickerOpen}
                    aria-controls={tenantPickerPanelId}
                    onClick={() => setIsTenantPickerOpen((open) => !open)}
                  >
                    <span className="truncate">
                      {selectedTenantIds.length === 0
                        ? t('claudeEnvV2.tenant.selectPlaceholder', { defaultValue: 'Select tenants' })
                        : t('claudeEnvV2.tenant.selectedCount', {
                          defaultValue: '{{count}} tenant selected',
                          defaultValue_other: '{{count}} tenants selected',
                          count: selectedTenantIds.length,
                        })}
                    </span>
                    <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isTenantPickerOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                  </button>
                  {isTenantPickerOpen ? (
                    <div
                      id={tenantPickerPanelId}
                      role="dialog"
                      aria-modal="false"
                      aria-label={t('claudeEnvV2.tenant.selectLabel', { defaultValue: 'Select tenants' })}
                      className="absolute left-0 top-[calc(100%+0.375rem)] z-30 w-full min-w-80 rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-lg"
                    >
                    <div className="mb-2 flex items-center justify-between border-b border-border pb-2 text-xs">
                      <button type="button" className="text-primary hover:underline disabled:opacity-50" disabled={isSaving || activeTenants.length === 0} onClick={() => changeTenantSelection(activeTenants.map((tenant) => String(tenant.id)), true)}>
                        {t('claudeEnvV2.tenant.selectAll', { defaultValue: 'Select all' })}
                      </button>
                      <button type="button" className="text-muted-foreground hover:text-foreground disabled:opacity-50" disabled={isSaving || selectedTenantIds.length === 0} onClick={() => changeTenantSelection([])}>
                        {t('claudeEnvV2.tenant.clearSelection', { defaultValue: 'Clear' })}
                      </button>
                    </div>
                    <div className="max-h-64 space-y-1 overflow-y-auto">
                      {activeTenants.map((tenant) => {
                        const selected = selectedTenantIds.includes(String(tenant.id));
                        return (
                          <label key={tenant.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/60">
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-input accent-primary"
                              checked={selected}
                              disabled={isSaving || (!selected && selectedTenantIds.length >= MAX_BATCH_TENANTS)}
                              onChange={(event) => toggleTenantSelection(String(tenant.id), event.target.checked)}
                            />
                            <span className="min-w-0 flex-1 truncate">{tenant.name} ({tenant.code})</span>
                          </label>
                        );
                      })}
                      {activeTenants.length === 0 ? (
                        <p className="px-2 py-3 text-center text-sm text-muted-foreground">
                          {t('claudeEnvV2.tenant.noActiveTenants', { defaultValue: 'No active tenants' })}
                        </p>
                      ) : null}
                    </div>
                    <p className="mt-2 border-t border-border px-2 pt-2 text-xs text-muted-foreground">
                      {t('claudeEnvV2.tenant.selectionLimitHint', {
                        defaultValue: 'Up to {{count}} tenants per batch. Select all uses the first {{count}} active tenants.',
                        count: MAX_BATCH_TENANTS,
                      })}
                    </p>
                    </div>
                  ) : null}
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => void Promise.all([
                    selectedTenantIds.length === 1 ? loadTenantVariables() : Promise.resolve(),
                    loadTenantOverview(),
                  ])}
                  disabled={isTenantLoading || isOverviewLoading || isSaving || deletingTenantVariableKey != null}
                  aria-label={t('common.refresh')}
                >
                  <RefreshCw className={isTenantLoading || isOverviewLoading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    if (isBatchMode) setBatchRows((rows) => [...rows, createDraft()]);
                    else setTenantRows((rows) => [...rows, createDraft()]);
                  }}
                  disabled={!tenantReady || isSaving}
                >
                  <Plus className="h-4 w-4" />
                  {t('claudeEnvV2.addVariable', { defaultValue: 'Add variable' })}
                </Button>
                {isBatchMode ? (
                  <Button variant="outline" onClick={() => setBatchDeleteRows((rows) => [...rows, createDeleteDraft()])} disabled={!batchTenantReady || isSaving || deletingTenantVariableKey != null}>
                    <Trash2 className="h-4 w-4" />
                    {t('claudeEnvV2.tenant.addDelete', { defaultValue: 'Add deletion' })}
                  </Button>
                ) : null}
                <Button onClick={() => void saveTenantVariables()} disabled={!tenantReady || isSaving || deletingTenantVariableKey != null || (isBatchMode && !hasBatchChanges)}>
                  <Check className="h-4 w-4" />
                  {isBatchMode
                    ? t('claudeEnvV2.tenant.applyToSelected', { defaultValue: 'Apply to selected' })
                    : t('common.save', { defaultValue: 'Save' })}
                </Button>
              </div>
            </div>

            {selectedTenantIds.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-5 text-center text-sm text-muted-foreground">
                {t('claudeEnvV2.tenant.selectHint', { defaultValue: 'Select one tenant to edit it, or select multiple tenants to prepare a safe batch change.' })}
              </p>
            ) : (
              <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
                <h4 className="text-sm font-medium text-foreground">
                  {isBatchMode
                    ? t('claudeEnvV2.tenant.batchEditorTitle', { defaultValue: 'Batch changes for {{count}} tenants', count: selectedTenantIds.length })
                    : t('claudeEnvV2.tenant.singleEditorTitle', {
                      defaultValue: 'Editing {{tenant}}',
                      tenant: selectedSingleTenant?.name || tenantId,
                    })}
                </h4>
                <p className="mt-1 text-xs text-muted-foreground">
                  {isBatchMode
                    ? t('claudeEnvV2.tenant.batchEditorHint', {
                      defaultValue: 'This is an empty operation draft. Only values and deletion names entered below are applied; existing unrelated tenant values are not copied or changed. Changing the tenant selection clears this draft.',
                    })
                    : t('claudeEnvV2.tenant.singleEditorHint', {
                      defaultValue: 'Existing encrypted values remain masked and are changed only after you enter a replacement.',
                    })}
                </p>
              </div>
            )}

            {selectedTenantIds.length > 0 ? (
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">{t('claudeEnv.fieldName')}</th>
                      <th className="px-3 py-2 text-left font-medium">{t('claudeEnv.fieldValue')}</th>
                      <th className="w-28 px-3 py-2 text-center font-medium">{t('claudeEnv.encrypted')}</th>
                      <th className="w-20 px-3 py-2 text-center font-medium">{t('common.delete')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {editableTenantRows.filter((row) => !row.deleted).map((row) => (
                      <tr key={row.id} className="border-t border-border">
                        <td className="px-3 py-2">
                          <Input
                            value={row.name}
                            disabled={!tenantReady || isSaving}
                            onChange={(event) => {
                              const patch = { name: event.target.value };
                              if (isBatchMode) updateBatchRow(row.id, patch);
                              else updateTenantRow(row.id, patch);
                            }}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <Input
                            type={row.encrypted ? 'password' : 'text'}
                            value={row.value}
                            disabled={!tenantReady || isSaving}
                            placeholder={!isBatchMode && row.configured && !row.serverValueAvailable && !row.replacementTouched
                              ? t('claudeEnvV2.encryptedConfigured', { defaultValue: 'Configured — enter a value to replace' })
                              : ''}
                            onChange={(event) => {
                              const patch = { value: event.target.value, replacementTouched: true };
                              if (isBatchMode) updateBatchRow(row.id, patch);
                              else updateTenantRow(row.id, patch);
                            }}
                          />
                        </td>
                        <td className="px-3 py-2 text-center">
                          <input
                            type="checkbox"
                            checked={row.encrypted}
                            disabled={!tenantReady || isSaving}
                            onChange={(event) => {
                              const patch = { encrypted: event.target.checked };
                              if (isBatchMode) updateBatchRow(row.id, patch);
                              else updateTenantRow(row.id, patch);
                            }}
                          />
                        </td>
                        <td className="px-3 py-2 text-center">
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={!tenantReady || isSaving}
                            onClick={() => {
                              if (isBatchMode) setBatchRows((rows) => rows.filter((item) => item.id !== row.id));
                              else updateTenantRow(row.id, { deleted: true });
                            }}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                    {editableTenantRows.every((row) => row.deleted) ? (
                      <tr>
                        <td colSpan={4} className="px-3 py-5 text-center text-muted-foreground">
                          {isBatchMode
                            ? t('claudeEnvV2.tenant.emptyBatchUpserts', { defaultValue: 'No additions or updates in this batch.' })
                            : t('claudeEnv.emptyRows')}
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            ) : null}

            {isBatchMode ? (
              <div className="space-y-2 rounded-md border border-border p-3">
                <div>
                  <h5 className="text-sm font-medium text-foreground">{t('claudeEnvV2.tenant.batchDeletesTitle', { defaultValue: 'Delete from every selected tenant' })}</h5>
                  <p className="text-xs text-muted-foreground">{t('claudeEnvV2.tenant.batchDeletesHint', { defaultValue: 'Only names explicitly listed here are deleted.' })}</p>
                </div>
                {batchDeleteRows.map((row) => (
                  <div key={row.id} className="flex items-center gap-2">
                    <Input
                      value={row.name}
                      disabled={!batchTenantReady || isSaving || deletingTenantVariableKey != null}
                      placeholder="CUSTOM_VARIABLE"
                      onChange={(event) => setBatchDeleteRows((rows) => rows.map((item) => item.id === row.id ? { ...item, name: event.target.value } : item))}
                    />
                    <Button variant="ghost" size="icon" disabled={!batchTenantReady || isSaving || deletingTenantVariableKey != null} onClick={() => setBatchDeleteRows((rows) => rows.filter((item) => item.id !== row.id))}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                ))}
                {batchDeleteRows.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
                    {t('claudeEnvV2.tenant.emptyBatchDeletes', { defaultValue: 'No deletions in this batch.' })}
                  </p>
                ) : null}
              </div>
            ) : null}

          </div>

          <div className="space-y-3 border-t border-border pt-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h4 className="text-sm font-medium text-foreground">{t('claudeEnvV2.tenant.overviewTitle', { defaultValue: 'Current tenant configurations' })}</h4>
                <p className="text-xs text-muted-foreground">{t('claudeEnvV2.tenant.overviewHint', { defaultValue: 'Current snapshots for every tenant. Encrypted values are always hidden, and each configured item can be deleted here.' })}</p>
              </div>
              <Button variant="ghost" size="icon" onClick={() => void loadTenantOverview()} disabled={isOverviewLoading || isSaving || deletingTenantVariableKey != null} aria-label={t('common.refresh')}>
                <RefreshCw className={isOverviewLoading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
              </Button>
            </div>
            {overviewError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{overviewError}</div>
            ) : null}
            {hasTenantDraftChanges ? (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                {t('claudeEnvV2.tenant.overviewDeleteDisabled', {
                  defaultValue: 'Apply or remove all pending tenant changes before deleting from the configuration overview.',
                })}
              </div>
            ) : null}
            {isOverviewLoading && tenantOverview.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-5 text-center text-sm text-muted-foreground">
                {t('claudeEnvV2.tenant.loadingOverview', { defaultValue: 'Loading tenant configurations…' })}
              </p>
            ) : null}
            {!isOverviewLoading && tenantOverviewCards.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-5 text-center text-sm text-muted-foreground">
                {t('claudeEnvV2.tenant.emptyOverview', { defaultValue: 'No tenants to display.' })}
              </p>
            ) : null}
            <div className="grid gap-3">
              {tenantOverviewCards.map((card) => {
                const variables = card.snapshot?.variables || [];
                return (
                  <div key={card.tenantId} className="min-w-0 rounded-md border border-border p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h5 className="truncate text-sm font-medium text-foreground">{card.name}</h5>
                        <p className="truncate text-xs text-muted-foreground">{card.code}</p>
                      </div>
                      {card.status ? <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{card.status}</span> : null}
                    </div>
                    {!card.snapshot ? (
                      <p className="mt-3 text-sm text-muted-foreground">{t('claudeEnvV2.tenant.snapshotUnavailable', { defaultValue: 'Snapshot unavailable.' })}</p>
                    ) : variables.length === 0 ? (
                      <p className="mt-3 text-sm text-muted-foreground">{t('claudeEnvV2.tenant.noVariables', { defaultValue: 'No tenant environment variables configured.' })}</p>
                    ) : (
                      <div className="mt-3 space-y-2">
                        {variables.map((variable) => {
                          const variableKey = `${card.tenantId}:${variable.name}`;
                          const isDeletingVariable = deletingTenantVariableKey === variableKey;
                          return (
                            <div key={variable.name} className="grid min-w-0 grid-cols-[minmax(8rem,0.75fr)_minmax(0,1fr)_2.25rem] items-center gap-3 rounded bg-muted/30 px-2 py-1.5 text-xs">
                              <div className="min-w-0">
                                <div className="truncate font-mono text-foreground">{variable.name}</div>
                                {variable.encrypted ? <div className="text-muted-foreground">{t('claudeEnvV2.tenant.encrypted', { defaultValue: 'Encrypted' })}</div> : null}
                              </div>
                              <div className="min-w-0 break-all text-muted-foreground">
                                {variable.encrypted
                                  ? '••••••••'
                                  : typeof variable.value === 'string'
                                    ? variable.value
                                    : t('claudeEnvV2.tenant.configured', { defaultValue: 'Configured' })}
                              </div>
                              <Button
                                variant="ghost"
                                size="icon"
                                disabled={deletingTenantVariableKey != null || isSaving || isOverviewLoading || hasTenantDraftChanges}
                                title={hasTenantDraftChanges
                                  ? t('claudeEnvV2.tenant.overviewDeleteDisabled', {
                                    defaultValue: 'Apply or remove all pending tenant changes before deleting from the configuration overview.',
                                  })
                                  : undefined}
                                aria-label={t('claudeEnvV2.tenant.deleteConfigured', {
                                  name: variable.name,
                                  tenant: card.name,
                                  defaultValue: 'Delete {{name}} from {{tenant}}',
                                })}
                                onClick={() => void deleteTenantOverviewVariable(card.tenantId, card.name, variable.name)}
                              >
                                {isDeletingVariable
                                  ? <RefreshCw className="h-4 w-4 animate-spin" />
                                  : <Trash2 className="h-4 w-4 text-destructive" />}
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-foreground">
                {t('claudeEnvV2.policy.editorTitle', { defaultValue: 'Configure allowlist and denylist' })}
              </h3>
              <p className="text-xs text-muted-foreground">
                {t('claudeEnvV2.policy.editorHint', { defaultValue: 'New entries are saved from the forms below. Saved entries are listed separately and can be deleted.' })}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void loadPolicies()}
              disabled={isPolicyLoading || isSaving}
              aria-label={t('common.refresh')}
            >
              <RefreshCw className={isPolicyLoading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            </Button>
          </div>

          <div className="space-y-3 rounded-lg border border-border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h4 className="text-sm font-medium text-foreground">{t('claudeEnvV2.policy.allowlistForm', { defaultValue: 'Add allowlist entries' })}</h4>
                <p className="text-xs text-muted-foreground">{t('claudeEnvV2.policy.allowlistHint', { defaultValue: 'Only these names may be configured by users. Length is measured in UTF-8 bytes.' })}</p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => setAllowlistDrafts((rows) => [...rows, createAllowlistField()])}
                  disabled={!policyReady || isSaving}
                >
                  <Plus className="h-4 w-4" />
                  {t('claudeEnvV2.policy.addAllowlistField', { defaultValue: 'Add field' })}
                </Button>
                <Button onClick={() => void saveAllowlist()} disabled={!policyReady || isSaving || allowlistDrafts.length === 0}>
                  <Check className="h-4 w-4" />
                  {t('claudeEnvV2.policy.saveAllowlist', { defaultValue: 'Save allowlist' })}
                </Button>
              </div>
            </div>
            {allowlistDrafts.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                {t('claudeEnvV2.policy.emptyAllowlistDraft', { defaultValue: 'No pending allowlist entries. Add a field to begin.' })}
              </p>
            ) : (
              <div className="space-y-2">
                {allowlistDrafts.map((field) => (
                  <div key={field.id} className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-[minmax(0,1fr)_10rem_2.5rem]">
                    <Input value={field.name} disabled={!policyReady || isSaving} placeholder="CUSTOM_VARIABLE" onChange={(event) => setAllowlistDrafts((rows) => rows.map((item) => item.id === field.id ? { ...item, name: event.target.value } : item))} />
                    <Input type="number" min={1} value={field.maxLength} disabled={!policyReady || isSaving} aria-label={t('claudeEnvV2.policy.maxLength', { defaultValue: 'Maximum bytes' })} onChange={(event) => setAllowlistDrafts((rows) => rows.map((item) => item.id === field.id ? { ...item, maxLength: Number(event.target.value) } : item))} />
                    <Button variant="ghost" size="icon" disabled={!policyReady || isSaving} aria-label={t('common.delete')} onClick={() => setAllowlistDrafts((rows) => rows.filter((item) => item.id !== field.id))}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-3 rounded-lg border border-border p-4">
            <div>
              <h4 className="text-sm font-medium text-foreground">{t('claudeEnvV2.policy.denyForm', { defaultValue: 'Add a denylist rule' })}</h4>
              <p className="text-xs text-muted-foreground">{t('claudeEnvV2.policy.denyHint', { defaultValue: 'These rules add restrictions to personal variables and cannot override built-in protection.' })}</p>
            </div>
            <div className="grid gap-2 rounded-md border border-dashed border-border p-3 sm:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)_auto]">
              <select className={selectClassName} value={newRule.matchType} disabled={!policyReady || isSaving} onChange={(event) => setNewRule((rule) => ({ ...rule, matchType: event.target.value as DenyRule['matchType'] }))}>
                {denyMatchTypes.map((matchType) => (
                  <option key={matchType} value={matchType}>
                    {t(`claudeEnvV2.policy.matchType.${matchType}`, { defaultValue: matchType })}
                  </option>
                ))}
              </select>
              <Input value={newRule.pattern} disabled={!policyReady || isSaving} placeholder="CUSTOM_INTERNAL_" onChange={(event) => setNewRule((rule) => ({ ...rule, pattern: event.target.value }))} />
              <Input value={newRule.reason || ''} disabled={!policyReady || isSaving} placeholder={t('claudeEnvV2.policy.reason', { defaultValue: 'Reason' })} onChange={(event) => setNewRule((rule) => ({ ...rule, reason: event.target.value }))} />
              <Button onClick={() => void createPlatformRule()} disabled={!policyReady || isSaving || !newRule.pattern.trim()}>
                <Check className="h-4 w-4" />
                {t('claudeEnvV2.policy.saveDenyRule', { defaultValue: 'Save rule' })}
              </Button>
            </div>
          </div>

          <div className="space-y-4 border-t border-border pt-5">
            <div>
              <h3 className="text-base font-semibold text-foreground">
                {t('claudeEnvV2.policy.savedTitle', { defaultValue: 'Saved administrator configuration' })}
              </h3>
              <p className="text-xs text-muted-foreground">
                {t('claudeEnvV2.policy.savedHint', { defaultValue: 'These entries are active for all users. Delete an entry to remove it from the policy.' })}
              </p>
            </div>

            <div className="space-y-2">
              <h4 className="text-sm font-medium text-foreground">{t('claudeEnvV2.policy.savedAllowlist', { defaultValue: 'Administrator allowlist' })}</h4>
              {allowlist.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                  {t('claudeEnvV2.policy.emptySavedAllowlist', { defaultValue: 'No administrator allowlist entries are configured.' })}
                </p>
              ) : (
                <div className="space-y-2">
                  {allowlist.map((field) => (
                    <div key={field.id} className="grid items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-sm sm:grid-cols-[minmax(0,1fr)_10rem_2.5rem]">
                      <span className="truncate font-mono text-foreground">{field.name}</span>
                      <span className="text-muted-foreground">{t('claudeEnvV2.policy.maxLengthValue', { defaultValue: '{{count}} bytes', count: field.maxLength })}</span>
                      <Button variant="ghost" size="icon" disabled={!policyReady || isSaving} aria-label={t('claudeEnvV2.policy.deleteAllowlist', { defaultValue: 'Delete {{name}}', name: field.name })} onClick={() => void removeAllowlistField(field)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <h4 className="text-sm font-medium text-foreground">{t('claudeEnvV2.policy.savedDenylist', { defaultValue: 'Administrator denylist' })}</h4>
              {platformRules.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                  {t('claudeEnvV2.policy.emptySavedDenylist', { defaultValue: 'No administrator denylist rules are configured.' })}
                </p>
              ) : (
                <div className="space-y-2">
                  {platformRules.map((rule, index) => (
                    <div key={ruleId(rule) || `${rule.pattern}-${index}`} className="grid items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-sm sm:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)_6rem_2.5rem]">
                      <span className="text-muted-foreground">{t(`claudeEnvV2.policy.matchType.${rule.matchType}`, { defaultValue: rule.matchType })}</span>
                      <span className="truncate font-mono text-foreground">{rule.pattern}</span>
                      <span className="truncate text-muted-foreground">{rule.reason || '—'}</span>
                      <span className={rule.enabled !== false ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground'}>
                        {rule.enabled !== false ? t('claudeEnvV2.policy.enabled', { defaultValue: 'Enabled' }) : t('claudeEnvV2.policy.disabled', { defaultValue: 'Disabled' })}
                      </span>
                      <Button variant="ghost" size="icon" onClick={() => void removePlatformRule(rule)} disabled={!policyReady || isSaving} aria-label={t('claudeEnvV2.policy.deleteDenyRule', { defaultValue: 'Delete {{pattern}}', pattern: rule.pattern })}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-2 border-t border-border pt-5">
            <h4 className="text-sm font-medium text-foreground">{t('claudeEnvV2.policy.builtIn', { defaultValue: 'Built-in denylist (read-only)' })}</h4>
            <div className="grid gap-2 sm:grid-cols-2">
              {builtInRules.map((rule, index) => (
                <div key={ruleId(rule) || `${rule.pattern}-${index}`} className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs">
                  <span className="font-mono text-foreground">
                    {t(`claudeEnvV2.policy.matchType.${rule.matchType}`, { defaultValue: rule.matchType })}: {rule.pattern}
                  </span>
                  {rule.reason ? <div className="mt-1 text-muted-foreground">{rule.reason}</div> : null}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {message ? <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">{message}</div> : null}
      {error ? <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div> : null}
    </section>
  );
}
