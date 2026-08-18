import { defaultRange } from '../dateUtils.js';

const DEFAULT_PRESETS = [
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
  { label: '90d', hours: 2160 },
];

export default function DateRangePicker({ start, end, onChange, presets = DEFAULT_PRESETS }) {
  function applyPreset(hours) {
    onChange(defaultRange(hours));
  }

  function updateStart(value) {
    // Native date inputs fire onChange with '' when cleared; new Date('') throws
    // on .toISOString(), so no-op until a real date is picked.
    if (!value) return;
    const newStart = new Date(value).toISOString();
    // Guard against an inverted range client-side rather than relying on the server.
    onChange({ start: newStart, end: newStart > end ? newStart : end });
  }

  function updateEnd(value) {
    if (!value) return; // see updateStart
    // End-of-day, not start-of-day — otherwise picking the same calendar day for
    // both "From" and "To" produces a zero-width instant instead of a full day.
    const newEnd = new Date(`${value}T23:59:59.999Z`).toISOString();
    onChange({ start: newEnd < start ? newEnd : start, end: newEnd });
  }

  return (
    <div className="date-range-picker">
      <div className="presets">
        {presets.map((p) => (
          <button key={p.label} onClick={() => applyPreset(p.hours)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="custom-range">
        <label>
          From
          <input type="date" value={start.slice(0, 10)} onChange={(e) => updateStart(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={end.slice(0, 10)} onChange={(e) => updateEnd(e.target.value)} />
        </label>
      </div>
    </div>
  );
}

