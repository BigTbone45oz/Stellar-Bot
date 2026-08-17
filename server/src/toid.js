// Horizon's paging_token for ledgers/transactions/operations/effects is a TOID:
// a single integer packing (ledgerSeq << 32) | (txIndex << 12) | opIndex.
// These values exceed Number.MAX_SAFE_INTEGER for real ledgers, so BigInt is required —
// using Number here would silently lose precision rather than error.

const LEDGER_SHIFT = 32n;

/** Cursor that lands just before the first record of `ledgerSeq` (inclusive lower bound). */
export function cursorBeforeLedger(ledgerSeq) {
  return String((BigInt(ledgerSeq) << LEDGER_SHIFT) - 1n);
}

/** The ledger sequence a given paging_token/toid belongs to. */
export function ledgerSeqFromToid(toid) {
  return Number(BigInt(toid) >> LEDGER_SHIFT);
}
