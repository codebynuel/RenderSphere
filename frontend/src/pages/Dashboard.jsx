import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { toast } from 'react-hot-toast';
import { io } from 'socket.io-client';
import {
    Activity,
    CheckCircle2,
    Clock3,
    Copy,
    Download,
    ExternalLink,
    Eye,
    EyeOff,
    FolderKanban,
    FolderPlus,
    KeyRound,
    Plus,
    RefreshCcw,
    Trash2,
    XCircle,
} from 'lucide-react';
import Sidebar from '../components/Sidebar';
import { api, formatDate, formatDuration, formatUsd } from '../utils/api';
import { useAuth } from '../context/AuthContext';

const ACTIVE_STATUSES = new Set(['SUBMITTED', 'IN_QUEUE', 'IN_PROGRESS', 'RUNNING']);

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
    return 'pending';
}

function progressPercent(job) {
    if (job?.status === 'COMPLETED') return 100;
    const percent = Number(job?.progress?.percent);
    if (Number.isFinite(percent)) return Math.min(100, Math.max(0, Math.round(percent)));
    if (ACTIVE_STATUSES.has(job?.status)) return job.status === 'IN_QUEUE' ? 4 : 10;
    return 0;
}

function projectLabel(job) {
    return job.project?.name || 'Unassigned';
}

