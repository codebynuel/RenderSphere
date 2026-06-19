import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { toast } from 'react-hot-toast';
import { io } from 'socket.io-client';
import {
    Activity,
    CheckCircle2,
    ChevronDown,
    ChevronUp,
    Clock3,
    Copy,
    Download,
    Edit3,
    ExternalLink,
    Eye,
    EyeOff,
    FileArchive,
    FolderKanban,
    FolderPlus,
    KeyRound,
    Plus,
    RefreshCcw,
    Save,
    Search,
    Trash2,
    X,
    XCircle,
} from 'lucide-react';
import Sidebar from '../components/Sidebar';
import { api, formatDate, formatDuration, formatUsd } from '../utils/api';
import { useAuth } from '../context/AuthContext';

const ACTIVE_STATUSES = new Set(['SUBMITTED', 'IN_QUEUE', 'IN_PROGRESS', 'RUNNING']);
const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const STATUS_OPTIONS = [
    { id: 'all', label: 'All statuses' },
    { id: 'active', label: 'Active' },
    { id: 'COMPLETED', label: 'Completed' },
    { id: 'FAILED', label: 'Failed' },
    { id: 'CANCELLED', label: 'Cancelled' },
];

function sortByCreatedDesc(items) {
    return [...items].sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
}

function mergeJob(jobs, updatedJob) {
    if (!updatedJob?.jobId) return jobs;
    const found = jobs.some((job) => job.jobId === updatedJob.jobId);
    const nextJobs = found
        ? jobs.map((job) => (job.jobId === updatedJob.jobId ? { ...job, ...updatedJob } : job))
        : [updatedJob, ...jobs];
    return sortByCreatedDesc(nextJobs);
}

function statusClass(status) {
    if (status === 'FAILED') return 'failed';
    if (status === 'COMPLETED') return 'complete';
    if (status === 'CANCELLED') return 'cancelled';
    if (ACTIVE_STATUSES.has(status)) return 'active';
    return 'pending';
}

function progressPercent(job) {
    if (job?.status === 'COMPLETED') return 100;
    const percent = Number(job?.progress?.percent);
    if (Number.isFinite(percent)) return Math.min(100, Math.max(0, Math.round(percent)));
    if (ACTIVE_STATUSES.has(job?.status)) return job.status === 'IN_QUEUE' ? 4 : 10;
    return 0;
}

function projectLabel(item) {
    return item?.project?.name || 'Unassigned';
}

function outputLabel(settings = {}) {
    const format = settings.outputFormat || settings.output_format || 'Output';
    if (settings.isAnimation || settings.is_animation) return `${format} animation`;
    return `${format} still`;
}

function renderTypeLabel(job) {
    if (job.settings?.isAnimation || job.settings?.is_animation) return `${job.frameCount || job.settings?.frameCount || 1} frames`;
    return 'Still frame';
}

function normalizeText(value) {
    return String(value || '').toLowerCase().trim();
}

function statusMatches(job, statusFilter) {
    if (statusFilter === 'all') return true;
    if (statusFilter === 'active') return ACTIVE_STATUSES.has(job.status);
    return job.status === statusFilter;
}

function matchesSearch(item, query) {
    const text = normalizeText(query);
    if (!text) return true;
    const settings = item.settings || {};
    const haystack = [
        item.jobId,
        item.fileName,
        item.resultKey,
        item.status,
        item.project?.name,
        settings.engine,
        settings.scene,
        settings.camera,
        settings.outputFormat,
        settings.output_format,
    ].map(normalizeText).join(' ');
    return haystack.includes(text);
}

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

