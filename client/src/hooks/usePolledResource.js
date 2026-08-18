import { useEffect, useRef, useState } from 'react';

// Same reset-on-dep-change guarantee as useAsyncResource, but for polling: a 30s
// interval plus immediate refresh on tab visibilitychange. Kept separate from
// useAsyncResource's single-shot "fetch once per dep change" contract rather than
// folding "fetch repeatedly" into it.
export function usePolledResource(fetcher, resetDeps, { intervalMs, pauseWhenHidden = true } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const generationRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    generationRef.current += 1;
    setData(null);
    setError(null);

    async function load() {
      // Skip while the tab is hidden; visibilitychange triggers an immediate
      // refresh instead, so data isn't stale when the user comes back.
      if (pauseWhenHidden && document.visibilityState === 'hidden') return;
      const myGeneration = ++generationRef.current;
      try {
        const d = await fetcherRef.current();
        if (cancelled || generationRef.current !== myGeneration) return;
        setData(d);
        setError(null);
      } catch (e) {
        if (cancelled || generationRef.current !== myGeneration) return;
        // Deliberately does not clear `data` here (unlike useAsyncResource's
        // run()) — stale-while-revalidate by design, so a flaky poll shows an
        // error banner alongside the last-known-good values instead of blanking.
        setError(e.message);
      }
    }

    load();
    const id = intervalMs ? setInterval(load, intervalMs) : null;
    document.addEventListener('visibilitychange', load);
    return () => {
      cancelled = true;
      if (id) clearInterval(id);
      document.removeEventListener('visibilitychange', load);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, resetDeps);

  return { data, error };
}
