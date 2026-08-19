import { useCallback, useEffect, useState } from 'react';

import { api } from '../../../utils/api';

export type AdminSkillPresetStatus = 'draft' | 'published' | 'disabled';
export type AdminSkillPresetValidationStatus = 'healthy' | 'failed' | string;

export type MarketSkillSummary = {
  id?: string;
  skillId?: string;
  name: string;
  displayName?: string;
  description?: string;
  nspPath?: string;
  createUserId?: string;
  version?: number;
};

export type AdminSkillPreset = {
  id: number;
  tenantId: number;
  name: string;
  displayName: string;
  description: string;
  sourceType: 'skill-market-api';
  skillId: string;
  remoteId: string;
  nspPath: string;
  version: number;
  source?: Record<string, unknown>;
  preinstallScope: 'none' | 'all_workspaces';
  preinstall?: boolean;
  status: AdminSkillPresetStatus;
  lastValidationStatus?: AdminSkillPresetValidationStatus | null;
  lastValidationError?: string | null;
  lastValidatedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type SkillPresetFormValues = {
  tenantId: number;
  sourceRef: string;
  selectedSkill: MarketSkillSummary | null;
  selectedSkills: MarketSkillSummary[];
  preinstall: boolean;
  status: AdminSkillPresetStatus;
};

export type MarketSkillPageInfo = {
  page: number;
  pageSize: number;
  hasNextPage: boolean;
  total?: number;
  totalPages?: number;
};

const DEFAULT_MARKET_PAGE_INFO: MarketSkillPageInfo = {
  page: 1,
  pageSize: 50,
  hasNextPage: false,
};

type ErrorPayload = {
  error?: string;
  message?: string;
};

async function readError(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => ({} as ErrorPayload));
  return payload.error || payload.message || fallback;
}

function buildPayload(values: SkillPresetFormValues) {
  return buildSkillPayload(values);
}

function getSkillRef(skill: MarketSkillSummary) {
  return skill.id || skill.skillId || skill.name;
}

function buildSkillPayload(values: SkillPresetFormValues, selectedSkill?: MarketSkillSummary | null) {
  const skill = selectedSkill || values.selectedSkill || values.selectedSkills[0] || undefined;
  return {
    tenantId: values.tenantId,
    sourceRef: skill ? getSkillRef(skill) : values.sourceRef,
    skill,
    preinstall: true,
    status: 'draft',
  };
}

