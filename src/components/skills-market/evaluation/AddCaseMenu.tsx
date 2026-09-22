import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Plus, Wand2 } from 'lucide-react';

export default function AddCaseMenu({ disabled, aiDisabled, onManual, onAi }: {
  disabled: boolean; aiDisabled: boolean; onManual: () => void; onAi: () => void;
}) {
  const { t } = useTranslation('common');
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const initialFocus = useRef<'first' | 'last' | null>(null);
  const visible = open && !disabled;
  useEffect(() => {
    if (!visible) return;
    if (initialFocus.current) {
      const items = root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
      const index = initialFocus.current === 'last' ? (items?.length || 1) - 1 : 0;
      items?.[index]?.focus();
      initialFocus.current = null;
    }
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [visible]);
  const select = (action: () => void) => {
    setOpen(false); trigger.current?.focus(); action();
  };
  const item = 'flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-sm hover:bg-accent focus:outline-none focus-visible:bg-accent disabled:cursor-not-allowed disabled:opacity-50';
  return <div ref={root} className="relative" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }} onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!visible) { initialFocus.current = ['ArrowUp', 'End'].includes(event.key) ? 'last' : 'first'; setOpen(true); return; }
      const items = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || []);
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : current < 0 ? (event.key === 'ArrowUp' ? items.length - 1 : 0) : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
    }
  }}>
    <button ref={trigger} type="button" disabled={disabled} aria-haspopup="menu" aria-expanded={visible} aria-controls={visible ? id : undefined}
      className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
      onClick={(event) => { initialFocus.current = !visible && event.detail === 0 ? 'first' : null; setOpen((current) => !current); }}>
      <Plus className="h-4 w-4" />{t('skillEvaluation.add')}<ChevronDown className="h-4 w-4" />
    </button>
    {visible && <div id={id} role="menu" aria-label={t('skillEvaluation.add')} className="absolute left-0 top-full z-30 mt-1 w-56 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg">
      <button type="button" role="menuitem" className={item} onClick={() => select(onManual)}><Plus className="h-4 w-4" />{t('skillEvaluation.manualAdd')}</button>
      <button type="button" role="menuitem" className={item} disabled={aiDisabled} onClick={() => select(onAi)}><Wand2 className="h-4 w-4" />{t('skillEvaluation.aiAdd')}</button>
    </div>}
  </div>;
}
