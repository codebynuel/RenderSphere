import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'react-hot-toast';
import {
    Activity,
    ArrowLeft,
    BarChart3,
    CheckCircle2,
    DollarSign,
    FileArchive,
    FolderKanban,
    Globe,
    HardDrive,
    Power,
    PowerOff,
    RefreshCcw,
    Server,
    Trash2,
    Upload,
    Users,
    WalletCards,
    XCircle,
} from 'lucide-react';
import { api, formatDate, formatDuration, formatUsd } from '../utils/api';
import { useAuth } from '../context/AuthContext';

const ACTIVE_STATUSES = new Set(['SUBMITTED', 'DISPATCHING', 'IN_QUEUE', 'IN_PROGRESS', 'RUNNING']);

// ─── Shared sub-components ───────────────────────────────────────────

function MetricCard({ icon: Icon, label, value, detail, tone = 'default' }) {
    return (
        <div className={`dashboard-metric metric-${tone}`}>
            <div className="metric-icon"><Icon size={18} /></div>
            <strong title={String(value)}>{value}</strong>
            <span>{label}</span>
            {detail && <small>{detail}</small>}
        </div>
    );
}

function LoadingState({ label = 'Loading...' }) {
    return (
        <div className="loading-state" aria-live="polite">
            <div className="skeleton-line wide" />
            <div className="skeleton-line" />
            <div className="skeleton-grid"><span /><span /><span /></div>
            <p className="muted">{label}</p>
        </div>
    );
}

function ErrorState({ title = 'Could not load this section', message, onRetry }) {
    return (
        <div className="error-state">
            <XCircle size={20} />
            <div>
                <strong>{title}</strong>
                <span>{message}</span>
            </div>
            {onRetry && <button className="button" type="button" onClick={onRetry}>Retry</button>}
        </div>
    );
}

function EmptyState({ icon: Icon = FileArchive, title, text, action }) {
    return (
        <div className="empty-state empty-state-polished">
            <div className="empty-icon"><Icon size={22} /></div>
            <strong>{title}</strong>
            <span>{text}</span>
            {action}
        </div>
    );
}

function StatusPill({ status }) {
    const cls = status === 'FAILED' || status === 'DISPATCH_FAILED' ? 'failed'
        : status === 'COMPLETED' ? 'complete'
        : status === 'CANCELLED' ? 'cancelled'
        : ACTIVE_STATUSES.has(status) ? 'active' : 'pending';
    return <span className={`pill status-pill ${cls}`}>{status || 'UNKNOWN'}</span>;
}

