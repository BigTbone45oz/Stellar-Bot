import { cursorBeforeLedger, ledgerSeqFromToid } from './toid.js';

const PAGE_LIMIT = 200; // Horizon's hard max per page

/**
 * Fetches every record of a Horizon collection endpoint (ledgers, operations,
 * effects, transactions — anything with a TOID paging_token) across a known
 * ledger-sequence range, using parallel chunked requests instead of one long
 * sequential cursor-walk.
 *
 * Safe to parallelize because the caller already knows the full
 * [startSeq, endSeq] range up front (from ledgerSequenceForTimestamp), so a
 * starting cursor for any sub-range can be computed independently via
 * cursorBeforeLedger() — chunks don't depend on each other. Normal Horizon
 * pagination can't do this since each page's cursor comes from the previous
 * page's last record.
 *
 * Each chunk still pages sequentially *within itself* since record density
 * per ledger varies (notably for /operations), so a fixed ledger-sequence
 * span isn't always exactly one page. `ledgersPerChunk` only tunes
 * performance — correctness just needs exhaustive paging within each chunk.
 *
 * @param onPage called with each page's in-range records as they arrive, so
 *   the caller can aggregate incrementally instead of holding everything in
 *   memory at once.
 * @returns {truncated, recordCount} — recordCount can overshoot maxRecords by
 *   up to roughly (concurrency × page size): in-flight chunks aren't
 *   interrupted mid-fetch when the cap is crossed, only new chunks stop being
 *   claimed. Fine as a safety valve against runaway ranges, not an exact
 *   ceiling.
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
  // firing all chunks at once (which could trip Horizon's rate limiting on a
  // wide date range).
  //
  // Chunks are claimed via a shared, strictly-ascending `nextChunk` counter
  // and always run to completion once claimed, so even though they execute
  // concurrently and can finish in any order, the chunks processed by the
  // time maxRecords is hit are always a contiguous prefix in sequence order —
  // required for the UI's "showing the first portion fetched" truncation
  // message to be accurate.
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

  // fetchChunk's own truncated=true only fires if a chunk needs 2+ pages to
  // cross maxRecords — a chunk that crosses the cap on a single short page
  // returns without hitting that check, leaving later chunks unclaimed. Any
  // unclaimed chunk means the range wasn't fully covered, regardless of which
  // path caused the stop.
  if (nextChunk < chunkBounds.length) truncated = true;

  return { truncated, recordCount };
}
