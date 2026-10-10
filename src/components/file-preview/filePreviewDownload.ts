import { api } from '../../utils/api';

import { savePreviewBlob } from './filePreview';

type DownloadableFile = { name: string; path: string; projectName?: string; workspaceId?: number };

export async function downloadOriginalFile(file: DownloadableFile, projectPath?: string): Promise<void> {
  const projectName = file.projectName || projectPath;
  if (!projectName) throw new Error('缺少工作区信息，无法下载文件。');
  const response = await api.readFileBlob(projectName, file.path, file.workspaceId);
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || `下载失败（${response.status}）`);
  }
  savePreviewBlob(await response.blob(), file.name);
}
