import { useEffect, useRef, useState } from 'react';

// Same reset-on-dep-change guarantee as useAsyncResource, but for the one
// polling case in this codebase (Overview.jsx's network-health stats: a 30s
// interval + immediate refresh on tab visibilitychange, since network health
// is the one thing that's genuinely worth polling — see useAsyncResource's
// own comment for why the reset-before-fetch pattern matters). Kept as a
// separate hook rather than folded into useAsyncResource's single-shot
// "fetch once per dep change" contract — conflating "fetch once" with "fetch
// repeatedly, deps just control the reset boundary" would make the primary
// hook harder to reason about for a shape only one view currently needs.
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
      // Skip while the tab is hidden — no point polling for a chart nobody's
      // looking at. Refreshes immediately on visibilitychange instead, so
      // data isn't stale when the user comes back.
      if (pauseWhenHidden && document.visibilityState === 'hidden') return;
      const myGeneration = ++generationRef.current;
      try {
        const d = await fetcherRef.current();
        if (cancelled || generationRef.current !== myGeneration) return;
        setData(d);
        setError(null);
      } catch (e) {
        if (cancelled || generationRef.current !== myGeneration) return;
        // Deliberately does NOT clear `data` here, unlike useAsyncResource's
        // run() — this is stale-while-revalidate by design: a live-health
        // widget polling every 30s should keep showing the last-known-good
        // ledger/fee numbers through one flaky poll, with an error banner
        // alongside them, rather than blanking the whole panel on every
        // transient failure. Not the same situation as a manual lookup
        // (Accounts/Trades/Assets search), where a NEW request replacing an
        // UNRELATED previous result should discard it on failure.
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
