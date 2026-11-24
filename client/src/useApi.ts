import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './api.ts';

/** Load data on mount / when deps change; exposes reload for after mutations. */
export function useApi<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, deps);

  const reload = useCallback(async () => {
    try {
      setData(await run());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load data');
    }
  }, [run]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, reload };
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const field = err.details && Object.entries(err.details)[0];
    return field ? `${field[0]}: ${field[1][0]}` : err.message;
  }
  return 'Something went wrong';
}
