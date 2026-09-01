import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../utils/api';
import type { McpPresetFormValues } from '../adminMcpPresetUtils';
import { buildMcpPresetPayload } from '../adminMcpPresetUtils';

export type AdminMcpPreset = {
  id: number;
  tenantId: number;
  name: string;
  displayName: string;
  description: string;
  transport: 'http';
  config: {
    type: 'http';
    url: string;
    timeout?: number;
    headers?: Record<string, string>;
    headersHelper?: string;
    helperEnv?: Record<string, string>;
  };
  status: 'draft' | 'published' | 'disabled';
  preinstallScope: 'none' | 'all_workspaces';
  preinstall?: boolean;
  dockerCompatible: boolean;
  lastTestStatus?: string | null;
  lastTestError?: string | null;
  lastTestedAt?: string | null;
  toolCount: number;
  tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  helperScript?: {
    fileName: string;
    sizeBytes: number;
    sha256: string;
    updatedAt?: string | null;
  } | null;
};

export type AdminMcpPresetTestResult = {
  presetId: number;
  status: string;
  toolCount: number;
  error?: string | null;
  testedAt?: string | null;
  transient?: boolean;
};

export type AdminMcpPresetCopyAction = 'created' | 'updated' | 'skipped' | 'failed';

export type AdminMcpPresetCopyResult = {
  tenantId: number;
  action: AdminMcpPresetCopyAction;
  preset?: AdminMcpPreset;
  reason?: string;
  error?: string;
};

export type AdminMcpPresetCopyResponse = {
  sourcePreset?: AdminMcpPreset;
  results: AdminMcpPresetCopyResult[];
  summary: {
    total: number;
    created: number;
    updated: number;
    skipped: number;
    failed: number;
  };
};

type ErrorPayload = {
  error?: string;
  message?: string;
};

async function readError(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => ({} as ErrorPayload));
  return payload.error || payload.message || fallback;
}

