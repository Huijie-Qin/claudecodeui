import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';

export type CodeHubRepository = {
  id: number;
  targetRepository: string;
  privateRepository: string;
  tokenConfigured: boolean;
  lastTestStatus?: 'connected' | 'failed' | null;
  lastTestError?: string | null;
  lastTestedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

type CodeHubListResponse = {
  success?: boolean;
  repositories?: CodeHubRepository[];
  error?: string;
};

type CodeHubMutationResponse = {
  success?: boolean;
  repository?: CodeHubRepository;
  error?: string;
};

type CodeHubTestResponse = {
  success?: boolean;
  repository?: CodeHubRepository;
  connection?: {
    status: 'connected' | 'failed';
    command?: string;
    output?: string;
    error?: string;
  };
  error?: string;
};

export type CodeHubFormState = {
  targetRepository: string;
  privateRepository: string;
  token: string;
};

const EMPTY_FORM: CodeHubFormState = {
  targetRepository: '',
  privateRepository: '',
  token: '',
};

const readError = (payload: { error?: string } | undefined, fallback: string) => (
  payload?.error || fallback
);

export function useCodeHubSettings() {
  const [repositories, setRepositories] = useState<CodeHubRepository[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<CodeHubFormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [testingIds, setTestingIds] = useState<Record<number, boolean>>({});
  const [testMessages, setTestMessages] = useState<Record<number, string>>({});

  const fetchRepositories = useCallback(async () => {
    try {
      setLoading(true);
      const response = await authenticatedFetch('/api/settings/codehub/repositories');
      const payload = await response.json() as CodeHubListResponse;
      if (!response.ok || !payload.success) {
        throw new Error(readError(payload, 'Failed to load CodeHub repositories'));
      }
      setRepositories(payload.repositories || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load CodeHub repositories');
    } finally {
      setLoading(false);
    }
  }, []);

  const updateForm = useCallback(<K extends keyof CodeHubFormState>(key: K, value: CodeHubFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const resetForm = useCallback(() => {
    setForm(EMPTY_FORM);
    setEditingId(null);
  }, []);

  const editRepository = useCallback((repository: CodeHubRepository) => {
    setEditingId(repository.id);
    setForm({
      targetRepository: repository.targetRepository,
      privateRepository: repository.privateRepository,
      token: '',
    });
  }, []);

  const saveRepository = useCallback(async () => {
    if (!form.targetRepository.trim() || !form.privateRepository.trim()) {
      return;
    }
    if (!editingId && !form.token.trim()) {
      return;
    }

    try {
      setSaving(true);
      const body = {
        targetRepository: form.targetRepository.trim(),
        privateRepository: form.privateRepository.trim(),
        token: form.token,
      };
      const response = await authenticatedFetch(
        editingId
          ? `/api/settings/codehub/repositories/${editingId}`
          : '/api/settings/codehub/repositories',
        {
          method: editingId ? 'PUT' : 'POST',
          body: JSON.stringify(body),
        },
      );
      const payload = await response.json() as CodeHubMutationResponse;
      if (!response.ok || !payload.success) {
        throw new Error(readError(payload, 'Failed to save CodeHub repository'));
      }
      resetForm();
      await fetchRepositories();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save CodeHub repository');
    } finally {
      setSaving(false);
    }
  }, [editingId, fetchRepositories, form, resetForm]);

  const deleteRepository = useCallback(async (repositoryId: number, confirmText: string) => {
    if (!window.confirm(confirmText)) {
      return;
    }

    try {
      const response = await authenticatedFetch(`/api/settings/codehub/repositories/${repositoryId}`, {
        method: 'DELETE',
      });
      const payload = await response.json() as CodeHubMutationResponse;
      if (!response.ok || !payload.success) {
        throw new Error(readError(payload, 'Failed to delete CodeHub repository'));
      }
      await fetchRepositories();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete CodeHub repository');
    }
  }, [fetchRepositories]);

  const testRepository = useCallback(async (repositoryId: number) => {
    try {
      setTestingIds((prev) => ({ ...prev, [repositoryId]: true }));
      setTestMessages((prev) => ({ ...prev, [repositoryId]: '' }));
      const response = await authenticatedFetch(`/api/settings/codehub/repositories/${repositoryId}/test`, {
        method: 'POST',
      });
      const payload = await response.json() as CodeHubTestResponse;
      if (!response.ok || !payload.success || !payload.connection) {
        throw new Error(readError(payload, 'Failed to test CodeHub repository'));
      }
      if (payload.repository) {
        setRepositories((prev) => prev.map((entry) => (
          entry.id === payload.repository?.id ? payload.repository : entry
        )));
      }
      setTestMessages((prev) => ({
        ...prev,
        [repositoryId]: payload.connection?.status === 'connected'
          ? 'connected'
          : (payload.connection?.error || 'failed'),
      }));
      setError(null);
    } catch (err) {
      setTestMessages((prev) => ({
        ...prev,
        [repositoryId]: err instanceof Error ? err.message : 'failed',
      }));
    } finally {
      setTestingIds((prev) => ({ ...prev, [repositoryId]: false }));
    }
  }, []);

  useEffect(() => {
    void fetchRepositories();
  }, [fetchRepositories]);

  return {
    repositories,
    loading,
    saving,
    error,
    form,
    editingId,
    testingIds,
    testMessages,
    updateForm,
    resetForm,
    editRepository,
    saveRepository,
    deleteRepository,
    testRepository,
  };
}
