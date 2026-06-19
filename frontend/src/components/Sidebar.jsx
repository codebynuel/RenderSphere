import { Activity, Download, FolderKanban, KeyRound, LayoutDashboard } from 'lucide-react';

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
}) {
  return (
    <aside className="dashboard-sidebar">
      <div className="sidebar-section sidebar-hero">
        <div className="sidebar-kicker">RenderSphere</div>
        <h2>Operations workspace</h2>
      </div>

      <nav className="sidebar-section sidebar-nav" aria-label="Dashboard navigation" data-tour="sidebar-nav">
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

      <p className="sidebar-note">
        Navigate workspace tools without status cards, balance cards, or project-scoped side filters.
      </p>
    </aside>
  );
}
