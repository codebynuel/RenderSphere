import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { toast } from 'react-hot-toast';
import { io } from 'socket.io-client';
import {
    Activity,
    BarChart3,
    CheckCircle2,
    Clock3,
    Copy,
    Download,
    Edit3,
    ExternalLink,
    FileArchive,
    FolderKanban,
    FolderPlus,
    HelpCircle,
    KeyRound,
    Plus,
    ReceiptText,
    RefreshCcw,
    Save,
    Search,
    Trash2,
    WalletCards,
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

const DASHBOARD_TOUR_STORAGE_KEY = 'rendersphere.dashboardProductTour.v1';
const TABLE_PAGE_SIZE = 10;
const PROJECT_ACTION_MENU_GAP = 8;
const PROJECT_ACTION_MENU_HEIGHT = {
    editing: 104,
    default: 184,
};
const DASHBOARD_TOUR_STEPS = [
    {
        id: 'navigation',
        view: 'overview',
        target: '[data-tour="sidebar-nav"]',
        title: 'Navigate your workspace',
        text: 'Use the sidebar to switch between the overview, projects, render queue, rendered files, usage, billing, and access keys without changing the data scope.',
        placement: 'right',
    },
    {
        id: 'access-keys',
        view: 'access',
        target: '[data-tour="access-panel"]',
        title: 'Connect Blender with access keys',
        text: 'Create secure keys for Blender workstations or automation clients. Full tokens are shown once, so copy them immediately after creation.',
        placement: 'left',
    },
    {
        id: 'render-queue',
        view: 'renders',
        target: '[data-tour="render-queue-panel"]',
        title: 'Monitor every render job',
        text: 'Track active work first, search job history, filter by status, refresh the queue, inspect details, cancel active jobs, and download completed output when available.',
        placement: 'left',
    },
    {
        id: 'files',
        view: 'files',
        target: '[data-tour="files-panel"]',
        title: 'Review and download rendered files',
        text: 'Completed deliveries stay searchable by file name, job ID, project, and metadata. Open, copy, or download authenticated file links from here.',
        placement: 'left',
    },
    {
        id: 'projects',
        view: 'projects',
        target: '[data-tour="projects-panel"]',
        title: 'Organize work with projects',
        text: 'Create and rename project containers, then jump to related jobs or files from explicit project actions while the dashboard still shows all data by default.',
        placement: 'left',
    },
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

function clampPage(page, totalItems, pageSize = TABLE_PAGE_SIZE) {
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    const parsedPage = Number(page);
    if (!Number.isFinite(parsedPage)) return 1;
    return Math.min(totalPages, Math.max(1, Math.floor(parsedPage)));
}

function paginateItems(items, page, pageSize = TABLE_PAGE_SIZE) {
    const currentPage = clampPage(page, items.length, pageSize);
    const startIndex = (currentPage - 1) * pageSize;
    const pageItems = items.slice(startIndex, startIndex + pageSize);
    return {
        endItem: items.length === 0 ? 0 : Math.min(items.length, startIndex + pageItems.length),
        items: pageItems,
        page: currentPage,
        pageSize,
        startItem: items.length === 0 ? 0 : startIndex + 1,
        totalItems: items.length,
        totalPages: Math.max(1, Math.ceil(items.length / pageSize)),
    };
}

function PaginationControls({ label, totalItems, page, pageSize = TABLE_PAGE_SIZE, onPageChange }) {
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    const currentPage = clampPage(page, totalItems, pageSize);
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
    const [jobStatusFilter, setJobStatusFilter] = useState('all');
    const [jobSearchQuery, setJobSearchQuery] = useState('');
    const [fileSearchQuery, setFileSearchQuery] = useState('');
    const [activeJobsPage, setActiveJobsPage] = useState(1);
    const [historyJobsPage, setHistoryJobsPage] = useState(1);
    const [filesPage, setFilesPage] = useState(1);
    const [projectsPage, setProjectsPage] = useState(1);
    const [accessKeysPage, setAccessKeysPage] = useState(1);
    const [usageJobsPage, setUsageJobsPage] = useState(1);
    const [accessKeys, setAccessKeys] = useState([]);
    const [files, setFiles] = useState([]);
    const [jobs, setJobs] = useState([]);
    const [projects, setProjects] = useState([]);
    const [expandedJobId, setExpandedJobId] = useState(null);
    const [newKeyName, setNewKeyName] = useState('');
    const [accessKeyDialogOpen, setAccessKeyDialogOpen] = useState(false);
    const [createdAccessKey, setCreatedAccessKey] = useState(null);
    const [pendingDeleteKey, setPendingDeleteKey] = useState(null);
    const [deletingKeyId, setDeletingKeyId] = useState(null);
    const [newProjectName, setNewProjectName] = useState('');
    const [editingProjectId, setEditingProjectId] = useState(null);
    const [editingProjectName, setEditingProjectName] = useState('');
    const [openProjectActionsId, setOpenProjectActionsId] = useState(null);
    const [projectActionsPlacement, setProjectActionsPlacement] = useState('down');
    const [creatingKey, setCreatingKey] = useState(false);
    const [creatingProject, setCreatingProject] = useState(false);
    const [updatingProjectId, setUpdatingProjectId] = useState(null);
    const [loading, setLoading] = useState({ keys: true, files: true, jobs: true, projects: true });
    const [errors, setErrors] = useState({ keys: '', files: '', jobs: '', projects: '' });
    const [tourOpen, setTourOpen] = useState(false);
    const [tourStepIndex, setTourStepIndex] = useState(0);
    const [tourTargetRect, setTourTargetRect] = useState(null);
    const dashboardMainRef = useRef(null);
    const projectActionsMenuRef = useRef(null);
    const projectActionButtonRefs = useRef(new Map());
    const tourDialogRef = useRef(null);

    const getProjectActionPlacement = useCallback((projectId, buttonElement) => {
        if (!buttonElement || typeof window === 'undefined') return 'down';
        const buttonRect = buttonElement.getBoundingClientRect();
        const viewportBottom = window.innerHeight || document.documentElement.clientHeight || 0;
        const containerRect = dashboardMainRef.current?.getBoundingClientRect();
        const lowerBoundary = Math.min(viewportBottom, containerRect?.bottom ?? viewportBottom);
        const upperBoundary = Math.max(0, containerRect?.top ?? 0);
        const estimatedMenuHeight = editingProjectId === projectId ? PROJECT_ACTION_MENU_HEIGHT.editing : PROJECT_ACTION_MENU_HEIGHT.default;
        const availableBelow = lowerBoundary - buttonRect.bottom - PROJECT_ACTION_MENU_GAP;
        const availableAbove = buttonRect.top - upperBoundary - PROJECT_ACTION_MENU_GAP;
        return availableBelow < estimatedMenuHeight && availableAbove > availableBelow ? 'up' : 'down';
    }, [editingProjectId]);

    const updateProjectActionPlacement = useCallback((projectId = openProjectActionsId) => {
        if (!projectId) return;
        const buttonElement = projectActionButtonRefs.current.get(projectId);
        setProjectActionsPlacement(getProjectActionPlacement(projectId, buttonElement));
    }, [getProjectActionPlacement, openProjectActionsId]);

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
        };
    }, [user?.id, loadFiles, loadJobs]);

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

    const visibleJobs = useMemo(() => jobs
        .filter((job) => statusMatches(job, jobStatusFilter))
        .filter((job) => matchesSearch(job, jobSearchQuery)), [jobSearchQuery, jobStatusFilter, jobs]);

    const activeJobs = useMemo(() => visibleJobs.filter((job) => ACTIVE_STATUSES.has(job.status)), [visibleJobs]);
    const historyJobs = useMemo(() => visibleJobs.filter((job) => TERMINAL_STATUSES.has(job.status) || !ACTIVE_STATUSES.has(job.status)), [visibleJobs]);

    const visibleFiles = useMemo(() => files.filter((file) => matchesSearch(file, fileSearchQuery)), [fileSearchQuery, files]);
    const sortedAccessKeys = useMemo(() => sortByCreatedDesc(accessKeys), [accessKeys]);

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
                description: 'Create, rename, and review production containers without scoping the dashboard to one project.',
            },
            renders: {
                eyebrow: 'Render operations',
                title: 'Render queue',
                description: 'Active jobs are prioritized first, with searchable history and status controls.',
            },
            files: {
                eyebrow: 'Delivery library',
                title: 'Rendered files',
                description: 'Find completed outputs by file metadata, project name, scene, or job ID.',
            },
            usage: {
                eyebrow: 'Usage analytics',
                title: 'Usage',
                description: 'Review render volume, delivery output, billable duration, and spend from existing workspace jobs.',
            },
            billing: {
                eyebrow: 'Account billing',
                title: 'Billing',
                description: 'See current credit balance and recharge availability for this account.',
            },
            access: {
                eyebrow: 'Blender connection',
                title: 'Access keys',
                description: 'Create secure keys for Blender workstations and automation clients before submitting jobs.',
            },
        };
        return copy[activeView] || copy.overview;
    }, [activeView]);

    const hasJobFilters = jobStatusFilter !== 'all' || Boolean(jobSearchQuery.trim());
    const hasFileFilters = Boolean(fileSearchQuery.trim());
    const currentTourStep = DASHBOARD_TOUR_STEPS[tourStepIndex] || DASHBOARD_TOUR_STEPS[0];
    const isFirstTourStep = tourStepIndex === 0;
    const isLastTourStep = tourStepIndex === DASHBOARD_TOUR_STEPS.length - 1;

    const markTourDismissed = useCallback(() => {
        try {
            window.localStorage.setItem(DASHBOARD_TOUR_STORAGE_KEY, 'done');
        } catch {
            // Storage may be unavailable in private contexts; still dismiss for this session.
        }
        setTourOpen(false);
        setTourTargetRect(null);
    }, []);

    const restartTour = useCallback(() => {
        setTourStepIndex(0);
        setTourOpen(true);
    }, []);

    const updateTourTarget = useCallback(() => {
        if (!tourOpen || !currentTourStep) return;
        const target = document.querySelector(currentTourStep.target);
        if (!target) {
            setTourTargetRect(null);
            return;
        }
        const rect = target.getBoundingClientRect();
        setTourTargetRect({
            top: rect.top,
            left: rect.left,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
        });
    }, [currentTourStep, tourOpen]);

    const goToNextTourStep = useCallback(() => {
        if (isLastTourStep) {
            markTourDismissed();
            return;
        }
        setTourStepIndex((current) => Math.min(current + 1, DASHBOARD_TOUR_STEPS.length - 1));
    }, [isLastTourStep, markTourDismissed]);

    const goToPreviousTourStep = useCallback(() => {
        setTourStepIndex((current) => Math.max(current - 1, 0));
    }, []);

    useEffect(() => {
        if (authLoading || !user?.id) return undefined;
        try {
            if (window.localStorage.getItem(DASHBOARD_TOUR_STORAGE_KEY) === 'done') return undefined;
        } catch {
            // If storage cannot be read, show the tour for the current session.
        }
        const openTimer = window.setTimeout(() => {
            setTourStepIndex(0);
            setTourOpen(true);
        }, 0);
        return () => window.clearTimeout(openTimer);
    }, [authLoading, user?.id]);

    useEffect(() => {
        if (!tourOpen || !currentTourStep?.view || activeView === currentTourStep.view) return undefined;
        const viewTimer = window.setTimeout(() => {
            setActiveView(currentTourStep.view);
        }, 0);
        return () => window.clearTimeout(viewTimer);
    }, [activeView, currentTourStep, tourOpen]);

    useEffect(() => {
        if (!tourOpen || !currentTourStep) return undefined;

        const dashboardMain = dashboardMainRef.current;
        const focusTimer = window.setTimeout(() => {
            tourDialogRef.current?.focus();
        }, 0);
        const measureTimer = window.setTimeout(updateTourTarget, 0);
        let scrollMeasureTimer;

        const scrollTimer = window.setTimeout(() => {
            const target = document.querySelector(currentTourStep.target);
            target?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
            scrollMeasureTimer = window.setTimeout(updateTourTarget, 180);
        }, 60);

        window.addEventListener('resize', updateTourTarget);
        window.addEventListener('scroll', updateTourTarget, true);
        dashboardMain?.addEventListener('scroll', updateTourTarget, { passive: true });

        return () => {
            window.clearTimeout(focusTimer);
            window.clearTimeout(measureTimer);
            window.clearTimeout(scrollTimer);
            window.clearTimeout(scrollMeasureTimer);
            window.removeEventListener('resize', updateTourTarget);
            window.removeEventListener('scroll', updateTourTarget, true);
            dashboardMain?.removeEventListener('scroll', updateTourTarget);
        };
    }, [activeView, currentTourStep, tourOpen, updateTourTarget]);

    useEffect(() => {
        if (!tourOpen) return undefined;
        const handleKeyDown = (event) => {
            if (event.key === 'Escape') markTourDismissed();
            if (event.key === 'ArrowRight') goToNextTourStep();
            if (event.key === 'ArrowLeft' && !isFirstTourStep) goToPreviousTourStep();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [goToNextTourStep, goToPreviousTourStep, isFirstTourStep, markTourDismissed, tourOpen]);

    useEffect(() => {
        if (!openProjectActionsId) return undefined;

        updateProjectActionPlacement(openProjectActionsId);
        const dashboardMain = dashboardMainRef.current;

        const handlePointerDown = (event) => {
            if (projectActionsMenuRef.current?.contains(event.target)) return;
            setOpenProjectActionsId(null);
        };

        const handleKeyDown = (event) => {
            if (event.key === 'Escape') setOpenProjectActionsId(null);
        };

        const handleViewportChange = () => {
            updateProjectActionPlacement(openProjectActionsId);
        };

        document.addEventListener('pointerdown', handlePointerDown);
        document.addEventListener('keydown', handleKeyDown);
        window.addEventListener('resize', handleViewportChange);
        window.addEventListener('scroll', handleViewportChange, true);
        dashboardMain?.addEventListener('scroll', handleViewportChange, { passive: true });
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown);
            document.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('resize', handleViewportChange);
            window.removeEventListener('scroll', handleViewportChange, true);
            dashboardMain?.removeEventListener('scroll', handleViewportChange);
        };
    }, [openProjectActionsId, updateProjectActionPlacement]);

    const openCreateKeyDialog = () => {
        setNewKeyName('');
        setCreatedAccessKey(null);
        setAccessKeyDialogOpen(true);
    };

    const closeCreateKeyDialog = () => {
        if (creatingKey) return;
        setAccessKeyDialogOpen(false);
        setNewKeyName('');
        setCreatedAccessKey(null);
    };

    const handleCreateKey = async (event) => {
        event.preventDefault();
        const trimmedName = newKeyName.trim();
        if (!trimmedName) return;
        setCreatingKey(true);
        try {
            const data = await api('/api/auth/access-keys', {
                method: 'POST',
                body: JSON.stringify({ name: trimmedName }),
            });
            const createdKey = data.accessKey;
            const listedKey = { ...createdKey, token: null };
            setAccessKeys((current) => sortByCreatedDesc([listedKey, ...current.filter((key) => key.id !== createdKey.id)]));
            setAccessKeysPage(1);
            setCreatedAccessKey(createdKey);
            setNewKeyName('');
            toast.success('Access key created. Copy it now; the full token is shown once.');
        } catch (error) {
            toast.error(error.message || 'Failed to create key');
        } finally {
            setCreatingKey(false);
        }
    };

    const handleDeleteKey = async () => {
        if (!pendingDeleteKey?.id) return;
        setDeletingKeyId(pendingDeleteKey.id);
        try {
            await api(`/api/auth/access-keys/${pendingDeleteKey.id}`, { method: 'DELETE', body: '{}' });
            setAccessKeys((current) => current.filter((key) => key.id !== pendingDeleteKey.id));
            setPendingDeleteKey(null);
            toast.success('Access key revoked.');
        } catch (error) {
            toast.error(error.message || 'Failed to revoke key');
        } finally {
            setDeletingKeyId(null);
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
            setProjectsPage(1);
            setNewProjectName('');
            setActiveView('projects');
            toast.success('Project created.');
        } catch (error) {
            toast.error(error.message || 'Failed to create project');
        } finally {
            setCreatingProject(false);
        }
    };

    const closeProjectActionMenu = () => {
        setOpenProjectActionsId(null);
    };

    const toggleProjectActionMenu = (projectId, buttonElement) => {
        if (openProjectActionsId === projectId) {
            setOpenProjectActionsId(null);
            return;
        }
        setProjectActionsPlacement(getProjectActionPlacement(projectId, buttonElement));
        setOpenProjectActionsId(projectId);
    };

    const startProjectEdit = (project) => {
        closeProjectActionMenu();
        setEditingProjectId(project.id);
        setEditingProjectName(project.name || '');
    };

    const cancelProjectEdit = () => {
        closeProjectActionMenu();
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

    const runProjectMenuAction = (action) => {
        closeProjectActionMenu();
        action();
    };

    const handleDeleteProject = async (project) => {
        if (!window.confirm(`Delete project "${project.name}"? Existing jobs will become unassigned.`)) return;
        try {
            await api(`/api/projects/${project.id}`, { method: 'DELETE', body: '{}' });
            setProjects((current) => current.filter((item) => item.id !== project.id));
            setJobs((current) => current.map((job) => (job.projectId === project.id ? { ...job, projectId: null, project: null } : job)));
            setFiles((current) => current.map((file) => (file.projectId === project.id ? { ...file, projectId: null, project: null } : file)));
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

    const copyToClipboard = async (text, name) => {
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            toast.success(`Copied ${name} to clipboard.`);
        } catch {
            toast.error('Failed to copy to clipboard.');
        }
    };

    const handleJobStatusFilterChange = (value) => {
        setJobStatusFilter(value);
        setActiveJobsPage(1);
        setHistoryJobsPage(1);
    };

    const handleJobSearchChange = (value) => {
        setJobSearchQuery(value);
        setActiveJobsPage(1);
        setHistoryJobsPage(1);
    };

    const handleFileSearchChange = (value) => {
        setFileSearchQuery(value);
        setFilesPage(1);
    };

    const resetJobFilters = () => {
        setJobStatusFilter('all');
        setJobSearchQuery('');
        setActiveJobsPage(1);
        setHistoryJobsPage(1);
    };

    const resetFileFilters = () => {
        setFileSearchQuery('');
        setFilesPage(1);
    };

    const viewProjectRenders = (project) => {
        closeProjectActionMenu();
        setJobStatusFilter('all');
        setJobSearchQuery(project.name || project.id);
        setActiveJobsPage(1);
        setHistoryJobsPage(1);
        setActiveView('renders');
    };

    const viewProjectFiles = (project) => {
        closeProjectActionMenu();
        setFileSearchQuery(project.name || project.id);
        setFilesPage(1);
        setActiveView('files');
    };

    const renderJobRow = (job) => {
        const expanded = expandedJobId === job.jobId;
        return (
            <Fragment key={job.jobId}>
                <tr className="data-row">
                    <td data-label="Job">
                        <div className="table-primary job-id">{job.fileName || job.jobId}</div>
                        <div className="table-meta">
                            <span>{job.jobId}</span>
                            <span>{renderTypeLabel(job)}</span>
                            <span>{outputLabel(job.settings)}</span>
                        </div>
                    </td>
                    <td data-label="Project">{projectLabel(job)}</td>
                    <td data-label="Status"><StatusPill status={job.status} /></td>
                    <td data-label="Progress"><ProgressBar job={job} /></td>
                    <td data-label="Submitted">{formatDate(job.createdAt)}</td>
                    <td data-label="Duration / cost">
                        <div className="table-money">
                            <span>{job.status === 'COMPLETED' ? formatDuration(job.billableSeconds) : 'Pending'}</span>
                            <small>{job.status === 'COMPLETED' ? formatUsd(job.priceUsd) : 'Bill on completion'}</small>
                        </div>
                    </td>
                    <td data-label="Actions">
                        <div className="table-actions">
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
                    </td>
                </tr>
                {expanded && (
                    <tr className="data-row-details">
                        <td colSpan={7}>
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
                        </td>
                    </tr>
                )}
            </Fragment>
        );
    };

    const renderJobTable = (rows, label) => (
        <div className="data-table-wrap queue-table" aria-live="polite">
            <table className="data-table jobs-data-table" aria-label={label}>
                <thead>
                    <tr>
                        <th scope="col">Job / file</th>
                        <th scope="col">Project</th>
                        <th scope="col">Status</th>
                        <th scope="col">Progress</th>
                        <th scope="col">Submitted</th>
                        <th scope="col">Duration / cost</th>
                        <th scope="col">Actions</th>
                    </tr>
                </thead>
                <tbody>{rows.map(renderJobRow)}</tbody>
            </table>
        </div>
    );

    const renderJobSection = (title, description, rows, emptyTitle, emptyText, page, onPageChange) => {
        const pagination = paginateItems(rows, page);
        return (
            <section className="queue-section">
                <div className="queue-section-head">
                    <div>
                        <h3>{title}</h3>
                        <p className="muted">{description}</p>
                    </div>
                    <span className="count-chip">{rows.length}</span>
                </div>
                {rows.length === 0 ? <EmptyState title={emptyTitle} text={emptyText} /> : (
                    <>
                        {renderJobTable(pagination.items, title)}
                        <PaginationControls label={title} totalItems={rows.length} page={pagination.page} onPageChange={onPageChange} />
                    </>
                )}
            </section>
        );
    };

    const renderAccessKeys = () => {
        const accessKeyPagination = paginateItems(sortedAccessKeys, accessKeysPage);
        return (
        <motion.div className="panel dashboard-panel access-management-panel" data-tour="access-panel" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
            <div className="panel-head access-panel-head">
                <div>
                    <h2>Access keys</h2>
                    <p className="muted">Manage Blender and automation credentials without showing full secrets after creation.</p>
                </div>
                <button className="button primary" type="button" onClick={openCreateKeyDialog}>
                    <Plus size={16} /> New access key
                </button>
            </div>

            <div className="access-guidance-card">
                <KeyRound size={18} />
                <div>
                    <strong>Full keys are revealed one time only.</strong>
                    <p>After you create a key, copy it into the Blender add-on preferences before leaving the success screen. Existing keys can only show their saved preview.</p>
                </div>
            </div>

            <div className="access-key-list" aria-live="polite">
                {loading.keys ? <LoadingState label="Loading access keys..." /> : null}
                {!loading.keys && errors.keys ? <ErrorState message={errors.keys} onRetry={loadAccessKeys} /> : null}
                {!loading.keys && !errors.keys && sortedAccessKeys.length === 0 ? (
                    <EmptyState
                        icon={KeyRound}
                        title="No access keys yet"
                        text="Create a named key for each Blender workstation or automation client, then paste the one-time token into that client."
                        action={<button className="button primary" type="button" onClick={openCreateKeyDialog}><Plus size={16} /> Create first key</button>}
                    />
                ) : null}
                {!loading.keys && !errors.keys && sortedAccessKeys.length > 0 ? (
                    <>
                    <div className="data-table-wrap">
                        <table className="data-table access-key-table" aria-label="Access keys">
                            <thead>
                                <tr>
                                    <th scope="col">Key label</th>
                                    <th scope="col">Preview</th>
                                    <th scope="col">Created</th>
                                    <th scope="col">Last used</th>
                                    <th scope="col">Status</th>
                                    <th scope="col">Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {accessKeyPagination.items.map((key) => (
                                    <tr className="data-row" key={key.id}>
                                        <td data-label="Key label"><div className="table-primary">{key.name || 'Access key'}</div></td>
                                        <td data-label="Preview">
                                            <div className="access-key-preview" aria-label="Masked access key preview">
                                                <code>{key.preview || 'rs_live_••••••••••••••••••••'}</code>
                                                <span>Full token hidden</span>
                                            </div>
                                        </td>
                                        <td data-label="Created">{formatDate(key.createdAt)}</td>
                                        <td data-label="Last used">{key.lastUsedAt ? formatDate(key.lastUsedAt) : 'Never used'}</td>
                                        <td data-label="Status"><span className="pill access-status active">Active</span></td>
                                        <td data-label="Actions">
                                            <div className="table-actions">
                                                <button className="button danger compact-button" type="button" onClick={() => setPendingDeleteKey(key)}>
                                                    <Trash2 size={15} /> Revoke
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <PaginationControls label="Access keys" totalItems={sortedAccessKeys.length} page={accessKeyPagination.page} onPageChange={setAccessKeysPage} />
                    </>
                ) : null}
            </div>
        </motion.div>
        );
    };

    const renderCreateKeyDialog = () => {
        if (!accessKeyDialogOpen) return null;
        const hasCreatedToken = Boolean(createdAccessKey?.token);
        return (
            <div className="confirm-overlay access-modal-overlay" role="presentation">
                <motion.section
                    className="confirm-box access-modal"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="access-key-dialog-title"
                    initial={{ opacity: 0, y: 12, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                >
                    <div className="access-modal-head">
                        <div>
                            <p className="eyebrow">Credential setup</p>
                            <h3 id="access-key-dialog-title">{hasCreatedToken ? 'Copy your new access key' : 'Create access key'}</h3>
                        </div>
                        {!hasCreatedToken && (
                            <button className="button compact-button ghost-button" type="button" onClick={closeCreateKeyDialog} disabled={creatingKey} aria-label="Close access key dialog">
                                <X size={15} />
                            </button>
                        )}
                    </div>

                    {hasCreatedToken ? (
                        <div className="access-reveal-state">
                            <div className="access-success-icon"><CheckCircle2 size={22} /></div>
                            <p className="muted">This is the only time RenderSphere will show the full key. Copy it now and store it somewhere safe before continuing.</p>
                            <div className="one-time-key-box">
                                <code>{createdAccessKey.token}</code>
                                <button className="button primary" type="button" onClick={() => copyToClipboard(createdAccessKey.token, createdAccessKey.name || 'access key')}>
                                    <Copy size={16} /> Copy key
                                </button>
                            </div>
                            <div className="access-modal-note">
                                <strong>Next step</strong>
                                <span>Paste this unchanged <code>rs_live_</code> key into the RenderSphere Blender add-on preferences.</span>
                            </div>
                            <button className="button primary access-modal-full-button" type="button" onClick={closeCreateKeyDialog}>
                                I saved it
                            </button>
                        </div>
                    ) : (
                        <form className="access-create-form" onSubmit={handleCreateKey}>
                            <p className="muted">Use a clear label so you can revoke one workstation or automation client without disrupting others.</p>
                            <label>
                                <span>Key label</span>
                                <input
                                    type="text"
                                    maxLength={80}
                                    placeholder="For example: Studio Blender workstation"
                                    value={newKeyName}
                                    onChange={(event) => setNewKeyName(event.target.value)}
                                    disabled={creatingKey}
                                    autoFocus
                                />
                            </label>
                            <div className="access-modal-note warning-note">
                                <strong>One-time secret</strong>
                                <span>The full key will be shown once after creation. Existing keys only show a masked preview.</span>
                            </div>
                            <div className="access-modal-actions">
                                <button className="button" type="button" onClick={closeCreateKeyDialog} disabled={creatingKey}>Cancel</button>
                                <button className="button primary" type="submit" disabled={creatingKey || !newKeyName.trim()}>
                                    <Plus size={16} /> {creatingKey ? 'Creating...' : 'Create key'}
                                </button>
                            </div>
                        </form>
                    )}
                </motion.section>
            </div>
        );
    };

    const renderDeleteKeyDialog = () => {
        if (!pendingDeleteKey) return null;
        const isDeleting = deletingKeyId === pendingDeleteKey.id;
        return (
            <div className="confirm-overlay access-modal-overlay" role="presentation">
                <motion.section
                    className="confirm-box access-modal danger-modal"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="delete-access-key-title"
                    initial={{ opacity: 0, y: 12, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                >
                    <div className="access-modal-head">
                        <div>
                            <p className="eyebrow">Revoke credential</p>
                            <h3 id="delete-access-key-title">Revoke “{pendingDeleteKey.name || 'Access key'}”?</h3>
                        </div>
                        <button className="button compact-button ghost-button" type="button" onClick={() => setPendingDeleteKey(null)} disabled={isDeleting} aria-label="Close revoke confirmation">
                            <X size={15} />
                        </button>
                    </div>
                    <p className="muted">Any Blender workstation or automation client using this key will stop authenticating immediately. This cannot be undone.</p>
                    <div className="access-modal-note">
                        <strong>Key preview</strong>
                        <span>{pendingDeleteKey.preview || 'Preview unavailable'}</span>
                    </div>
                    <div className="access-modal-actions">
                        <button className="button" type="button" onClick={() => setPendingDeleteKey(null)} disabled={isDeleting}>Keep key</button>
                        <button className="button danger" type="button" onClick={handleDeleteKey} disabled={isDeleting}>
                            <Trash2 size={16} /> {isDeleting ? 'Revoking...' : 'Revoke key'}
                        </button>
                    </div>
                </motion.section>
            </div>
        );
    };

    const renderProjects = () => {
        const projectPagination = paginateItems(projects, projectsPage);
        return (
        <motion.div className="panel dashboard-panel full" data-tour="projects-panel" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
            <div className="panel-head project-panel-head">
                <div>
                    <h2>Projects</h2>
                    <p className="muted">Manage production containers and jump into related renders or files from explicit actions.</p>
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

            <div className="project-table-region" aria-live="polite">
                {loading.projects ? <LoadingState label="Loading projects..." /> : null}
                {!loading.projects && errors.projects ? <ErrorState message={errors.projects} onRetry={loadProjects} /> : null}
                {!loading.projects && !errors.projects && projects.length === 0 ? <EmptyState icon={FolderKanban} title="No projects yet" text="Create projects for client work, shot sequences, milestones, experiments, or internal tests." /> : null}
                {!loading.projects && !errors.projects && projects.length > 0 ? (
                    <>
                    <div className="data-table-wrap project-table-wrap">
                        <table className="data-table projects-data-table" aria-label="Projects">
                            <thead>
                                <tr>
                                    <th scope="col">Name</th>
                                    <th scope="col">Jobs</th>
                                    <th scope="col">Delivered</th>
                                    <th scope="col">Updated</th>
                                    <th scope="col">Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {projectPagination.items.map((project) => {
                                    const jobCount = stats.jobsByProject.get(project.id) || project.jobCount || 0;
                                    const fileCount = stats.filesByProject.get(project.id) || 0;
                                    const isEditing = editingProjectId === project.id;
                                    const actionsMenuOpen = openProjectActionsId === project.id;
                                    const editFormId = `project-edit-${project.id}`;
                                    return (
                                        <tr className="data-row" key={project.id}>
                                            <td data-label="Name">
                                                {isEditing ? (
                                                    <form id={editFormId} className="project-edit-form" onSubmit={(event) => handleUpdateProject(event, project)}>
                                                        <input
                                                            type="text"
                                                            maxLength={80}
                                                            value={editingProjectName}
                                                            onChange={(event) => setEditingProjectName(event.target.value)}
                                                            disabled={updatingProjectId === project.id}
                                                            autoFocus
                                                        />
                                                    </form>
                                                ) : (
                                                    <div>
                                                        <div className="table-primary">{project.name}</div>
                                                        <code className="inline-code">{project.id}</code>
                                                    </div>
                                                )}
                                            </td>
                                            <td data-label="Jobs"><strong>{jobCount}</strong></td>
                                            <td data-label="Delivered">
                                                <div className="table-metric-stack">
                                                    <span><strong>{fileCount}</strong> files</span>
                                                    <span>{jobCount ? Math.round((fileCount / jobCount) * 100) : 0}% complete</span>
                                                </div>
                                            </td>
                                            <td data-label="Updated">{formatDate(project.updatedAt || project.createdAt)}</td>
                                            <td data-label="Actions">
                                                <div className="project-actions-menu" ref={actionsMenuOpen ? projectActionsMenuRef : null}>
                                                    <button
                                                        ref={(node) => {
                                                            if (node) projectActionButtonRefs.current.set(project.id, node);
                                                            else projectActionButtonRefs.current.delete(project.id);
                                                        }}
                                                        className="button compact-button project-actions-toggle"
                                                        type="button"
                                                        aria-haspopup="menu"
                                                        aria-expanded={actionsMenuOpen}
                                                        aria-controls={`project-actions-${project.id}`}
                                                        aria-label={`Project actions for ${project.name}`}
                                                        onClick={(event) => toggleProjectActionMenu(project.id, event.currentTarget)}
                                                    >
                                                        <span aria-hidden="true">⋯</span>
                                                    </button>
                                                    {actionsMenuOpen && (
                                                        <div className={`project-actions-dropdown placement-${projectActionsPlacement}`} id={`project-actions-${project.id}`} role="menu" aria-label={`Actions for ${project.name}`}>
                                                            {isEditing ? (
                                                                <>
                                                                    <button
                                                                        className="project-menu-item primary"
                                                                        type="submit"
                                                                        form={editFormId}
                                                                        role="menuitem"
                                                                        disabled={updatingProjectId === project.id || !editingProjectName.trim()}
                                                                    >
                                                                        <Save size={15} /> Save rename
                                                                    </button>
                                                                    <button className="project-menu-item" type="button" role="menuitem" onClick={cancelProjectEdit}>
                                                                        <X size={15} /> Cancel rename
                                                                    </button>
                                                                </>
                                                            ) : (
                                                                <>
                                                                    <button className="project-menu-item" type="button" role="menuitem" onClick={() => viewProjectRenders(project)}>View jobs</button>
                                                                    <button className="project-menu-item" type="button" role="menuitem" onClick={() => viewProjectFiles(project)}>View files</button>
                                                                    <button className="project-menu-item" type="button" role="menuitem" onClick={() => startProjectEdit(project)}>
                                                                        <Edit3 size={15} /> Rename
                                                                    </button>
                                                                    <button className="project-menu-item danger" type="button" role="menuitem" onClick={() => runProjectMenuAction(() => handleDeleteProject(project))}>
                                                                        <Trash2 size={15} /> Delete
                                                                    </button>
                                                                </>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                    <PaginationControls label="Projects" totalItems={projects.length} page={projectPagination.page} onPageChange={setProjectsPage} />
                    </>
                ) : null}
            </div>
        </motion.div>
        );
    };

    const renderJobs = ({ overview = false } = {}) => {
        const previewJobs = overview ? jobs.slice(0, 6) : null;
        return (
            <motion.div className="panel dashboard-panel full" data-tour={overview ? 'queue-snapshot-panel' : 'render-queue-panel'} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
                <div className="panel-head queue-panel-head">
                    <div>
                        <h2>{overview ? 'Queue snapshot' : 'Render queue'}</h2>
                        <p className="muted">{overview ? 'Most recent work across the workspace.' : 'Active jobs stay above historical outcomes with explicit filtering.'}</p>
                    </div>
                    <button className="button" type="button" onClick={loadJobs} disabled={loading.jobs}>
                        <RefreshCcw size={16} className={loading.jobs ? 'spin' : ''} /> Refresh jobs
                    </button>
                </div>

                {!overview && (
                    <div className="list-toolbar list-toolbar-simple">
                        <label>
                            <span>Status</span>
                            <select value={jobStatusFilter} onChange={(event) => handleJobStatusFilterChange(event.target.value)}>
                                {STATUS_OPTIONS.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
                            </select>
                        </label>
                        <SearchBox value={jobSearchQuery} onChange={handleJobSearchChange} placeholder="Search job, scene, camera, project..." />
                        <button className="button" type="button" onClick={resetJobFilters} disabled={!hasJobFilters}>Clear filters</button>
                    </div>
                )}

                <div className="filter-summary">
                    <span>{overview ? `${previewJobs.length} of ${jobs.length} recent jobs` : `${visibleJobs.length} matching jobs`}</span>
                    {!overview && <span>{activeJobs.length} active / {historyJobs.length} history</span>}
                </div>

                {loading.jobs ? <LoadingState label="Loading render queue..." /> : null}
                {!loading.jobs && errors.jobs ? <ErrorState message={errors.jobs} onRetry={loadJobs} /> : null}
                {!loading.jobs && !errors.jobs && overview && (
                    previewJobs.length === 0
                        ? <EmptyState icon={Activity} title="No render jobs yet" text="Submit a render from Blender and it will appear here with real-time progress." />
                        : renderJobTable(previewJobs, 'Queue snapshot')
                )}
                {!loading.jobs && !errors.jobs && !overview && (
                    visibleJobs.length === 0 ? (
                        <EmptyState
                            icon={Activity}
                            title="No jobs match these controls"
                            text="Adjust the status or search query to find submitted render jobs."
                            action={<button className="button" type="button" onClick={resetJobFilters}>Clear filters</button>}
                        />
                    ) : (
                        <div className="queue-stack">
                            {renderJobSection('Active queue', 'Submitted, queued, and running renders ordered by newest first.', activeJobs, 'No active jobs', 'Running work will be pinned here as soon as it is submitted.', activeJobsPage, setActiveJobsPage)}
                            {renderJobSection('History', 'Completed, failed, cancelled, and archived outcomes.', historyJobs, 'No history in this view', 'Completed and terminal jobs appear here after processing.', historyJobsPage, setHistoryJobsPage)}
                        </div>
                    )
                )}
            </motion.div>
        );
    };

    const renderFiles = ({ overview = false } = {}) => {
        const previewFiles = overview ? files.slice(0, 5) : visibleFiles;
        const filePagination = paginateItems(visibleFiles, filesPage);
        const tableFiles = overview ? previewFiles : filePagination.items;
        return (
            <motion.div className="panel dashboard-panel full" data-tour={overview ? 'latest-files-panel' : 'files-panel'} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
                <div className="panel-head queue-panel-head">
                    <div>
                        <h2>{overview ? 'Latest deliveries' : 'Rendered files'}</h2>
                        <p className="muted">Completed outputs are served through authenticated downloads.</p>
                    </div>
                    <button className="button" type="button" onClick={loadFiles} disabled={loading.files}>
                        <RefreshCcw size={16} className={loading.files ? 'spin' : ''} /> Refresh files
                    </button>
                </div>

                {!overview && (
                    <div className="list-toolbar file-toolbar list-toolbar-simple">
                        <SearchBox value={fileSearchQuery} onChange={handleFileSearchChange} placeholder="Search file, job ID, project..." />
                        <button className="button" type="button" onClick={resetFileFilters} disabled={!hasFileFilters}>Clear filters</button>
                    </div>
                )}

                <div className="filter-summary">
                    <span>{overview ? `${previewFiles.length} latest files` : `${visibleFiles.length} matching files`}</span>
                </div>

                {loading.files ? <LoadingState label="Loading rendered files..." /> : null}
                {!loading.files && errors.files ? <ErrorState message={errors.files} onRetry={loadFiles} /> : null}
                {!loading.files && !errors.files && previewFiles.length === 0 ? (
                    <EmptyState
                        icon={FileArchive}
                        title={overview ? 'No delivered files yet' : 'No files match this search'}
                        text={overview ? 'Completed jobs with result files will show download links here.' : 'Adjust the search query to find rendered outputs.'}
                        action={!overview && hasFileFilters ? <button className="button" type="button" onClick={resetFileFilters}>Clear filters</button> : null}
                    />
                ) : null}
                {!loading.files && !errors.files && previewFiles.length > 0 ? (
                    <div className="data-table-wrap file-library">
                        <table className="data-table files-data-table" aria-label={overview ? 'Latest deliveries' : 'Rendered files'}>
                            <thead>
                                <tr>
                                    <th scope="col">File</th>
                                    <th scope="col">Project</th>
                                    <th scope="col">Created</th>
                                    <th scope="col">Type</th>
                                    <th scope="col">Render metrics</th>
                                    <th scope="col">Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {tableFiles.map((file) => {
                                    const absoluteUrl = file.downloadUrl ? new URL(file.downloadUrl, window.location.origin).href : '';
                                    return (
                                        <tr className="data-row" key={file.id || file.jobId || file.resultKey}>
                                            <td data-label="File">
                                                <div className="table-primary">{file.fileName || file.resultKey}</div>
                                                <div className="table-meta"><span>{file.jobId}</span></div>
                                            </td>
                                            <td data-label="Project">{projectLabel(file)}</td>
                                            <td data-label="Created">{formatDate(file.completedAt || file.createdAt)}</td>
                                            <td data-label="Type">{file.outputFormat || file.contentType || 'Output'}</td>
                                            <td data-label="Render metrics">
                                                <div className="table-metric-stack">
                                                    <span>{formatDuration(file.billableSeconds)} render time</span>
                                                    <span>{formatUsd(file.priceUsd)} deducted</span>
                                                </div>
                                            </td>
                                            <td data-label="Actions">
                                                <div className="table-actions">
                                                    {file.downloadUrl ? (
                                                        <a className="link-button compact-button" href={file.downloadUrl} target="_blank" rel="noopener noreferrer">
                                                            <ExternalLink size={15} /> Open
                                                        </a>
                                                    ) : (
                                                        <button className="button compact-button" disabled>Open</button>
                                                    )}
                                                    <button className="button compact-button" type="button" disabled={!file.downloadUrl} onClick={() => copyToClipboard(absoluteUrl, 'file link')}>
                                                        <Copy size={15} /> Copy link
                                                    </button>
                                                    {file.downloadUrl && (
                                                        <a className="link-button compact-button" href={file.downloadUrl} download>
                                                            <Download size={15} /> Download
                                                        </a>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                ) : null}
                {!overview && !loading.files && !errors.files && previewFiles.length > 0 ? (
                    <PaginationControls label="Rendered files" totalItems={visibleFiles.length} page={filePagination.page} onPageChange={setFilesPage} />
                ) : null}
            </motion.div>
        );
    };

    const renderUsage = () => {
        const usagePagination = paginateItems(jobs, usageJobsPage);
        return (
            <motion.div className="panel dashboard-panel full usage-panel" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
                <div className="panel-head usage-panel-head">
                    <div>
                        <h2>Usage details</h2>
                        <p className="muted">Aggregated from your render jobs and delivered files across the whole workspace.</p>
                    </div>
                    <button className="button" type="button" onClick={loadAll} disabled={loading.jobs || loading.files}>
                        <RefreshCcw size={16} className={loading.jobs || loading.files ? 'spin' : ''} /> Refresh usage
                    </button>
                </div>

                <div className="dashboard-metrics-grid usage-metrics-grid">
                    <MetricCard icon={Activity} label="Total renders" value={stats.totalJobs} detail={`${stats.activeJobs} active now`} tone="active" />
                    <MetricCard icon={CheckCircle2} label="Completed" value={stats.completedJobs} detail={`${stats.totalFiles} delivered files`} tone="good" />
                    <MetricCard icon={XCircle} label="Failed / cancelled" value={stats.failedJobs + stats.cancelledJobs} detail={`${stats.failedJobs} failed / ${stats.cancelledJobs} cancelled`} tone="danger" />
                    <MetricCard icon={Clock3} label="Billable duration" value={formatDuration(stats.billableSeconds)} detail="Recorded on completed billed jobs" />
                    <MetricCard icon={WalletCards} label="Total spend" value={formatUsd(stats.totalSpend)} detail="Calculated from existing job costs" />
                </div>

                <section className="queue-section usage-breakdown-section">
                    <div className="queue-section-head">
                        <div>
                            <h3>Render usage ledger</h3>
                            <p className="muted">Every render remains visible here without project-scoped filtering.</p>
                        </div>
                        <span className="count-chip">{jobs.length}</span>
                    </div>

                    {loading.jobs ? <LoadingState label="Loading usage details..." /> : null}
                    {!loading.jobs && errors.jobs ? <ErrorState message={errors.jobs} onRetry={loadJobs} /> : null}
                    {!loading.jobs && !errors.jobs && jobs.length === 0 ? (
                        <EmptyState icon={BarChart3} title="No usage recorded yet" text="Submitted render jobs will appear here with status, delivery, duration, and cost details." />
                    ) : null}
                    {!loading.jobs && !errors.jobs && jobs.length > 0 ? (
                        <>
                            <div className="data-table-wrap usage-table-wrap">
                                <table className="data-table usage-data-table" aria-label="Render usage details">
                                    <thead>
                                        <tr>
                                            <th scope="col">Render</th>
                                            <th scope="col">Project</th>
                                            <th scope="col">Status</th>
                                            <th scope="col">Delivery</th>
                                            <th scope="col">Billable duration</th>
                                            <th scope="col">Spend</th>
                                            <th scope="col">Submitted / completed</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {usagePagination.items.map((job) => (
                                            <tr className="data-row" key={job.jobId}>
                                                <td data-label="Render">
                                                    <div className="table-primary job-id">{job.fileName || job.jobId}</div>
                                                    <div className="table-meta">
                                                        <span>{job.jobId}</span>
                                                        <span>{renderTypeLabel(job)}</span>
                                                    </div>
                                                </td>
                                                <td data-label="Project">{projectLabel(job)}</td>
                                                <td data-label="Status"><StatusPill status={job.status} /></td>
                                                <td data-label="Delivery">{job.resultKey ? 'Delivered file' : job.status === 'COMPLETED' ? 'Completed without file' : 'Not delivered yet'}</td>
                                                <td data-label="Billable duration">{job.billedAt || job.status === 'COMPLETED' ? formatDuration(job.billableSeconds) : 'Pending'}</td>
                                                <td data-label="Spend">{job.billedAt || job.status === 'COMPLETED' ? formatUsd(job.priceUsd) : 'Pending'}</td>
                                                <td data-label="Submitted / completed">
                                                    <div className="table-metric-stack">
                                                        <span>Submitted {formatDate(job.createdAt)}</span>
                                                        <span>Completed {job.completedAt ? formatDate(job.completedAt) : '—'}</span>
                                                    </div>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            <PaginationControls label="Usage details" totalItems={jobs.length} page={usagePagination.page} onPageChange={setUsageJobsPage} />
                        </>
                    ) : null}
                </section>
            </motion.div>
        );
    };

    const renderBilling = () => (
        <motion.div className="panel dashboard-panel full billing-panel" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
            <div className="panel-head billing-panel-head">
                <div>
                    <h2>Billing</h2>
                    <p className="muted">Current credit balance is sourced from your account. Recharge records are shown only when an API exists.</p>
                </div>
                <button className="button" type="button" onClick={loadAll} disabled={loading.jobs || loading.files}>
                    <RefreshCcw size={16} className={loading.jobs || loading.files ? 'spin' : ''} /> Refresh billing
                </button>
            </div>

            <div className="dashboard-metrics-grid billing-metrics-grid">
                <MetricCard icon={WalletCards} label="Current credit balance" value={formatUsd(user.starterBalanceUsd)} detail="Available account credit" tone="good" />
                <MetricCard icon={ReceiptText} label="Render spend" value={formatUsd(stats.totalSpend)} detail={`${formatDuration(stats.billableSeconds)} billed from completed jobs`} />
                <MetricCard icon={CheckCircle2} label="Billed renders" value={stats.completedJobs} detail={`${stats.totalFiles} delivered files`} tone="active" />
            </div>

            <section className="queue-section billing-summary-section">
                <div className="queue-section-head">
                    <div>
                        <h3>Account credit summary</h3>
                        <p className="muted">Credit and render deductions are based on existing account and job fields.</p>
                    </div>
                </div>
                <div className="data-table-wrap billing-table-wrap">
                    <table className="data-table billing-data-table" aria-label="Account credit summary">
                        <thead>
                            <tr>
                                <th scope="col">Item</th>
                                <th scope="col">Amount</th>
                                <th scope="col">Source</th>
                                <th scope="col">Last updated</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr className="data-row">
                                <td data-label="Item"><div className="table-primary">Current credit balance</div></td>
                                <td data-label="Amount">{formatUsd(user.starterBalanceUsd)}</td>
                                <td data-label="Source">Account field starterBalanceUsd</td>
                                <td data-label="Last updated">{formatDate(user.updatedAt || user.createdAt)}</td>
                            </tr>
                            <tr className="data-row">
                                <td data-label="Item"><div className="table-primary">Total render deductions</div></td>
                                <td data-label="Amount">{formatUsd(stats.totalSpend)}</td>
                                <td data-label="Source">Completed job costs</td>
                                <td data-label="Last updated">{jobs[0]?.createdAt ? formatDate(jobs[0].createdAt) : 'No jobs yet'}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </section>

            <section className="queue-section recharge-history-section">
                <div className="queue-section-head">
                    <div>
                        <h3>Recharge history</h3>
                        <p className="muted">No recharge or payment records are exposed by the current backend schema or APIs.</p>
                    </div>
                    <span className="count-chip">0</span>
                </div>
                <EmptyState
                    icon={ReceiptText}
                    title="No recharge history available yet"
                    text="This account currently exposes credit balance and render deductions only. Recharge records will appear here when a billing/recharge API is added."
                />
            </section>
        </motion.div>
    );

    const getTourPanelStyle = () => {
        if (!tourTargetRect || typeof window === 'undefined' || window.innerWidth <= 760) return {};
        const margin = 18;
        const panelWidth = Math.min(360, window.innerWidth - 32);
        const maxTop = Math.max(16, window.innerHeight - 290);
        const top = Math.min(Math.max(16, tourTargetRect.top), maxTop);
        const preferredLeft = currentTourStep.placement === 'right'
            ? tourTargetRect.right + margin
            : tourTargetRect.left - panelWidth - margin;
        const left = Math.min(Math.max(16, preferredLeft), window.innerWidth - panelWidth - 16);
        return { top, left, width: panelWidth };
    };

    const renderProductTour = () => {
        if (!tourOpen || !currentTourStep) return null;
        const spotlightStyle = tourTargetRect ? {
            top: Math.max(8, tourTargetRect.top - 8),
            left: Math.max(8, tourTargetRect.left - 8),
            width: Math.min(window.innerWidth - 16, tourTargetRect.width + 16),
            height: Math.min(window.innerHeight - 16, tourTargetRect.height + 16),
        } : undefined;
        const spotlightBounds = spotlightStyle ? {
            ...spotlightStyle,
            right: Math.min(window.innerWidth - 8, spotlightStyle.left + spotlightStyle.width),
            bottom: Math.min(window.innerHeight - 8, spotlightStyle.top + spotlightStyle.height),
        } : null;
        const backdropSegments = spotlightBounds ? [
            { top: 0, left: 0, right: 0, height: spotlightBounds.top },
            { top: spotlightBounds.bottom, left: 0, right: 0, bottom: 0 },
            { top: spotlightBounds.top, left: 0, width: spotlightBounds.left, height: spotlightBounds.height },
            { top: spotlightBounds.top, left: spotlightBounds.right, right: 0, height: spotlightBounds.height },
        ] : [];

        return (
            <div className="product-tour" aria-live="polite">
                {spotlightBounds ? backdropSegments.map((segmentStyle, index) => (
                    <div className="product-tour-backdrop product-tour-backdrop-segment" style={segmentStyle} aria-hidden="true" key={index} />
                )) : <div className="product-tour-backdrop" aria-hidden="true" />}
                {spotlightStyle && <div className="product-tour-spotlight" style={spotlightStyle} aria-hidden="true" />}
                <motion.section
                    className={`product-tour-card placement-${currentTourStep.placement}`}
                    ref={tourDialogRef}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="product-tour-title"
                    aria-describedby="product-tour-copy"
                    tabIndex={-1}
                    style={getTourPanelStyle()}
                    initial={{ opacity: 0, y: 10, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ duration: 0.18 }}
                >
                    <div className="product-tour-topline">
                        <span>Product tour</span>
                        <button className="button compact-button ghost-button" type="button" onClick={markTourDismissed}>Skip</button>
                    </div>
                    <h2 id="product-tour-title">{currentTourStep.title}</h2>
                    <p id="product-tour-copy">{currentTourStep.text}</p>
                    <div className="product-tour-progress" aria-label={`Step ${tourStepIndex + 1} of ${DASHBOARD_TOUR_STEPS.length}`}>
                        {DASHBOARD_TOUR_STEPS.map((step, index) => (
                            <span className={index === tourStepIndex ? 'active' : ''} key={step.id} />
                        ))}
                    </div>
                    <div className="product-tour-actions">
                        <button className="button" type="button" onClick={goToPreviousTourStep} disabled={isFirstTourStep}>Back</button>
                        <span>{tourStepIndex + 1} / {DASHBOARD_TOUR_STEPS.length}</span>
                        <button className="button primary" type="button" onClick={goToNextTourStep}>{isLastTourStep ? 'Done' : 'Next'}</button>
                    </div>
                    <p className="product-tour-hint">Use ArrowLeft, ArrowRight, or Escape to navigate.</p>
                </motion.section>
            </div>
        );
    };

    if (authLoading || !user) return null;

    return (
        <main className="dashboard-page">
            <Sidebar
                activeView={activeView}
                onChangeView={setActiveView}
            />

            <section className="dashboard-main" ref={dashboardMainRef}>
                <div className="dashboard-titlebar operations-titlebar">
                    <div>
                        <p className="eyebrow">{viewMeta.eyebrow}</p>
                        <h1>{viewMeta.title}</h1>
                        <p className="muted">{viewMeta.description}</p>
                    </div>
                    <div className="titlebar-actions">
                        <button className="button" type="button" onClick={restartTour}>
                            <HelpCircle size={16} /> Tour
                        </button>
                        <button className="button" type="button" onClick={loadAll}>
                            <RefreshCcw size={16} /> Refresh all
                        </button>
                    </div>
                </div>

                {activeView === 'overview' && (
                    <div className="dashboard-metrics-grid operations-metrics">
                        <MetricCard icon={FolderKanban} label="Projects" value={projects.length} detail={`${stats.unassignedJobs} unassigned jobs`} />
                        <MetricCard icon={Activity} label="Active jobs" value={stats.activeJobs} detail={`${stats.totalJobs} total jobs`} tone="active" />
                        <MetricCard icon={CheckCircle2} label="Completed" value={stats.completedJobs} detail={`${stats.totalFiles} downloadable files`} tone="good" />
                        <MetricCard icon={XCircle} label="Failed" value={stats.failedJobs} detail={`${stats.cancelledJobs} cancelled`} tone="danger" />
                        <MetricCard icon={Clock3} label="Spend" value={formatUsd(stats.totalSpend)} detail={`${formatDuration(stats.billableSeconds)} billed / Balance ${formatUsd(user.starterBalanceUsd)}`} />
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
                {activeView === 'usage' && <div className="dashboard-grid operations-grid">{renderUsage()}</div>}
                {activeView === 'billing' && <div className="dashboard-grid operations-grid">{renderBilling()}</div>}
                {activeView === 'access' && <div className="dashboard-grid operations-grid">{renderAccessKeys()}</div>}
            </section>
            {renderCreateKeyDialog()}
            {renderDeleteKeyDialog()}
            {renderProductTour()}
        </main>
    );
}
