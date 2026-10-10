import type { FileTreeNode, FileTreeSort, FileTreeSortField } from '../types/types';

export function nextFileTreeSort(current: FileTreeSort, field: FileTreeSortField): FileTreeSort {
  return {
    field,
    direction: current.field === field
      ? (current.direction === 'asc' ? 'desc' : 'asc')
      : (field === 'name' ? 'asc' : 'desc'),
  };
}

export function sortFileTree(items: FileTreeNode[], sort: FileTreeSort): FileTreeNode[] {
  const direction = sort.direction === 'asc' ? 1 : -1;
  return items.map((item) => item.children
    ? { ...item, children: sortFileTree(item.children, sort) }
    : item).sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    if (sort.field === 'name') return direction * a.name.localeCompare(b.name);

    const aTime = Date.parse(a.modified ?? '');
    const bTime = Date.parse(b.modified ?? '');
    // Unavailable timestamps stay last in either direction.
    if (Number.isNaN(aTime)) return Number.isNaN(bTime) ? 0 : 1;
    if (Number.isNaN(bTime)) return -1;
    return direction * (aTime - bTime);
  });
}
