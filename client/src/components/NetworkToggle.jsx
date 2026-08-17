export default function NetworkToggle({ network, onChange }) {
  return (
    <div className="network-toggle">
      <button className={network === 'pubnet' ? 'active' : ''} onClick={() => onChange('pubnet')}>
        Public Network
      </button>
      <button className={network === 'testnet' ? 'active' : ''} onClick={() => onChange('testnet')}>
        Testnet
      </button>
      {network === 'testnet' && (
        <span className="testnet-note">Testnet is periodically reset by SDF — older date ranges may return no data.</span>
      )}
    </div>
  );
}
