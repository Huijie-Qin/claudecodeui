import { authenticatedFetch } from '../../../utils/api';

export type Snippet = {
  id: string;
  title: string;
  description: string;
  markdown: string;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
};
export type SnippetDraft = Pick<Snippet, 'title' | 'description' | 'markdown'>;

async function request<T>(url: string, options = {}): Promise<T> {
  const response = await authenticatedFetch(url, options);
  if (response.status === 204) return undefined as T;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '片段操作失败，请重试。');
  return data as T;
}

export const snippetApi = {
  list: () => request<{ snippets: Snippet[]; canManage: boolean }>('/api/skill-snippets'),
  create: (draft: SnippetDraft) => request<{ snippet: Snippet }>('/api/admin/skill-snippets', { method: 'POST', body: JSON.stringify(draft) }),
  update: (snippet: Snippet, draft: SnippetDraft) => request<{ snippet: Snippet }>(`/api/admin/skill-snippets/${encodeURIComponent(snippet.id)}`, {
    method: 'PATCH', headers: { 'If-Match': `"${snippet.contentHash}"` }, body: JSON.stringify(draft),
  }),
  remove: (snippet: Snippet) => request<void>(`/api/admin/skill-snippets/${encodeURIComponent(snippet.id)}`, {
    method: 'DELETE', headers: { 'If-Match': `"${snippet.contentHash}"` },
  }),
};

export function filterSnippets(snippets: Snippet[], query: string) {
  const term = query.trim().normalize('NFC').toLowerCase();
  return snippets.filter((snippet) => [snippet.title, snippet.description, snippet.markdown]
    .some((value) => value.normalize('NFC').toLowerCase().includes(term)));
}
