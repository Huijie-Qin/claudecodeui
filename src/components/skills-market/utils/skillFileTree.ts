import type { WorkspaceSkillEntry } from './skillFormatting';

export type SkillTreeNode = {
  depth: number;
  label: string;
  parentPath: string;
  path: string;
  type: 'directory' | 'file';
};

export function createSkillTreeNodes(entries: WorkspaceSkillEntry[]): SkillTreeNode[] {
  const nodes = new Map<string, SkillTreeNode>();
  const entryTypes = new Map(entries.map((entry) => [entry.path, entry.type]));

  for (const entry of entries) {
    const parts = entry.path.split('/').filter(Boolean);
    parts.forEach((label, index) => {
      const path = parts.slice(0, index + 1).join('/');
      const explicitType = entryTypes.get(path);
      nodes.set(path, {
        depth: index,
        label,
        parentPath: parts.slice(0, index).join('/'),
        path,
        type: explicitType === 'file' || explicitType === 'symlink'
          ? 'file'
          : index === parts.length - 1 && entry.type !== 'directory'
            ? 'file'
            : 'directory',
      });
    });
  }

  return sortSkillTreeNodes(Array.from(nodes.values()));
}

export function getVisibleSkillTreeNodes(nodes: SkillTreeNode[], expandedPaths: ReadonlySet<string>): SkillTreeNode[] {
  return nodes.filter((node) => getAncestorPaths(node.path).every((path) => expandedPaths.has(path)));
}

export function getSkillDirectoryPaths(nodes: SkillTreeNode[]): string[] {
  return nodes.filter((node) => node.type === 'directory').map((node) => node.path);
}

export function getNewEntryParentPath(nodes: SkillTreeNode[], selectedPath: string | null): string {
  if (!selectedPath) return '';
  const selected = nodes.find((node) => node.path === selectedPath);
  if (!selected) return '';
  return selected.type === 'directory' ? selected.path : selected.parentPath;
}

export function buildChildPath(parentPath: string, name: string): string {
  const normalizedName = name.trim();
  return parentPath ? `${parentPath}/${normalizedName}` : normalizedName;
}

export function buildRenamedPath(path: string, name: string): string {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return buildChildPath(parts.join('/'), name);
}

export function buildMovedPath(path: string, parentPath: string): string {
  const parts = path.split('/').filter(Boolean);
  return buildChildPath(parentPath, parts.at(-1) ?? '');
}

export function validateSkillEntryName(value: string): string | null {
  const name = value.trim();
  if (!name) return '名称不能为空。';
  if (name === '.' || name === '..') return '名称不能是 . 或 ..。';
  if (/[\\/]/.test(name)) return '名称不能包含路径分隔符。';
  if (/[\u0000-\u001f\u007f]/.test(name)) return '名称不能包含控制字符。';
  return null;
}

export function validateSkillEntryMove(
  path: string,
  type: 'directory' | 'file',
  parentPath: string,
): string | null {
  if (path === 'SKILL.md') return 'SKILL.md 不能移动。';
  if (type === 'directory' && (parentPath === path || parentPath.startsWith(`${path}/`))) {
    return '文件夹不能移动到自身或其子目录。';
  }
  if (buildMovedPath(path, parentPath) === path) {
    return type === 'directory' ? '文件夹已经位于该目录。' : '文件已经位于该目录。';
  }
  return null;
}

function getAncestorPaths(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

function sortSkillTreeNodes(nodes: SkillTreeNode[]): SkillTreeNode[] {
  const children = new Map<string, SkillTreeNode[]>();
  nodes.forEach((node) => {
    const siblings = children.get(node.parentPath) ?? [];
    siblings.push(node);
    children.set(node.parentPath, siblings);
  });

  const sorted: SkillTreeNode[] = [];
  const visit = (parentPath: string) => {
    const siblings = children.get(parentPath) ?? [];
    siblings.sort(compareSiblingNodes).forEach((node) => {
      sorted.push(node);
      if (node.type === 'directory') visit(node.path);
    });
  };
  visit('');
  return sorted;
}

function compareSiblingNodes(left: SkillTreeNode, right: SkillTreeNode): number {
  if (left.type !== right.type) {
    return left.type === 'directory' ? -1 : 1;
  }
  return left.label.localeCompare(right.label);
}
