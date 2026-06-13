import { useRef, type ReactNode, type RefObject } from 'react';
import { Folder } from 'lucide-react';

import { cn } from '../../../lib/utils';
import { Input } from '../../../shared/view/ui';
import { ICON_SIZE_CLASS } from '../constants/fileIcons';
import type { FileTreeViewMode } from '../types/types';

type FileTreeCreateInputProps = {
  viewMode: FileTreeViewMode;
  level: number;
  newItemType: 'file' | 'directory';
  newItemName: string;
  setNewItemName: (name: string) => void;
  handleConfirmCreate: () => void;
  handleCancelCreate: () => void;
  newItemInputRef: RefObject<HTMLInputElement>;
  operationLoading?: boolean;
  renderFileIcon: (filename: string) => ReactNode;
};

function CreateItemIcon({
  newItemType,
  newItemName,
  renderFileIcon,
}: Pick<FileTreeCreateInputProps, 'newItemType' | 'newItemName' | 'renderFileIcon'>) {
  return (
    <span className="ml-[18px] flex flex-shrink-0 items-center">
      {newItemType === 'directory' ? (
        <Folder className={cn(ICON_SIZE_CLASS, 'text-blue-500')} />
      ) : (
        renderFileIcon(newItemName)
      )}
    </span>
  );
}

export default function FileTreeCreateInput({
  viewMode,
  level,
  newItemType,
  newItemName,
  setNewItemName,
  handleConfirmCreate,
  handleCancelCreate,
  newItemInputRef,
  operationLoading,
  renderFileIcon,
}: FileTreeCreateInputProps) {
  const shouldConfirmOnBlurRef = useRef(true);

  const input = (
    <Input
      ref={newItemInputRef}
      type="text"
      value={newItemName}
      onChange={(event) => setNewItemName(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          shouldConfirmOnBlurRef.current = false;
          handleConfirmCreate();
        }
        if (event.key === 'Escape') {
          shouldConfirmOnBlurRef.current = false;
          handleCancelCreate();
        }
      }}
      onBlur={() => {
        setTimeout(() => {
          if (shouldConfirmOnBlurRef.current) {
            handleConfirmCreate();
          }
        }, 100);
      }}
      className="h-6 min-w-0 flex-1 text-sm"
      disabled={operationLoading}
    />
  );

  if (viewMode === 'detailed') {
    return (
      <div
        className="mb-1 grid grid-cols-12 items-center gap-2 py-[3px] pr-2"
        style={{ paddingLeft: `${level * 16 + 4}px` }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="col-span-5 flex min-w-0 items-center gap-1.5">
          <CreateItemIcon newItemType={newItemType} newItemName={newItemName} renderFileIcon={renderFileIcon} />
          {input}
        </div>
        <div className="col-span-2" />
        <div className="col-span-3" />
        <div className="col-span-2" />
      </div>
    );
  }

  return (
    <div
      className="mb-1 flex items-center gap-1.5 py-[3px] pr-2"
      style={{ paddingLeft: `${level * 16 + 4}px` }}
      onClick={(event) => event.stopPropagation()}
    >
      <CreateItemIcon newItemType={newItemType} newItemName={newItemName} renderFileIcon={renderFileIcon} />
      {input}
    </div>
  );
}
