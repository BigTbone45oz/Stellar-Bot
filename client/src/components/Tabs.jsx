export default function Tabs({ tabs, active, onChange }) {
  return (
    <nav className="tabs">
      {tabs.map((t) => (
        <button key={t.id} className={active === t.id ? 'active' : ''} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </nav>
  );
}
