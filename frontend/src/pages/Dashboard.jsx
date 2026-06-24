import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
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
    Eye,
    FileArchive,
    FileUp,
    FolderKanban,
    FolderPlus,
    KeyRound,
    Menu,
    Plus,
    ReceiptText,
    RefreshCcw,
    Save,
    Search,
    Trash2,
    Upload,
    WalletCards,
    X,
    XCircle,
} from 'lucide-react';
import Sidebar from '../components/Sidebar';
import { api, formatDate, formatDuration, formatUsd } from '../utils/api';
import { useAuth } from '../context/AuthContext';

const ACTIVE_STATUSES = new Set(['SUBMITTED', 'DISPATCHING', 'IN_QUEUE', 'IN_PROGRESS', 'RUNNING']);
const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'DISPATCH_FAILED']);
const STATUS_OPTIONS = [
    { id: 'all', label: 'All statuses' },
    { id: 'active', label: 'Active' },
    { id: 'COMPLETED', label: 'Completed' },
    { id: 'FAILED', label: 'Failed' },
    { id: 'CANCELLED', label: 'Cancelled' },
];

const DASHBOARD_TOUR_STORAGE_KEY = 'rendersphere.dashboardProductTour.v1';
const TABLE_PAGE_SIZE = 10;
const SERVER_PAGE_SIZE = 50;
const ACTION_MENU_GAP = 8;
const ACTION_MENU_DEFAULT_HEIGHT = 160;
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

function formatMoney(value, currency = 'USD') {
    const normalizedCurrency = String(currency || 'USD').toUpperCase();
    if (normalizedCurrency === 'USD') return formatUsd(value);
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: normalizedCurrency }).format(Number(value || 0));
}

