import { Activity, Download, FolderKanban, KeyRound, LayoutDashboard, Radio } from 'lucide-react';

const navItems = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'projects', label: 'Projects', icon: FolderKanban },
  { id: 'renders', label: 'Render jobs', icon: Activity },
  { id: 'files', label: 'Rendered files', icon: Download },
  { id: 'access', label: 'Access keys', icon: KeyRound },
];

export default function Sidebar({
  activeView,
  onChangeView,
  projects,
  selectedProjectId,
  onSelectProject,
  stats,
  socketConnected,
}) {
  return (
    <aside className="dashboard-sidebar">
      <div className="sidebar-section sidebar-hero">
        <div className="sidebar-kicker">RenderSphere</div>
        <h2>Cloud render dashboard</h2>
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

      <div className="sidebar-section sidebar-projects">
        <div className="sidebar-section-head">
          <span>Projects</span>
          <strong>{projects.length}</strong>
        </div>
        <button
          className={`project-filter ${selectedProjectId === 'all' ? 'active' : ''}`}
          type="button"
          onClick={() => onSelectProject('all')}
        >
          All renders
          <span>{stats.totalJobs}</span>
        </button>
        <button
          className={`project-filter ${selectedProjectId === 'unassigned' ? 'active' : ''}`}
          type="button"
          onClick={() => onSelectProject('unassigned')}
        >
          Unassigned
          <span>{stats.unassignedJobs}</span>
        </button>
        {projects.map((project) => (
          <button
            className={`project-filter ${selectedProjectId === project.id ? 'active' : ''}`}
            type="button"
            key={project.id}
            onClick={() => onSelectProject(project.id)}
          >
            {project.name}
            <span>{stats.jobsByProject.get(project.id) || 0}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
