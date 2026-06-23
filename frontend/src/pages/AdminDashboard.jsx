import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { toast } from 'react-hot-toast';
import {
    Activity,
    AlertTriangle,
    BarChart3,
    CheckCircle2,
    Clock3,
    Database,
    FileArchive,
    Globe,
    HardDrive,
    HelpCircle,
    RefreshCcw,
    Server,
    Shield,
    Sliders,
    Trash2,
    Users,
    WalletCards,
    XCircle,
} from 'lucide-react';
import { api, formatDate, formatDuration, formatUsd } from '../utils/api';
import { useAuth } from '../context/AuthContext';

const ACTIVE_STATUSES = new Set(['SUBMITTED', 'DISPATCHING', 'IN_QUEUE', 'IN_PROGRESS', 'RUNNING']);

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

function StatusPill({ status }) {
    const cls = status === 'FAILED' ? 'failed'
        : status === 'COMPLETED' ? 'complete'
        : status === 'CANCELLED' ? 'cancelled'
        : ACTIVE_STATUSES.has(status) ? 'active' : 'pending';
    return <span className={`pill status-pill ${cls}`}>{status || 'UNKNOWN'}</span>;
}

function LoadingState({ label = 'Loading...' }) {
    return (
        <div className="loading-state" aria-live="polite">
            <div className="skeleton-line wide" />
            <div className="skeleton-line" />
            <div className="skeleton-grid">
                <span />
                <span />
                <span />
            </div>
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

function PaginationControls({ label, totalItems, page, pageSize = 10, onPageChange }) {
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    const currentPage = Math.min(totalPages, Math.max(1, page));
    const startItem = totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1;
    const endItem = totalItems === 0 ? 0 : Math.min(totalItems, currentPage * pageSize);

    return (
        <nav className="pagination-bar" aria-label={`${label} pagination`}>
            <span className="pagination-range">Showing {startItem}–{endItem} of {totalItems}</span>
            <div className="pagination-actions">
                <button
                    className="button compact-button"
                    type="button"
                    onClick={() => onPageChange(currentPage - 1)}
                    disabled={currentPage <= 1}
                >
                    Previous
                </button>
                <span className="pagination-page" aria-live="polite">Page {currentPage} of {totalPages}</span>
                <button
                    className="button compact-button"
                    type="button"
                    onClick={() => onPageChange(currentPage + 1)}
                    disabled={currentPage >= totalPages}
                >
                    Next
                </button>
            </div>
        </nav>
    );
}

const adminNavItems = [
    { id: 'overview', label: 'Overview', icon: Server },
    { id: 'users', label: 'Users', icon: Users },
    { id: 'jobs', label: 'Jobs', icon: Activity },
    { id: 'system', label: 'System', icon: BarChart3 },
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

            <p className="sidebar-note">
                System administration panel. Monitor platform health, users, jobs, and infrastructure.
            </p>
        </aside>
    );
}

export default function AdminDashboard() {
    const { user, loading: authLoading } = useAuth();
    const navigate = useNavigate();

    const [activeView, setActiveView] = useState('overview');
    const [summary, setSummary] = useState(null);
    const [users, setUsers] = useState([]);
    const [jobs, setJobs] = useState([]);
    const [metrics, setMetrics] = useState(null);
    const [loading, setLoading] = useState({ summary: true, users: true, jobs: true, metrics: true });
    const [errors, setErrors] = useState({ summary: '', users: '', jobs: '', metrics: '' });
    const [usersPage, setUsersPage] = useState(1);
    const [jobsPage, setJobsPage] = useState(1);

    const USERS_PAGE_SIZE = 15;
    const JOBS_PAGE_SIZE = 15;

    const setLoadingFlag = useCallback((key, value) => {
        setLoading((current) => ({ ...current, [key]: value }));
    }, []);

    const setErrorFlag = useCallback((key, value) => {
        setErrors((current) => ({ ...current, [key]: value }));
    }, []);

    const loadSummary = useCallback(async () => {
        setLoadingFlag('summary', true);
        setErrorFlag('summary', '');
        try {
            const data = await api('/api/admin/summary');
            setSummary(data);
        } catch (error) {
            setErrorFlag('summary', error.message || 'Failed to load summary');
        } finally {
            setLoadingFlag('summary', false);
        }
    }, [setErrorFlag, setLoadingFlag]);

    const loadUsers = useCallback(async () => {
        setLoadingFlag('users', true);
        setErrorFlag('users', '');
        try {
            const data = await api('/api/admin/users');
            setUsers(data.users || []);
        } catch (error) {
            setErrorFlag('users', error.message || 'Failed to load users');
        } finally {
            setLoadingFlag('users', false);
        }
    }, [setErrorFlag, setLoadingFlag]);

    const loadJobs = useCallback(async () => {
        setLoadingFlag('jobs', true);
        setErrorFlag('jobs', '');
        try {
            const data = await api('/api/admin/jobs');
            setJobs(data.jobs || []);
        } catch (error) {
            setErrorFlag('jobs', error.message || 'Failed to load jobs');
        } finally {
            setLoadingFlag('jobs', false);
        }
    }, [setErrorFlag, setLoadingFlag]);

    const loadMetrics = useCallback(async () => {
        setLoadingFlag('metrics', true);
        setErrorFlag('metrics', '');
        try {
            const data = await api('/api/admin/metrics');
            setMetrics(data);
        } catch (error) {
            setErrorFlag('metrics', error.message || 'Failed to load metrics');
        } finally {
            setLoadingFlag('metrics', false);
        }
    }, [setErrorFlag, setLoadingFlag]);

    const loadAll = useCallback(async () => {
        await Promise.all([loadSummary(), loadUsers(), loadJobs(), loadMetrics()]);
    }, [loadSummary, loadUsers, loadJobs, loadMetrics]);

    useEffect(() => {
        if (!authLoading && !user) {
            navigate('/auth');
            return;
        }
        if (!authLoading && user && user.role !== 'admin') {
            return; // renders nothing — 404 behavior
        }
        if (user?.role === 'admin') {
            loadAll();
        }
    }, [user, authLoading, navigate, loadAll]);

    const summaryStats = useMemo(() => {
        if (!summary) return null;
        return {
            users: summary.users || 0,
            uploads: summary.uploads || 0,
            jobs: summary.jobs || 0,
            activeJobs: summary.activeJobs || 0,
            failedJobs: summary.failedJobs || 0,
            completedJobs: summary.completedJobs || 0,
            revenueUsd: summary.revenueUsd || 0,
            billableSeconds: summary.billableSeconds || 0,
            database: summary.database || 'postgres',
            limits: summary.limits || {},
        };
    }, [summary]);

    const paginatedUsers = useMemo(() => {
        const totalPages = Math.max(1, Math.ceil(users.length / USERS_PAGE_SIZE));
        const currentPage = Math.min(totalPages, Math.max(1, usersPage));
        const startIndex = (currentPage - 1) * USERS_PAGE_SIZE;
        return {
            items: users.slice(startIndex, startIndex + USERS_PAGE_SIZE),
            page: currentPage,
            totalItems: users.length,
            totalPages,
        };
    }, [users, usersPage]);

    const paginatedJobs = useMemo(() => {
        const totalPages = Math.max(1, Math.ceil(jobs.length / JOBS_PAGE_SIZE));
        const currentPage = Math.min(totalPages, Math.max(1, jobsPage));
        const startIndex = (currentPage - 1) * JOBS_PAGE_SIZE;
        return {
            items: jobs.slice(startIndex, startIndex + JOBS_PAGE_SIZE),
            page: currentPage,
            totalItems: jobs.length,
            totalPages,
        };
    }, [jobs, jobsPage]);

    const handleCleanup = async () => {
        if (!window.confirm('Clean up expired sessions, used uploads, and old job records? This cannot be undone.')) return;
        try {
            const data = await api('/api/admin/cleanup-records', { method: 'POST', body: '{}' });
            toast.success(`Cleaned up: ${data.removed.sessions} sessions, ${data.removed.uploads} uploads, ${data.removed.jobs} jobs`);
            loadAll();
        } catch (error) {
            toast.error(error.message || 'Cleanup failed');
        }
    };

    const viewMeta = useMemo(() => {
        const meta = {
            overview: {
                eyebrow: 'Infrastructure overview',
                title: 'Admin overview',
                description: 'Platform-wide metrics, system limits, and operational health at a glance.',
            },
            users: {
                eyebrow: 'User management',
                title: 'Users',
                description: 'All registered users, their job counts, project counts, and access keys.',
            },
            jobs: {
                eyebrow: 'Job management',
                title: 'All jobs',
                description: 'Every render job across all users, ordered by newest first.',
            },
            system: {
                eyebrow: 'System health',
                title: 'System',
                description: 'Operational metrics, health checks, and record cleanup tools.',
            },
        };
        return meta[activeView] || meta.overview;
    }, [activeView]);

    // Redirect non-admin users silently (404 behavior)
    if (authLoading) return null;
    if (!user) return null;
    if (user.role !== 'admin') return null;

    const renderOverview = () => (
        <>
            <div className="dashboard-metrics-grid operations-metrics">
                {loading.summary ? (
                    <LoadingState label="Loading summary..." />
                ) : errors.summary ? (
                    <ErrorState message={errors.summary} onRetry={loadSummary} />
                ) : summaryStats ? (
                    <>
                        <MetricCard icon={Users} label="Total users" value={summaryStats.users} detail={`${summaryStats.uploads} uploads`} />
                        <MetricCard icon={Activity} label="Active jobs" value={summaryStats.activeJobs} detail={`${summaryStats.jobs} total jobs`} tone="active" />
                        <MetricCard icon={CheckCircle2} label="Completed" value={summaryStats.completedJobs} tone="good" />
                        <MetricCard icon={XCircle} label="Failed" value={summaryStats.failedJobs} tone="danger" />
                        <MetricCard icon={WalletCards} label="Revenue" value={formatUsd(summaryStats.revenueUsd)} detail={`${formatDuration(summaryStats.billableSeconds)} billed`} />
                        <MetricCard icon={Database} label="Database" value={summaryStats.database} detail="PostgreSQL" />
                    </>
                ) : null}
            </div>

            {summaryStats?.limits && (
                <motion.div className="panel dashboard-panel full" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
                    <div className="panel-head">
                        <div>
                            <h2>System limits</h2>
                            <p className="muted">Configured platform limits and pricing parameters.</p>
                        </div>
                    </div>
                    <div className="data-table-wrap">
                        <table className="data-table" aria-label="System limits" style={{ minWidth: '600px' }}>
                            <thead>
                                <tr>
                                    <th scope="col">Setting</th>
                                    <th scope="col">Value</th>
                                </tr>
                            </thead>
                            <tbody>
                                {Object.entries(summaryStats.limits).map(([key, value]) => (
                                    <tr className="data-row" key={key}>
                                        <td data-label="Setting"><div className="table-primary">{key}</div></td>
                                        <td data-label="Value"><code className="inline-code" style={{ maxWidth: 'none' }}>{String(value)}</code></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </motion.div>
            )}
        </>
    );

    const renderUsers = () => (
        <motion.div className="panel dashboard-panel full" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
            <div className="panel-head">
                <div>
                    <h2>Users</h2>
                    <p className="muted">{users.length} registered users.</p>
                </div>
                <button className="button" type="button" onClick={loadUsers} disabled={loading.users}>
                    <RefreshCcw size={16} className={loading.users ? 'spin' : ''} /> Refresh
                </button>
            </div>

            {loading.users ? <LoadingState label="Loading users..." /> : null}
            {!loading.users && errors.users ? <ErrorState message={errors.users} onRetry={loadUsers} /> : null}
            {!loading.users && !errors.users && users.length === 0 ? (
                <EmptyState icon={Users} title="No users found" text="No users have registered yet." />
            ) : null}
            {!loading.users && !errors.users && users.length > 0 ? (
                <>
                    <div className="data-table-wrap">
                        <table className="data-table" aria-label="Users" style={{ minWidth: '900px' }}>
                            <thead>
                                <tr>
                                    <th scope="col">Email</th>
                                    <th scope="col">Jobs</th>
                                    <th scope="col">Active</th>
                                    <th scope="col">Projects</th>
                                    <th scope="col">Access keys</th>
                                    <th scope="col">Balance</th>
                                    <th scope="col">Created</th>
                                </tr>
                            </thead>
                            <tbody>
                                {paginatedUsers.items.map((u) => (
                                    <tr className="data-row" key={u.id}>
                                        <td data-label="Email"><div className="table-primary">{u.email}</div></td>
                                        <td data-label="Jobs"><strong>{u.jobs || 0}</strong></td>
                                        <td data-label="Active">
                                            <span className={`pill status-pill ${(u.activeJobs || 0) > 0 ? 'active' : 'complete'}`}>
                                                {u.activeJobs || 0}
                                            </span>
                                        </td>
                                        <td data-label="Projects"><strong>{u.projectCount || 0}</strong></td>
                                        <td data-label="Access keys"><strong>{u.accessKeyCount || 0}</strong></td>
                                        <td data-label="Balance">{formatUsd(u.starterBalanceUsd)}</td>
                                        <td data-label="Created">{formatDate(u.createdAt)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <PaginationControls
                        label="Users"
                        totalItems={paginatedUsers.totalItems}
                        page={paginatedUsers.page}
                        pageSize={USERS_PAGE_SIZE}
                        onPageChange={setUsersPage}
                    />
                </>
            ) : null}
        </motion.div>
    );

    const renderJobs = () => (
        <motion.div className="panel dashboard-panel full" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
            <div className="panel-head">
                <div>
                    <h2>All jobs</h2>
                    <p className="muted">{jobs.length} total jobs across all users.</p>
                </div>
                <button className="button" type="button" onClick={loadJobs} disabled={loading.jobs}>
                    <RefreshCcw size={16} className={loading.jobs ? 'spin' : ''} /> Refresh
                </button>
            </div>

            {loading.jobs ? <LoadingState label="Loading jobs..." /> : null}
            {!loading.jobs && errors.jobs ? <ErrorState message={errors.jobs} onRetry={loadJobs} /> : null}
            {!loading.jobs && !errors.jobs && jobs.length === 0 ? (
                <EmptyState icon={Activity} title="No jobs yet" text="No render jobs have been submitted." />
            ) : null}
            {!loading.jobs && !errors.jobs && jobs.length > 0 ? (
                <>
                    <div className="data-table-wrap">
                        <table className="data-table" aria-label="All jobs" style={{ minWidth: '1000px' }}>
                            <thead>
                                <tr>
                                    <th scope="col">Job ID</th>
                                    <th scope="col">User</th>
                                    <th scope="col">Status</th>
                                    <th scope="col">Dispatch</th>
                                    <th scope="col">Project</th>
                                    <th scope="col">Cost</th>
                                    <th scope="col">Duration</th>
                                    <th scope="col">Created</th>
                                </tr>
                            </thead>
                            <tbody>
                                {paginatedJobs.items.map((job) => (
                                    <tr className="data-row" key={job.jobId}>
                                        <td data-label="Job ID">
                                            <div className="table-primary" title={job.jobId}>{job.jobId.slice(0, 12)}...</div>
                                        </td>
                                        <td data-label="User">
                                            <div className="table-primary">{job.user?.email || 'Unknown'}</div>
                                        </td>
                                        <td data-label="Status"><StatusPill status={job.status} /></td>
                                        <td data-label="Dispatch"><span className="pill">{job.dispatchStatus || 'PENDING'}</span></td>
                                        <td data-label="Project">{job.project?.name || '—'}</td>
                                        <td data-label="Cost">{job.priceUsd ? formatUsd(job.priceUsd) : '—'}</td>
                                        <td data-label="Duration">{job.billableSeconds ? formatDuration(job.billableSeconds) : '—'}</td>
                                        <td data-label="Created">{formatDate(job.createdAt)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <PaginationControls
                        label="Jobs"
                        totalItems={paginatedJobs.totalItems}
                        page={paginatedJobs.page}
                        pageSize={JOBS_PAGE_SIZE}
                        onPageChange={setJobsPage}
                    />
                </>
            ) : null}
        </motion.div>
    );

    const renderSystem = () => (
        <>
            <motion.div className="panel dashboard-panel full" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
                <div className="panel-head">
                    <div>
                        <h2>Operational metrics</h2>
                        <p className="muted">Snapshot of memory, uptime, and platform health indicators.</p>
                    </div>
                    <button className="button" type="button" onClick={loadMetrics} disabled={loading.metrics}>
                        <RefreshCcw size={16} className={loading.metrics ? 'spin' : ''} /> Refresh
                    </button>
                </div>

                {loading.metrics ? <LoadingState label="Loading metrics..." /> : null}
                {!loading.metrics && errors.metrics ? <ErrorState message={errors.metrics} onRetry={loadMetrics} /> : null}
                {!loading.metrics && !errors.metrics && metrics ? (
                    <div className="dashboard-metrics-grid operations-metrics">
                        <MetricCard icon={Server} label="Uptime" value={metrics.uptime ? `${Math.floor(metrics.uptime / 3600)}h` : 'N/A'} detail="Process uptime" />
                        <MetricCard icon={HardDrive} label="Memory (RSS)" value={metrics.memoryUsageMb ? `${Math.round(metrics.memoryUsageMb)} MB` : 'N/A'} detail="Resident set size" />
                        <MetricCard icon={Globe} label="Node version" value={metrics.nodeVersion || 'N/A'} detail={metrics.platform || ''} />
                        <MetricCard icon={Activity} label="Active jobs" value={metrics.activeJobs ?? 'N/A'} detail="Currently running" tone="active" />
                        <MetricCard icon={Database} label="DB pool" value={metrics.databasePoolTotal ?? 'N/A'} detail={`${metrics.databasePoolActive ?? '?'} active / ${metrics.databasePoolIdle ?? '?'} idle`} />
                        <MetricCard icon={Clock3} label="Event loop lag" value={metrics.eventLoopLagMs ? `${Math.round(metrics.eventLoopLagMs)} ms` : 'N/A'} detail="Max lag (ms)" />
                    </div>
                ) : null}
            </motion.div>

            <motion.div className="panel dashboard-panel full" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
                <div className="panel-head">
                    <div>
                        <h2>Record cleanup</h2>
                        <p className="muted">Remove expired sessions, used uploads, and old job records beyond retention.</p>
                    </div>
                </div>
                <div className="dashboard-metrics-grid" style={{ gridTemplateColumns: '1fr' }}>
                    <div className="dashboard-metric" style={{ minHeight: 'auto', display: 'flex', alignItems: 'center', gap: '16px' }}>
                        <div className="metric-icon"><Trash2 size={18} /></div>
                        <div>
                            <strong>Clean up old records</strong>
                            <span>Removes expired sessions, used uploads, and jobs past the retention period.</span>
                        </div>
                        <button className="button danger" type="button" onClick={handleCleanup} style={{ marginLeft: 'auto' }}>
                            <Trash2 size={16} /> Run cleanup
                        </button>
                    </div>
                </div>
            </motion.div>
        </>
    );

    return (
        <main className="dashboard-page">
            <AdminSidebar
                activeView={activeView}
                onChangeView={setActiveView}
            />

            <section className="dashboard-main">
                <div className="dashboard-titlebar operations-titlebar">
                    <div>
                        <p className="eyebrow">{viewMeta.eyebrow}</p>
                        <h1>{viewMeta.title}</h1>
                        <p className="muted">{viewMeta.description}</p>
                    </div>
                    <div className="titlebar-actions">
                        <button className="button" type="button" onClick={loadAll}>
                            <RefreshCcw size={16} /> Refresh all
                        </button>
                    </div>
                </div>

                {activeView === 'overview' && <div className="dashboard-grid operations-grid">{renderOverview()}</div>}
                {activeView === 'users' && <div className="dashboard-grid operations-grid">{renderUsers()}</div>}
                {activeView === 'jobs' && <div className="dashboard-grid operations-grid">{renderJobs()}</div>}
                {activeView === 'system' && <div className="dashboard-grid operations-grid">{renderSystem()}</div>}
            </section>
        </main>
    );
}
