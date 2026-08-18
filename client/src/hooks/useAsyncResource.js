import { useCallback, useEffect, useRef, useState } from 'react';

// Fixes a bug class that kept recurring across this codebase: a fetch effect
// that doesn't reset its own state before firing a new request, so a failed
// refetch (network switch, transient error) leaves the PREVIOUS request's
// data rendering on screen alongside the new error message — most render
// guards only checked `!loading`, not `!error`. Found and fixed piecemeal in
// well over a dozen places (Overview, Accounts, Trades, Assets, Protocols,
// SmartContracts, LedgersTransactions, PaymentsOperations, NetworkGrowth)
// before being pulled out here, because nothing structurally stopped a new
// effect from omitting the reset — it was a convention, not a rule the code
// enforced. This hook makes the reset the hook's job, not the caller's.
//
// One generation counter (not a `cancelled` boolean) guards every completion
// — a boolean handles unmount/dep-change, but not two overlapping calls of
// the SAME generation (e.g. a manual re-click before the first request
// finishes), which the click-triggered call sites need too.
//
// - `resetDeps`: when any of these change, in-flight requests are
//   invalidated, `data`/`error`/`loading` reset, `onReset` fires, and (if
//   `enabled`) a new fetch auto-fires — same shape as the auto-fetch effects
//   this replaces.
// - `enabled: false`: the deps-effect still resets state on dep change (so a
//   network switch correctly clears stale results even for a manual-trigger
//   view), but never auto-fetches — call the returned `run(...args)`
//   yourself (e.g. from a button's onClick), matching Accounts.jsx/
//   Trades.jsx/Assets.jsx's search()-style manual lookups.
// - `onReset`: fires synchronously in the same tick data/error are cleared —
//   for resetting a derived selection back to a FIXED default (e.g.
//   Protocols.jsx's trendSelection -> TOTAL_OPTION) before the new fetch starts.
// - `onSuccess(data)`: fires after a fetch resolves — for deriving a
//   selection FROM the response (e.g. SmartContracts.jsx picking the
//   highest-call-count function as the default selection). Deliberately
//   separate from onReset: one must run before the fetch, the other only
//   makes sense after.
export function useAsyncResource(fetcher, resetDeps, options = {}) {
  const { enabled = true, onReset, onSuccess } = options;

  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // Latest callbacks kept in refs, not used directly as effect deps — these
  // are new closures every render (inline arrow functions at call sites are
  // the norm here), and depending on them by reference would make the
  // deps-effect below fire on every render instead of only on resetDeps
  // changes, silently reintroducing the exact staleness bug this hook exists
  // to prevent.
  const fetcherRef = useRef(fetcher);
  const onResetRef = useRef(onReset);
  const onSuccessRef = useRef(onSuccess);
  fetcherRef.current = fetcher;
  onResetRef.current = onReset;
  onSuccessRef.current = onSuccess;

  const generationRef = useRef(0);

  const run = useCallback((...args) => {
    const myGeneration = ++generationRef.current;
    setLoading(true);
    setError(null);
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

  const reset = useCallback(() => {
    generationRef.current += 1; // invalidate any in-flight request
    setData(null);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    generationRef.current += 1; // invalidate anything in flight from before this change
    setData(null);
    setError(null);
    setLoading(false);
    onResetRef.current?.();
    if (enabled) run();
    // resetDeps is caller-controlled, same contract as a normal effect deps
    // array — exhaustive-deps is intentionally not satisfiable here since the
    // array's length/contents vary per call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, resetDeps);

  return { data, error, loading, run, reset, setData };
}
