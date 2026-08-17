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
    const newStart = new Date(value).toISOString();
    // Guard against an inverted range from the UI itself, rather than relying
    // solely on the server to reject it after a round trip.
    onChange({ start: newStart, end: newStart > end ? newStart : end });
  }

  function updateEnd(value) {
    const newEnd = new Date(value).toISOString();
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

