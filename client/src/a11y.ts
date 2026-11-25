import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router';

/**
 * After client-side navigation, move focus to <main> (so screen readers and keyboard users
 * start at the new content, not the link they clicked) and set the document title from the page's <h1>.
 * The first render keeps the browser's default focus.
 */
export function useRouteFocus() {
  const ref = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  const first = useRef(true);

  useEffect(() => {
    const main = ref.current;
    if (!main) return;
    // Wait a frame so the page (and its <h1>) has rendered.
    const id = requestAnimationFrame(() => {
      const h1 = main.querySelector('h1')?.textContent?.trim();
      document.title = h1 ? `${h1} · Synrgy` : 'Synrgy';
      if (first.current) first.current = false;
      else main.focus({ preventScroll: false });
    });
    return () => cancelAnimationFrame(id);
  }, [pathname]);

  return ref;
}

const subscribe = (cb: () => void) => {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
};

/** navigator.onLine as React state. */
export function useOnline() {
  return useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Dialog focus management: focus the first field on open, keep Tab inside, restore focus on close.
 */
export function useFocusTrap<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [opener] = useState(() => document.activeElement as HTMLElement | null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const items = () => [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
    // Prefer the first form field over the close button.
    const firstField = items().find((x) => !x.classList.contains('close')) ?? items()[0];
    (firstField ?? el).focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const list = items();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    el.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [opener]);

  return ref;
}