function CompactTable({ columns, rows, onRowClick }) {
    return (
        <div className="data-table-wrap" style={{ fontSize: '12px' }}>
            <table className="data-table" style={{ minWidth: 'auto' }}>
                <thead>
                    <tr>
                        {columns.map((col) => (
                            <th scope="col" key={col.key} style={col.style}>{col.label}</th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, i) => (
                        <tr
                            className="data-row"
                            key={row.key || i}
                            onClick={() => onRowClick?.(row)}
                            style={onRowClick ? { cursor: 'pointer' } : undefined}
                        >
                            {columns.map((col) => (
                                <td data-label={col.label} key={col.key} style={{ padding: '8px 10px', ...col.cellStyle }}>
                                    {col.render ? col.render(row) : row[col.key]}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function DetailPanel({ title, onBack, children }) {
    return (
        <motion.div className="panel dashboard-panel full" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
            <div className="panel-head" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <button className="button compact-button" type="button" onClick={onBack}>
                    <ArrowLeft size={16} /> Back
                </button>
                <div>
                    <h2 style={{ margin: 0 }}>{title}</h2>
                </div>
            </div>
            {children}
        </motion.div>
    );
}

function DetailRow({ label, value }) {
    return (
        <div style={{ display: 'flex', gap: '8px', padding: '6px 0', borderBottom: '1px solid var(--line-soft)' }}>
            <span style={{ minWidth: '160px', color: 'var(--subtle)', fontWeight: 700, fontSize: '12px' }}>{label}</span>
            <span style={{ color: 'var(--text)', fontWeight: 600, fontSize: '12px' }}>{value || '—'}</span>
        </div>
    );
}

// ─── Sidebar ─────────────────────────────────────────────────────────

const adminNavItems = [
    { id: 'overview', label: 'Overview', icon: Server },
    { id: 'users', label: 'Users', icon: Users },
    { id: 'jobs', label: 'Jobs', icon: Activity },
    { id: 'projects', label: 'Projects', icon: FolderKanban },
    { id: 'uploads', label: 'Uploads', icon: Upload },
    { id: 'credits', label: 'Billing', icon: DollarSign },
    { id: 'system', label: 'System', icon: BarChart3 },
    { id: 'errors', label: 'Extension Errors', icon: XCircle },
];

function AdminSidebar({ activeView, onChangeView }) {
    return (
        <aside className="dashboard-sidebar">
            <div className="sidebar-section sidebar-hero">
                <div className="sidebar-kicker">RenderSphere</div>
                <h2>Admin console</h2>
            </div>
            <nav className="sidebar-section sidebar-nav" aria-label="Admin navigation">
                {adminNavItems.map((item) => {
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
            <p className="sidebar-note">System administration panel.</p>
        </aside>
    );
}

// ─── Main component ──────────────────────────────────────────────────

export default function AdminDashboard() {
    const { user, loading: authLoading } = useAuth();
    const navigate = useNavigate();

    const [activeView, setActiveView] = useState('overview');
    const [detailView, setDetailView] = useState(null); // { type: 'user'|'job', id, data }

    // Data
    const [summary, setSummary] = useState(null);
    const [users, setUsers] = useState([]);
    const [jobs, setJobs] = useState([]);
    const [projects, setProjects] = useState([]);
    const [uploads, setUploads] = useState([]);
    const [credits, setCredits] = useState([]);
    const [metrics, setMetrics] = useState(null);
    const [settings, setSettings] = useState({});
    const [togglingSetting, setTogglingSetting] = useState(null);

    const [loading, setLoading] = useState({
        summary: true, users: true, jobs: true, projects: true,
        uploads: true, credits: true, metrics: true,
    });
    const [errors, setErrors] = useState({});

    const PAGE_SIZE = 20;

    const setLoadingFlag = useCallback((k, v) => setLoading((c) => ({ ...c, [k]: v })), []);
    const setErrorFlag = useCallback((k, v) => setErrors((c) => ({ ...c, [k]: v })), []);

    // ── Data loaders ──────────────────────────────────────────────────
    const loadSummary = useCallback(async () => {
        setLoadingFlag('summary', true); setErrorFlag('summary', '');
        try { setSummary(await api('/api/admin/summary')); }
        catch (e) { setErrorFlag('summary', e.message); }
        finally { setLoadingFlag('summary', false); }
    }, [setErrorFlag, setLoadingFlag]);

    const loadUsers = useCallback(async () => {
        setLoadingFlag('users', true); setErrorFlag('users', '');
        try { const d = await api('/api/admin/users'); setUsers(d.users || []); }
        catch (e) { setErrorFlag('users', e.message); }
        finally { setLoadingFlag('users', false); }
    }, [setErrorFlag, setLoadingFlag]);

    const loadJobs = useCallback(async () => {
        setLoadingFlag('jobs', true); setErrorFlag('jobs', '');
        try { const d = await api('/api/admin/jobs'); setJobs(d.jobs || []); }
        catch (e) { setErrorFlag('jobs', e.message); }
        finally { setLoadingFlag('jobs', false); }
    }, [setErrorFlag, setLoadingFlag]);

    const loadProjects = useCallback(async () => {
        setLoadingFlag('projects', true); setErrorFlag('projects', '');
        try { const d = await api('/api/admin/projects'); setProjects(d.projects || []); }
        catch (e) { setErrorFlag('projects', e.message); }
        finally { setLoadingFlag('projects', false); }
    }, [setErrorFlag, setLoadingFlag]);

    const loadUploads = useCallback(async () => {
        setLoadingFlag('uploads', true); setErrorFlag('uploads', '');
        try { const d = await api('/api/admin/uploads'); setUploads(d.uploads || []); }
        catch (e) { setErrorFlag('uploads', e.message); }
        finally { setLoadingFlag('uploads', false); }
    }, [setErrorFlag, setLoadingFlag]);

    const loadCredits = useCallback(async () => {
        setLoadingFlag('credits', true); setErrorFlag('credits', '');
        try { const d = await api('/api/admin/credits'); setCredits(d.transactions || []); }
        catch (e) { setErrorFlag('credits', e.message); }
        finally { setLoadingFlag('credits', false); }
    }, [setErrorFlag, setLoadingFlag]);

    const loadMetrics = useCallback(async () => {
        setLoadingFlag('metrics', true); setErrorFlag('metrics', '');
        try { setMetrics(await api('/api/admin/metrics')); }
        catch (e) { setErrorFlag('metrics', e.message); }
        finally { setLoadingFlag('metrics', false); }
    }, [setErrorFlag, setLoadingFlag]);

    const loadSettings = useCallback(async () => {
        try { const d = await api('/api/admin/settings'); setSettings(d.settings || {}); }
        catch { /* ignore */ }
    }, []);

    const handleToggleProvider = useCallback(async (key) => {
        const current = settings[key] || (key === 'payment_provider_paypal' ? 'disabled' : 'enabled');
        const next = current === 'enabled' ? 'disabled' : 'enabled';
        setTogglingSetting(key);
        try {
            await api('/api/admin/settings', {
                method: 'PUT',
                body: JSON.stringify({ [key]: next }),
            });
            setSettings((prev) => ({ ...prev, [key]: next }));
            toast.success(`${key === 'payment_provider_paypal' ? 'PayPal' : 'NOWPayments'} ${next === 'enabled' ? 'enabled' : 'disabled'}`);
        } catch (e) {
            toast.error(e.message || 'Failed to update setting');
        } finally {
            setTogglingSetting(null);
        }
    }, [settings]);

    const loadAll = useCallback(async () => {
        await Promise.all([loadSummary(), loadUsers(), loadJobs(), loadProjects(), loadUploads(), loadCredits(), loadMetrics(), loadSettings()]);
    }, [loadSummary, loadUsers, loadJobs, loadProjects, loadUploads, loadCredits, loadMetrics, loadSettings]);

    const loadUserDetail = useCallback(async (userId) => {
        try {
            const d = await api(`/api/admin/user/${userId}`);
            setDetailView({ type: 'user', id: userId, data: d.user });
        } catch (e) {
            toast.error(`Failed to load user: ${e.message}`);
        }
    }, []);

    const loadJobDetail = useCallback(async (jobId) => {
        try {
            const d = await api(`/api/admin/job/${jobId}`);
            setDetailView({ type: 'job', id: jobId, data: d.job });
        } catch (e) {
            toast.error(`Failed to load job: ${e.message}`);
        }
    }, []);

    useEffect(() => {
        if (!authLoading && !user) { navigate('/auth'); return; }
        if (!authLoading && user && user.role !== 'admin') return;
        if (user?.role === 'admin') {
            const t = window.setTimeout(loadAll, 0);
            return () => window.clearTimeout(t);
        }
    }, [user, authLoading, navigate, loadAll]);

    const handleCleanup = async () => {
        if (!window.confirm('Clean up expired sessions, used uploads, and old job records? This cannot be undone.')) return;
        try {
            const d = await api('/api/admin/cleanup-records', { method: 'POST', body: '{}' });
            toast.success(`Cleaned up: ${d.removed.sessions} sessions, ${d.removed.uploads} uploads, ${d.removed.jobs} jobs`);
            loadAll();
        } catch (e) { toast.error(e.message || 'Cleanup failed'); }
    };

    const navigateTo = (view) => {
        setDetailView(null);
        setActiveView(view);
    };

    // ── Pagination helpers ───────────────────────────────────────────
    const paginate = (items, page) => {
        const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
        const cp = Math.min(totalPages, Math.max(1, page));
        return { items: items.slice((cp - 1) * PAGE_SIZE, cp * PAGE_SIZE), page: cp, totalItems: items.length, totalPages };
    };

    const [usersPage, setUsersPage] = useState(1);
    const [jobsPage, setJobsPage] = useState(1);
    const [projectsPage, setProjectsPage] = useState(1);
    const [uploadsPage, setUploadsPage] = useState(1);
    const [creditsPage, setCreditsPage] = useState(1);

    const pUsers = useMemo(() => paginate(users, usersPage), [users, usersPage]);
    const pJobs = useMemo(() => paginate(jobs, jobsPage), [jobs, jobsPage]);
    const pProjects = useMemo(() => paginate(projects, projectsPage), [projects, projectsPage]);
    const pUploads = useMemo(() => paginate(uploads, uploadsPage), [uploads, uploadsPage]);
    const pCredits = useMemo(() => paginate(credits, creditsPage), [credits, creditsPage]);

    const summaryStats = useMemo(() => {
        if (!summary) return null;
        return {
            users: summary.users || 0, uploads: summary.uploads || 0,
            jobs: summary.jobs || 0, projects: summary.projects || 0,
            activeJobs: summary.activeJobs || 0, failedJobs: summary.failedJobs || 0,
            completedJobs: summary.completedJobs || 0,
            revenueUsd: summary.revenueUsd || 0, billableSeconds: summary.billableSeconds || 0,
            database: summary.database || 'postgres', limits: summary.limits || {},
        };
    }, [summary]);

    const viewMeta = useMemo(() => {
        const meta = {
            overview: { eyebrow: 'Infrastructure overview', title: 'Admin overview', description: 'Platform-wide metrics at a glance.' },
            users: { eyebrow: 'User management', title: 'Users', description: `${users.length} registered users.` },
            jobs: { eyebrow: 'Job management', title: 'All jobs', description: `${jobs.length} total render jobs.` },
            projects: { eyebrow: 'Project management', title: 'Projects', description: `${projects.length} projects across all users.` },
            uploads: { eyebrow: 'File uploads', title: 'Uploads', description: `${uploads.length} uploaded source files.` },
            credits: { eyebrow: 'Billing ledger', title: 'Credit transactions', description: `${credits.length} recent transactions.` },
            system: { eyebrow: 'System health', title: 'System', description: 'Operational metrics and maintenance tools.' },
        };
        return meta[activeView] || meta.overview;
    }, [activeView, users.length, jobs.length, projects.length, uploads.length, credits.length]);

    if (authLoading) return null;
    if (!user) return null;
    if (user.role !== 'admin') return null;

    // ── Pagination bar ───────────────────────────────────────────────
    function PaginationBar({ page, totalItems, onChange }) {
        const tp = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
        const si = totalItems === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
        const ei = totalItems === 0 ? 0 : Math.min(totalItems, page * PAGE_SIZE);
        return (
            <nav className="pagination-bar" style={{ padding: '8px 0' }}>
                <span className="pagination-range">Showing {si}–{ei} of {totalItems}</span>
                <div className="pagination-actions">
                    <button className="button compact-button" type="button" onClick={() => onChange(page - 1)} disabled={page <= 1}>Previous</button>
                    <span className="pagination-page">{page} of {tp}</span>
                    <button className="button compact-button" type="button" onClick={() => onChange(page + 1)} disabled={page >= tp}>Next</button>
                </div>
            </nav>
        );
    }

    // ── User detail view ─────────────────────────────────────────────
    if (detailView?.type === 'user') {
        const u = detailView.data;
        return (
            <main className="dashboard-page">
                <AdminSidebar activeView="users" onChangeView={navigateTo} />
                <section className="dashboard-main">
                    <DetailPanel title={`User: ${u.email}`} onBack={() => { setDetailView(null); setActiveView('users'); }}>
                        <div style={{ padding: '16px', display: 'grid', gap: '4px' }}>
                            <DetailRow label="ID" value={u.id} />
                            <DetailRow label="Email" value={u.email} />
                            <DetailRow label="Role" value={u.role} />
                            <DetailRow label="Balance" value={formatUsd(u.starterBalanceUsd)} />
                            <DetailRow label="Created" value={formatDate(u.createdAt)} />
                            <DetailRow label="Updated" value={formatDate(u.updatedAt)} />
                            <DetailRow label="Jobs" value={u._count?.jobs ?? u.jobs?.length ?? '—'} />
                            <DetailRow label="Projects" value={u._count?.projects ?? u.projects?.length ?? '—'} />
                            <DetailRow label="Access keys" value={u._count?.accessKeys ?? u.accessKeys?.length ?? '—'} />
                            <DetailRow label="Uploads" value={u._count?.uploads ?? '—'} />
                            <DetailRow label="Sessions" value={u._count?.sessions ?? '—'} />
                        </div>

                        {u.jobs?.length > 0 && (
                            <div style={{ padding: '0 16px 16px' }}>
                                <h3 style={{ margin: '16px 0 8px', fontSize: '14px' }}>Recent jobs</h3>
                                <CompactTable
                                    columns={[
                                        { key: 'jobId', label: 'Job', render: (r) => <span style={{ fontWeight: 700 }}>{r.jobId?.slice(0, 12)}...</span> },
                                        { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.status} /> },
                                        { key: 'project', label: 'Project', render: (r) => r.project?.name || '—' },
                                        { key: 'price', label: 'Cost', render: (r) => r.priceUsd ? formatUsd(r.priceUsd) : '—' },
                                        { key: 'createdAt', label: 'Created', render: (r) => formatDate(r.createdAt) },
                                    ]}
                                    rows={u.jobs.map((j) => ({ ...j, key: j.jobId }))}
                                    onRowClick={(r) => loadJobDetail(r.jobId)}
                                />
                            </div>
                        )}

                        {u.projects?.length > 0 && (
                            <div style={{ padding: '0 16px 16px' }}>
                                <h3 style={{ margin: '16px 0 8px', fontSize: '14px' }}>Projects</h3>
                                <CompactTable
                                    columns={[
                                        { key: 'name', label: 'Name', render: (r) => <span style={{ fontWeight: 700 }}>{r.name}</span> },
                                        { key: 'id', label: 'ID', render: (r) => <code style={{ fontSize: '11px' }}>{r.id.slice(0, 12)}...</code> },
                                        { key: 'createdAt', label: 'Created', render: (r) => formatDate(r.createdAt) },
                                    ]}
                                    rows={u.projects.map((p) => ({ ...p, key: p.id }))}
                                />
                            </div>
                        )}
                    </DetailPanel>
                </section>
            </main>
        );
    }

    // ── Job detail view ──────────────────────────────────────────────
    if (detailView?.type === 'job') {
        const j = detailView.data;
        const settings = j.settings || {};
        return (
            <main className="dashboard-page">
                <AdminSidebar activeView="jobs" onChangeView={navigateTo} />
                <section className="dashboard-main">
                    <DetailPanel title={`Job: ${j.jobId?.slice(0, 20)}...`} onBack={() => { setDetailView(null); setActiveView('jobs'); }}>
                        <div style={{ padding: '16px', display: 'grid', gap: '4px' }}>
                            <DetailRow label="Job ID" value={j.jobId} />
                            <DetailRow label="User" value={j.user?.email || '—'} />
                            <DetailRow label="Status" value={<StatusPill status={j.status} />} />
                            <DetailRow label="Dispatch status" value={j.dispatchStatus} />
                            <DetailRow label="Project" value={j.project?.name || '—'} />
                            <DetailRow label="File key" value={j.fileKey} />
                            <DetailRow label="Result key" value={j.resultKey || '—'} />
                            <DetailRow label="Error" value={j.error || '—'} />
                            <DetailRow label="Frame count" value={String(j.frameCount)} />
                            <DetailRow label="Billable seconds" value={String(j.billableSeconds)} />
                            <DetailRow label="Price" value={j.priceUsd ? formatUsd(j.priceUsd) : '—'} />
                            <DetailRow label="Price/sec" value={j.pricePerSecondUsd ? formatUsd(j.pricePerSecondUsd) : '—'} />
                            <DetailRow label="Billing state" value={j.billingState} />
                            <DetailRow label="Created" value={formatDate(j.createdAt)} />
                            <DetailRow label="Completed" value={j.completedAt ? formatDate(j.completedAt) : '—'} />
                            <DetailRow label="Dispatched" value={j.dispatchedAt ? formatDate(j.dispatchedAt) : '—'} />
                        </div>

                        {Object.keys(settings).length > 0 && (
                            <div style={{ padding: '0 16px 16px' }}>
                                <h3 style={{ margin: '16px 0 8px', fontSize: '14px' }}>Render settings</h3>
                                <CompactTable
                                    columns={[
                                        { key: 'key', label: 'Setting', render: (r) => <span style={{ fontWeight: 700 }}>{r.key}</span> },
                                        { key: 'value', label: 'Value', render: (r) => String(r.value) },
                                    ]}
                                    rows={Object.entries(settings).map(([k, v]) => ({ key: k, value: v, _key: k }))}
                                />
                            </div>
                        )}
                    </DetailPanel>
                </section>
            </main>
        );
    }

    // ── View renderers ───────────────────────────────────────────────

    const renderOverview = () => (
        <div className="overview-grid" style={{ gridColumn: '1 / -1', minWidth: 0 }}>
            <div className="dashboard-metrics-grid operations-metrics" style={{ overflowX: 'auto', paddingBottom: '4px' }}>
                {loading.summary ? <LoadingState label="Loading summary..." /> : errors.summary ? <ErrorState message={errors.summary} onRetry={loadSummary} /> : summaryStats ? (
                    <>
                        <MetricCard icon={Users} label="Users" value={summaryStats.users} detail={`${summaryStats.uploads} uploads`} />
                        <MetricCard icon={FolderKanban} label="Projects" value={summaryStats.projects} />
                        <MetricCard icon={Activity} label="Active jobs" value={summaryStats.activeJobs} detail={`${summaryStats.jobs} total`} tone="active" />
                        <MetricCard icon={CheckCircle2} label="Completed" value={summaryStats.completedJobs} tone="good" />
                        <MetricCard icon={XCircle} label="Failed" value={summaryStats.failedJobs} tone="danger" />
                        <MetricCard icon={WalletCards} label="Revenue" value={formatUsd(summaryStats.revenueUsd)} detail={`${formatDuration(summaryStats.billableSeconds)} billed`} />
                    </>
                ) : null}
            </div>
            {summaryStats?.limits && (
                <motion.div className="panel dashboard-panel full" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
                    <div className="panel-head"><div><h2>System limits</h2><p className="muted">Configured platform parameters.</p></div></div>
                    <CompactTable
                        columns={[
                            { key: 'key', label: 'Setting', render: (r) => <span style={{ fontWeight: 700, fontSize: '11px' }}>{r.key}</span> },
                            { key: 'value', label: 'Value', render: (r) => <code style={{ fontSize: '11px' }}>{String(r.value)}</code> },
                        ]}
                        rows={Object.entries(summaryStats.limits).map(([k, v]) => ({ key: k, value: v, _key: k }))}
                    />
                </motion.div>
            )}
        </div>
    );

    const renderUsersList = () => (
        <motion.div className="panel dashboard-panel full" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
            <div className="panel-head">
                <div><h2>Users</h2><p className="muted">{users.length} registered.</p></div>
                <button className="button" type="button" onClick={loadUsers} disabled={loading.users}>
                    <RefreshCcw size={16} className={loading.users ? 'spin' : ''} /> Refresh
                </button>
            </div>
            {loading.users ? <LoadingState label="Loading users..." /> : errors.users ? <ErrorState message={errors.users} onRetry={loadUsers} /> : users.length === 0 ? <EmptyState icon={Users} title="No users" text="No registered users yet." /> : (
                <>
                    <CompactTable
                        columns={[
                            { key: 'email', label: 'Email', render: (r) => <span style={{ fontWeight: 700 }}>{r.email}</span> },
                            { key: 'role', label: 'Role', render: (r) => <span className={`pill ${r.role === 'admin' ? 'status-pill active' : ''}`}>{r.role}</span> },
                            { key: 'jobs', label: 'Jobs', render: (r) => <strong>{r.jobs}</strong>, style: { width: '60px' } },
                            { key: 'activeJobs', label: 'Active', render: (r) => <span className={`pill status-pill ${r.activeJobs > 0 ? 'active' : 'complete'}`}>{r.activeJobs}</span>, style: { width: '70px' } },
                            { key: 'createdAt', label: 'Joined', render: (r) => formatDate(r.createdAt) },
                            { key: 'balance', label: 'Balance', render: (r) => formatUsd(r.starterBalanceUsd), style: { width: '80px', textAlign: 'right' } },
                        ]}
                        rows={pUsers.items.map((u) => ({ ...u, key: u.id }))}
                        onRowClick={(r) => loadUserDetail(r.id)}
                    />
                    <PaginationBar page={pUsers.page} totalItems={pUsers.totalItems} onChange={setUsersPage} />
                </>
            )}
        </motion.div>
    );

    const renderJobsList = () => (
        <motion.div className="panel dashboard-panel full" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
            <div className="panel-head">
                <div><h2>All jobs</h2><p className="muted">{jobs.length} total.</p></div>
                <button className="button" type="button" onClick={loadJobs} disabled={loading.jobs}>
                    <RefreshCcw size={16} className={loading.jobs ? 'spin' : ''} /> Refresh
                </button>
            </div>
            {loading.jobs ? <LoadingState label="Loading jobs..." /> : errors.jobs ? <ErrorState message={errors.jobs} onRetry={loadJobs} /> : jobs.length === 0 ? <EmptyState icon={Activity} title="No jobs" text="No render jobs submitted yet." /> : (
                <>
                    <CompactTable
                        columns={[
                            { key: 'jobId', label: 'Job', render: (r) => <span style={{ fontWeight: 700, fontSize: '11px' }} title={r.jobId}>{r.jobId.slice(0, 12)}...</span> },
                            { key: 'user', label: 'User', render: (r) => r.user?.email || '—' },
                            { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.status} />, style: { width: '100px' } },
                            { key: 'cost', label: 'Cost', render: (r) => r.priceUsd ? formatUsd(r.priceUsd) : '—', style: { width: '80px', textAlign: 'right' } },
                            { key: 'createdAt', label: 'Created', render: (r) => formatDate(r.createdAt) },
                        ]}
                        rows={pJobs.items.map((j) => ({ ...j, key: j.jobId }))}
                        onRowClick={(r) => loadJobDetail(r.jobId)}
                    />
                    <PaginationBar page={pJobs.page} totalItems={pJobs.totalItems} onChange={setJobsPage} />
                </>
            )}
        </motion.div>
    );

    const renderProjectsList = () => (
        <motion.div className="panel dashboard-panel full" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
            <div className="panel-head">
                <div><h2>Projects</h2><p className="muted">{projects.length} total.</p></div>
                <button className="button" type="button" onClick={loadProjects} disabled={loading.projects}>
                    <RefreshCcw size={16} className={loading.projects ? 'spin' : ''} /> Refresh
                </button>
            </div>
            {loading.projects ? <LoadingState label="Loading projects..." /> : errors.projects ? <ErrorState message={errors.projects} onRetry={loadProjects} /> : projects.length === 0 ? <EmptyState icon={FolderKanban} title="No projects" text="No projects created yet." /> : (
                <>
                    <CompactTable
                        columns={[
                            { key: 'name', label: 'Name', render: (r) => <span style={{ fontWeight: 700 }}>{r.name}</span> },
                            { key: 'user', label: 'User', render: (r) => r.user?.email || '—' },
                            { key: 'jobs', label: 'Jobs', render: (r) => <strong>{r._count?.jobs ?? 0}</strong>, style: { width: '60px' } },
                            { key: 'createdAt', label: 'Created', render: (r) => formatDate(r.createdAt) },
                        ]}
                        rows={pProjects.items.map((p) => ({ ...p, key: p.id }))}
                    />
                    <PaginationBar page={pProjects.page} totalItems={pProjects.totalItems} onChange={setProjectsPage} />
                </>
            )}
        </motion.div>
    );

    const renderUploadsList = () => (
        <motion.div className="panel dashboard-panel full" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
            <div className="panel-head">
                <div><h2>Uploads</h2><p className="muted">{uploads.length} source files.</p></div>
                <button className="button" type="button" onClick={loadUploads} disabled={loading.uploads}>
                    <RefreshCcw size={16} className={loading.uploads ? 'spin' : ''} /> Refresh
                </button>
            </div>
            {loading.uploads ? <LoadingState label="Loading uploads..." /> : errors.uploads ? <ErrorState message={errors.uploads} onRetry={loadUploads} /> : uploads.length === 0 ? <EmptyState icon={Upload} title="No uploads" text="No files uploaded yet." /> : (
                <>
                    <CompactTable
                        columns={[
                            { key: 'fileName', label: 'File', render: (r) => <span style={{ fontWeight: 700, fontSize: '11px' }}>{r.fileName}</span> },
                            { key: 'user', label: 'User', render: (r) => r.user?.email || '—' },
                            { key: 'size', label: 'Size', render: (r) => { const mb = Number(r.fileSizeBytes || 0) / (1024 * 1024); return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(Number(r.fileSizeBytes || 0) / 1024)} KB`; } },
                            { key: 'used', label: 'Used', render: (r) => <span className={`pill ${r.used ? 'status-pill complete' : ''}`}>{r.used ? 'Used' : 'Pending'}</span>, style: { width: '70px' } },
                            { key: 'createdAt', label: 'Uploaded', render: (r) => formatDate(r.createdAt) },
                        ]}
                        rows={pUploads.items.map((u) => ({ ...u, key: u.key }))}
                    />
                    <PaginationBar page={pUploads.page} totalItems={pUploads.totalItems} onChange={setUploadsPage} />
                </>
            )}
        </motion.div>
    );

    const renderCreditsList = () => (
        <motion.div className="panel dashboard-panel full" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
            <div className="panel-head">
                <div><h2>Credit transactions</h2><p className="muted">{credits.length} recent.</p></div>
                <button className="button" type="button" onClick={loadCredits} disabled={loading.credits}>
                    <RefreshCcw size={16} className={loading.credits ? 'spin' : ''} /> Refresh
                </button>
            </div>
            {loading.credits ? <LoadingState label="Loading transactions..." /> : errors.credits ? <ErrorState message={errors.credits} onRetry={loadCredits} /> : credits.length === 0 ? <EmptyState icon={DollarSign} title="No transactions" text="No credit transactions recorded yet." /> : (
                <>
                    <CompactTable
                        columns={[
                            { key: 'type', label: 'Type', render: (r) => <span className="pill" style={{ fontSize: '10px' }}>{r.type}</span> },
                            { key: 'user', label: 'User', render: (r) => r.user?.email || '—' },
                            { key: 'amount', label: 'Amount', render: (r) => {
                                const amt = Number(r.amountUsd || 0);
                                return <span style={{ fontWeight: 700, color: amt >= 0 ? 'var(--good)' : 'var(--accent)' }}>{amt >= 0 ? '+' : ''}{formatUsd(amt)}</span>;
                            }, style: { width: '100px', textAlign: 'right' } },
                            { key: 'balance', label: 'After', render: (r) => formatUsd(r.balanceAfterUsd), style: { width: '80px', textAlign: 'right' } },
                            { key: 'createdAt', label: 'Date', render: (r) => formatDate(r.createdAt) },
                        ]}
                        rows={pCredits.items.map((t) => ({ ...t, key: t.id }))}
                    />
                    <PaginationBar page={pCredits.page} totalItems={pCredits.totalItems} onChange={setCreditsPage} />
                </>
            )}
        </motion.div>
    );

    const renderExtensionErrors = () => {
        const [errors, setErrors] = useState([]);
        const [loading, setLoading] = useState(true);
        const [err, setErr] = useState('');

        const loadErrors = useCallback(async () => {
            setLoading(true);
            setErr('');
            try {
                const data = await api('/api/admin/extension-errors');
                setErrors(data.errors || []);
            } catch (error) {
                setErr(error.message || 'Failed to load');
            } finally {
                setLoading(false);
            }
        }, []);

        useEffect(() => { loadErrors(); }, [loadErrors]);

        return (
            <div className="panel dashboard-panel full">
                <div className="panel-head">
                    <div>
                        <h2>Extension Errors</h2>
                        <p className="muted">Errors reported by Blender add-on instances.</p>
                    </div>
                    <button className="button" type="button" onClick={loadErrors} disabled={loading}>
                        <RefreshCcw size={16} className={loading ? 'spin' : ''} /> Refresh
                    </button>
                </div>
                {loading ? <LoadingState label="Loading errors..." /> : null}
                {!loading && err ? <ErrorState message={err} onRetry={loadErrors} /> : null}
                {!loading && !err && errors.length === 0 ? <EmptyState icon={XCircle} title="No errors reported" text="Extension errors will appear here when they occur." /> : null}
                {!loading && !err && errors.length > 0 ? (
                    <div className="data-table-wrap">
                        <table className="data-table">
                            <thead>
                                <tr>
                                    <th>Time</th>
                                    <th>Level</th>
                                    <th>Message</th>
                                    <th>User</th>
                                    <th>Add-on</th>
                                    <th>Blender</th>
                                    <th>OS</th>
                                </tr>
                            </thead>
                            <tbody>
                                {errors.map((e) => (
                                    <tr key={e.id}>
                                        <td className="table-meta">{formatDate(e.createdAt)}</td>
                                        <td><span className={`pill ${e.level === 'error' ? 'failed' : 'pending'}`}>{e.level}</span></td>
                                        <td style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis' }} title={e.message}>{e.message}</td>
                                        <td>{e.email || '-'}</td>
                                        <td>{e.addonVersion || '-'}</td>
                                        <td>{e.blenderVersion || '-'}</td>
                                        <td>{e.os || '-'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : null}
            </div>
        );
    };

    const renderSystem = () => (
        <>
            <motion.div className="panel dashboard-panel full" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
                <div className="panel-head">
                    <div><h2>Operational metrics</h2><p className="muted">Snapshot of memory, uptime, and health.</p></div>
                    <button className="button" type="button" onClick={loadMetrics} disabled={loading.metrics}>
                        <RefreshCcw size={16} className={loading.metrics ? 'spin' : ''} /> Refresh
                    </button>
                </div>
                {loading.metrics ? <LoadingState label="Loading metrics..." /> : errors.metrics ? <ErrorState message={errors.metrics} onRetry={loadMetrics} /> : metrics ? (
                    <div className="dashboard-metrics-grid operations-metrics">
                        <MetricCard icon={Server} label="Uptime" value={metrics.uptime ? `${Math.floor(metrics.uptime / 3600)}h` : 'N/A'} detail="Process uptime" />
                        <MetricCard icon={HardDrive} label="Memory (RSS)" value={metrics.memoryUsageMb ? `${Math.round(metrics.memoryUsageMb)} MB` : 'N/A'} detail="Resident set size" />
                        <MetricCard icon={Globe} label="Node" value={metrics.nodeVersion || 'N/A'} detail={metrics.platform || ''} />
                        <MetricCard icon={Activity} label="Active jobs" value={metrics.activeJobs ?? 'N/A'} tone="active" />
                    </div>
                ) : null}
            </motion.div>

            <motion.div className="panel dashboard-panel full" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
                <div className="panel-head"><div><h2>Record cleanup</h2><p className="muted">Remove expired sessions, used uploads, and old jobs.</p></div></div>
                <div style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '16px' }}>
                    <Trash2 size={20} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                    <span style={{ color: 'var(--muted)', fontSize: '13px', flex: 1 }}>Remove expired sessions, used uploads, and jobs past the retention period.</span>
                    <button className="button danger" type="button" onClick={handleCleanup}><Trash2 size={16} /> Run cleanup</button>
                </div>
            </motion.div>

            <motion.div className="panel dashboard-panel full" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
                <div className="panel-head"><div><h2>Payment providers</h2><p className="muted">Enable or disable payment methods. Disabled providers return a 503 error to users.</p></div></div>
                <div style={{ padding: '16px', display: 'grid', gap: '12px' }}>
                    {[
                        { key: 'payment_provider_paypal', label: 'PayPal', desc: 'Credit card and PayPal account payments' },
                        { key: 'payment_provider_nowpayments', label: 'NOWPayments', desc: 'Cryptocurrency payments (BTC, ETH, USDT, etc.)' },
                    ].map(({ key, label, desc }) => {
                        const isEnabled = settings[key] !== 'disabled';
                        const isToggling = togglingSetting === key;
                        return (
                            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '12px 16px', border: '1px solid var(--line-soft)', borderRadius: '12px', background: 'var(--panel-card-strong)' }}>
                                <div style={{ flex: 1 }}>
                                    <strong style={{ display: 'block', fontSize: '14px' }}>{label}</strong>
                                    <span style={{ color: 'var(--muted)', fontSize: '12px' }}>{desc}</span>
                                </div>
                                <span className={`pill status-pill ${isEnabled ? 'active' : 'cancelled'}`} style={{ fontSize: '11px' }}>
                                    {isEnabled ? 'Enabled' : 'Disabled'}
                                </span>
                                <button
                                    className={`button compact-button ${isEnabled ? 'danger' : 'primary'}`}
                                    type="button"
                                    onClick={() => handleToggleProvider(key)}
                                    disabled={isToggling}
                                >
                                    {isToggling ? '...' : isEnabled ? <><PowerOff size={14} /> Disable</> : <><Power size={14} /> Enable</>}
                                </button>
                            </div>
                        );
                    })}
                </div>
            </motion.div>
        </>
    );

    // ── Main render ──────────────────────────────────────────────────
    return (
        <main className="dashboard-page">
            <AdminSidebar activeView={activeView} onChangeView={navigateTo} />
            <section className="dashboard-main">
                <div className="dashboard-titlebar operations-titlebar">
                    <div>
                        <p className="eyebrow">{viewMeta.eyebrow}</p>
                        <h1>{viewMeta.title}</h1>
                        <p className="muted">{viewMeta.description}</p>
                    </div>
                    <div className="titlebar-actions">
                        <button className="button" type="button" onClick={loadAll}><RefreshCcw size={16} /> Refresh all</button>
                    </div>
                </div>

                <AnimatePresence mode="wait">
                    <motion.div
                        key={activeView}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        style={{ gridColumn: '1 / -1', minWidth: 0 }}
                    >
                {activeView === 'overview' && <div className="dashboard-grid operations-grid">{renderOverview()}</div>}
                {activeView === 'users' && <div className="dashboard-grid operations-grid">{renderUsersList()}</div>}
                {activeView === 'jobs' && <div className="dashboard-grid operations-grid">{renderJobsList()}</div>}
                {activeView === 'projects' && <div className="dashboard-grid operations-grid">{renderProjectsList()}</div>}
                {activeView === 'uploads' && <div className="dashboard-grid operations-grid">{renderUploadsList()}</div>}
                {activeView === 'credits' && <div className="dashboard-grid operations-grid">{renderCreditsList()}</div>}
                {activeView === 'system' && <div className="dashboard-grid operations-grid">{renderSystem()}</div>}
                {activeView === 'errors' && <div className="dashboard-grid operations-grid">{renderExtensionErrors()}</div>}
                    </motion.div>
                </AnimatePresence>
            </section>
        </main>
    );
}
