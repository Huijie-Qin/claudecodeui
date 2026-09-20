import { IMAGE_FILE_EXTENSIONS } from '../file-tree/constants/constants';

export type FilePreviewKind = 'editor' | 'image' | 'spreadsheet';

export function getFilePreviewKind(fileName: string): FilePreviewKind {
  const extension = fileName.split('.').pop()?.toLowerCase() || '';
  if (IMAGE_FILE_EXTENSIONS.has(extension)) return 'image';
  return extension === 'xlsx' ? 'spreadsheet' : 'editor';
}
