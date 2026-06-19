import { Activity, Download, FolderKanban, KeyRound, LayoutDashboard, Radio, WalletCards } from 'lucide-react';
import { formatUsd } from '../utils/api';

const navItems = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'projects', label: 'Projects', icon: FolderKanban },
  { id: 'renders', label: 'Render queue', icon: Activity },
  { id: 'files', label: 'Rendered files', icon: Download },
  { id: 'access', label: 'Access keys', icon: KeyRound },
];

export default function Sidebar({
  activeView,
  onChangeView,
  stats,
  socketConnected,
  balanceUsd,
}) {
  return (
    <aside className="dashboard-sidebar">
      <div className="sidebar-section sidebar-hero">
        <div className="sidebar-kicker">RenderSphere</div>
        <h2>Operations workspace</h2>
        <div className={`socket-state ${socketConnected ? 'connected' : ''}`}>
          <Radio size={14} /> {socketConnected ? 'Live updates connected' : 'Live updates offline'}
        </div>
      </div>

      <nav className="sidebar-section sidebar-nav" aria-label="Dashboard navigation">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              className={`sidebar-link ${activeView === item.id ? 'active' : ''}`}
              type="button"
              key={item.id}
              onClick={() => onChangeView(item.id)}
            >
              <Icon size={18} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="sidebar-section sidebar-status-card">
        <div className="sidebar-section-head">
          <span>Workspace status</span>
        </div>
        <div className="sidebar-stat-row">
          <span>Active jobs</span>
          <strong>{stats.activeJobs}</strong>
        </div>
        <div className="sidebar-stat-row">
          <span>Completed</span>
          <strong>{stats.completedJobs}</strong>
        </div>
        <div className="sidebar-stat-row">
          <span>Files</span>
          <strong>{stats.totalFiles}</strong>
        </div>
        <div className="sidebar-stat-row">
          <span>Spend</span>
          <strong>{formatUsd(stats.totalSpend)}</strong>
        </div>
      </div>

      <div className="sidebar-section sidebar-balance-card">
        <WalletCards size={18} />
        <span>Starter balance</span>
        <strong>{formatUsd(balanceUsd)}</strong>
      </div>

      <p className="sidebar-note">
        Project scoping now lives in each list toolbar so queue and file filters are explicit.
      </p>
    </aside>
  );
}
