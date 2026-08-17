import { cursorBeforeLedger, ledgerSeqFromToid } from './toid.js';

const PAGE_LIMIT = 200; // Horizon's hard max per page

/**
 * Fetches every record of a Horizon collection endpoint (ledgers, operations,
 * effects, transactions — anything with a TOID paging_token) across a known
 * ledger-sequence range, using parallel chunked requests instead of one long
 * sequential cursor-walk.
 *
 * Why this is safe to parallelize when normal pagination isn't: Horizon
 * pagination usually requires each page's cursor to come from the previous
 * page's last record, forcing sequential requests. But the callers here
 * already know the full [startSeq, endSeq] range up front (from
 * ledgerSequenceForTimestamp), so a starting cursor for any sub-range can be
 * computed independently with cursorBeforeLedger() — chunks don't depend on
 * each other and can be fetched concurrently.
 *
 * Each chunk still pages sequentially *within itself* if it has more than one
 * page of records — this matters for /operations, where record density per
 * ledger varies a lot, so a chunk defined by a fixed ledger-sequence span
 * won't always be exactly one page. Correctness doesn't depend on the chunk
 * size guess being right, only on exhaustively paging within each chunk;
 * `ledgersPerChunk` is a performance tuning knob, not a correctness one.
 *
 * @param onPage called with each page's in-range records as they arrive, so
 *   the caller can aggregate incrementally instead of holding everything in
 *   memory at once.
 * @returns {truncated, recordCount} — note recordCount can overshoot maxRecords
 *   by up to roughly (concurrency × page size): in-flight chunks aren't
 *   interrupted mid-fetch when the cap is crossed, only new chunks stop being
 *   claimed. That's fine for a safety valve against runaway ranges — it isn't
 *   meant to be an exact ceiling, just a bound on how bad "too wide a range"
 *   can get.
 */
export async function fetchRangeParallel(
  horizon,
  path,
  startSeq,
  endSeq,
  { ledgersPerChunk, maxRecords, concurrency = 6, onPage }
) {
  const chunkBounds = [];
  for (let seq = startSeq; seq <= endSeq; seq += ledgersPerChunk) {
    chunkBounds.push([seq, Math.min(seq + ledgersPerChunk - 1, endSeq)]);
  }

  let recordCount = 0;
  let truncated = false;

  async function fetchChunk([chunkStart, chunkEnd]) {
    let cursor = cursorBeforeLedger(chunkStart);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (recordCount >= maxRecords) {
        truncated = true;
        return;
      }
      const page = await horizon.get(path, { order: 'asc', limit: PAGE_LIMIT, cursor });
      const records = page._embedded.records;
      if (records.length === 0) return;

      const inRange = [];
      let doneChunk = false;
      for (const r of records) {
        if (ledgerSeqFromToid(r.paging_token) > chunkEnd) {
          doneChunk = true;
          break;
        }
        inRange.push(r);
      }
      if (inRange.length) {
        onPage(inRange);
        recordCount += inRange.length;
      }
      if (doneChunk || records.length < PAGE_LIMIT) return;
      cursor = records[records.length - 1].paging_token;
    }
  }

  // Bounded-concurrency worker pool: each worker pulls the next unclaimed
  // chunk until none remain, capping in-flight Horizon requests rather than
  // firing all chunks at once (which could trip Horizon's own rate limiting
  // on a wide date range).
  //
  // Correctness note: workers claim chunks via a shared, strictly-ascending
  // `nextChunk` counter, and a claimed chunk always runs to completion (never
  // abandoned mid-fetch). So even though chunks execute concurrently and can
  // finish in any order, the set of chunks actually processed when maxRecords
  // is hit is always a contiguous prefix {0, 1, ..., K} in sequence order —
  // not a scattered subset. That matters because the UI's truncation message
  // ("showing the first portion fetched") depends on it being a clean prefix
  // of the date range, not gaps in the middle.
  let nextChunk = 0;
  async function worker() {
    while (nextChunk < chunkBounds.length) {
      if (recordCount >= maxRecords) return;
      const chunk = chunkBounds[nextChunk++];
      await fetchChunk(chunk);
    }
  }
  const workerCount = Math.min(concurrency, chunkBounds.length) || 1;
  await Promise.all(Array.from({ length: workerCount }, worker));

  // Belt-and-suspenders on top of fetchChunk's own truncated=true (which only
  // fires if a chunk needs 2+ pages to cross maxRecords): if a chunk crosses the
  // cap on a single short page, it returns immediately without ever hitting that
  // check again, and any remaining unclaimed chunks in chunkBounds silently never
  // get fetched. Detecting that directly here — some chunks left unclaimed means
  // the range wasn't actually fully covered, regardless of which code path caused
  // it to stop.
  if (nextChunk < chunkBounds.length) truncated = true;

  return { truncated, recordCount };
}
