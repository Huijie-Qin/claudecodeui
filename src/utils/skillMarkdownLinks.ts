type SkillFileEntry = {
  path: string;
  type?: string;
};

const SKILL_DIRECTORY_MARKERS = [
  ['.claude', 'skills'],
  ['.codex', 'skills'],
  ['.agents', 'skills'],
] as const;

/** Resolves a Markdown link to a file that is present in the current skill. */
export function resolveSkillFileLink(
  href: string,
  currentFilePath: string,
  files: readonly SkillFileEntry[],
): string | null {
  const decodedPath = getInternalLinkPath(href);
  if (!decodedPath) return null;

  const currentDirectory = currentFilePath.includes('/')
    ? currentFilePath.slice(0, currentFilePath.lastIndexOf('/'))
    : '';
  const candidatePath = normalizeSkillPath(
    decodedPath.startsWith('/') ? decodedPath.slice(1) : `${currentDirectory}/${decodedPath}`,
  );
  if (!candidatePath) return null;

  return files.some((file) => file.type !== 'directory' && file.path === candidatePath)
    ? candidatePath
    : null;
}

/** Resolves a generic editor link while keeping it inside the current workspace skill. */
export function resolveWorkspaceSkillFileLink(href: string, currentFilePath: string): string | null {
  const decodedPath = getInternalLinkPath(href);
  if (!decodedPath) return null;

  const normalizedCurrentPath = currentFilePath.replace(/\\/g, '/');
  const currentIsAbsolute = normalizedCurrentPath.startsWith('/');
  const currentSegments = normalizePathSegments(normalizedCurrentPath);
  if (!currentSegments) return null;

  const markerIndex = findSkillDirectoryMarker(currentSegments);
  if (markerIndex === -1) return null;

  const pathInsideSkills = currentSegments.slice(markerIndex + 2);
  if (pathInsideSkills.length === 0) return null;

  // Also support a manually created root-level .claude/skills/SKILL.md.
  const rootLength = pathInsideSkills[0].toLowerCase() === 'skill.md'
    ? markerIndex + 2
    : markerIndex + 3;
  const skillRootSegments = currentSegments.slice(0, rootLength);
  const targetSegments = normalizePathSegments(
    decodedPath.startsWith('/')
      ? [...skillRootSegments, ...decodedPath.slice(1).split('/')].join('/')
      : [...currentSegments.slice(0, -1), ...decodedPath.split('/')].join('/'),
  );
  if (!targetSegments || !startsWithPath(targetSegments, skillRootSegments)) return null;

  const resolvedPath = targetSegments.join('/');
  return currentIsAbsolute ? `/${resolvedPath}` : resolvedPath;
}

function getInternalLinkPath(href: string): string | null {
  const trimmedHref = href.trim();
  if (!trimmedHref || trimmedHref.startsWith('#') || isExternalHref(trimmedHref)) {
    return null;
  }

  const pathWithoutSuffix = trimmedHref.split(/[?#]/, 1)[0];
  if (!pathWithoutSuffix) return null;

  try {
    return decodeURIComponent(pathWithoutSuffix).replace(/\\/g, '/');
  } catch {
    return null;
  }
}

function isExternalHref(href: string): boolean {
  return href.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(href);
}

function normalizeSkillPath(path: string): string | null {
  const segments = normalizePathSegments(path);
  return segments?.join('/') || null;
}

function normalizePathSegments(path: string): string[] | null {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments;
}

function findSkillDirectoryMarker(segments: readonly string[]): number {
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    if (SKILL_DIRECTORY_MARKERS.some(([directory, skills]) => (
      segments[index] === directory && segments[index + 1] === skills
    ))) {
      return index;
    }
  }
  return -1;
}

function startsWithPath(path: readonly string[], parent: readonly string[]): boolean {
  return parent.every((segment, index) => path[index] === segment);
}