function MetricCard({ icon: Icon, label, value, detail }) {
    return (
        <div className="dashboard-metric">
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

function EmptyState({ title, text }) {
    return (
        <div className="empty-state">
            <strong>{title}</strong>
            <span>{text}</span>
        </div>
    );
}

export default function Dashboard() {
    const { user, loading: authLoading, setUser } = useAuth();
    const navigate = useNavigate();

    const [activeView, setActiveView] = useState('overview');
    const [selectedProjectId, setSelectedProjectId] = useState('all');
    const [socketConnected, setSocketConnected] = useState(false);
    const [accessKeys, setAccessKeys] = useState([]);
    const [files, setFiles] = useState([]);
    const [jobs, setJobs] = useState([]);
    const [projects, setProjects] = useState([]);
    const [visibleKeyIds, setVisibleKeyIds] = useState(new Set());
    const [expandedJobId, setExpandedJobId] = useState(null);
    const [newKeyName, setNewKeyName] = useState('');
    const [newProjectName, setNewProjectName] = useState('');
    const [creatingKey, setCreatingKey] = useState(false);
    const [creatingProject, setCreatingProject] = useState(false);
    const [loading, setLoading] = useState({ keys: true, files: true, jobs: true, projects: true });

    useEffect(() => {
        if (!authLoading && !user) navigate('/auth');
    }, [user, authLoading, navigate]);

    const setLoadingFlag = useCallback((key, value) => {
        setLoading((current) => ({ ...current, [key]: value }));
    }, []);

    const loadAccessKeys = useCallback(async () => {
        setLoadingFlag('keys', true);
        try {
            const data = await api('/api/auth/access-keys');
            setAccessKeys(data.accessKeys || []);
        } catch (error) {
            toast.error(`Failed to load access keys: ${error.message}`);
        } finally {
            setLoadingFlag('keys', false);
        }
    }, [setLoadingFlag]);

    const loadProjects = useCallback(async () => {
        setLoadingFlag('projects', true);
        try {
            const data = await api('/api/projects');
            setProjects(data.projects || []);
        } catch (error) {
            toast.error(`Failed to load projects: ${error.message}`);
        } finally {
            setLoadingFlag('projects', false);
        }
    }, [setLoadingFlag]);

    const loadFiles = useCallback(async () => {
        setLoadingFlag('files', true);
        try {
            const data = await api('/api/rendered-files');
            setFiles(data.files || []);
            if (data.user) setUser(data.user);
        } catch (error) {
            toast.error(`Failed to load files: ${error.message}`);
        } finally {
            setLoadingFlag('files', false);
        }
    }, [setLoadingFlag, setUser]);

    const loadJobs = useCallback(async () => {
        setLoadingFlag('jobs', true);
        try {
            const data = await api('/api/jobs');
            setJobs(data.jobs || []);
            if (data.user) setUser(data.user);
        } catch (error) {
            toast.error(`Failed to load jobs: ${error.message}`);
        } finally {
            setLoadingFlag('jobs', false);
        }
    }, [setLoadingFlag, setUser]);

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

    const stats = useMemo(() => {
        const jobsByProject = new Map();
        let unassignedJobs = 0;
        let activeJobs = 0;
        let completedJobs = 0;
        let failedJobs = 0;
        let totalSpend = 0;

        jobs.forEach((job) => {
            if (job.projectId) jobsByProject.set(job.projectId, (jobsByProject.get(job.projectId) || 0) + 1);
            else unassignedJobs += 1;

            if (ACTIVE_STATUSES.has(job.status)) activeJobs += 1;
            if (job.status === 'COMPLETED') completedJobs += 1;
            if (job.status === 'FAILED') failedJobs += 1;
            totalSpend += Number(job.priceUsd || 0);
        });

        return {
            activeJobs,
            completedJobs,
            failedJobs,
            jobsByProject,
            totalJobs: jobs.length,
            totalSpend,
            unassignedJobs,
        };
    }, [jobs]);

    const selectedProjectName = useMemo(() => {
        if (selectedProjectId === 'all') return 'All projects';
        if (selectedProjectId === 'unassigned') return 'Unassigned';
        return projects.find((project) => project.id === selectedProjectId)?.name || 'Selected project';
    }, [projects, selectedProjectId]);

    const projectMatches = useCallback((item) => {
        if (selectedProjectId === 'all') return true;
        if (selectedProjectId === 'unassigned') return !item.projectId;
        return item.projectId === selectedProjectId;
    }, [selectedProjectId]);

    const filteredJobs = useMemo(() => jobs.filter(projectMatches), [jobs, projectMatches]);
    const filteredFiles = useMemo(() => files.filter(projectMatches), [files, projectMatches]);
    const scopedStats = useMemo(() => {
        let activeJobs = 0;
        let completedJobs = 0;
        let failedJobs = 0;
        let totalSpend = 0;
        let billableSeconds = 0;

        filteredJobs.forEach((job) => {
            if (ACTIVE_STATUSES.has(job.status)) activeJobs += 1;
            if (job.status === 'COMPLETED') completedJobs += 1;
            if (job.status === 'FAILED') failedJobs += 1;
            totalSpend += Number(job.priceUsd || 0);
            billableSeconds += Number(job.billableSeconds || 0);
        });

        return {
            activeJobs,
            billableSeconds,
            completedJobs,
            failedJobs,
            totalFiles: filteredFiles.length,
            totalJobs: filteredJobs.length,
            totalSpend,
        };
    }, [filteredFiles.length, filteredJobs]);
    const scopeDetail = useMemo(() => {
        if (selectedProjectId === 'all') return `${projects.length} projects / ${stats.unassignedJobs} unassigned jobs`;
        if (selectedProjectId === 'unassigned') return 'Jobs without a project';
        return `${stats.jobsByProject.get(selectedProjectId) || 0} lifetime jobs in project`;
    }, [projects.length, selectedProjectId, stats.jobsByProject, stats.unassignedJobs]);
    const recentJobs = useMemo(() => filteredJobs.slice(0, activeView === 'overview' ? 5 : filteredJobs.length), [activeView, filteredJobs]);
    const recentFiles = useMemo(() => filteredFiles.slice(0, activeView === 'overview' ? 4 : filteredFiles.length), [activeView, filteredFiles]);
    const viewMeta = useMemo(() => {
        const copy = {
            overview: {
                eyebrow: 'Production workspace',
                title: 'Overview',
                description: 'Start here: connect Blender, create a project, submit a render, monitor progress, then download completed files.',
            },
            projects: {
                eyebrow: 'Organize work',
                title: 'Projects',
                description: 'Create project spaces for clients, shots, sequences, experiments, and production milestones.',
            },
            renders: {
                eyebrow: 'Render operations',
                title: 'Render jobs',
                description: `Monitor active and historical render jobs for ${selectedProjectName}.`,
            },
            files: {
                eyebrow: 'Delivery library',
                title: 'Rendered files',
                description: `Download completed outputs and share authenticated links for ${selectedProjectName}.`,
            },
            access: {
                eyebrow: 'Blender connection',
                title: 'Access keys',
                description: 'Create secure keys for Blender workstations and automation clients before submitting jobs.',
            },
        };
        return copy[activeView] || copy.overview;
    }, [activeView, selectedProjectName]);
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
            setSelectedProjectId(data.project.id);
            setNewProjectName('');
            setActiveView('projects');
            toast.success('Project created.');
        } catch (error) {
            toast.error(error.message || 'Failed to create project');
        } finally {
            setCreatingProject(false);
        }
    };

    const handleDeleteProject = async (project) => {
        if (!window.confirm(`Delete project "${project.name}"? Existing jobs will become unassigned.`)) return;
        try {
            await api(`/api/projects/${project.id}`, { method: 'DELETE', body: '{}' });
            setProjects((current) => current.filter((item) => item.id !== project.id));
            setJobs((current) => current.map((job) => (job.projectId === project.id ? { ...job, projectId: null, project: null } : job)));
            if (selectedProjectId === project.id) setSelectedProjectId('all');
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

    const renderJobCard = (job) => (
        <div className="job-card" key={job.jobId}>
            <div className="job-card-main">
                <div>
                    <div className="job-id">{job.jobId}</div>
                    <div className="job-meta">
                        <span>{projectLabel(job)}</span>
                        <span>Submitted {formatDate(job.createdAt)}</span>
                        <span>{job.settings?.isAnimation ? `${job.frameCount || 1} frames` : 'Still frame'}</span>
                    </div>
                </div>
                <div className={`pill ${statusClass(job.status)}`}>{job.status || 'SUBMITTED'}</div>
            </div>

            <ProgressBar job={job} />

            <div className="job-actions">
                <button className="button" type="button" onClick={() => setExpandedJobId(expandedJobId === job.jobId ? null : job.jobId)}>
                    {expandedJobId === job.jobId ? 'Hide details' : 'View details'}
                </button>
                {ACTIVE_STATUSES.has(job.status) && (
                    <button className="button danger" type="button" onClick={() => handleCancelJob(job.jobId)}>
                        Cancel
                    </button>
                )}
                {job.downloadUrl && (
                    <a className="link-button" href={job.downloadUrl} target="_blank" rel="noopener noreferrer">
                        <Download size={16} /> Download
                    </a>
                )}
            </div>

            {expandedJobId === job.jobId && (
                <div className="job-details">
                    <div><span>Engine</span><strong>{job.settings?.engine || 'Unknown'}</strong></div>
                    <div><span>Samples</span><strong>{job.settings?.samples || '—'}</strong></div>
                    <div><span>Resolution</span><strong>{job.settings?.resolutionPct || job.settings?.resolution_pct || '—'}%</strong></div>
                    <div><span>Format</span><strong>{job.settings?.outputFormat || job.settings?.output_format || '—'}</strong></div>
                    <div><span>Scene</span><strong>{job.settings?.scene || 'Default'}</strong></div>
                    <div><span>Camera</span><strong>{job.settings?.camera || 'Scene camera'}</strong></div>
                    <div><span>Duration</span><strong>{job.status === 'COMPLETED' ? formatDuration(job.billableSeconds) : 'Pending'}</strong></div>
                    <div><span>Cost</span><strong>{job.status === 'COMPLETED' ? formatUsd(job.priceUsd) : 'Pending'}</strong></div>
                    {job.error && <div className="detail-wide"><span>Error</span><strong>{job.error}</strong></div>}
                </div>
            )}
        </div>
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
                {loading.keys ? <div className="muted">Loading access keys...</div> : null}
                {!loading.keys && accessKeys.length === 0 ? <EmptyState title="No access keys yet" text="Create a key and paste it into the Blender add-on preferences." /> : null}
                {!loading.keys && accessKeys.map((key) => (
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
        <motion.div className="panel dashboard-panel" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
            <div className="panel-head">
                <div>
                    <h2>Projects</h2>
                    <p className="muted">Group renders by client, shot, sequence, or experiment.</p>
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

            <div className="project-grid">
                {loading.projects ? <div className="muted">Loading projects...</div> : null}
                {!loading.projects && projects.length === 0 ? <EmptyState title="No projects yet" text="Create a project, then pass its ID from API clients or organize renders submitted from the dashboard API." /> : null}
                {!loading.projects && projects.map((project) => (
                    <div className="project-card" key={project.id}>
                        <div>
                            <FolderKanban size={22} />
                            <h3>{project.name}</h3>
                            <p>{stats.jobsByProject.get(project.id) || 0} render jobs</p>
                            <code>{project.id}</code>
                        </div>
                        <div className="button-row compact-row">
                            <button className="button" type="button" onClick={() => { setSelectedProjectId(project.id); setActiveView('renders'); }}>
                                View renders
                            </button>
                            <button className="button danger" type="button" onClick={() => handleDeleteProject(project)}>
                                <Trash2 size={16} /> Delete
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        </motion.div>
    );

    const renderJobs = () => (
        <motion.div className="panel dashboard-panel" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
            <div className="panel-head">
                <div>
                    <h2>{activeView === 'overview' ? 'Active and recent jobs' : `Render jobs / ${selectedProjectName}`}</h2>
                    <p className="muted">Live render progress updates through the dashboard.</p>
                </div>
                <button className="button" type="button" onClick={loadJobs} disabled={loading.jobs}>
                    <RefreshCcw size={16} className={loading.jobs ? 'spin' : ''} /> Refresh
                </button>
            </div>
            <div className="job-list rich">
                {loading.jobs ? <div className="muted">Loading jobs...</div> : null}
                {!loading.jobs && recentJobs.length === 0 ? <EmptyState title="No render jobs" text="Submit a render from Blender and it will appear here with real-time progress." /> : null}
                {!loading.jobs && recentJobs.map(renderJobCard)}
            </div>
        </motion.div>
    );

    const renderFiles = () => (
        <motion.div className="panel dashboard-panel full" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
            <div className="panel-head">
                <div>
                    <h2>{activeView === 'overview' ? 'Latest rendered files' : `Rendered files / ${selectedProjectName}`}</h2>
                    <p className="muted">Completed outputs are served through authenticated downloads.</p>
                </div>
                <button className="button" type="button" onClick={loadFiles} disabled={loading.files}>
                    <RefreshCcw size={16} className={loading.files ? 'spin' : ''} /> Refresh
                </button>
            </div>
            <div className="stack-list">
                {loading.files ? <div className="muted">Loading files...</div> : null}
                {!loading.files && recentFiles.length === 0 ? <EmptyState title="No rendered files" text="Completed jobs with result files will show download links here." /> : null}
                {!loading.files && recentFiles.map((file) => (
                    <div className="stack-item file-item" key={file.jobId}>
                        <div className="stack-meta">
                            <strong>{file.fileName || file.resultKey}</strong>
                            <div className="subtle">{file.project?.name || 'Unassigned'} / Completed {formatDate(file.completedAt || file.createdAt)}</div>
                            <div className="subtle">{formatDuration(file.billableSeconds)} render time / {formatUsd(file.priceUsd)} deducted</div>
                        </div>
                        <div className="button-row compact-row">
                            {file.downloadUrl ? (
                                <a className="link-button" href={file.downloadUrl} target="_blank" rel="noopener noreferrer">
                                    <ExternalLink size={16} /> Open file
                                </a>
                            ) : (
                                <button className="button" disabled>Open file</button>
                            )}
                            <button className="button" type="button" disabled={!file.downloadUrl} onClick={() => copyToClipboard(new URL(file.downloadUrl, window.location.origin).href, 'link')}>
                                <Copy size={16} /> Copy link
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        </motion.div>
    );

    const renderWorkflowGuide = () => (
        <motion.div className="panel dashboard-panel full workflow-panel" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
            <div className="panel-head workflow-head">
                <div>
                    <h2>Get from Blender to delivered files</h2>
                    <p className="muted">Follow these steps in order. Completed steps are marked automatically as your workspace fills with keys, projects, jobs, and files.</p>
                </div>
            </div>
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
        </motion.div>
    );

    if (authLoading || !user) return null;

    return (
        <main className="dashboard-page">
            <Sidebar
                activeView={activeView}
                onChangeView={setActiveView}
                projects={projects}
                selectedProjectId={selectedProjectId}
                onSelectProject={setSelectedProjectId}
                stats={stats}
                socketConnected={socketConnected}
            />

            <section className="dashboard-main">
                <div className="dashboard-titlebar">
                    <div>
                        <p className="eyebrow">{viewMeta.eyebrow}</p>
                        <h1>{viewMeta.title}</h1>
                        <p className="muted">{viewMeta.description}</p>
                        {activeView !== 'overview' && <span className="scope-chip">Scope: {selectedProjectName}</span>}
                    </div>
                    <button className="button" type="button" onClick={loadAll}>
                        <RefreshCcw size={16} /> Refresh all
                    </button>
                </div>

                {activeView === 'overview' && renderWorkflowGuide()}

                {activeView === 'overview' && (
                    <div className="dashboard-metrics-grid">
                        <MetricCard icon={FolderKanban} label="Current scope" value={selectedProjectName} detail={scopeDetail} />
                        <MetricCard icon={Activity} label="Active jobs" value={scopedStats.activeJobs} detail={`${scopedStats.totalJobs} jobs in this view`} />
                        <MetricCard icon={CheckCircle2} label="Completed" value={scopedStats.completedJobs} detail={`${scopedStats.totalFiles} downloadable files`} />
                        <MetricCard icon={XCircle} label="Failed" value={scopedStats.failedJobs} detail="In this view" />
                        <MetricCard icon={Clock3} label="Spend" value={formatUsd(scopedStats.totalSpend)} detail={`${formatDuration(scopedStats.billableSeconds)} billed / Balance ${formatUsd(user.starterBalanceUsd)}`} />
                    </div>
                )}

                {activeView === 'overview' && (
                    <div className="dashboard-grid">
                        {renderProjects()}
                        {renderJobs()}
                        {renderFiles()}
                    </div>
                )}
                {activeView === 'projects' && <div className="dashboard-grid">{renderProjects()}{renderJobs()}</div>}
                {activeView === 'renders' && <div className="dashboard-grid">{renderJobs()}</div>}
                {activeView === 'files' && <div className="dashboard-grid">{renderFiles()}</div>}
                {activeView === 'access' && <div className="dashboard-grid two-col"><div className="helper-panel"><KeyRound size={22} /><h2>Connect Blender</h2><p className="muted">Create an access key, paste it into the RenderSphere add-on preferences, then use the Scene and Output panels to submit jobs.</p></div>{renderAccessKeys()}</div>}
            </section>
        </main>
    );
}
