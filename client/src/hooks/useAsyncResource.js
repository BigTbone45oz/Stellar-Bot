import { useCallback, useEffect, useRef, useState } from 'react';

// Ensures every fetch resets its own `data`/`error` state before a new request
// fires, so a failed refetch (network switch, transient error) never leaves the
// PREVIOUS request's data rendering on screen alongside the new error.
//
// Uses a generation counter rather than a `cancelled` boolean, since a boolean
// only handles unmount/dep-change — it can't distinguish two overlapping calls of
// the SAME generation (e.g. a manual re-click before the first request finishes),
// which the click-triggered call sites need too.
//
// - `resetDeps`: when any of these change, in-flight requests are invalidated,
//   `data`/`error`/`loading` reset, `onReset` fires, and (if `enabled`) a new
//   fetch auto-fires.
// - `enabled: false`: the deps-effect still resets state on dep change, but never
//   auto-fetches — call the returned `run(...args)` yourself (e.g. a button's
//   onClick) for manual-lookup views.
// - `onReset`: fires synchronously when data/error are cleared — for resetting a
//   derived selection back to a fixed default before the new fetch starts.
// - `onSuccess(data)`: fires after a fetch resolves — for deriving a selection
//   FROM the response. Kept separate from `onReset` since one must run before the
//   fetch and the other only makes sense after.
export function useAsyncResource(fetcher, resetDeps, options = {}) {
  const { enabled = true, onReset, onSuccess } = options;

  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // Latest callbacks kept in refs rather than used as effect deps — they're new
  // closures every render, and depending on them by reference would make the
  // deps-effect below fire on every render instead of only on resetDeps changes.
  const fetcherRef = useRef(fetcher);
  const onResetRef = useRef(onReset);
  const onSuccessRef = useRef(onSuccess);
  const enabledRef = useRef(enabled);
  fetcherRef.current = fetcher;
  onResetRef.current = onReset;
  onSuccessRef.current = onSuccess;
  enabledRef.current = enabled;

  const generationRef = useRef(0);

  const run = useCallback((...args) => {
    const myGeneration = ++generationRef.current;
    setLoading(true);
    setError(null);
    // Clears `data` too, not just `error` — matters for the manual-trigger path
    // (deps-effect already clears `data` before calling `run()` on auto-fetch).
    setData(null);
    return fetcherRef
      .current(...args)
      .then((d) => {
        if (generationRef.current !== myGeneration) return; // superseded
        setData(d);
        onSuccessRef.current?.(d);
      })
      .catch((e) => {
        if (generationRef.current !== myGeneration) return;
        setError(e.message);
      })
      .finally(() => {
        if (generationRef.current !== myGeneration) return;
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    generationRef.current += 1; // invalidate anything in flight from before this change
    setData(null);
    setError(null);
    setLoading(false);
    onResetRef.current?.();
    if (enabledRef.current) run();
    // resetDeps is caller-controlled, same contract as a normal effect deps
    // array — exhaustive-deps is intentionally not satisfiable here since the
    // array's length/contents vary per call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, resetDeps);

  return { data, error, loading, run };
}
