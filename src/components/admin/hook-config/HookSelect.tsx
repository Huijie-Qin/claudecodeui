import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';

import { cn } from '../../../lib/utils';

export type HookSelectOption = {
  value: string;
  label: string;
  description?: string;
  group?: string;
  disabled?: boolean;
};

type HookSelectProps = {
  value: string;
  options: HookSelectOption[];
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  menuClassName?: string;
  menuMinWidth?: number;
  anchorRef?: RefObject<HTMLElement>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
};

export default function HookSelect({
  value,
  options,
  onChange,
  placeholder,
  ariaLabel,
  disabled = false,
  className,
  menuClassName,
  menuMinWidth = 0,
  anchorRef,
  open: controlledOpen,
  onOpenChange,
  hideTrigger = false,
}: HookSelectProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = useCallback((next: boolean | ((current: boolean) => boolean)) => {
    const resolved = typeof next === 'function' ? next(open) : next;
    if (controlledOpen === undefined) setInternalOpen(resolved);
    onOpenChange?.(resolved);
  }, [controlledOpen, onOpenChange, open]);
  const [search, setSearch] = useState('');
  const [menuPosition, setMenuPosition] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);
  const searchable = options.length > 8;
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return options;
    return options.filter((option) => (
      option.label.toLowerCase().includes(query)
      || option.value.toLowerCase().includes(query)
      || option.description?.toLowerCase().includes(query)
    ));
  }, [options, search]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)
        && !anchorRef?.current?.contains(target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [anchorRef, open, setOpen]);

  useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return undefined;

    const updatePlacement = () => {
      const root = anchorRef?.current || rootRef.current;
      const menu = menuRef.current;
      if (!root || !menu) return;

      const rootRect = root.getBoundingClientRect();
      const menuHeight = Math.min(320, menu.scrollHeight);
      const viewportHeight = window.innerHeight;
      const margin = 8;
      const gap = 6;
      const spaceBelow = Math.max(0, viewportHeight - rootRect.bottom - gap - margin);
      const spaceAbove = Math.max(0, rootRect.top - gap - margin);
      const above = spaceBelow < menuHeight && spaceAbove > spaceBelow;
      const width = Math.min(Math.max(rootRect.width, menuMinWidth), window.innerWidth - margin * 2);
      setMenuPosition({
        left: Math.max(margin, Math.min(rootRect.left, window.innerWidth - width - margin)),
        width,
        maxHeight: Math.min(320, above ? spaceAbove : spaceBelow),
        top: above ? 'auto' : rootRect.bottom + gap,
        bottom: above ? viewportHeight - rootRect.top + gap : 'auto',
      });
    };

    updatePlacement();
    window.addEventListener('resize', updatePlacement);
    window.addEventListener('scroll', updatePlacement, true);
    const observer = new ResizeObserver(updatePlacement);
    const anchor = anchorRef?.current || rootRef.current;
    if (anchor) observer.observe(anchor);
    if (menuRef.current) observer.observe(menuRef.current);
    return () => {
      window.removeEventListener('resize', updatePlacement);
      window.removeEventListener('scroll', updatePlacement, true);
      observer.disconnect();
    };
  }, [anchorRef, filtered.length, menuMinWidth, open]);

  const groups = filtered.reduce<Record<string, HookSelectOption[]>>((result, option) => {
    const group = option.group || '';
    result[group] = result[group] || [];
    result[group].push(option);
    return result;
  }, {});

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      {!hideTrigger ? (
        <button
          type="button"
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
          className={cn(
            'flex h-10 w-full items-center justify-between gap-2 rounded-xl border border-input bg-background px-3 text-left text-sm text-foreground shadow-sm outline-none transition',
            'hover:border-primary/40 focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-primary/10',
            disabled && 'cursor-not-allowed opacity-50',
          )}
        >
          <span className={cn('min-w-0 flex-1 truncate', !selected && 'text-muted-foreground')}>
            {selected?.label || placeholder}
          </span>
          <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </button>
      ) : null}

      {open ? createPortal(
        <div ref={menuRef} style={menuPosition} className={cn(
          'fixed z-[100] flex max-h-80 flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl',
          menuClassName,
        )}>
          {searchable ? (
            <div className="shrink-0 border-b border-border p-2">
              <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-2.5">
                <Search className="h-3.5 w-3.5 text-muted-foreground" />
                <input
                  autoFocus
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  placeholder={placeholder}
                />
              </div>
            </div>
          ) : null}
          <div className="max-h-64 min-h-0 overflow-y-auto p-1.5" role="listbox" aria-label={ariaLabel}>
            {filtered.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">{placeholder}</div>
            ) : Object.entries(groups).map(([group, groupOptions]) => (
              <div key={group || 'default'}>
                {group ? (
                  <div className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {group}
                  </div>
                ) : null}
                {groupOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    disabled={option.disabled}
                    onClick={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground',
                      option.value === value && 'bg-primary/10 text-primary',
                      option.disabled && 'cursor-not-allowed opacity-45',
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{option.label}</span>
                      {option.description ? (
                        <span className="mt-0.5 line-clamp-2 block text-[11px] leading-4 text-muted-foreground">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                    {option.value === value ? <Check className="mt-0.5 h-4 w-4 shrink-0" /> : null}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
