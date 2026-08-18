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
    // Native date inputs fire onChange with '' when cleared (the browser's
    // built-in clear button, or backspacing through the field) — a completely
    // ordinary interaction, not a contrived edge case. new Date('') throws on
    // .toISOString() (RangeError: Invalid time value), which would otherwise
    // crash this handler with no visible feedback. No-op until a real date is
    // picked, same as leaving the range unchanged.
    if (!value) return;
    const newStart = new Date(value).toISOString();
    // Guard against an inverted range from the UI itself, rather than relying
    // solely on the server to reject it after a round trip.
    onChange({ start: newStart, end: newStart > end ? newStart : end });
  }

  function updateEnd(value) {
    if (!value) return; // see updateStart — same clear-button crash risk
    // Treat the picked day as running through its own end, not its start —
    // otherwise picking the same calendar day for both "From" and "To" (a
    // completely natural way to ask "show me all of today") produces a
    // zero-width instant instead of a full day.
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

