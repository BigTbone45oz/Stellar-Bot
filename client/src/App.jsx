import { useState } from 'react';
import NetworkToggle from './components/NetworkToggle.jsx';
import Tabs from './components/Tabs.jsx';
import Overview from './views/Overview.jsx';
import LedgersTransactions from './views/LedgersTransactions.jsx';
import PaymentsOperations from './views/PaymentsOperations.jsx';
import Accounts from './views/Accounts.jsx';
import Assets from './views/Assets.jsx';
import SmartContracts from './views/SmartContracts.jsx';
import Trades from './views/Trades.jsx';
import Protocols from './views/Protocols.jsx';
import NetworkGrowth from './views/NetworkGrowth.jsx';

const TABS = [
  { id: 'overview', label: 'Overview', component: Overview },
  { id: 'assets', label: 'Assets', component: Assets },
  { id: 'contracts', label: 'Smart Contracts', component: SmartContracts },
  { id: 'growth', label: 'Network Growth', component: NetworkGrowth },
  { id: 'protocols', label: 'Protocols', component: Protocols },
  { id: 'ledgers', label: 'Ledgers & Transactions', component: LedgersTransactions },
  { id: 'payments', label: 'Payments & Operations', component: PaymentsOperations },
  { id: 'accounts', label: 'Accounts', component: Accounts },
  { id: 'trades', label: 'Trades', component: Trades },
];

export default function App() {
  const [network, setNetwork] = useState('pubnet');
  const [activeTab, setActiveTab] = useState('overview');

  const ActiveView = TABS.find((t) => t.id === activeTab).component;

  return (
    <div className="app">
      <header className="app-header">
        <h1>Stellar Dashboard</h1>
        <NetworkToggle network={network} onChange={setNetwork} />
      </header>
      <Tabs tabs={TABS} active={activeTab} onChange={setActiveTab} />
      <main>
        <ActiveView network={network} />
      </main>
    </div>
  );
}
