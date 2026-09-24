import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

type Option = { value: string; label: string; description?: string };
const useClientLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** A select-only combobox. Focus stays on the trigger, including inside report dialogs. */
export default function ReportSelect({ label, value, options, onChange, disabled = false, className = '', icon, menuMinWidth = 220 }: {
  label: string; value: string; options: Option[]; onChange: (value: string) => void;
  disabled?: boolean; className?: string; icon?: ReactNode; menuMinWidth?: number;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef({ text: '', at: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [placement, setPlacement] = useState<CSSProperties>({ visibility: 'hidden' });
  const selected = options.find(option => option.value === value);
  const expanded = open && !disabled && options.length > 0;
  const show = (index = options.findIndex(option => option.value === value)) => {
    if (disabled || !options.length) return;
    setActive(Math.max(0, index)); setOpen(true); search.current = { text: '', at: 0 };
  };
  const choose = (index: number) => {
    const option = options[index];
    setOpen(false);
    if (option && option.value !== value) onChange(option.value);
    trigger.current?.focus({ preventScroll: true });
  };
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!expanded) return;
    const dismiss = (event: Event) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('focusin', dismiss);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('focusin', dismiss); };
  }, [expanded]);
  useClientLayoutEffect(() => {
    if (!expanded) return;
    const position = () => {
      if (!trigger.current || !menu.current) return;
      const rect = trigger.current.getBoundingClientRect();
      const gap = 6; const margin = 10;
      const below = Math.max(0, window.innerHeight - rect.bottom - gap - margin);
      const above = Math.max(0, rect.top - gap - margin);
      const upwards = below < Math.min(300, menu.current.scrollHeight) && above > below;
      const width = Math.min(Math.max(rect.width, menuMinWidth), window.innerWidth - margin * 2);
      setPlacement({ width, left: Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin)),
        maxHeight: Math.min(300, upwards ? above : below),
        top: upwards ? undefined : rect.bottom + gap, bottom: upwards ? window.innerHeight - rect.top + gap : undefined });
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    const observer = new ResizeObserver(position);
    if (trigger.current) observer.observe(trigger.current);
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); observer.disconnect(); };
  }, [expanded, menuMinWidth, options.length]);
  useEffect(() => {
    if (expanded) menu.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, expanded]);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Tab') { setOpen(false); return; }
    if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      if (!expanded) { show(event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : undefined); return; }
      if (event.key === 'Enter' || event.key === ' ') { choose(active); return; }
      setActive(index => event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
        : (index + (event.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      const text = (now - search.current.at < 600 ? search.current.text : '') + event.key.toLowerCase();
      search.current = { text, at: now };
      const index = options.findIndex(option => `${option.label} ${option.description || ''}`.toLowerCase().includes(text));
      if (index >= 0) { setActive(index); setOpen(true); }
    }
  };
  return <div className={`ai-report-select ${className}`}>
    <span id={`${id}-label`} className="ai-report-select-label">{label}</span>
    <button ref={trigger} type="button" role="combobox" aria-labelledby={`${id}-label`} aria-haspopup="listbox"
      aria-expanded={expanded} aria-controls={expanded ? `${id}-menu` : undefined}
      aria-activedescendant={expanded && options[active] ? `${id}-option-${active}` : undefined}
      data-report-select="" disabled={disabled || !options.length} className="ai-report-select-trigger"
      title={selected ? [selected.label, selected.description].filter(Boolean).join(' · ') : value}
      onClick={() => expanded ? setOpen(false) : show()} onKeyDown={onKeyDown}>
      {icon && <span aria-hidden="true" className="ai-report-select-icon">{icon}</span>}
      <span className="ai-report-select-value">{selected?.label || value || label}</span>
      <ChevronDown aria-hidden="true" className="ai-report-select-chevron" />
    </button>
    {expanded && createPortal(<div ref={menu} id={`${id}-menu`} role="listbox" aria-label={label}
      className="ai-report-select-menu" style={placement} onMouseDown={event => event.preventDefault()}>
      {options.map((option, index) => <div key={option.value} id={`${id}-option-${index}`} role="option"
        aria-selected={option.value === value} data-active={index === active}
        className="ai-report-select-option" onPointerMove={() => setActive(index)} onClick={() => choose(index)}>
        <span className="ai-report-select-option-text"><span>{option.label}</span>
          {option.description && <small>{option.description}</small>}
        </span>
        {option.value === value && <Check aria-hidden="true" />}
      </div>)}
    </div>, document.body)}
  </div>;
}