export function useAdminSkillPresets(tenantId?: number) {
  const [presets, setPresets] = useState<AdminSkillPreset[]>([]);
  const [marketSkills, setMarketSkills] = useState<MarketSkillSummary[]>([]);
  const [marketPageInfo, setMarketPageInfo] = useState<MarketSkillPageInfo>(DEFAULT_MARKET_PAGE_INFO);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [validatingPresetIds, setValidatingPresetIds] = useState<Set<number>>(() => new Set());

  const load = useCallback(async () => {
    if (!tenantId) {
      setPresets([]);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const response = await api.admin.skillPresets(tenantId);
      if (!response.ok) {
        setError(await readError(response, 'Failed to load Skill presets'));
        return;
      }
      const payload = await response.json() as { presets?: AdminSkillPreset[] };
      setPresets(payload.presets || []);
    } finally {
      setIsLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const searchMarket = useCallback(async (
    searchContent = '',
    { page = 1, pageSize = 50 }: { page?: number; pageSize?: number } = {},
  ) => {
    if (!tenantId) {
      setMarketSkills([]);
      setMarketPageInfo(DEFAULT_MARKET_PAGE_INFO);
      return [];
    }
    setIsSearching(true);
    setError(null);
    try {
      const response = await api.admin.searchSkillPresetMarket(tenantId, { searchContent, page, pageSize });
      if (!response.ok) {
        setError(await readError(response, 'Failed to search Skill Market'));
        return [];
      }
      const payload = await response.json() as {
        skills?: MarketSkillSummary[];
        pageInfo?: Partial<MarketSkillPageInfo>;
      };
      const skills = payload.skills || [];
      const responsePage = Number(payload.pageInfo?.page);
      const responsePageSize = Number(payload.pageInfo?.pageSize);
      const responseTotal = Number(payload.pageInfo?.total);
      const responseTotalPages = Number(payload.pageInfo?.totalPages);
      setMarketSkills(skills);
      setMarketPageInfo({
        page: Number.isInteger(responsePage) && responsePage > 0 ? responsePage : page,
        pageSize: Number.isInteger(responsePageSize) && responsePageSize > 0 ? responsePageSize : pageSize,
        hasNextPage: Boolean(payload.pageInfo?.hasNextPage ?? skills.length >= pageSize),
        ...(Number.isInteger(responseTotal) && responseTotal >= 0 ? { total: responseTotal } : {}),
        ...(Number.isInteger(responseTotalPages) && responseTotalPages > 0 ? { totalPages: responseTotalPages } : {}),
      });
      return skills;
    } finally {
      setIsSearching(false);
    }
  }, [tenantId]);

  useEffect(() => {
    setMarketSkills([]);
    setMarketPageInfo(DEFAULT_MARKET_PAGE_INFO);
    if (tenantId) {
      void searchMarket('', { pageSize: 50 });
    }
  }, [searchMarket, tenantId]);

  const savePreset = useCallback(async (values: SkillPresetFormValues, presetId?: number | null) => {
    setIsSaving(true);
    setError(null);
    try {
      const response = presetId
        ? await api.admin.updateSkillPreset(presetId, buildPayload(values))
        : await api.admin.createSkillPreset(buildPayload(values));
      if (!response.ok) {
        setError(await readError(response, 'Failed to save Skill preset'));
        return null;
      }
      const payload = await response.json() as { preset?: AdminSkillPreset };
      await load();
      return payload.preset || null;
    } finally {
      setIsSaving(false);
    }
  }, [load]);

  const savePresets = useCallback(async (values: SkillPresetFormValues) => {
    const skills = values.selectedSkills.length > 0
      ? values.selectedSkills
      : values.selectedSkill
        ? [values.selectedSkill]
        : [];
    if (skills.length === 0 && !values.sourceRef) {
      setError('Select at least one Skill Market skill');
      return [];
    }

    setIsSaving(true);
    setError(null);
    const saved: AdminSkillPreset[] = [];
    const cleanupCreatedPreset = async (presetId: number) => {
      try {
        await api.admin.deleteSkillPreset(presetId, values.tenantId);
      } catch {
        // Best-effort cleanup only. The original validation/publish error remains the user-facing error.
      }
    };
    const createValidatePublish = async (payload: ReturnType<typeof buildSkillPayload>, label: string) => {
      const createResponse = await api.admin.createSkillPreset(payload);
      if (!createResponse.ok) {
        setError(await readError(createResponse, `Failed to preset Skill: ${label}`));
        return null;
      }

      const createPayload = await createResponse.json() as { preset?: AdminSkillPreset };
      const createdPreset = createPayload.preset;
      if (!createdPreset) {
        setError(`Failed to preset Skill: ${label}`);
        return null;
      }

      const validateResponse = await api.admin.validateSkillPreset(createdPreset.id, values.tenantId);
      if (!validateResponse.ok) {
        setError(await readError(validateResponse, `Failed to validate Skill preset: ${label}`));
        await cleanupCreatedPreset(createdPreset.id);
        return null;
      }
      const validatePayload = await validateResponse.json() as {
        preset?: AdminSkillPreset;
        validation?: { status?: string; error?: string };
      };
      if (validatePayload.validation?.status && validatePayload.validation.status !== 'healthy') {
        setError(validatePayload.validation.error || `Skill preset validation failed: ${label}`);
        await cleanupCreatedPreset(createdPreset.id);
        return null;
      }

      const publishResponse = await api.admin.publishSkillPreset(createdPreset.id, values.tenantId);
      if (!publishResponse.ok) {
        setError(await readError(publishResponse, `Failed to publish Skill preset: ${label}`));
        await cleanupCreatedPreset(createdPreset.id);
        return null;
      }
      const publishPayload = await publishResponse.json() as { preset?: AdminSkillPreset };
      return publishPayload.preset || validatePayload.preset || createdPreset;
    };

    try {
      if (skills.length === 0) {
        const preset = await createValidatePublish(buildPayload(values), values.sourceRef);
        if (preset) saved.push(preset);
      } else {
        for (const skill of skills) {
          const preset = await createValidatePublish(buildSkillPayload(values, skill), getSkillRef(skill));
          if (!preset) {
            if (saved.length > 0) {
              await load();
            }
            return saved;
          }
          saved.push(preset);
        }
      }
      await load();
      return saved;
    } finally {
      setIsSaving(false);
    }
  }, [load]);

  const validatePreset = useCallback(async (presetId: number) => {
    if (!tenantId) return null;
    setValidatingPresetIds((current) => new Set(current).add(presetId));
    setError(null);
    try {
      const response = await api.admin.validateSkillPreset(presetId, tenantId);
      if (!response.ok) {
        setError(await readError(response, 'Failed to validate Skill preset'));
        return null;
      }
      const payload = await response.json() as { preset?: AdminSkillPreset };
      await load();
      return payload.preset || null;
    } finally {
      setValidatingPresetIds((current) => {
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
      const response = await api.admin.publishSkillPreset(presetId, tenantId);
      if (!response.ok) {
        setError(await readError(response, 'Failed to publish Skill preset'));
        return null;
      }
      const payload = await response.json() as { preset?: AdminSkillPreset };
      await load();
      return payload.preset || null;
    } finally {
      setIsSaving(false);
    }
  }, [load, tenantId]);

  const applyPreset = useCallback(async (presetId: number, overwrite = false) => {
    if (!tenantId) return null;
    setIsSaving(true);
    setError(null);
    try {
      const response = await api.admin.applySkillPreset(presetId, { tenantId, overwrite });
      if (!response.ok) {
        setError(await readError(response, 'Failed to apply Skill preset'));
        return null;
      }
      return await response.json();
    } finally {
      setIsSaving(false);
    }
  }, [tenantId]);

  const disablePreset = useCallback(async (presetId: number) => {
    if (!tenantId) return null;
    setIsSaving(true);
    setError(null);
    try {
      const response = await api.admin.disableSkillPreset(presetId, tenantId);
      if (!response.ok) {
        setError(await readError(response, 'Failed to disable Skill preset'));
        return null;
      }
      const payload = await response.json() as { preset?: AdminSkillPreset };
      await load();
      return payload.preset || null;
    } finally {
      setIsSaving(false);
    }
  }, [load, tenantId]);

  const deletePreset = useCallback(async (presetId: number) => {
    if (!tenantId) return false;
    setIsSaving(true);
    setError(null);
    try {
      const response = await api.admin.deleteSkillPreset(presetId, tenantId);
      if (!response.ok) {
        setError(await readError(response, 'Failed to delete Skill preset'));
        return false;
      }
      setPresets((current) => current.filter((preset) => preset.id !== presetId));
      return true;
    } finally {
      setIsSaving(false);
    }
  }, [tenantId]);

  return {
    presets,
    marketSkills,
    marketPageInfo,
    error,
    isLoading,
    isSearching,
    isSaving,
    validatingPresetIds,
    reload: load,
    searchMarket,
    savePreset,
    savePresets,
    validatePreset,
    publishPreset,
    applyPreset,
    disablePreset,
    deletePreset,
  };
}
