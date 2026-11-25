import { useEffect, useId, type ReactNode } from 'react';
import { useFocusTrap } from './a11y.ts';

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const titleId = useId();
  const ref = useFocusTrap<HTMLDivElement>();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    // Keep the page behind from scrolling while the dialog is open.
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} tabIndex={-1}>
        <header>
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="link close" aria-label="Close dialog" onClick={onClose}>
            ✕
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
