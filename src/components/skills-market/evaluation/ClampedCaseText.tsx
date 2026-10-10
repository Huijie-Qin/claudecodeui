import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Two-line table summary with a scrollable full-text tooltip. */
export default function ClampedCaseText({ text }: { text: string }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null), tooltip = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxHeight: 0 });
  const keepOpen = () => { clearTimeout(hideTimer.current); setOpen(true); };
  const hideSoon = () => { clearTimeout(hideTimer.current); hideTimer.current = setTimeout(() => setOpen(false), 150); };
  useEffect(() => () => clearTimeout(hideTimer.current), []);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(480, window.innerWidth - 24);
      const below = window.innerHeight - rect.bottom - 20, above = rect.top - 20;
      const useBelow = below >= Math.min(240, above);
      const maxHeight = Math.min(320, Math.max(80, useBelow ? below : above));
      const height = Math.min(tooltip.current?.scrollHeight || maxHeight, maxHeight);
      setPosition({ width, maxHeight, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: useBelow ? rect.bottom + 8 : Math.max(12, rect.top - height - 8) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, text, position.width]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !tooltip.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, [open]);
  const onBlur = (event: React.FocusEvent) => {
    const next = event.relatedTarget as Node | null;
    if (!trigger.current?.contains(next) && !tooltip.current?.contains(next)) hideSoon();
  };
  return <>
    <button ref={trigger} type="button" aria-describedby={open ? id : undefined}
      className="line-clamp-2 w-full cursor-help whitespace-pre-wrap break-words rounded-sm text-left text-sm leading-5 outline-none [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring"
      onMouseEnter={keepOpen} onMouseLeave={hideSoon} onFocus={keepOpen} onBlur={onBlur} onClick={keepOpen}>
      {text}
    </button>
    {open && createPortal(<div ref={tooltip} id={id} role="tooltip" tabIndex={0}
      style={position} className="fixed z-[10060] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-popover p-3 text-sm leading-6 text-popover-foreground shadow-lg outline-none [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring"
      onMouseEnter={keepOpen} onMouseLeave={hideSoon} onFocus={keepOpen} onBlur={onBlur}>{text}</div>, document.body)}
  </>;
}
