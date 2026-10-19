import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';

/**
 * Loads data every time the screen comes into view, with pull-to-refresh.
 * `load` must be stable (a module-level function or wrapped in useCallback),
 * or the screen reloads on every render.
 */
export function useLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const focused = useRef(true);

  const run = useCallback(
    async (mode: 'load' | 'refresh' = 'load') => {
      if (mode === 'refresh') setRefreshing(true);
      try {
        const result = await load();
        if (!focused.current) return;
        setData(result);
        setError(null);
      } catch (e) {
        if (!focused.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (focused.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [load],
  );

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      void run();
      return () => {
        focused.current = false;
      };
    }, [run]),
  );

  const reload = useCallback(() => run('refresh'), [run]);
  return { data, error, loading, refreshing, reload };
}
