import { getFilePreviewKind } from './filePreviewKind';

/** Returns a local image/workbook path without changing external or ordinary links. */
export function resolveFilePreviewLink(href: string | undefined): string | null {
  const link = href?.trim();
  if (!link || link.startsWith('#') || link.startsWith('?') || hasProtocol(link)) {
    return null;
  }

  let path: string;
  try {
    path = decodeURIComponent(link.split(/[?#]/, 1)[0]).replace(/\\/g, '/');
  } catch {
    return null;
  }

  // Check again after decoding so encoded protocols and network paths stay links.
  if (!path || hasProtocol(path) || /[\u0000-\u001f\u007f]/.test(path)) {
    return null;
  }

  const fileName = path.slice(path.lastIndexOf('/') + 1);
  if (!fileName.includes('.') || getFilePreviewKind(fileName) === 'editor') {
    return null;
  }

  return path;
}

function hasProtocol(path: string): boolean {
  const normalizedPath = path.trimStart();
  return /^[a-z][a-z\d+.-]*:/i.test(normalizedPath) || /^[\\/]{2}/.test(normalizedPath);
}