function ProgressBar({ job }) {
    const percent = progressPercent(job);
    return (
        <div className="progress-wrap" aria-label={`Render progress ${percent}%`}>
            <div className="progress-track">
                <motion.div
                    className={`progress-fill ${statusClass(job.status)}`}
                    initial={false}
                    animate={{ width: `${percent}%` }}
                    transition={{ duration: 0.35 }}
                />
            </div>
            <span>{percent}%</span>
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

function LoadingState({ label = 'Loading workspace data...' }) {
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

function ScopeControls({ value, projects, counts, onChange, compact = false }) {
    return (
        <div className={`scope-controls ${compact ? 'compact' : ''}`} aria-label="Project scope filter">
            <label>
                <span>Project scope</span>
                <select value={value} onChange={(event) => onChange(event.target.value)}>
                    <option value="all">All projects ({counts.all || 0})</option>
                    <option value="unassigned">Unassigned ({counts.unassigned || 0})</option>
                    {projects.map((project) => (
                        <option value={project.id} key={project.id}>
                            {project.name} ({counts.byProject.get(project.id) || 0})
                        </option>
                    ))}
                </select>
            </label>
        </div>
    );
}

function SearchBox({ value, onChange, placeholder }) {
    return (
        <label className="search-box">
            <Search size={16} />
            <span className="sr-only">Search</span>
            <input type="search" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
        </label>
    );
}

function StatusPill({ status }) {
    return <span className={`pill status-pill ${statusClass(status)}`}>{status || 'SUBMITTED'}</span>;
}

export default function Dashboard() {
    const { user, loading: authLoading, setUser } = useAuth();
    const navigate = useNavigate();

    const [activeView, setActiveView] = useState('overview');
    const [projectScope, setProjectScope] = useState('all');
    const [jobStatusFilter, setJobStatusFilter] = useState('all');
    const [jobSearchQuery, setJobSearchQuery] = useState('');
    const [fileSearchQuery, setFileSearchQuery] = useState('');
    const [socketConnected, setSocketConnected] = useState(false);
    const [accessKeys, setAccessKeys] = useState([]);
    const [files, setFiles] = useState([]);
    const [jobs, setJobs] = useState([]);
    const [projects, setProjects] = useState([]);
    const [visibleKeyIds, setVisibleKeyIds] = useState(new Set());
    const [expandedJobId, setExpandedJobId] = useState(null);
    const [newKeyName, setNewKeyName] = useState('');
    const [newProjectName, setNewProjectName] = useState('');
    const [editingProjectId, setEditingProjectId] = useState(null);
    const [editingProjectName, setEditingProjectName] = useState('');
    const [creatingKey, setCreatingKey] = useState(false);
    const [creatingProject, setCreatingProject] = useState(false);
    const [updatingProjectId, setUpdatingProjectId] = useState(null);
    const [showWorkflow, setShowWorkflow] = useState(true);
    const [loading, setLoading] = useState({ keys: true, files: true, jobs: true, projects: true });
    const [errors, setErrors] = useState({ keys: '', files: '', jobs: '', projects: '' });

    useEffect(() => {
        if (!authLoading && !user) navigate('/auth');
    }, [user, authLoading, navigate]);

    const setLoadingFlag = useCallback((key, value) => {
        setLoading((current) => ({ ...current, [key]: value }));
    }, []);

    const setErrorFlag = useCallback((key, value) => {
        setErrors((current) => ({ ...current, [key]: value }));
    }, []);

    const loadAccessKeys = useCallback(async () => {
        setLoadingFlag('keys', true);
        setErrorFlag('keys', '');
        try {
            const data = await api('/api/auth/access-keys');
            setAccessKeys(data.accessKeys || []);
        } catch (error) {
            setErrorFlag('keys', error.message || 'Failed to load access keys');
            toast.error(`Failed to load access keys: ${error.message}`);
        } finally {
            setLoadingFlag('keys', false);
        }
    }, [setErrorFlag, setLoadingFlag]);

    const loadProjects = useCallback(async () => {
        setLoadingFlag('projects', true);
        setErrorFlag('projects', '');
        try {
            const data = await api('/api/projects');
            setProjects(data.projects || []);
        } catch (error) {
            setErrorFlag('projects', error.message || 'Failed to load projects');
            toast.error(`Failed to load projects: ${error.message}`);
        } finally {
            setLoadingFlag('projects', false);
        }
    }, [setErrorFlag, setLoadingFlag]);

    const loadFiles = useCallback(async () => {
        setLoadingFlag('files', true);
        setErrorFlag('files', '');
        try {
            const data = await api('/api/rendered-files');
            setFiles(data.files || []);
            if (data.user) setUser(data.user);
        } catch (error) {
            setErrorFlag('files', error.message || 'Failed to load files');
            toast.error(`Failed to load files: ${error.message}`);
        } finally {
            setLoadingFlag('files', false);
        }
    }, [setErrorFlag, setLoadingFlag, setUser]);

    const loadJobs = useCallback(async () => {
        setLoadingFlag('jobs', true);
        setErrorFlag('jobs', '');
        try {
            const data = await api('/api/jobs');
            setJobs(data.jobs || []);
            if (data.user) setUser(data.user);
        } catch (error) {
            setErrorFlag('jobs', error.message || 'Failed to load jobs');
            toast.error(`Failed to load jobs: ${error.message}`);
        } finally {
            setLoadingFlag('jobs', false);
        }
    }, [setErrorFlag, setLoadingFlag, setUser]);

    const loadAll = useCallback(async () => {
        await Promise.all([loadAccessKeys(), loadProjects(), loadFiles(), loadJobs()]);
    }, [loadAccessKeys, loadFiles, loadJobs, loadProjects]);

    useEffect(() => {
        if (!user?.id) return undefined;
        const timer = window.setTimeout(() => {
            loadAll();
        }, 0);
        return () => window.clearTimeout(timer);
    }, [user?.id, loadAll]);

    useEffect(() => {
        if (!user?.id) return undefined;

        const socket = io('/', { withCredentials: true });
        socket.on('connect', () => setSocketConnected(true));
        socket.on('disconnect', () => setSocketConnected(false));
        socket.on('connect_error', () => setSocketConnected(false));
        socket.on('job_update', (job) => {
            setJobs((current) => mergeJob(current, job));
            if (job?.status === 'COMPLETED') {
                setTimeout(() => {
                    loadFiles();
                    loadJobs();
                }, 250);
            }
        });

        return () => {
            socket.disconnect();
            setSocketConnected(false);
        };
    }, [user?.id, loadFiles, loadJobs]);

    const scopeMatches = useCallback((item) => {
        if (projectScope === 'all') return true;
        if (projectScope === 'unassigned') return !item.projectId;
        return item.projectId === projectScope;
    }, [projectScope]);

    const stats = useMemo(() => {
        const jobsByProject = new Map();
        const filesByProject = new Map();
        let unassignedJobs = 0;
        let unassignedFiles = 0;
        let activeJobs = 0;
        let completedJobs = 0;
        let failedJobs = 0;
        let cancelledJobs = 0;
        let totalSpend = 0;
        let billableSeconds = 0;

        jobs.forEach((job) => {
            if (job.projectId) jobsByProject.set(job.projectId, (jobsByProject.get(job.projectId) || 0) + 1);
            else unassignedJobs += 1;

            if (ACTIVE_STATUSES.has(job.status)) activeJobs += 1;
            if (job.status === 'COMPLETED') completedJobs += 1;
            if (job.status === 'FAILED') failedJobs += 1;
            if (job.status === 'CANCELLED') cancelledJobs += 1;
            totalSpend += Number(job.priceUsd || 0);
            billableSeconds += Number(job.billableSeconds || 0);
        });

        files.forEach((file) => {
            if (file.projectId) filesByProject.set(file.projectId, (filesByProject.get(file.projectId) || 0) + 1);
            else unassignedFiles += 1;
        });

        return {
            activeJobs,
            billableSeconds,
            cancelledJobs,
            completedJobs,
            failedJobs,
            filesByProject,
            jobsByProject,
            totalFiles: files.length,
            totalJobs: jobs.length,
            totalSpend,
            unassignedFiles,
            unassignedJobs,
        };
    }, [files, jobs]);

    const projectScopeName = useMemo(() => {
        if (projectScope === 'all') return 'All projects';
        if (projectScope === 'unassigned') return 'Unassigned';
        return projects.find((project) => project.id === projectScope)?.name || 'Selected project';
    }, [projects, projectScope]);

    const scopedJobs = useMemo(() => jobs.filter(scopeMatches), [jobs, scopeMatches]);
    const scopedFiles = useMemo(() => files.filter(scopeMatches), [files, scopeMatches]);

    const visibleJobs = useMemo(() => scopedJobs
        .filter((job) => statusMatches(job, jobStatusFilter))
        .filter((job) => matchesSearch(job, jobSearchQuery)), [jobSearchQuery, jobStatusFilter, scopedJobs]);

    const activeJobs = useMemo(() => visibleJobs.filter((job) => ACTIVE_STATUSES.has(job.status)), [visibleJobs]);
    const historyJobs = useMemo(() => visibleJobs.filter((job) => TERMINAL_STATUSES.has(job.status) || !ACTIVE_STATUSES.has(job.status)), [visibleJobs]);

    const visibleFiles = useMemo(() => scopedFiles.filter((file) => matchesSearch(file, fileSearchQuery)), [fileSearchQuery, scopedFiles]);

    const scopedStats = useMemo(() => {
        let activeJobCount = 0;
        let completedJobs = 0;
        let failedJobs = 0;
        let cancelledJobs = 0;
        let totalSpend = 0;
        let billableSeconds = 0;

        scopedJobs.forEach((job) => {
            if (ACTIVE_STATUSES.has(job.status)) activeJobCount += 1;
            if (job.status === 'COMPLETED') completedJobs += 1;
            if (job.status === 'FAILED') failedJobs += 1;
            if (job.status === 'CANCELLED') cancelledJobs += 1;
            totalSpend += Number(job.priceUsd || 0);
            billableSeconds += Number(job.billableSeconds || 0);
        });

        return {
            activeJobs: activeJobCount,
            billableSeconds,
            cancelledJobs,
            completedJobs,
            failedJobs,
            totalFiles: scopedFiles.length,
            totalJobs: scopedJobs.length,
            totalSpend,
        };
    }, [scopedFiles.length, scopedJobs]);

    const scopeCounts = useMemo(() => ({
        all: jobs.length,
        unassigned: stats.unassignedJobs,
        byProject: stats.jobsByProject,
    }), [jobs.length, stats.jobsByProject, stats.unassignedJobs]);

    const fileScopeCounts = useMemo(() => ({
        all: files.length,
        unassigned: stats.unassignedFiles,
        byProject: stats.filesByProject,
    }), [files.length, stats.filesByProject, stats.unassignedFiles]);

    const scopeDetail = useMemo(() => {
        if (projectScope === 'all') return `${projects.length} projects / ${stats.unassignedJobs} unassigned jobs`;
        if (projectScope === 'unassigned') return 'Jobs and files without a project';
        return `${stats.jobsByProject.get(projectScope) || 0} jobs / ${stats.filesByProject.get(projectScope) || 0} files`;
    }, [projectScope, projects.length, stats.filesByProject, stats.jobsByProject, stats.unassignedJobs]);

    const viewMeta = useMemo(() => {
        const copy = {
            overview: {
                eyebrow: 'Production operations',
                title: 'Operations dashboard',
                description: 'Monitor render health, delivery output, spend, and setup status across your workspace.',
            },
            projects: {
                eyebrow: 'Organize work',
                title: 'Projects',
                description: 'Create, rename, review, and route project work without hiding list filters in the sidebar.',
            },
            renders: {
                eyebrow: 'Render operations',
                title: 'Render queue',
                description: 'Active jobs are prioritized first, with searchable history and explicit project scope controls.',
            },
            files: {
                eyebrow: 'Delivery library',
                title: 'Rendered files',
                description: 'Find completed outputs by project scope, file metadata, scene, or job ID.',
            },
            access: {
                eyebrow: 'Blender connection',
                title: 'Access keys',
                description: 'Create secure keys for Blender workstations and automation clients before submitting jobs.',
            },
        };
        return copy[activeView] || copy.overview;
    }, [activeView]);

    const workflowSteps = useMemo(() => [
        {
            id: 'connect',
            icon: KeyRound,
            title: 'Connect Blender',
            text: 'Create an access key and paste it into the RenderSphere Blender add-on preferences.',
            complete: accessKeys.length > 0,
            actionLabel: accessKeys.length > 0 ? 'Manage keys' : 'Create access key',
            view: 'access',
        },
        {
            id: 'project',
            icon: FolderPlus,
            title: 'Create project',
            text: 'Group renders by client, shot, sequence, or experiment before production starts.',
            complete: projects.length > 0,
            actionLabel: projects.length > 0 ? 'View projects' : 'Create project',
            view: 'projects',
        },
        {
            id: 'submit',
            icon: Activity,
            title: 'Submit render',
            text: 'Use the Blender add-on to send still frames or animations to the cloud render queue.',
            complete: jobs.length > 0,
            actionLabel: 'Download add-on',
            href: '/downloads/rendersphere-blender-addon.zip',
        },
        {
            id: 'monitor',
            icon: Clock3,
            title: 'Monitor jobs',
            text: 'Track live progress, cost, duration, status changes, and failures in one queue.',
            complete: jobs.length > 0,
            actionLabel: 'Monitor jobs',
            view: 'renders',
        },
        {
            id: 'download',
            icon: Download,
            title: 'Download files',
            text: 'Open completed results, copy download links, and review billed render time.',
            complete: files.length > 0,
            actionLabel: 'View files',
            view: 'files',
        },
    ], [accessKeys.length, files.length, jobs.length, projects.length]);

    const hasJobFilters = projectScope !== 'all' || jobStatusFilter !== 'all' || Boolean(jobSearchQuery.trim());
    const hasFileFilters = projectScope !== 'all' || Boolean(fileSearchQuery.trim());

    const handleCreateKey = async (event) => {
        event.preventDefault();
        if (!newKeyName.trim()) return;
        setCreatingKey(true);
        try {
            const data = await api('/api/auth/access-keys', {
                method: 'POST',
                body: JSON.stringify({ name: newKeyName.trim() }),
            });
            const createdKey = data.accessKey;
            setAccessKeys((current) => [...current, createdKey]);
            setVisibleKeyIds((current) => new Set([...current, createdKey.id]));
            setNewKeyName('');
            toast.success('Access key created. Copy it now; the full token is shown once.');
        } catch (error) {
            toast.error(error.message || 'Failed to create key');
        } finally {
            setCreatingKey(false);
        }
    };

    const handleDeleteKey = async (id, name) => {
        if (!window.confirm(`Delete "${name || 'Access key'}"? This action cannot be undone.`)) return;
        try {
            await api(`/api/auth/access-keys/${id}`, { method: 'DELETE', body: '{}' });
            setVisibleKeyIds((current) => {
                const next = new Set(current);
                next.delete(id);
                return next;
            });
            setAccessKeys((current) => current.filter((key) => key.id !== id));
            toast.success('Access key deleted.');
        } catch (error) {
            toast.error(error.message || 'Failed to delete key');
        }
    };

    const handleCreateProject = async (event) => {
        event.preventDefault();
        if (!newProjectName.trim()) return;
        setCreatingProject(true);
        try {
            const data = await api('/api/projects', {
                method: 'POST',
                body: JSON.stringify({ name: newProjectName.trim() }),
            });
            setProjects((current) => [data.project, ...current]);
            setProjectScope(data.project.id);
            setNewProjectName('');
            setActiveView('projects');
            toast.success('Project created.');
        } catch (error) {
            toast.error(error.message || 'Failed to create project');
        } finally {
            setCreatingProject(false);
        }
    };

    const startProjectEdit = (project) => {
        setEditingProjectId(project.id);
        setEditingProjectName(project.name || '');
    };

    const cancelProjectEdit = () => {
        setEditingProjectId(null);
        setEditingProjectName('');
    };

    const handleUpdateProject = async (event, project) => {
        event.preventDefault();
        const nextName = editingProjectName.trim();
        if (!nextName || nextName === project.name) {
            cancelProjectEdit();
            return;
        }
        setUpdatingProjectId(project.id);
        try {
            const data = await api(`/api/projects/${project.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ name: nextName }),
            });
            const updatedProject = data.project;
            setProjects((current) => current.map((item) => (item.id === project.id ? updatedProject : item)));
            setJobs((current) => current.map((job) => (job.projectId === project.id ? { ...job, project: updatedProject } : job)));
            setFiles((current) => current.map((file) => (file.projectId === project.id ? { ...file, project: updatedProject } : file)));
            cancelProjectEdit();
            toast.success('Project renamed.');
        } catch (error) {
            toast.error(error.message || 'Failed to rename project');
        } finally {
            setUpdatingProjectId(null);
        }
    };

    const handleDeleteProject = async (project) => {
        if (!window.confirm(`Delete project "${project.name}"? Existing jobs will become unassigned.`)) return;
        try {
            await api(`/api/projects/${project.id}`, { method: 'DELETE', body: '{}' });
            setProjects((current) => current.filter((item) => item.id !== project.id));
            setJobs((current) => current.map((job) => (job.projectId === project.id ? { ...job, projectId: null, project: null } : job)));
            setFiles((current) => current.map((file) => (file.projectId === project.id ? { ...file, projectId: null, project: null } : file)));
            if (projectScope === project.id) setProjectScope('all');
            toast.success('Project deleted.');
        } catch (error) {
            toast.error(error.message || 'Failed to delete project');
        }
    };

    const handleCancelJob = async (jobId) => {
        if (!window.confirm(`Cancel job ${jobId}?`)) return;
        try {
            const data = await api('/api/cancel-job', {
                method: 'POST',
                body: JSON.stringify({ jobId }),
            });
            if (data.job) setJobs((current) => mergeJob(current, data.job));
            toast.success('Cancel request sent.');
        } catch (error) {
            toast.error(error.message || 'Failed to cancel job');
        }
    };

    const toggleKeyVisibility = (id) => {
        setVisibleKeyIds((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const copyToClipboard = async (text, name) => {
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            toast.success(`Copied ${name} to clipboard.`);
        } catch {
            toast.error('Failed to copy to clipboard.');
        }
    };

    const resetJobFilters = () => {
        setProjectScope('all');
        setJobStatusFilter('all');
        setJobSearchQuery('');
    };

    const resetFileFilters = () => {
        setProjectScope('all');
        setFileSearchQuery('');
    };

    const viewProjectRenders = (projectId) => {
        setProjectScope(projectId);
        setJobStatusFilter('all');
        setJobSearchQuery('');
        setActiveView('renders');
    };

    const viewProjectFiles = (projectId) => {
        setProjectScope(projectId);
        setFileSearchQuery('');
        setActiveView('files');
    };

    const renderJobRow = (job) => {
        const expanded = expandedJobId === job.jobId;
        return (
            <article className="queue-row" key={job.jobId}>
                <div className="queue-main">
                    <div className="queue-identity">
                        <div className="job-id">{job.jobId}</div>
                        <div className="job-meta">
                            <span>{projectLabel(job)}</span>
                            <span>{renderTypeLabel(job)}</span>
                            <span>{outputLabel(job.settings)}</span>
                            <span>Submitted {formatDate(job.createdAt)}</span>
                        </div>
                    </div>
                    <StatusPill status={job.status} />
                    <ProgressBar job={job} />
                    <div className="queue-money">
                        <span>{job.status === 'COMPLETED' ? formatUsd(job.priceUsd) : 'Pending'}</span>
                        <small>{job.status === 'COMPLETED' ? formatDuration(job.billableSeconds) : 'Bill on completion'}</small>
                    </div>
                    <div className="queue-actions">
                        <button className="button compact-button" type="button" onClick={() => setExpandedJobId(expanded ? null : job.jobId)}>
                            {expanded ? 'Hide' : 'Details'}
                        </button>
                        {ACTIVE_STATUSES.has(job.status) && (
                            <button className="button compact-button danger" type="button" onClick={() => handleCancelJob(job.jobId)}>
                                Cancel
                            </button>
                        )}
                        {job.downloadUrl && (
                            <a className="link-button compact-button" href={job.downloadUrl} target="_blank" rel="noopener noreferrer">
                                <Download size={15} /> Download
                            </a>
                        )}
                    </div>
                </div>

                {expanded && (
                    <div className="job-details queue-details">
                        <div><span>Engine</span><strong>{job.settings?.engine || 'Unknown'}</strong></div>
                        <div><span>Samples</span><strong>{job.settings?.samples || '—'}</strong></div>
                        <div><span>Resolution</span><strong>{job.settings?.resolutionPct || job.settings?.resolution_pct || '—'}%</strong></div>
                        <div><span>Format</span><strong>{job.settings?.outputFormat || job.settings?.output_format || '—'}</strong></div>
                        <div><span>Scene</span><strong>{job.settings?.scene || 'Default'}</strong></div>
                        <div><span>Camera</span><strong>{job.settings?.camera || 'Scene camera'}</strong></div>
                        <div><span>Last checked</span><strong>{formatDate(job.lastCheckedAt || job.updatedAt)}</strong></div>
                        <div><span>Completed</span><strong>{job.completedAt ? formatDate(job.completedAt) : '—'}</strong></div>
                        {job.progress?.message && <div className="detail-wide"><span>Progress message</span><strong>{job.progress.message}</strong></div>}
                        {job.error && <div className="detail-wide"><span>Error</span><strong>{job.error}</strong></div>}
                    </div>
                )}
            </article>
        );
    };

    const renderJobSection = (title, description, rows, emptyTitle, emptyText) => (
        <section className="queue-section">
            <div className="queue-section-head">
                <div>
                    <h3>{title}</h3>
                    <p className="muted">{description}</p>
                </div>
                <span className="count-chip">{rows.length}</span>
            </div>
            {rows.length === 0 ? <EmptyState title={emptyTitle} text={emptyText} /> : <div className="queue-table">{rows.map(renderJobRow)}</div>}
        </section>
    );

    const renderAccessKeys = () => (
        <motion.div className="panel dashboard-panel" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
            <div className="panel-head">
                <div>
                    <h2>Access keys</h2>
                    <p className="muted">Create keys for Blender and automation. Full keys are shown once, then only the preview remains.</p>
                </div>
            </div>
            <form className="inline-form" onSubmit={handleCreateKey}>
                <input
                    type="text"
                    maxLength={80}
                    placeholder="Key name, for example Blender workstation"
                    value={newKeyName}
                    onChange={(event) => setNewKeyName(event.target.value)}
                    disabled={creatingKey}
                />
                <button className="button primary" type="submit" disabled={creatingKey || !newKeyName.trim()}>
                    <Plus size={16} /> Create access key
                </button>
            </form>

            <div className="stack-list">
                {loading.keys ? <LoadingState label="Loading access keys..." /> : null}
                {!loading.keys && errors.keys ? <ErrorState message={errors.keys} onRetry={loadAccessKeys} /> : null}
                {!loading.keys && !errors.keys && accessKeys.length === 0 ? <EmptyState icon={KeyRound} title="No access keys yet" text="Create a key and paste it into the Blender add-on preferences." /> : null}
                {!loading.keys && !errors.keys && accessKeys.map((key) => (
                    <div className="stack-item" key={key.id}>
                        <div className="stack-meta">
                            <strong>{key.name || 'Access key'}</strong>
                            <div className="subtle">Created {formatDate(key.createdAt)}{key.lastUsedAt ? ` / Last used ${formatDate(key.lastUsedAt)}` : ''}</div>
                        </div>
                        <input readOnly value={visibleKeyIds.has(key.id) ? (key.token || key.preview) : key.preview} type={visibleKeyIds.has(key.id) ? 'text' : 'password'} />
                        <div className="button-row compact-row">
                            <button className="button" type="button" disabled={!key.token} onClick={() => toggleKeyVisibility(key.id)} title={!key.token ? 'Full access keys are only shown when first created.' : ''}>
                                {visibleKeyIds.has(key.id) ? <><EyeOff size={16} /> Hide</> : <><Eye size={16} /> Show</>}
                            </button>
                            <button className="button" type="button" disabled={!key.token} onClick={() => copyToClipboard(key.token, key.name || 'access key')} title={!key.token ? 'Full access keys are only shown when first created.' : ''}>
                                <Copy size={16} /> Copy
                            </button>
                            <button className="button danger" type="button" onClick={() => handleDeleteKey(key.id, key.name)}>
                                <Trash2 size={16} /> Delete
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        </motion.div>
    );

    const renderProjects = () => (
        <motion.div className="panel dashboard-panel full" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
            <div className="panel-head project-panel-head">
                <div>
                    <h2>Projects</h2>
                    <p className="muted">Manage production containers and jump into scoped renders or files from explicit actions.</p>
                </div>
                <div className="project-summary-strip">
                    <span><strong>{projects.length}</strong> projects</span>
                    <span><strong>{stats.unassignedJobs}</strong> unassigned jobs</span>
                </div>
            </div>
            <form className="inline-form" onSubmit={handleCreateProject}>
                <input
                    type="text"
                    maxLength={80}
                    placeholder="Project name, for example Product launch shot 04"
                    value={newProjectName}
                    onChange={(event) => setNewProjectName(event.target.value)}
                    disabled={creatingProject}
                />
                <button className="button primary" type="submit" disabled={creatingProject || !newProjectName.trim()}>
                    <FolderPlus size={16} /> Create project
                </button>
            </form>

            <div className="project-grid project-grid-pro">
                {loading.projects ? <LoadingState label="Loading projects..." /> : null}
                {!loading.projects && errors.projects ? <ErrorState message={errors.projects} onRetry={loadProjects} /> : null}
                {!loading.projects && !errors.projects && projects.length === 0 ? <EmptyState icon={FolderKanban} title="No projects yet" text="Create projects for client work, shot sequences, milestones, experiments, or internal tests." /> : null}
                {!loading.projects && !errors.projects && projects.map((project) => {
                    const jobCount = stats.jobsByProject.get(project.id) || project.jobCount || 0;
                    const fileCount = stats.filesByProject.get(project.id) || 0;
                    const isEditing = editingProjectId === project.id;
                    return (
                        <article className="project-card project-card-pro" key={project.id}>
                            <div className="project-card-top">
                                <div className="project-icon"><FolderKanban size={22} /></div>
                                {isEditing ? (
                                    <form className="project-edit-form" onSubmit={(event) => handleUpdateProject(event, project)}>
                                        <input
                                            type="text"
                                            maxLength={80}
                                            value={editingProjectName}
                                            onChange={(event) => setEditingProjectName(event.target.value)}
                                            disabled={updatingProjectId === project.id}
                                            autoFocus
                                        />
                                        <button className="button compact-button primary" type="submit" disabled={updatingProjectId === project.id || !editingProjectName.trim()}>
                                            <Save size={15} /> Save
                                        </button>
                                        <button className="button compact-button" type="button" onClick={cancelProjectEdit}>
                                            <X size={15} /> Cancel
                                        </button>
                                    </form>
                                ) : (
                                    <div>
                                        <h3>{project.name}</h3>
                                        <p>Updated {formatDate(project.updatedAt || project.createdAt)}</p>
                                    </div>
                                )}
                            </div>
                            <div className="project-stats-row">
                                <span><strong>{jobCount}</strong> jobs</span>
                                <span><strong>{fileCount}</strong> files</span>
                                <span><strong>{jobCount ? Math.round((fileCount / jobCount) * 100) : 0}%</strong> delivered</span>
                            </div>
                            <code>{project.id}</code>
                            <div className="button-row compact-row project-actions">
                                <button className="button" type="button" onClick={() => viewProjectRenders(project.id)}>
                                    View jobs
                                </button>
                                <button className="button" type="button" onClick={() => viewProjectFiles(project.id)}>
                                    View files
                                </button>
                                {!isEditing && (
                                    <button className="button" type="button" onClick={() => startProjectEdit(project)}>
                                        <Edit3 size={16} /> Rename
                                    </button>
                                )}
                                <button className="button danger" type="button" onClick={() => handleDeleteProject(project)}>
                                    <Trash2 size={16} /> Delete
                                </button>
                            </div>
                        </article>
                    );
                })}
            </div>
        </motion.div>
    );

    const renderJobs = ({ overview = false } = {}) => {
        const previewJobs = overview ? scopedJobs.slice(0, 6) : null;
        return (
            <motion.div className="panel dashboard-panel full" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
                <div className="panel-head queue-panel-head">
                    <div>
                        <h2>{overview ? 'Queue snapshot' : `Render queue / ${projectScopeName}`}</h2>
                        <p className="muted">{overview ? 'Most recent work across the selected scope.' : 'Active jobs stay above historical outcomes with explicit filtering.'}</p>
                    </div>
                    <button className="button" type="button" onClick={loadJobs} disabled={loading.jobs}>
                        <RefreshCcw size={16} className={loading.jobs ? 'spin' : ''} /> Refresh jobs
                    </button>
                </div>

                {!overview && (
                    <div className="list-toolbar">
                        <ScopeControls value={projectScope} projects={projects} counts={scopeCounts} onChange={setProjectScope} />
                        <label>
                            <span>Status</span>
                            <select value={jobStatusFilter} onChange={(event) => setJobStatusFilter(event.target.value)}>
                                {STATUS_OPTIONS.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
                            </select>
                        </label>
                        <SearchBox value={jobSearchQuery} onChange={setJobSearchQuery} placeholder="Search job, scene, camera, project..." />
                        <button className="button" type="button" onClick={resetJobFilters} disabled={!hasJobFilters}>Clear filters</button>
                    </div>
                )}

                <div className="filter-summary">
                    <span className="scope-chip">Scope: {projectScopeName}</span>
                    <span>{overview ? `${previewJobs.length} of ${scopedJobs.length} recent jobs` : `${visibleJobs.length} matching jobs`}</span>
                    {!overview && <span>{activeJobs.length} active / {historyJobs.length} history</span>}
                </div>

                {loading.jobs ? <LoadingState label="Loading render queue..." /> : null}
                {!loading.jobs && errors.jobs ? <ErrorState message={errors.jobs} onRetry={loadJobs} /> : null}
                {!loading.jobs && !errors.jobs && overview && (
                    previewJobs.length === 0
                        ? <EmptyState icon={Activity} title="No render jobs yet" text="Submit a render from Blender and it will appear here with real-time progress." />
                        : <div className="queue-table compact-queue">{previewJobs.map(renderJobRow)}</div>
                )}
                {!loading.jobs && !errors.jobs && !overview && (
                    visibleJobs.length === 0 ? (
                        <EmptyState
                            icon={Activity}
                            title="No jobs match these controls"
                            text="Adjust the project scope, status, or search query to find submitted render jobs."
                            action={<button className="button" type="button" onClick={resetJobFilters}>Clear filters</button>}
                        />
                    ) : (
                        <div className="queue-stack">
                            {renderJobSection('Active queue', 'Submitted, queued, and running renders ordered by newest first.', activeJobs, 'No active jobs', 'Running work will be pinned here as soon as it is submitted.')}
                            {renderJobSection('History', 'Completed, failed, cancelled, and archived outcomes.', historyJobs, 'No history in this view', 'Completed and terminal jobs appear here after processing.')}
                        </div>
                    )
                )}
            </motion.div>
        );
    };

    const renderFiles = ({ overview = false } = {}) => {
        const previewFiles = overview ? scopedFiles.slice(0, 5) : visibleFiles;
        return (
            <motion.div className="panel dashboard-panel full" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
                <div className="panel-head queue-panel-head">
                    <div>
                        <h2>{overview ? 'Latest deliveries' : `Rendered files / ${projectScopeName}`}</h2>
                        <p className="muted">Completed outputs are served through authenticated downloads.</p>
                    </div>
                    <button className="button" type="button" onClick={loadFiles} disabled={loading.files}>
                        <RefreshCcw size={16} className={loading.files ? 'spin' : ''} /> Refresh files
                    </button>
                </div>

                {!overview && (
                    <div className="list-toolbar file-toolbar">
                        <ScopeControls value={projectScope} projects={projects} counts={fileScopeCounts} onChange={setProjectScope} />
                        <SearchBox value={fileSearchQuery} onChange={setFileSearchQuery} placeholder="Search file, job ID, project..." />
                        <button className="button" type="button" onClick={resetFileFilters} disabled={!hasFileFilters}>Clear filters</button>
                    </div>
                )}

                <div className="filter-summary">
                    <span className="scope-chip">Scope: {projectScopeName}</span>
                    <span>{overview ? `${previewFiles.length} latest files` : `${visibleFiles.length} matching files`}</span>
                </div>

                {loading.files ? <LoadingState label="Loading rendered files..." /> : null}
                {!loading.files && errors.files ? <ErrorState message={errors.files} onRetry={loadFiles} /> : null}
                {!loading.files && !errors.files && previewFiles.length === 0 ? (
                    <EmptyState
                        icon={FileArchive}
                        title={overview ? 'No delivered files yet' : 'No files match this scope'}
                        text={overview ? 'Completed jobs with result files will show download links here.' : 'Adjust the project scope or search query to find rendered outputs.'}
                        action={!overview && hasFileFilters ? <button className="button" type="button" onClick={resetFileFilters}>Clear filters</button> : null}
                    />
                ) : null}
                {!loading.files && !errors.files && previewFiles.length > 0 ? (
                    <div className="file-library">
                        {previewFiles.map((file) => {
                            const absoluteUrl = file.downloadUrl ? new URL(file.downloadUrl, window.location.origin).href : '';
                            return (
                                <article className="file-card" key={file.jobId}>
                                    <div className="file-icon"><FileArchive size={20} /></div>
                                    <div className="file-copy">
                                        <strong>{file.fileName || file.resultKey}</strong>
                                        <div className="subtle">{projectLabel(file)} / Completed {formatDate(file.completedAt || file.createdAt)}</div>
                                        <div className="file-meta-row">
                                            <span>{file.outputFormat || 'Output'}</span>
                                            <span>{formatDuration(file.billableSeconds)} render time</span>
                                            <span>{formatUsd(file.priceUsd)} deducted</span>
                                            <span>{file.jobId}</span>
                                        </div>
                                    </div>
                                    <div className="button-row compact-row file-actions">
                                        {file.downloadUrl ? (
                                            <a className="link-button" href={file.downloadUrl} target="_blank" rel="noopener noreferrer">
                                                <ExternalLink size={16} /> Open
                                            </a>
                                        ) : (
                                            <button className="button" disabled>Open</button>
                                        )}
                                        <button className="button" type="button" disabled={!file.downloadUrl} onClick={() => copyToClipboard(absoluteUrl, 'file link')}>
                                            <Copy size={16} /> Copy link
                                        </button>
                                        {file.downloadUrl && (
                                            <a className="link-button" href={file.downloadUrl} download>
                                                <Download size={16} /> Download
                                            </a>
                                        )}
                                    </div>
                                </article>
                            );
                        })}
                    </div>
                ) : null}
            </motion.div>
        );
    };

    const renderWorkflowGuide = () => (
        <motion.div className="panel dashboard-panel full workflow-panel" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
            <div className="panel-head workflow-head">
                <div>
                    <h2>Get from Blender to delivered files</h2>
                    <p className={`muted${showWorkflow ? '' : ' hide-mobile'}`}>{showWorkflow ? 'Follow these steps in order. Completed steps are marked automatically as your workspace fills with keys, projects, jobs, and files.' : ''}</p>
                </div>
                <button className="button workflow-toggle" type="button" onClick={() => setShowWorkflow(!showWorkflow)} aria-label={showWorkflow ? 'Collapse workflow guide' : 'Expand workflow guide'}>
                    {showWorkflow ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    <span className="toggle-label">{showWorkflow ? 'Hide steps' : 'Show steps'}</span>
                </button>
            </div>
            {showWorkflow && (
                <div className="workflow-steps">
                    {workflowSteps.map((step, index) => {
                        const Icon = step.icon;
                        return (
                            <article className={`workflow-step ${step.complete ? 'complete' : ''}`} key={step.id}>
                                <div className="workflow-step-number">{step.complete ? <CheckCircle2 size={16} /> : index + 1}</div>
                                <div className="workflow-step-icon"><Icon size={20} /></div>
                                <div className="workflow-step-copy">
                                    <h3>{step.title}</h3>
                                    <p>{step.text}</p>
                                </div>
                                {step.href ? (
                                    <a className="link-button" href={step.href} download>
                                        {step.actionLabel}
                                    </a>
                                ) : (
                                    <button className="button" type="button" onClick={() => setActiveView(step.view)}>
                                        {step.actionLabel}
                                    </button>
                                )}
                            </article>
                        );
                    })}
                </div>
            )}
        </motion.div>
    );

    if (authLoading || !user) return null;

    return (
        <main className="dashboard-page">
            <Sidebar
                activeView={activeView}
                onChangeView={setActiveView}
                stats={stats}
                socketConnected={socketConnected}
                balanceUsd={user.starterBalanceUsd}
            />

            <section className="dashboard-main">
                <div className="dashboard-titlebar operations-titlebar">
                    <div>
                        <p className="eyebrow">{viewMeta.eyebrow}</p>
                        <h1>{viewMeta.title}</h1>
                        <p className="muted">{viewMeta.description}</p>
                        <div className="titlebar-status-row">
                            <span className={`socket-state inline ${socketConnected ? 'connected' : ''}`}>{socketConnected ? 'Live socket connected' : 'Live socket offline'}</span>
                            <span className="scope-chip">Current scope: {projectScopeName}</span>
                        </div>
                    </div>
                    <div className="titlebar-actions">
                        {(activeView === 'overview' || activeView === 'renders' || activeView === 'files') && (
                            <ScopeControls value={projectScope} projects={projects} counts={scopeCounts} onChange={setProjectScope} compact />
                        )}
                        <button className="button" type="button" onClick={loadAll}>
                            <RefreshCcw size={16} /> Refresh all
                        </button>
                    </div>
                </div>

                {activeView === 'overview' && renderWorkflowGuide()}

                {activeView === 'overview' && (
                    <div className="dashboard-metrics-grid operations-metrics">
                        <MetricCard icon={FolderKanban} label="Current scope" value={projectScopeName} detail={scopeDetail} />
                        <MetricCard icon={Activity} label="Active jobs" value={scopedStats.activeJobs} detail={`${scopedStats.totalJobs} jobs in scope`} tone="active" />
                        <MetricCard icon={CheckCircle2} label="Completed" value={scopedStats.completedJobs} detail={`${scopedStats.totalFiles} downloadable files`} tone="good" />
                        <MetricCard icon={XCircle} label="Failed" value={scopedStats.failedJobs} detail={`${scopedStats.cancelledJobs} cancelled`} tone="danger" />
                        <MetricCard icon={Clock3} label="Spend" value={formatUsd(scopedStats.totalSpend)} detail={`${formatDuration(scopedStats.billableSeconds)} billed / Balance ${formatUsd(user.starterBalanceUsd)}`} />
                    </div>
                )}

                {activeView === 'overview' && (
                    <div className="dashboard-grid operations-grid">
                        {renderJobs({ overview: true })}
                        {renderFiles({ overview: true })}
                        {renderProjects()}
                    </div>
                )}
                {activeView === 'projects' && <div className="dashboard-grid operations-grid">{renderProjects()}</div>}
                {activeView === 'renders' && <div className="dashboard-grid operations-grid">{renderJobs()}</div>}
                {activeView === 'files' && <div className="dashboard-grid operations-grid">{renderFiles()}</div>}
                {activeView === 'access' && <div className="dashboard-grid two-col"><div className="helper-panel"><KeyRound size={22} /><h2>Connect Blender</h2><p className="muted">Create an access key, paste it into the RenderSphere add-on preferences, then use the Scene and Output panels to submit jobs.</p></div>{renderAccessKeys()}</div>}
            </section>
        </main>
    );
}
