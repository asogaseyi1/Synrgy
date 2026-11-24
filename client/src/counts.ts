import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { api } from './api.ts';
import { APPROVALS_CHANGED } from './pages/ExceptionPages.tsx';
import { SWAPS_CHANGED } from './pages/SwapPages.tsx';

export interface Counts {
  /** Time corrections waiting for me to review. */
  exceptions: number;
  /** Swaps waiting for my approval as a manager. */
  swapReview: number;
  /** Swap/cover requests addressed to me. */
  swapIncoming: number;
}

const ZERO: Counts = { exceptions: 0, swapReview: 0, swapIncoming: 0 };

/** Badge counts; refreshed on navigation, after decisions, and every minute. */
export function useCounts(isManager: boolean): Counts {
  const [counts, setCounts] = useState<Counts>(ZERO);
  const location = useLocation();

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [swaps, ex] = await Promise.all([
          api.get<{ incoming: number; review: number }>('/swaps/counts'),
          isManager ? api.get<{ pending: number }>('/exceptions/review-count') : Promise.resolve({ pending: 0 }),
        ]);
        if (alive) setCounts({ exceptions: ex.pending, swapReview: swaps.review, swapIncoming: swaps.incoming });
      } catch {
        // Badges are best-effort.
      }
    };
    void load();
    const id = setInterval(load, 60_000);
    window.addEventListener(APPROVALS_CHANGED, load);
    window.addEventListener(SWAPS_CHANGED, load);
    return () => {
      alive = false;
      clearInterval(id);
      window.removeEventListener(APPROVALS_CHANGED, load);
      window.removeEventListener(SWAPS_CHANGED, load);
    };
  }, [isManager, location.pathname, location.search]);

  return counts;
}
