export function isoHoursAgo(hours) {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() - hours);
  return d.toISOString();
}

export function defaultRange(hours) {
  return { start: isoHoursAgo(hours), end: new Date().toISOString() };
}

// /api/payments/breakdown's op-density-based cap (20,000 records) means offering
// 7d/30d/90d presets would just burn the full cap to cover a few hours on a busy
// network. Shared by every view that calls that route — PaymentsOperations for its
// full operation-type chart, SmartContracts for the Soroban-only subset of the same
// data — so the two can't drift out of sync with each other or with the cap itself.
export const OPS_BREAKDOWN_RANGE_PRESETS = [
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '3d', hours: 72 },
];