function decimalPlaces(value) {
    const [, fraction = ''] = String(value || '').trim().split('.');
    return fraction.length;
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
    const [billingPage, setBillingPage] = useState(1);
    const [accessKeys, setAccessKeys] = useState([]);
    const [files, setFiles] = useState([]);
    const [jobs, setJobs] = useState([]);
    const [projects, setProjects] = useState([]);
    const [prepaidPackages, setPrepaidPackages] = useState([]);
    const [customTopUpConfig, setCustomTopUpConfig] = useState(null);
    const [nowpaymentsConfig, setNowpaymentsConfig] = useState(null);
    const [customTopUpAmount, setCustomTopUpAmount] = useState('');
    const [customNpAmount, setCustomNpAmount] = useState('');
    const [recharges, setRecharges] = useState([]);
    const [expandedJobId, setExpandedJobId] = useState(null);
    const [newKeyName, setNewKeyName] = useState('');
    const [accessKeyDialogOpen, setAccessKeyDialogOpen] = useState(false);
    const [createdAccessKey, setCreatedAccessKey] = useState(null);
    const [pendingDeleteKey, setPendingDeleteKey] = useState(null);
    const [deletingKeyId, setDeletingKeyId] = useState(null);
    const [newProjectName, setNewProjectName] = useState('');
    const [editingProjectId, setEditingProjectId] = useState(null);
    const [editingProjectName, setEditingProjectName] = useState('');
    const [openActionMenuId, setOpenActionMenuId] = useState(null);
    const [actionMenuPlacement, setActionMenuPlacement] = useState('down');
    const [creatingKey, setCreatingKey] = useState(false);
    const [creatingProject, setCreatingProject] = useState(false);
    const [updatingProjectId, setUpdatingProjectId] = useState(null);
    const [creatingTopUpPackageId, setCreatingTopUpPackageId] = useState(null);
    const [creatingCustomTopUp, setCreatingCustomTopUp] = useState(false);
    const [creatingNpPackageId] = useState(null);
    const [creatingCustomNp, setCreatingCustomNp] = useState(false);
    const [capturingOrderId, setCapturingOrderId] = useState(null);
    const [submitFile, setSubmitFile] = useState(null);
    const [submitUploading, setSubmitUploading] = useState(false);
    const [submitUploadProgress, setSubmitUploadProgress] = useState(0);
    const [submitFileKey, setSubmitFileKey] = useState(null);
    const [submitEngine, setSubmitEngine] = useState('CYCLES');
    const [submitSamples, setSubmitSamples] = useState(256);
    const [submitResolution, setSubmitResolution] = useState(100);
    const [submitAnimation, setSubmitAnimation] = useState(false);
    const [submitStartFrame, setSubmitStartFrame] = useState(1);
    const [submitEndFrame, setSubmitEndFrame] = useState(1);
    const [submitDenoiser, setSubmitDenoiser] = useState('NONE');
    const [submitFormat, setSubmitFormat] = useState('PNG');
    const [submitProjectId, setSubmitProjectId] = useState('');
    const [submitGpuDevice, setSubmitGpuDevice] = useState('AUTO');
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState('');
    const [loading, setLoading] = useState({ keys: true, files: true, jobs: true, projects: true, billingPackages: true, billingHistory: true });
    const [errors, setErrors] = useState({ keys: '', files: '', jobs: '', projects: '', billingPackages: '', billingHistory: '' });
    const [paginationMeta, setPaginationMeta] = useState({ keys: null, files: null, jobs: null, projects: null, billingHistory: null });
    const [tourOpen, setTourOpen] = useState(false);
    const [tourStepIndex, setTourStepIndex] = useState(0);
    const dashboardMainRef = useRef(null);
    const actionMenuRef = useRef(null);
    const actionMenuButtonRefs = useRef(new Map());
    const actionMenuHeightsRef = useRef(new Map());
    const tourDialogRef = useRef(null);
    const initialLoadUserIdRef = useRef(null);
    const jobFilterLoadRef = useRef({ userId: null, status: jobStatusFilter, search: jobSearchQuery });
    const fileFilterLoadRef = useRef({ userId: null, search: fileSearchQuery });
    const paypalReturnHandledRef = useRef(null);

    const getActionMenuPlacement = useCallback((menuId, buttonElement) => {
        if (!buttonElement || typeof window === 'undefined') return 'down';
        const buttonRect = buttonElement.getBoundingClientRect();
        const viewportBottom = window.innerHeight || document.documentElement.clientHeight || 0;
        const containerRect = dashboardMainRef.current?.getBoundingClientRect();
        const lowerBoundary = Math.min(viewportBottom, containerRect?.bottom ?? viewportBottom);
        const upperBoundary = Math.max(0, containerRect?.top ?? 0);
        const estimatedMenuHeight = actionMenuHeightsRef.current.get(menuId) || ACTION_MENU_DEFAULT_HEIGHT;
        const availableBelow = lowerBoundary - buttonRect.bottom - ACTION_MENU_GAP;
        const availableAbove = buttonRect.top - upperBoundary - ACTION_MENU_GAP;
        return availableBelow < estimatedMenuHeight && availableAbove > availableBelow ? 'up' : 'down';
    }, []);

    const updateActionMenuPlacement = useCallback((menuId = openActionMenuId) => {
        if (!menuId) return;
        const buttonElement = actionMenuButtonRefs.current.get(menuId);
        setActionMenuPlacement(getActionMenuPlacement(menuId, buttonElement));
    }, [getActionMenuPlacement, openActionMenuId]);

    useEffect(() => {
        if (!authLoading && !user) navigate('/auth');
    }, [user, authLoading, navigate]);

    const setLoadingFlag = useCallback((key, value) => {
        setLoading((current) => ({ ...current, [key]: value }));
    }, []);

    const setErrorFlag = useCallback((key, value) => {
        setErrors((current) => ({ ...current, [key]: value }));
    }, []);

    const loadAccessKeys = useCallback(async ({ page = 1, append = false } = {}) => {
        setLoadingFlag('keys', true);
        setErrorFlag('keys', '');
        try {
            const data = await api(`/api/auth/access-keys?page=${page}&pageSize=${SERVER_PAGE_SIZE}`);
            setAccessKeys((current) => (append ? sortByCreatedDesc([...current, ...(data.accessKeys || [])]) : data.accessKeys || []));
            setPaginationMeta((current) => ({ ...current, keys: data.pagination || null }));
        } catch (error) {
            setErrorFlag('keys', error.message || 'Failed to load access keys');
            toast.error(`Failed to load access keys: ${error.message}`);
        } finally {
            setLoadingFlag('keys', false);
        }
    }, [setErrorFlag, setLoadingFlag]);

    const loadProjects = useCallback(async ({ page = 1, append = false } = {}) => {
        setLoadingFlag('projects', true);
        setErrorFlag('projects', '');
        try {
            const data = await api(`/api/projects?page=${page}&pageSize=${SERVER_PAGE_SIZE}`);
            setProjects((current) => (append ? [...current, ...(data.projects || [])] : data.projects || []));
            setPaginationMeta((current) => ({ ...current, projects: data.pagination || null }));
        } catch (error) {
            setErrorFlag('projects', error.message || 'Failed to load projects');
            toast.error(`Failed to load projects: ${error.message}`);
        } finally {
            setLoadingFlag('projects', false);
        }
    }, [setErrorFlag, setLoadingFlag]);

    const loadFiles = useCallback(async ({ page = 1, append = false } = {}) => {
        setLoadingFlag('files', true);
        setErrorFlag('files', '');
        try {
            const params = new URLSearchParams({ page: String(page), pageSize: String(SERVER_PAGE_SIZE) });
            if (fileSearchQuery.trim()) params.set('search', fileSearchQuery.trim());
            const data = await api(`/api/rendered-files?${params.toString()}`);
            setFiles((current) => (append ? [...current, ...(data.files || [])] : data.files || []));
            setPaginationMeta((current) => ({ ...current, files: data.pagination || null }));
            if (data.user) setUser(data.user);
        } catch (error) {
            setErrorFlag('files', error.message || 'Failed to load files');
            toast.error(`Failed to load files: ${error.message}`);
        } finally {
            setLoadingFlag('files', false);
        }
    }, [fileSearchQuery, setErrorFlag, setLoadingFlag, setUser]);

    const loadJobs = useCallback(async ({ page = 1, append = false } = {}) => {
        setLoadingFlag('jobs', true);
        setErrorFlag('jobs', '');
        try {
            const params = new URLSearchParams({ page: String(page), pageSize: String(SERVER_PAGE_SIZE) });
            if (jobStatusFilter !== 'all') params.set('status', jobStatusFilter);
            if (jobSearchQuery.trim()) params.set('search', jobSearchQuery.trim());
            const data = await api(`/api/jobs?${params.toString()}`);
            setJobs((current) => (append ? [...current, ...(data.jobs || [])] : data.jobs || []));
            setPaginationMeta((current) => ({ ...current, jobs: data.pagination || null }));
            if (data.user) setUser(data.user);
        } catch (error) {
            setErrorFlag('jobs', error.message || 'Failed to load jobs');
            toast.error(`Failed to load jobs: ${error.message}`);
        } finally {
            setLoadingFlag('jobs', false);
        }
    }, [jobSearchQuery, jobStatusFilter, setErrorFlag, setLoadingFlag, setUser]);

    const loadBillingPackages = useCallback(async () => {
        setLoadingFlag('billingPackages', true);
        setErrorFlag('billingPackages', '');
        try {
            const data = await api('/api/billing/prepaid-packages');
            setPrepaidPackages(data.packages || []);
            setCustomTopUpConfig(data.customTopUp || null);
            setNowpaymentsConfig(data.nowpayments || null);
        } catch (error) {
            setErrorFlag('billingPackages', error.message || 'Failed to load prepaid packages');
            toast.error(`Failed to load prepaid packages: ${error.message}`);
        } finally {
            setLoadingFlag('billingPackages', false);
        }
    }, [setErrorFlag, setLoadingFlag]);

    const loadRechargeHistory = useCallback(async ({ page = 1, append = false } = {}) => {
        setLoadingFlag('billingHistory', true);
        setErrorFlag('billingHistory', '');
        try {
            const data = await api(`/api/billing/recharges?page=${page}&pageSize=${SERVER_PAGE_SIZE}`);
            setRecharges((current) => (append ? sortByCreatedDesc([...current, ...(data.recharges || [])]) : data.recharges || []));
            setPaginationMeta((current) => ({ ...current, billingHistory: data.pagination || null }));
        } catch (error) {
            setErrorFlag('billingHistory', error.message || 'Failed to load recharge history');
            toast.error(`Failed to load recharge history: ${error.message}`);
        } finally {
            setLoadingFlag('billingHistory', false);
        }
    }, [setErrorFlag, setLoadingFlag]);

    const refreshCurrentUser = useCallback(async () => {
        const data = await api('/api/auth/me');
        if (data.user) setUser(data.user);
        return data.user;
    }, [setUser]);

    const loadAll = useCallback(async () => {
        await Promise.all([
            loadAccessKeys(),
            loadProjects(),
            loadFiles({ page: 1 }),
            loadJobs({ page: 1 }),
            loadBillingPackages(),
            loadRechargeHistory({ page: 1 }),
        ]);
    }, [loadAccessKeys, loadBillingPackages, loadFiles, loadJobs, loadProjects, loadRechargeHistory]);

    useEffect(() => {
        if (!user?.id) return undefined;
        if (initialLoadUserIdRef.current === user.id) return undefined;
        initialLoadUserIdRef.current = user.id;
        jobFilterLoadRef.current = { userId: user.id, status: jobStatusFilter, search: jobSearchQuery };
        fileFilterLoadRef.current = { userId: user.id, search: fileSearchQuery };
        const timer = window.setTimeout(() => {
            loadAll();
        }, 0);
        return () => window.clearTimeout(timer);
    }, [jobSearchQuery, jobStatusFilter, fileSearchQuery, user?.id, loadAll]);

    useEffect(() => {
        if (!user?.id) return undefined;
        const previous = jobFilterLoadRef.current;
        if (previous.userId !== user.id) {
            jobFilterLoadRef.current = { userId: user.id, status: jobStatusFilter, search: jobSearchQuery };
            return undefined;
        }
        if (previous.status === jobStatusFilter && previous.search === jobSearchQuery) return undefined;
        jobFilterLoadRef.current = { userId: user.id, status: jobStatusFilter, search: jobSearchQuery };
        const timer = window.setTimeout(() => {
            loadJobs({ page: 1 });
        }, 250);
        return () => window.clearTimeout(timer);
    }, [jobSearchQuery, jobStatusFilter, loadJobs, user?.id]);

    useEffect(() => {
        if (!user?.id) return undefined;
        const previous = fileFilterLoadRef.current;
        if (previous.userId !== user.id) {
            fileFilterLoadRef.current = { userId: user.id, search: fileSearchQuery };
            return undefined;
        }
        if (previous.search === fileSearchQuery) return undefined;
        fileFilterLoadRef.current = { userId: user.id, search: fileSearchQuery };
        const timer = window.setTimeout(() => {
            loadFiles({ page: 1 });
        }, 250);
        return () => window.clearTimeout(timer);
    }, [fileSearchQuery, loadFiles, user?.id]);

    useEffect(() => {
        if (!user?.id) return undefined;

        const socket = io('/', { withCredentials: true });
        socket.on('job_update', (job) => {
            setJobs((current) => mergeJob(current, job));
            if (job?.status === 'COMPLETED') {
                setTimeout(() => {
                    loadFiles({ page: 1 });
                    loadJobs({ page: 1 });
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

    const customTopUpValidation = useMemo(() => {
        if (!customTopUpAmount.trim()) return '';
        if (!customTopUpConfig) return 'Custom top-ups are not configured.';
        const trimmed = customTopUpAmount.trim();
        if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) return 'Enter a positive decimal amount.';
        if (decimalPlaces(trimmed) > Number(customTopUpConfig.decimalPlaces ?? 2)) {
            return `Use at most ${customTopUpConfig.decimalPlaces} decimal places.`;
        }
        const amount = Number(trimmed);
        if (!Number.isFinite(amount) || amount <= 0) return 'Enter a positive amount.';
        if (amount < Number(customTopUpConfig.minAmountUsd)) return `Minimum custom top-up is ${formatMoney(customTopUpConfig.minAmountUsd, customTopUpConfig.currency)}.`;
        if (amount > Number(customTopUpConfig.maxAmountUsd)) return `Maximum custom top-up is ${formatMoney(customTopUpConfig.maxAmountUsd, customTopUpConfig.currency)}.`;
        return '';
    }, [customTopUpAmount, customTopUpConfig]);
    const customTopUpPreview = customTopUpAmount.trim() && !customTopUpValidation
        ? formatMoney(customTopUpAmount.trim(), customTopUpConfig?.currency)
        : null;
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
    }, []);

    const restartTour = useCallback(() => {
        setTourStepIndex(0);
        setTourOpen(true);
    }, []);

    // Listen for tour start event from navbar profile dropdown
    useEffect(() => {
        const handler = () => restartTour();
        window.addEventListener('start-tour', handler);
        return () => window.removeEventListener('start-tour', handler);
    }, [restartTour]);

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

    // Focus tour dialog when open
    useEffect(() => {
        if (!tourOpen) return;
        const focusTimer = window.setTimeout(() => {
            tourDialogRef.current?.focus();
        }, 0);
        return () => window.clearTimeout(focusTimer);
    }, [tourOpen]);

    // Listen for tour start event from navbar profile dropdown
    useEffect(() => {
        const handler = () => restartTour();
        window.addEventListener('start-tour', handler);
        return () => window.removeEventListener('start-tour', handler);
    }, [restartTour]);

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
        if (!openActionMenuId) return undefined;

        updateActionMenuPlacement(openActionMenuId);
        const dashboardMain = dashboardMainRef.current;

        const handlePointerDown = (event) => {
            if (actionMenuRef.current?.contains(event.target)) return;
            setOpenActionMenuId(null);
        };

        const handleKeyDown = (event) => {
            if (event.key === 'Escape') setOpenActionMenuId(null);
        };

        const handleViewportChange = () => {
            updateActionMenuPlacement(openActionMenuId);
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
    }, [openActionMenuId, updateActionMenuPlacement]);

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
            loadAccessKeys({ page: 1 });
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
            loadProjects({ page: 1 });
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

    const handleStartPayPalTopUp = async (packageId) => {
        if (!packageId || creatingTopUpPackageId || creatingCustomTopUp) return;
        setCreatingTopUpPackageId(packageId);
        try {
            const data = await api('/api/billing/paypal/orders', {
                method: 'POST',
                body: JSON.stringify({ packageId }),
            });
            if (data.order) {
                setRecharges((current) => sortByCreatedDesc([data.order, ...current.filter((order) => order.id !== data.order.id)]));
                setBillingPage(1);
            }
            if (data.order?.approvalUrl) {
                toast.success('Redirecting to PayPal checkout...');
                window.location.assign(data.order.approvalUrl);
                return;
            }
            toast.error('PayPal checkout did not return an approval link.');
        } catch (error) {
            toast.error(error.message || 'Failed to start PayPal checkout');
        } finally {
            setCreatingTopUpPackageId(null);
        }
    };

    const handleStartPayPalCustomTopUp = async (event) => {
        event.preventDefault();
        if (creatingCustomTopUp || creatingTopUpPackageId) return;
        const amount = customTopUpAmount.trim();
        if (!customTopUpConfig) {
            toast.error('Custom PayPal top-ups are not configured.');
            return;
        }
        if (!amount || customTopUpValidation) {
            toast.error(customTopUpValidation || 'Enter a custom top-up amount.');
            return;
        }
        setCreatingCustomTopUp(true);
        try {
            const data = await api('/api/billing/paypal/orders', {
                method: 'POST',
                body: JSON.stringify({ customAmount: { amountUsd: amount, currency: customTopUpConfig.currency } }),
            });
            if (data.order) {
                setRecharges((current) => sortByCreatedDesc([data.order, ...current.filter((order) => order.id !== data.order.id)]));
                setBillingPage(1);
            }
            if (data.order?.approvalUrl) {
                toast.success('Redirecting to PayPal checkout...');
                window.location.assign(data.order.approvalUrl);
                return;
            }
            toast.error('PayPal checkout did not return an approval link.');
        } catch (error) {
            toast.error(error.message || 'Failed to start custom PayPal checkout');
        } finally {
            setCreatingCustomTopUp(false);
        }
    };

    const handleCapturePayPalOrder = useCallback(async (providerOrderId) => {
        if (!providerOrderId || capturingOrderId) return;
        setCapturingOrderId(providerOrderId);
        try {
            const data = await api(`/api/billing/paypal/orders/${encodeURIComponent(providerOrderId)}/capture`, {
                method: 'POST',
                body: '{}',
            });
            if (data.order) {
                setRecharges((current) => sortByCreatedDesc([data.order, ...current.filter((order) => order.id !== data.order.id)]));
            }
            await refreshCurrentUser();
            await loadRechargeHistory({ page: 1 });
            setBillingPage(1);
            toast.success(data.idempotent ? 'PayPal top-up was already credited.' : 'PayPal top-up captured and credits added.');
        } catch (error) {
            toast.error(error.message || 'Failed to capture PayPal top-up');
            loadRechargeHistory({ page: 1 });
        } finally {
            setCapturingOrderId(null);
        }
    }, [capturingOrderId, loadRechargeHistory, refreshCurrentUser]);

    const handleStartNowPaymentsCustomTopUp = async (event) => {
        event.preventDefault();
        if (creatingCustomNp || creatingNpPackageId) return;
        const npConfig = nowpaymentsConfig;
        if (!npConfig?.configured) {
            toast.error('NOWPayments is not configured.');
            return;
        }
        const amount = customNpAmount.trim();
        if (!amount) {
            toast.error('Enter a custom top-up amount.');
            return;
        }
        setCreatingCustomNp(true);
        try {
            const data = await api('/api/billing/nowpayments/invoices', {
                method: 'POST',
                body: JSON.stringify({ customAmount: { amountUsd: amount, currency: 'USD' }, payCurrency: npConfig.defaultPayCurrency }),
            });
            if (data.order) {
                setRecharges((current) => sortByCreatedDesc([data.order, ...current.filter((order) => order.id !== data.order.id)]));
                setBillingPage(1);
            }
            if (data.order?.approvalUrl) {
                toast.success('Opening NOWPayments checkout...');
                window.open(data.order.approvalUrl, '_blank', 'noopener');
                return;
            }
            toast.error('NOWPayments did not return an invoice URL.');
        } catch (error) {
            toast.error(error.message || 'Failed to start custom NOWPayments checkout');
        } finally {
            setCreatingCustomNp(false);
        }
    };

    useEffect(() => {
        if (!user?.id || typeof window === 'undefined') return undefined;
        const params = new URLSearchParams(window.location.search);
        const isPayPalReturn = params.get('paypal') === 'return';
        const providerOrderId = params.get('token') || params.get('orderId') || params.get('providerOrderId');
        if (!isPayPalReturn || !providerOrderId) return undefined;
        if (paypalReturnHandledRef.current === providerOrderId) return undefined;
        paypalReturnHandledRef.current = providerOrderId;
        setActiveView('billing');
        const timer = window.setTimeout(() => {
            handleCapturePayPalOrder(providerOrderId);
            params.delete('paypal');
            params.delete('token');
            params.delete('PayerID');
            params.delete('orderId');
            params.delete('providerOrderId');
            const nextSearch = params.toString();
            window.history.replaceState({}, '', `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`);
        }, 0);
        return () => window.clearTimeout(timer);
    }, [handleCapturePayPalOrder, user?.id]);

    const loadMoreRecharges = () => {
        if (!paginationMeta.billingHistory?.hasNextPage || loading.billingHistory) return;
        loadRechargeHistory({ page: paginationMeta.billingHistory.page + 1, append: true });
    };

    const closeActionMenu = () => {
        setOpenActionMenuId(null);
    };

    const toggleActionMenu = (menuId, buttonElement, estimatedHeight = ACTION_MENU_DEFAULT_HEIGHT) => {
        if (openActionMenuId === menuId) {
            setOpenActionMenuId(null);
            return;
        }
        actionMenuHeightsRef.current.set(menuId, estimatedHeight);
        setActionMenuPlacement(getActionMenuPlacement(menuId, buttonElement));
        setOpenActionMenuId(menuId);
    };

    const startProjectEdit = (project) => {
        closeActionMenu();
        setEditingProjectId(project.id);
        setEditingProjectName(project.name || '');
    };

    const cancelProjectEdit = () => {
        closeActionMenu();
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

    const loadMoreAccessKeys = () => {
        if (!paginationMeta.keys?.hasNextPage || loading.keys) return;
        loadAccessKeys({ page: paginationMeta.keys.page + 1, append: true });
    };

    const loadMoreProjects = () => {
        if (!paginationMeta.projects?.hasNextPage || loading.projects) return;
        loadProjects({ page: paginationMeta.projects.page + 1, append: true });
    };

    const loadMoreJobs = () => {
        if (!paginationMeta.jobs?.hasNextPage || loading.jobs) return;
        loadJobs({ page: paginationMeta.jobs.page + 1, append: true });
    };

    const loadMoreFiles = () => {
        if (!paginationMeta.files?.hasNextPage || loading.files) return;
        loadFiles({ page: paginationMeta.files.page + 1, append: true });
    };

    const handleFileSelect = useCallback((event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        if (!file.name.endsWith('.blend')) {
            toast.error('Only .blend files are supported');
            return;
        }
        setSubmitFile(file);
        setSubmitFileKey(null);
        setSubmitError('');
    }, []);

    const handleDropFile = useCallback((event) => {
        event.preventDefault();
        const file = event.dataTransfer?.files?.[0];
        if (!file) return;
        if (!file.name.endsWith('.blend')) {
            toast.error('Only .blend files are supported');
            return;
        }
        setSubmitFile(file);
        setSubmitFileKey(null);
        setSubmitError('');
    }, []);

    const handleUploadAndSubmit = useCallback(async () => {
        if (!submitFile) return;
        setSubmitError('');
        setSubmitUploading(true);
        setSubmitUploadProgress(0);

        try {
            // 1. Get presigned upload URL
            const { uploadUrl, key } = await api('/api/render/get-upload-url', {
                method: 'POST',
                body: JSON.stringify({ fileName: submitFile.name, fileSizeBytes: submitFile.size }),
            });
            setSubmitFileKey(key);

            // 2. Upload file directly to R2
            const xhr = new XMLHttpRequest();
            await new Promise((resolve, reject) => {
                xhr.upload.addEventListener('progress', (e) => {
                    if (e.lengthComputable) setSubmitUploadProgress(Math.round((e.loaded / e.total) * 100));
                });
                xhr.addEventListener('load', () => resolve());
                xhr.addEventListener('error', () => reject(new Error('Upload failed')));
                xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));
                xhr.open('PUT', uploadUrl);
                xhr.setRequestHeader('Content-Type', 'application/octet-stream');
                xhr.send(submitFile);
            });

            setSubmitUploading(false);

            // 3. Submit render job
            setSubmitting(true);
            const payload = {
                fileKey: key,
                engine: submitEngine,
                samples: submitSamples,
                resolutionPct: submitResolution,
                outputFormat: submitFormat,
                denoiser: submitDenoiser,
                isAnimation: submitAnimation,
                startFrame: submitAnimation ? submitStartFrame : 1,
                endFrame: submitAnimation ? submitEndFrame : 1,
                gpuDeviceType: submitGpuDevice,
                noiseThreshold: 0.01,
            };
            if (submitProjectId) payload.projectId = submitProjectId;

            const result = await api('/api/render/trigger-render', {
                method: 'POST',
                body: JSON.stringify(payload),
            });

            toast.success('Render submitted successfully!');
            setSubmitFile(null);
            setSubmitFileKey(null);
            setActiveView('renders');
            loadJobs();
        } catch (error) {
            setSubmitError(error.message || 'Failed to submit render');
            toast.error(error.message || 'Failed to submit render');
        } finally {
            setSubmitUploading(false);
            setSubmitting(false);
        }
    }, [submitFile, submitEngine, submitSamples, submitResolution, submitFormat, submitDenoiser, submitAnimation, submitStartFrame, submitEndFrame, submitGpuDevice, submitProjectId]);

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
        closeActionMenu();
        setJobStatusFilter('all');
        setJobSearchQuery(project.name || project.id);
        setActiveJobsPage(1);
        setHistoryJobsPage(1);
        setActiveView('renders');
    };

    const viewProjectFiles = (project) => {
        closeActionMenu();
        setFileSearchQuery(project.name || project.id);
        setFilesPage(1);
        setActiveView('files');
    };

    const renderActionMenuItem = (item) => {
        const Icon = item.icon;
        const content = (
            <>
                <Icon size={15} /> {item.label}
            </>
        );

        if (item.href) {
            return (
                <a
                    className={`project-menu-item${item.danger ? ' danger' : ''}${item.primary ? ' primary' : ''}`}
                    href={item.href}
                    target={item.target}
                    rel={item.rel}
                    download={item.download}
                    role="menuitem"
                    onClick={closeActionMenu}
                    key={item.key}
                >
                    {content}
                </a>
            );
        }

        return (
            <button
                className={`project-menu-item${item.danger ? ' danger' : ''}${item.primary ? ' primary' : ''}`}
                type={item.type || 'button'}
                form={item.form}
                role="menuitem"
                disabled={item.disabled}
                onClick={item.onClick ? () => {
                    closeActionMenu();
                    item.onClick();
                } : undefined}
                key={item.key}
            >
                {content}
            </button>
        );
    };

    const ActionMenu = ({ menuId, label, items, estimatedHeight = ACTION_MENU_DEFAULT_HEIGHT }) => {
        const menuOpen = openActionMenuId === menuId;
        return (
            <div className="project-actions-menu action-menu" ref={menuOpen ? actionMenuRef : null}>
                <button
                    ref={(node) => {
                        if (node) actionMenuButtonRefs.current.set(menuId, node);
                        else actionMenuButtonRefs.current.delete(menuId);
                    }}
                    className="button compact-button project-actions-toggle action-menu-toggle"
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    aria-controls={`${menuId}-menu`}
                    aria-label={label}
                    onClick={(event) => toggleActionMenu(menuId, event.currentTarget, estimatedHeight)}
                >
                    <Menu size={16} aria-hidden="true" />
                </button>
                {menuOpen && (
                    <div className={`project-actions-dropdown action-menu-dropdown placement-${actionMenuPlacement}`} id={`${menuId}-menu`} role="menu" aria-label={label}>
                        {items.map(renderActionMenuItem)}
                    </div>
                )}
            </div>
        );
    };

    const renderJobRow = (job, overview = false) => {
        const expanded = expandedJobId === job.jobId;
        const jobActionItems = [
            {
                icon: Eye,
                key: 'details',
                label: expanded ? 'Hide details' : 'View details',
                onClick: () => setExpandedJobId(expanded ? null : job.jobId),
            },
            ...(ACTIVE_STATUSES.has(job.status) ? [{
                danger: true,
                icon: XCircle,
                key: 'cancel',
                label: 'Cancel job',
                onClick: () => handleCancelJob(job.jobId),
            }] : []),
            ...(job.downloadUrl ? [{
                href: job.downloadUrl,
                icon: Download,
                key: 'download',
                label: 'Download output',
                rel: 'noopener noreferrer',
                target: '_blank',
            }] : []),
        ];
        return (
            <Fragment key={job.jobId}>
                <tr className="data-row">
                    {overview ? (
                        <>
                            <td data-label="Job">
                                <div className="table-primary job-id">{job.fileName || job.jobId}</div>
                                <div className="table-meta"><span>{job.jobId}</span></div>
                            </td>
                            <td data-label="Status"><StatusPill status={job.status} /></td>
                            <td data-label="Submitted">{formatDate(job.createdAt)}</td>
                            <td data-label="Cost">
                                <div className="table-money">
                                    <span>{job.status === 'COMPLETED' ? formatUsd(job.priceUsd) : '—'}</span>
                                </div>
                            </td>
                        </>
                    ) : (
                        <>
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
                            {jobActionItems.length > 2 ? (
                                <ActionMenu menuId={`job-actions-${job.jobId}`} label={`Actions for job ${job.jobId}`} items={jobActionItems} />
                            ) : (
                                <>
                                    <button className="button compact-button" type="button" onClick={() => setExpandedJobId(expanded ? null : job.jobId)}>
                                        <Eye size={15} /> {expanded ? 'Hide' : 'Details'}
                                    </button>
                                    {ACTIVE_STATUSES.has(job.status) && (
                                        <button className="button compact-button danger" type="button" onClick={() => handleCancelJob(job.jobId)}>
                                            <XCircle size={15} /> Cancel
                                        </button>
                                    )}
                                    {job.downloadUrl && (
                                        <a className="link-button compact-button" href={job.downloadUrl} target="_blank" rel="noopener noreferrer">
                                            <Download size={15} /> Download
                                        </a>
                                    )}
                                </>
                            )}
                        </div>
                    </td>
                        </>
                    )}
                </tr>
                {expanded && (
                    <tr className="data-row-details">
                        <td colSpan={overview ? 4 : 7}>
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

    const renderJobTable = (rows, label, overview = false) => (
        <div className="data-table-wrap queue-table" aria-live="polite">
            <table className="data-table" aria-label={label}>
                <thead>
                    <tr>
                        {overview ? (
                            <>
                                <th scope="col">Job</th>
                                <th scope="col">Status</th>
                                <th scope="col">Submitted</th>
                                <th scope="col">Cost</th>
                            </>
                        ) : (
                            <>
                                <th scope="col">Job / file</th>
                                <th scope="col">Project</th>
                                <th scope="col">Status</th>
                                <th scope="col">Progress</th>
                                <th scope="col">Submitted</th>
                                <th scope="col">Duration / cost</th>
                                <th scope="col">Actions</th>
                            </>
                        )}
                    </tr>
                </thead>
                <tbody>{rows.map((job) => renderJobRow(job, overview))}</tbody>
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
                        {renderJobTable(pagination.items, title, false)}
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
                    {paginationMeta.keys?.hasNextPage ? <button className="button compact-button" type="button" onClick={loadMoreAccessKeys} disabled={loading.keys}>Load more access keys</button> : null}
                    </>
                ) : null}
            </div>
        </motion.div>
        );
    };

    const renderSubmitForm = () => {
        const fileSizeMb = submitFile ? (submitFile.size / (1024 * 1024)).toFixed(1) : 0;
        return (
            <motion.div className="panel dashboard-panel submit-panel" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
                <div className="panel-head">
                    <div>
                        <h2>Submit a new render</h2>
                        <p className="muted">Upload a .blend file and configure render settings. Estimate shown before submission.</p>
                    </div>
                </div>

                <div className="submit-form-layout">
                    <div className="submit-form-fields">
                        {/* File upload */}
                        <div className="submit-field">
                            <label>.blend file</label>
                            <div
                                className={`submit-dropzone ${submitFile ? 'submit-dropzone--has-file' : ''}`}
                                onDragOver={(e) => e.preventDefault()}
                                onDrop={handleDropFile}
                                onClick={() => document.getElementById('blend-file-input')?.click()}
                                role="button"
                                tabIndex={0}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') document.getElementById('blend-file-input')?.click(); }}
                            >
                                {submitFile ? (
                                    <div className="submit-dropzone-file">
                                        <FileArchive size={24} />
                                        <div>
                                            <strong>{submitFile.name}</strong>
                                            <span className="subtle">{fileSizeMb} MB</span>
                                        </div>
                                        <button
                                            className="button"
                                            type="button"
                                            onClick={(e) => { e.stopPropagation(); setSubmitFile(null); setSubmitFileKey(null); }}
                                        >
                                            <X size={14} /> Remove
                                        </button>
                                    </div>
                                ) : (
                                    <div className="submit-dropzone-empty">
                                        <Upload size={28} />
                                        <strong>Drop a .blend file here</strong>
                                        <span className="subtle">or click to browse (max 10 GB)</span>
                                    </div>
                                )}
                                <input id="blend-file-input" type="file" accept=".blend" onChange={handleFileSelect} style={{ display: 'none' }} />
                            </div>
                            {submitUploading && (
                                <div className="submit-progress-wrap">
                                    <div className="submit-progress-track">
                                        <div className="submit-progress-fill" style={{ width: `${submitUploadProgress}%` }} />
                                    </div>
                                    <span>{submitUploadProgress}% uploaded</span>
                                </div>
                            )}
                        </div>

                        {/* Engine */}
                        <div className="submit-field">
                            <label htmlFor="submit-engine">Render engine</label>
                            <select id="submit-engine" value={submitEngine} onChange={(e) => setSubmitEngine(e.target.value)}>
                                <option value="CYCLES">Cycles</option>
                                <option value="BLENDER_EEVEE_NEXT">Eevee</option>
                            </select>
                        </div>

                        {/* Samples + Resolution row */}
                        <div className="submit-field-row">
                            <div className="submit-field">
                                <label htmlFor="submit-samples">Samples</label>
                                <div className="submit-slider-wrap">
                                    <input id="submit-samples" type="range" min={8} max={2048} step={8} value={submitSamples} onChange={(e) => setSubmitSamples(Number(e.target.value))} className="submit-slider" />
                                    <input type="text" inputMode="numeric" value={submitSamples} onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 8 && v <= 2048) setSubmitSamples(v); }} className="submit-number" />
                                </div>
                            </div>
                            <div className="submit-field">
                                <label htmlFor="submit-resolution">Resolution %</label>
                                <div className="submit-slider-wrap">
                                    <input id="submit-resolution" type="range" min={25} max={150} step={5} value={submitResolution} onChange={(e) => setSubmitResolution(Number(e.target.value))} className="submit-slider" />
                                    <input type="text" inputMode="numeric" value={submitResolution} onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 25 && v <= 150) setSubmitResolution(v); }} className="submit-number" />
                                </div>
                            </div>
                        </div>

                        {/* Animation toggle */}
                        <div className="submit-field">
                            <label className="submit-checkbox-label">
                                <input type="checkbox" checked={submitAnimation} onChange={(e) => setSubmitAnimation(e.target.checked)} />
                                <span>Animation</span>
                            </label>
                        </div>

                        {submitAnimation && (
                            <div className="submit-field-row">
                                <div className="submit-field">
                                    <label htmlFor="submit-start">Start frame</label>
                                    <input id="submit-start" type="number" min={0} value={submitStartFrame} onChange={(e) => setSubmitStartFrame(Number(e.target.value))} className="submit-input" />
                                </div>
                                <div className="submit-field">
                                    <label htmlFor="submit-end">End frame</label>
                                    <input id="submit-end" type="number" min={submitStartFrame} value={submitEndFrame} onChange={(e) => setSubmitEndFrame(Number(e.target.value))} className="submit-input" />
                                </div>
                            </div>
                        )}

                        {/* Format + Denoiser row */}
                        <div className="submit-field-row">
                            <div className="submit-field">
                                <label htmlFor="submit-format">Output format</label>
                                <select id="submit-format" value={submitFormat} onChange={(e) => setSubmitFormat(e.target.value)}>
                                    <option value="PNG">PNG</option>
                                    <option value="JPEG">JPEG</option>
                                    <option value="OPEN_EXR">OpenEXR</option>
                                    <option value="OPEN_EXR_MULTILAYER">OpenEXR Multilayer</option>
                                </select>
                            </div>
                            <div className="submit-field">
                                <label htmlFor="submit-denoiser">Denoiser</label>
                                <select id="submit-denoiser" value={submitDenoiser} onChange={(e) => setSubmitDenoiser(e.target.value)}>
                                    <option value="NONE">None</option>
                                    <option value="OPTIX">OptiX</option>
                                    <option value="OPENIMAGEDENOISE">OpenImageDenoise</option>
                                </select>
                            </div>
                        </div>

                        {/* GPU device */}
                        <div className="submit-field">
                            <label htmlFor="submit-gpu">GPU device type</label>
                            <select id="submit-gpu" value={submitGpuDevice} onChange={(e) => setSubmitGpuDevice(e.target.value)}>
                                <option value="AUTO">Auto</option>
                                <option value="OPTIX">OptiX</option>
                                <option value="CUDA">CUDA</option>
                            </select>
                        </div>

                        {/* Project selector */}
                        <div className="submit-field">
                            <label htmlFor="submit-project">Project <span className="subtle">(optional)</span></label>
                            <select id="submit-project" value={submitProjectId} onChange={(e) => setSubmitProjectId(e.target.value)}>
                                <option value="">No project</option>
                                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                        </div>

                        {submitError && <div className="submit-error">{submitError}</div>}

                        <div className="submit-actions">
                            <button
                                className="button primary"
                                type="button"
                                onClick={handleUploadAndSubmit}
                                disabled={!submitFile || submitUploading || submitting}
                            >
                                {submitUploading
                                    ? `Uploading ${submitUploadProgress}%...`
                                    : submitting
                                        ? 'Submitting render...'
                                        : !submitFile
                                            ? 'Select a file first'
                                            : <><FileUp size={18} /> Submit render</>
                                }
                            </button>

                            <p className="submit-disclaimer subtle">
                                By submitting, you authorize a credit reservation from your balance.
                                You will only be charged for actual GPU seconds used (min. $0.02).
                            </p>
                        </div>
                    </div>
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
                    <span><strong>{projects.length}</strong> of {paginationMeta.projects?.totalItems ?? projects.length} projects loaded</span>
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
                        <table className="data-table" aria-label="Projects">
                            <thead>
                                <tr>
                                    <th scope="col">Name</th>
                                    <th scope="col">Jobs</th>
                                    <th scope="col">Updated</th>
                                    <th scope="col">Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {projectPagination.items.map((project) => {
                                    const jobCount = stats.jobsByProject.get(project.id) || project.jobCount || 0;
                                    const fileCount = stats.filesByProject.get(project.id) || 0;
                                    const isEditing = editingProjectId === project.id;
                                    const editFormId = `project-edit-${project.id}`;
                                    const projectActionItems = isEditing ? [
                                        {
                                            disabled: updatingProjectId === project.id || !editingProjectName.trim(),
                                            form: editFormId,
                                            icon: Save,
                                            key: 'save',
                                            label: 'Save rename',
                                            primary: true,
                                            type: 'submit',
                                        },
                                        {
                                            icon: X,
                                            key: 'cancel',
                                            label: 'Cancel rename',
                                            onClick: cancelProjectEdit,
                                        },
                                    ] : [
                                        {
                                            icon: Activity,
                                            key: 'jobs',
                                            label: 'View jobs',
                                            onClick: () => viewProjectRenders(project),
                                        },
                                        {
                                            icon: FileArchive,
                                            key: 'files',
                                            label: 'View files',
                                            onClick: () => viewProjectFiles(project),
                                        },
                                        {
                                            icon: Edit3,
                                            key: 'rename',
                                            label: 'Rename',
                                            onClick: () => startProjectEdit(project),
                                        },
                                        {
                                            danger: true,
                                            icon: Trash2,
                                            key: 'delete',
                                            label: 'Delete',
                                            onClick: () => handleDeleteProject(project),
                                        },
                                    ];
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
                                                <ActionMenu
                                                    menuId={`project-actions-${project.id}`}
                                                    label={`Project actions for ${project.name}`}
                                                    items={projectActionItems}
                                                    estimatedHeight={isEditing ? PROJECT_ACTION_MENU_HEIGHT.editing : PROJECT_ACTION_MENU_HEIGHT.default}
                                                />
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                    <PaginationControls label="Projects" totalItems={projects.length} page={projectPagination.page} onPageChange={setProjectsPage} />
                    {paginationMeta.projects?.hasNextPage ? <button className="button compact-button" type="button" onClick={loadMoreProjects} disabled={loading.projects}>Load more projects</button> : null}
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
                    <span>{overview ? `${previewJobs.length} of ${paginationMeta.jobs?.totalItems ?? jobs.length} recent jobs` : `${visibleJobs.length} loaded of ${paginationMeta.jobs?.totalItems ?? visibleJobs.length} matching jobs`}</span>
                    {!overview && <span>{activeJobs.length} active / {historyJobs.length} history</span>}
                    {paginationMeta.jobs?.hasNextPage && <button className="button compact-button" type="button" onClick={loadMoreJobs} disabled={loading.jobs}>Load more jobs</button>}
                </div>

                {loading.jobs ? <LoadingState label="Loading render queue..." /> : null}
                {!loading.jobs && errors.jobs ? <ErrorState message={errors.jobs} onRetry={loadJobs} /> : null}
                {!loading.jobs && !errors.jobs && overview && (
                    previewJobs.length === 0
                        ? <EmptyState icon={Activity} title="No render jobs yet" text="Submit a render from Blender and it will appear here with real-time progress." />
                        : renderJobTable(previewJobs, 'Queue snapshot', true)
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
                    <span>{overview ? `${previewFiles.length} latest files` : `${visibleFiles.length} loaded of ${paginationMeta.files?.totalItems ?? visibleFiles.length} matching files`}</span>
                    {!overview && paginationMeta.files?.hasNextPage && <button className="button compact-button" type="button" onClick={loadMoreFiles} disabled={loading.files}>Load more files</button>}
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
                        <table className="data-table" aria-label={overview ? 'Latest deliveries' : 'Rendered files'}>
                            <thead>
                                <tr>
                                    {overview ? (
                                        <>
                                            <th scope="col">File</th>
                                            <th scope="col">Created</th>
                                            <th scope="col">Type</th>
                                        </>
                                    ) : (
                                        <>
                                            <th scope="col">File</th>
                                            <th scope="col">Project</th>
                                            <th scope="col">Created</th>
                                            <th scope="col">Type</th>
                                            <th scope="col">Render metrics</th>
                                            <th scope="col">Actions</th>
                                        </>
                                    )}
                                </tr>
                            </thead>
                            <tbody>
                                {tableFiles.map((file) => {
                                    const absoluteUrl = file.downloadUrl ? new URL(file.downloadUrl, window.location.origin).href : '';
                                    return (
                                        <tr className="data-row" key={file.id || file.jobId || file.resultKey}>
                                            {overview ? (
                                                <>
                                                    <td data-label="File">
                                                        <div className="table-primary">{file.fileName || file.resultKey}</div>
                                                        <div className="table-meta"><span>{file.jobId}</span></div>
                                                    </td>
                                                    <td data-label="Created">{formatDate(file.completedAt || file.createdAt)}</td>
                                                    <td data-label="Type">{file.outputFormat || file.contentType || 'Output'}</td>
                                                </>
                                            ) : (
                                                <>
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
                                                        <ActionMenu
                                                            menuId={`file-actions-${file.id || file.jobId || file.resultKey}`}
                                                            label={`Actions for file ${file.fileName || file.resultKey || file.jobId}`}
                                                            items={[
                                                                {
                                                                    href: file.downloadUrl,
                                                                    icon: ExternalLink,
                                                                    key: 'open',
                                                                    label: 'Open file',
                                                                    rel: 'noopener noreferrer',
                                                                    target: '_blank',
                                                                },
                                                                {
                                                                    icon: Copy,
                                                                    key: 'copy',
                                                                    label: 'Copy link',
                                                                    onClick: () => copyToClipboard(absoluteUrl, 'file link'),
                                                                },
                                                                {
                                                                    download: true,
                                                                    href: file.downloadUrl,
                                                                    icon: Download,
                                                                    key: 'download',
                                                                    label: 'Download file',
                                                                },
                                                            ]}
                                                        />
                                                    ) : (
                                                        <>
                                                            <button className="button compact-button" type="button" disabled><ExternalLink size={15} /> Open</button>
                                                            <button className="button compact-button" type="button" disabled><Copy size={15} /> Copy link</button>
                                                        </>
                                                    )}
                                                </div>
                                            </td>
                                                </>
                                            )}
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

    const renderBilling = () => {
        const billingPagination = paginateItems(recharges, billingPage);
        const billingBusy = loading.billingPackages || loading.billingHistory;
        return (
            <motion.div className="panel dashboard-panel full billing-panel" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
                <div className="panel-head billing-panel-head">
                    <div>
                        <h2>Billing</h2>
                        <p className="muted">Top up prepaid credits with PayPal packages or a custom amount validated by the server, then track capture and ledger status here.</p>
                    </div>
                    <button className="button" type="button" onClick={loadAll} disabled={loading.jobs || loading.files || billingBusy}>
                        <RefreshCcw size={16} className={loading.jobs || loading.files || billingBusy ? 'spin' : ''} /> Refresh billing
                    </button>
                </div>

                <div className="dashboard-metrics-grid billing-metrics-grid">
                    <MetricCard icon={WalletCards} label="Current credit balance" value={formatUsd(user.starterBalanceUsd)} detail="Available prepaid account credit" tone="good" />
                    <MetricCard icon={ReceiptText} label="Successful top-ups" value={recharges.filter((order) => order.status === 'CAPTURED').length} detail={`${recharges.length} recharge records loaded`} />
                    <MetricCard icon={CheckCircle2} label="Render spend" value={formatUsd(stats.totalSpend)} detail={`${formatDuration(stats.billableSeconds)} billed from completed jobs`} tone="active" />
                </div>

                <section className="queue-section prepaid-packages-section">
                    <div className="queue-section-head">
                        <div>
                            <h3>Prepaid credit top-ups</h3>
                            <p className="muted">Choose a preset package or enter a custom amount. The backend validates every amount and currency before PayPal checkout.</p>
                        </div>
                        <span className="count-chip">{prepaidPackages.length} presets</span>
                    </div>
                    {loading.billingPackages ? <LoadingState label="Loading prepaid packages..." /> : null}
                    {!loading.billingPackages && errors.billingPackages ? <ErrorState message={errors.billingPackages} onRetry={loadBillingPackages} /> : null}
                    {!loading.billingPackages && !errors.billingPackages && prepaidPackages.length === 0 && !customTopUpConfig ? (
                        <EmptyState icon={WalletCards} title="No PayPal top-ups configured" text="Ask an administrator to configure PayPal package or custom top-up amounts before checkout can start." />
                    ) : null}
                    {!loading.billingPackages && !errors.billingPackages && (prepaidPackages.length > 0 || customTopUpConfig) ? (
                        <div className="prepaid-package-grid">
                            {prepaidPackages.map((item) => (
                                <article className="prepaid-package-card" key={item.id}>
                                    <div>
                                        <span className="package-eyebrow">Preset PayPal checkout</span>
                                        <h4>{item.label}</h4>
                                        <strong>{formatMoney(item.amountUsd, item.currency)}</strong>
                                        <p className="muted">Adds {formatMoney(item.amountUsd, item.currency)} to your RenderSphere prepaid balance after PayPal capture succeeds.</p>
                                    </div>
                                    <button
                                        className="button primary"
                                        type="button"
                                        onClick={() => handleStartPayPalTopUp(item.id)}
                                        disabled={Boolean(creatingTopUpPackageId) || creatingCustomTopUp}
                                    >
                                        {creatingTopUpPackageId === item.id ? 'Starting...' : 'Top up with PayPal'}
                                    </button>
                                </article>
                            ))}
                            {customTopUpConfig ? (
                                <article className="prepaid-package-card custom-top-up-card">
                                    <div>
                                        <span className="package-eyebrow">Custom PayPal checkout</span>
                                        <h4>Choose your amount</h4>
                                        <strong>{customTopUpPreview || formatMoney(customTopUpConfig.minAmountUsd, customTopUpConfig.currency)}</strong>
                                        <p className="muted">Enter a custom {customTopUpConfig.currency} amount from {formatMoney(customTopUpConfig.minAmountUsd, customTopUpConfig.currency)} to {formatMoney(customTopUpConfig.maxAmountUsd, customTopUpConfig.currency)}.</p>
                                    </div>
                                    <form className="custom-top-up-form" onSubmit={handleStartPayPalCustomTopUp} noValidate>
                                        <label htmlFor="custom-top-up-amount">
                                            <span>Custom amount ({customTopUpConfig.currency})</span>
                                            <input
                                                id="custom-top-up-amount"
                                                inputMode="decimal"
                                                min={customTopUpConfig.minAmountUsd}
                                                max={customTopUpConfig.maxAmountUsd}
                                                placeholder={String(customTopUpConfig.minAmountUsd)}
                                                step={customTopUpConfig.decimalPlaces > 0 ? `0.${'0'.repeat(Math.max(customTopUpConfig.decimalPlaces - 1, 0))}1` : '1'}
                                                type="text"
                                                value={customTopUpAmount}
                                                onChange={(event) => setCustomTopUpAmount(event.target.value)}
                                            />
                                        </label>
                                        <p className={customTopUpValidation ? 'custom-top-up-hint error-text' : 'custom-top-up-hint'}>
                                            {customTopUpValidation || `Server limit: ${formatMoney(customTopUpConfig.minAmountUsd, customTopUpConfig.currency)}–${formatMoney(customTopUpConfig.maxAmountUsd, customTopUpConfig.currency)}; ${customTopUpConfig.decimalPlaces} decimal places.`}
                                        </p>
                                        <button
                                            className="button primary"
                                            type="submit"
                                            disabled={creatingCustomTopUp || Boolean(creatingTopUpPackageId) || Boolean(customTopUpValidation) || !customTopUpAmount.trim()}
                                        >
                                            {creatingCustomTopUp ? 'Starting...' : 'Top up custom amount'}
                                        </button>
                                    </form>
                                </article>
                            ) : null}
                        </div>
                    ) : null}
                </section>

                {nowpaymentsConfig?.configured ? (
                <section className="queue-section nowpayments-section">
                    <div className="queue-section-head">
                        <div>
                            <h3>Crypto top-ups via NOWPayments</h3>
                            <p className="muted">Pay with Bitcoin, Ethereum, USDT, and other cryptocurrencies. The invoice opens in a new window.</p>
                        </div>
                    </div>
                    {nowpaymentsConfig.customTopUp ? (
                        <div className="prepaid-package-grid" style={{ gridTemplateColumns: '1fr' }}>
                            <article className="prepaid-package-card custom-top-up-card">
                                <div>
                                    <span className="package-eyebrow">Crypto top-up</span>
                                    <h4>Enter an amount</h4>
                                    <p className="muted">Enter a USD amount from {formatMoney(nowpaymentsConfig.customTopUp.minAmountUsd, nowpaymentsConfig.customTopUp.currency)} to {formatMoney(nowpaymentsConfig.customTopUp.maxAmountUsd, nowpaymentsConfig.customTopUp.currency)}. Paid in {nowpaymentsConfig.defaultPayCurrency?.toUpperCase() || 'crypto'}.</p>
                                </div>
                                <form className="custom-top-up-form" onSubmit={handleStartNowPaymentsCustomTopUp} noValidate>
                                    <label htmlFor="custom-np-amount">
                                        <span>Amount (USD)</span>
                                        <input
                                            id="custom-np-amount"
                                            inputMode="decimal"
                                            min={nowpaymentsConfig.customTopUp.minAmountUsd}
                                            max={nowpaymentsConfig.customTopUp.maxAmountUsd}
                                            placeholder={String(nowpaymentsConfig.customTopUp.minAmountUsd)}
                                            type="text"
                                            value={customNpAmount}
                                            onChange={(event) => setCustomNpAmount(event.target.value)}
                                        />
                                    </label>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', margin: '8px 0 4px' }}>
                                        {[10, 25, 50, 100, 250].map((preset) => (
                                            <button
                                                key={preset}
                                                type="button"
                                                className="button compact-button"
                                                onClick={() => setCustomNpAmount(String(preset))}
                                                style={customNpAmount === String(preset) ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}
                                            >
                                                ${preset}
                                            </button>
                                        ))}
                                    </div>
                                    <button
                                        className="button primary"
                                        type="submit"
                                        disabled={creatingCustomNp || Boolean(creatingNpPackageId) || !customNpAmount.trim()}
                                    >
                                        {creatingCustomNp ? 'Opening...' : 'Pay with crypto'}
                                    </button>
                                </form>
                            </article>
                        </div>
                    ) : null}
                </section>
                ) : null}

                <section className="queue-section billing-summary-section">
                    <div className="queue-section-head">
                        <div>
                            <h3>Account credit summary</h3>
                            <p className="muted">Credits come from the ledger-backed account balance; render deductions stay based on completed jobs.</p>
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
                                    <td data-label="Source">Ledger cached balance</td>
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
                            <p className="muted">PayPal order status, capture status, and linked ledger transaction are shown from backend records.</p>
                        </div>
                        <div className="section-actions">
                            <span className="count-chip">{paginationMeta.billingHistory?.totalItems ?? recharges.length}</span>
                            {paginationMeta.billingHistory?.hasNextPage ? <button className="button compact-button" type="button" onClick={loadMoreRecharges} disabled={loading.billingHistory}>Load more</button> : null}
                        </div>
                    </div>
                    {loading.billingHistory ? <LoadingState label="Loading recharge history..." /> : null}
                    {!loading.billingHistory && errors.billingHistory ? <ErrorState message={errors.billingHistory} onRetry={loadRechargeHistory} /> : null}
                    {!loading.billingHistory && !errors.billingHistory && recharges.length === 0 ? (
                        <EmptyState icon={ReceiptText} title="No recharge history yet" text="PayPal prepaid top-ups will appear here after checkout is started." />
                    ) : null}
                    {!loading.billingHistory && !errors.billingHistory && recharges.length > 0 ? (
                        <>
                            <div className="data-table-wrap billing-table-wrap">
                                <table className="data-table recharge-data-table" aria-label="Recharge history">
                                    <thead>
                                        <tr>
                                            <th scope="col">Recharge</th>
                                            <th scope="col">Amount</th>
                                            <th scope="col">Status</th>
                                            <th scope="col">Provider</th>
                                            <th scope="col">Ledger</th>
                                            <th scope="col">Created / captured</th>
                                            <th scope="col">Action</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {billingPagination.items.map((order) => (
                                            <tr className="data-row" key={order.id}>
                                                <td data-label="Recharge">
                                                    <div className="table-primary">{order.topUpLabel || order.packageId || 'Custom top-up'}</div>
                                                    <div className="table-meta"><span>{order.topUpType === 'CUSTOM' ? 'Custom amount' : 'Preset package'}</span><span>{order.providerOrderId}</span></div>
                                                </td>
                                                <td data-label="Amount">{formatMoney(order.amountUsd, order.currency)}</td>
                                                <td data-label="Status"><StatusPill status={order.status} /></td>
                                                <td data-label="Provider">
                                                    <div className="table-metric-stack">
                                                        <strong>{order.provider}</strong>
                                                        <span>{order.providerStatus || '—'}</span>
                                                    </div>
                                                </td>
                                                <td data-label="Ledger">{order.creditTransactionId ? <span className="pill status-pill complete">Credited</span> : <span className="pill status-pill pending">Pending</span>}</td>
                                                <td data-label="Created / captured">
                                                    <div className="table-metric-stack">
                                                        <span>Created {formatDate(order.createdAt)}</span>
                                                        <span>Captured {order.capturedAt ? formatDate(order.capturedAt) : '—'}</span>
                                                    </div>
                                                </td>
                                                <td data-label="Action">
                                                    {order.status === 'CAPTURED' ? <span className="muted">Complete</span> : (
                                                        <button className="button compact-button" type="button" onClick={() => handleCapturePayPalOrder(order.providerOrderId)} disabled={capturingOrderId === order.providerOrderId}>
                                                            {capturingOrderId === order.providerOrderId ? 'Capturing...' : 'Confirm capture'}
                                                        </button>
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            <PaginationControls label="Recharge history" totalItems={recharges.length} page={billingPagination.page} onPageChange={setBillingPage} />
                        </>
                    ) : null}
                </section>
            </motion.div>
        );
    };

    const renderProductTour = () => {
        if (!tourOpen || !currentTourStep) return null;

        return (
            <div className="tour-overlay" role="presentation" onClick={markTourDismissed}>
                <motion.article
                    className="tour-card"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="product-tour-title"
                    aria-describedby="product-tour-copy"
                    tabIndex={-1}
                    ref={tourDialogRef}
                    onClick={(e) => e.stopPropagation()}
                    initial={{ opacity: 0, y: 10, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                >
                    <div className="tour-card-top">
                        <span className="tour-step-label">Step {tourStepIndex + 1} of {DASHBOARD_TOUR_STEPS.length}</span>
                        <button className="tour-skip-btn" type="button" onClick={markTourDismissed}>Skip tour</button>
                    </div>

                    <h2 id="product-tour-title" className="tour-card-title">{currentTourStep.title}</h2>
                    <p id="product-tour-copy" className="tour-card-text">{currentTourStep.text}</p>

                    <div className="tour-dots">
                        {DASHBOARD_TOUR_STEPS.map((step, index) => (
                            <span key={step.id} className={`tour-dot ${index === tourStepIndex ? 'active' : ''}`} />
                        ))}
                    </div>

                    <div className="tour-card-footer">
                        <button className="button" type="button" onClick={goToPreviousTourStep} disabled={isFirstTourStep}>Back</button>
                        <button className="button primary" type="button" onClick={goToNextTourStep}>
                            {isLastTourStep ? 'Done' : 'Next'}
                        </button>
                    </div>

                    <div className="tour-arrow" />
                </motion.article>
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
                        <button className="button" type="button" onClick={loadAll}>
                            <RefreshCcw size={16} /> Refresh all
                        </button>
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
                {activeView === 'submit' && <div className="dashboard-grid operations-grid">{renderSubmitForm()}</div>}
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
                    </motion.div>
                </AnimatePresence>
            </section>
            {renderCreateKeyDialog()}
            {renderDeleteKeyDialog()}
            {renderProductTour()}
        </main>
    );
}
