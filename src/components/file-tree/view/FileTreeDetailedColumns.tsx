import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';

import type { FileTreeSort, FileTreeSortField } from '../types/types';

type FileTreeDetailedColumnsProps = {
  sort: FileTreeSort;
  onSortChange: (field: FileTreeSortField) => void;
};

export default function FileTreeDetailedColumns({ sort, onSortChange }: FileTreeDetailedColumnsProps) {
  const { t } = useTranslation();
  const renderSortButton = (field: FileTreeSortField) => {
    const active = sort.field === field;
    const Icon = active ? (sort.direction === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
    return (
      <button
        type="button"
        onClick={() => onSortChange(field)}
        aria-pressed={active}
        className={`flex w-full items-center gap-1 rounded text-left uppercase tracking-wider hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active ? 'text-foreground' : ''}`}
      >
        <span className="truncate">{t(`fileTree.${field}`)}</span>
        <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
        {active && <span className="sr-only">{t(`fileTree.sort.${sort.direction}`)}</span>}
      </button>
    );
  };

  return (
    <div className="data-agent-file-columns border-b border-border px-3 pb-1 pt-1.5">
      <div className="grid grid-cols-12 gap-2 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        <div className="col-span-5">{renderSortButton('name')}</div>
        <div className="col-span-2">{t('fileTree.size')}</div>
        <div className="col-span-3">{renderSortButton('modified')}</div>
        <div className="col-span-2">{t('fileTree.permissions')}</div>
      </div>
    </div>
  );
}