export function useAdminMcpPresets(tenantId?: number) {
  const { t } = useTranslation('admin');
  const [presets, setPresets] = useState<AdminMcpPreset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [testingPresetIds, setTestingPresetIds] = useState<Set<number>>(() => new Set());
  const [latestTestResult, setLatestTestResult] = useState<AdminMcpPresetTestResult | null>(null);

  const load = useCallback(async () => {
    if (!tenantId) {
      setPresets([]);
      setLatestTestResult(null);
      setTestingPresetIds(new Set());
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.admin.mcpPresets(tenantId);
      if (!response.ok) {
        setError(await readError(response, t('mcp.errors.load')));
        return;
      }
      const payload = await response.json() as { presets?: AdminMcpPreset[] };
      setPresets(payload.presets || []);
    } finally {
      setIsLoading(false);
    }
  }, [tenantId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const replacePreset = useCallback((nextPreset: AdminMcpPreset) => {
    setPresets((current) => current.map((preset) => (
      preset.id === nextPreset.id ? nextPreset : preset
    )));
  }, []);

  const clearLatestTestResultForPreset = useCallback((presetId: number) => {
    setLatestTestResult((current) => (current?.presetId === presetId ? null : current));
  }, []);

  const savePreset = useCallback(async (values: McpPresetFormValues, presetId?: number | null) => {
    setIsSaving(true);
    setError(null);
    try {
      const payload = buildMcpPresetPayload(values, {
        headersFormat: t('mcp.validationErrors.headersFormat'),
        helperEnvSyntax: t('mcp.validationErrors.helperEnvSyntax'),
        timeoutFormat: t('mcp.validationErrors.timeoutFormat'),
      });
      const response = presetId
        ? await api.admin.updateMcpPreset(presetId, payload)
        : await api.admin.createMcpPreset(payload);
      if (!response.ok) {
        setError(await readError(response, t('mcp.errors.save')));
        return null;
      }
      const data = await response.json() as { preset: AdminMcpPreset };
      if (presetId) {
        clearLatestTestResultForPreset(presetId);
      }
      await load();
      return data.preset;
    } finally {
      setIsSaving(false);
    }
  }, [clearLatestTestResultForPreset, load, t]);

  const testPreset = useCallback(async (presetId: number, values?: McpPresetFormValues) => {
    if (!tenantId) return null;
    setTestingPresetIds((current) => {
      const next = new Set(current);
      next.add(presetId);
      return next;
    });
    setError(null);
    try {
      let payload: ReturnType<typeof buildMcpPresetPayload> | null = null;
      if (values) {
        try {
          payload = buildMcpPresetPayload({ ...values, tenantId }, {
            headersFormat: t('mcp.validationErrors.headersFormat'),
            helperEnvSyntax: t('mcp.validationErrors.helperEnvSyntax'),
            timeoutFormat: t('mcp.validationErrors.timeoutFormat'),
          });
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : t('mcp.errors.invalidConfig');
          setError(message);
          setLatestTestResult({
            presetId,
            status: 'failed',
            toolCount: 0,
            error: message,
            testedAt: new Date().toISOString(),
            transient: true,
          });
          return null;
        }
      }

      const response = await api.admin.testMcpPreset(presetId, tenantId, payload);
      if (!response.ok) {
        const message = await readError(response, t('mcp.errors.test'));
        setError(message);
        setLatestTestResult({
          presetId,
          status: 'failed',
          toolCount: 0,
          error: message,
          testedAt: new Date().toISOString(),
          transient: true,
        });
        return null;
      }
      const data = await response.json() as { preset: AdminMcpPreset; transient?: boolean };
      if (!data.transient) {
        setPresets((current) => current.map((preset) => (
          preset.id === data.preset.id ? data.preset : preset
        )));
      }
      setLatestTestResult({
        presetId: data.preset.id,
        status: data.preset.lastTestStatus || 'tested',
        toolCount: data.preset.toolCount,
        error: data.preset.lastTestError,
        testedAt: data.preset.lastTestedAt || new Date().toISOString(),
        transient: data.transient === true,
      });
      if (!data.transient) {
        await load();
      }
      return data.preset;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : t('mcp.errors.test');
      setError(message);
      setLatestTestResult({
        presetId,
        status: 'failed',
        toolCount: 0,
        error: message,
        testedAt: new Date().toISOString(),
        transient: true,
      });
      return null;
    } finally {
      setTestingPresetIds((current) => {
        const next = new Set(current);
        next.delete(presetId);
        return next;
      });
    }
  }, [load, tenantId, t]);

  const publishPreset = useCallback(async (presetId: number) => {
    if (!tenantId) return null;
    setIsSaving(true);
    setError(null);
    try {
      const response = await api.admin.publishMcpPreset(presetId, tenantId);
      if (!response.ok) {
        setError(await readError(response, t('mcp.errors.publish')));
        return null;
      }
      const data = await response.json() as { preset: AdminMcpPreset };
      await load();
      return data.preset;
    } finally {
      setIsSaving(false);
    }
  }, [load, tenantId, t]);

  const copyPresetToTenants = useCallback(async (presetId: number, targetTenantIds: number[]) => {
    if (!tenantId) return null;
    setIsSaving(true);
    setError(null);
    try {
      const response = await api.admin.copyMcpPreset(presetId, {
        tenantId,
        targetTenantIds,
      });
      if (!response.ok) {
        setError(await readError(response, t('mcp.errors.copy')));
        return null;
      }
      return await response.json() as AdminMcpPresetCopyResponse;
    } finally {
      setIsSaving(false);
    }
  }, [tenantId, t]);

  const uploadHelperScript = useCallback(async (presetId: number, file: File) => {
    if (!tenantId) return null;
    setIsSaving(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.set('script', file);
      const response = await api.admin.uploadMcpPresetHelperScript(presetId, tenantId, formData);
      if (!response.ok) {
        setError(await readError(response, t('mcp.errors.uploadHelper')));
        return null;
      }
      const data = await response.json() as { preset: AdminMcpPreset };
      replacePreset(data.preset);
      clearLatestTestResultForPreset(presetId);
      return data.preset;
    } finally {
      setIsSaving(false);
    }
  }, [clearLatestTestResultForPreset, replacePreset, tenantId, t]);

  const deleteHelperScript = useCallback(async (presetId: number) => {
    if (!tenantId) return null;
    setIsSaving(true);
    setError(null);
    try {
      const response = await api.admin.deleteMcpPresetHelperScript(presetId, tenantId);
      if (!response.ok) {
        setError(await readError(response, t('mcp.errors.deleteHelper')));
        return null;
      }
      const data = await response.json() as { preset: AdminMcpPreset };
      replacePreset(data.preset);
      clearLatestTestResultForPreset(presetId);
      return data.preset;
    } finally {
      setIsSaving(false);
    }
  }, [clearLatestTestResultForPreset, replacePreset, tenantId, t]);

  const disablePreset = useCallback(async (presetId: number) => {
    if (!tenantId) return null;
    setIsSaving(true);
    setError(null);
    try {
      const response = await api.admin.disableMcpPreset(presetId, tenantId);
      if (!response.ok) {
        setError(await readError(response, t('mcp.errors.disable')));
        return null;
      }
      const data = await response.json() as { preset: AdminMcpPreset };
      await load();
      return data.preset;
    } finally {
      setIsSaving(false);
    }
  }, [load, tenantId, t]);

  const deletePreset = useCallback(async (presetId: number) => {
    if (!tenantId) return false;
    setIsSaving(true);
    setError(null);
    try {
      const response = await api.admin.deleteMcpPreset(presetId, tenantId);
      if (!response.ok) {
        setError(await readError(response, t('mcp.errors.delete')));
        return false;
      }
      const data = await response.json().catch(() => ({ deleted: true } as { deleted?: boolean }));
      if (data.deleted === false) {
        setError(t('mcp.errors.delete'));
        return false;
      }
      setPresets((current) => current.filter((preset) => preset.id !== presetId));
      clearLatestTestResultForPreset(presetId);
      return true;
    } finally {
      setIsSaving(false);
    }
  }, [clearLatestTestResultForPreset, tenantId, t]);

  return {
    presets,
    error,
    isLoading,
    isSaving,
    testingPresetIds,
    latestTestResult,
    reload: load,
    savePreset,
    testPreset,
    publishPreset,
    copyPresetToTenants,
    disablePreset,
    uploadHelperScript,
    deleteHelperScript,
    deletePreset,
  };
}
