import { useCallback, useEffect, useState } from 'react';

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
    headers?: Record<string, string>;
  };
  status: 'draft' | 'published' | 'disabled';
  dockerCompatible: boolean;
  lastTestStatus?: string | null;
  lastTestError?: string | null;
  lastTestedAt?: string | null;
  toolCount: number;
  tools?: Array<{ name: string; description?: string }>;
};

export type AdminMcpPresetTestResult = {
  presetId: number;
  status: string;
  toolCount: number;
  error?: string | null;
  testedAt?: string | null;
  transient?: boolean;
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
        setError(await readError(response, 'Failed to load MCP presets'));
        return;
      }
      const payload = await response.json() as { presets?: AdminMcpPreset[] };
      setPresets(payload.presets || []);
    } finally {
      setIsLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const savePreset = useCallback(async (values: McpPresetFormValues, presetId?: number | null) => {
    setIsSaving(true);
    setError(null);
    try {
      const payload = buildMcpPresetPayload(values);
      const response = presetId
        ? await api.admin.updateMcpPreset(presetId, payload)
        : await api.admin.createMcpPreset(payload);
      if (!response.ok) {
        setError(await readError(response, 'Failed to save MCP preset'));
        return null;
      }
      const data = await response.json() as { preset: AdminMcpPreset };
      await load();
      return data.preset;
    } finally {
      setIsSaving(false);
    }
  }, [load]);

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
          payload = buildMcpPresetPayload({ ...values, tenantId });
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : 'Invalid MCP preset configuration';
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
        const message = await readError(response, 'Failed to test MCP preset');
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
      const message = caught instanceof Error ? caught.message : 'Failed to test MCP preset';
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
  }, [load, tenantId]);

  const publishPreset = useCallback(async (presetId: number) => {
    if (!tenantId) return null;
    setIsSaving(true);
    setError(null);
    try {
      const response = await api.admin.publishMcpPreset(presetId, tenantId);
      if (!response.ok) {
        setError(await readError(response, 'Failed to publish MCP preset'));
        return null;
      }
      const data = await response.json() as { preset: AdminMcpPreset };
      await load();
      return data.preset;
    } finally {
      setIsSaving(false);
    }
  }, [load, tenantId]);

  const disablePreset = useCallback(async (presetId: number) => {
    if (!tenantId) return null;
    setIsSaving(true);
    setError(null);
    try {
      const response = await api.admin.disableMcpPreset(presetId, tenantId);
      if (!response.ok) {
        setError(await readError(response, 'Failed to disable MCP preset'));
        return null;
      }
      const data = await response.json() as { preset: AdminMcpPreset };
      await load();
      return data.preset;
    } finally {
      setIsSaving(false);
    }
  }, [load, tenantId]);

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
    disablePreset,
  };
}
