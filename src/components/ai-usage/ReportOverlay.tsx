import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../shared/view/ui';

const focusableSelector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export default function ReportOverlay({ title, children, onClose, compact = false, fullHeight = false }: {
  title: string; children: ReactNode; onClose: () => void; compact?: boolean; fullHeight?: boolean;
}) {
  const { t } = useTranslation('aiUsage');
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    const previousPadding = document.body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${parseFloat(getComputedStyle(document.body).paddingRight) + scrollbarWidth}px`;
    }
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus({ preventScroll: true });
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); onCloseRef.current();
      }
      if (event.key !== 'Tab') return;
      const elements = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) || [])
        .filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
      const first = elements[0]; const last = elements[elements.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault(); first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('keydown', handleKey, true);
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPadding;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(<div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-2 backdrop-blur-sm sm:p-6" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} className={`ai-report-dialog flex max-h-[92dvh] w-full ${compact ? 'max-w-lg' : 'max-w-6xl'} ${fullHeight ? 'h-[92dvh]' : ''} flex-col overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-xl`}>
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5 sm:py-4">
        <h2 className="min-w-0 break-words font-semibold">{title}</h2>
        <Button ref={closeRef} variant="ghost" size="icon" className="shrink-0" aria-label={t('close')} onClick={onClose}><X className="h-4 w-4" /></Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain p-3 sm:p-5">{children}</div>
    </div>
  </div>, document.body);
}
