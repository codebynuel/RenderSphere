import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Download, RefreshCcw } from 'lucide-react';
import { api, formatDate, formatDuration, formatUsd } from '../utils/api';

const ACTIVE_STATUSES = new Set(['SUBMITTED', 'DISPATCHING', 'IN_QUEUE', 'IN_PROGRESS', 'RUNNING']);

function DetailItem({ label, value }) {
    return (
        <div className="job-detail-item">
            <span>{label}</span>
            <strong>{value || '—'}</strong>
        </div>
    );
}

function statusTone(status) {
    if (status === 'COMPLETED') return 'complete';
    if (status === 'FAILED' || status === 'DISPATCH_FAILED') return 'failed';
    if (status === 'CANCELLED') return 'cancelled';
    if (ACTIVE_STATUSES.has(status)) return 'active';
    return 'pending';
}

function dateOrDash(value) {
    return value ? formatDate(value) : '—';
}

export default function JobDetails({ jobId, onBack }) {
    const [job, setJob] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const fetchJob = useCallback(async () => {
        const response = await api(`/api/job-status/${encodeURIComponent(jobId)}`);
        if (!response.job) throw new Error('Job details were not returned.');
        return response.job;
    }, [jobId]);

    const loadJob = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            setJob(await fetchJob());
        } catch (loadError) {
            setError(loadError.message || 'Could not load job details.');
        } finally {
            setLoading(false);
        }
    }, [fetchJob]);

    useEffect(() => {
        let cancelled = false;
        fetchJob()
            .then((loadedJob) => {
                if (!cancelled) setJob(loadedJob);
            })
            .catch((loadError) => {
                if (!cancelled) setError(loadError.message || 'Could not load job details.');
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [fetchJob]);

    const settings = job?.settings || {};
    const isAnimation = Boolean(settings.isAnimation || settings.is_animation);
    const status = job?.status || 'UNKNOWN';
    const progress = Math.min(100, Math.max(0, Number(job?.progress?.percent || 0)));

    return (
        <section className="job-detail-page" aria-label="Job details">
            <div className="job-detail-toolbar">
                <button className="button" type="button" onClick={onBack}>
                    <ArrowLeft size={16} /> Back to render queue
                </button>
                <div className="job-detail-toolbar-actions">
                    {job?.downloadUrl && (
                        <a className="button primary" href={job.downloadUrl}>
                            <Download size={16} /> Download output
                        </a>
                    )}
                    <button className="button" type="button" onClick={loadJob} disabled={loading}>
                        <RefreshCcw size={16} className={loading ? 'spin' : ''} /> Refresh
                    </button>
                </div>
            </div>

            {loading && !job ? (
                <div className="job-detail-card panel" role="status">Loading job details…</div>
            ) : error && !job ? (
                <div className="job-detail-card panel">
                    <h2 id="job-detail-title">Could not load job</h2>
                    <p className="muted">{error}</p>
                    <button className="button" type="button" onClick={loadJob}>Try again</button>
                </div>
            ) : job ? (
                <div className="job-detail-card panel">
                    <div className="job-detail-heading">
                        <div>
                            <p className="eyebrow">Render record</p>
                            <h2 id="job-detail-title" title={job.fileName || job.jobId}>{job.fileName || job.jobId}</h2>
                            <code className="job-detail-id">{job.jobId}</code>
                        </div>
                        <span className={`pill status-pill ${statusTone(status)}`}>
                            {status}
                        </span>
                    </div>

                    {ACTIVE_STATUSES.has(status) && (
                        <div className="job-detail-progress">
                            <div className="job-detail-progress-label">
                                <span>Progress</span>
                                <strong>{progress}%</strong>
                            </div>
                            <div className="progress-track" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label={`Render progress ${progress}%`}>
                                <div className="progress-fill" style={{ width: `${progress}%` }} />
                            </div>
                            {job.progress?.message && <p className="muted">{job.progress.message}</p>}
                        </div>
                    )}

                    <section className="job-detail-section" aria-labelledby="job-detail-render">
                        <h3 id="job-detail-render">Render settings</h3>
                        <div className="job-detail-grid">
                            <DetailItem label="Project" value={job.project?.name || 'Unassigned'} />
                            <DetailItem label="Type" value={isAnimation ? 'Animation' : 'Still frame'} />
                            <DetailItem label="Engine" value={settings.engine} />
                            <DetailItem label="Samples" value={settings.samples} />
                            <DetailItem label="Resolution" value={settings.resolutionPct || settings.resolution_pct ? `${settings.resolutionPct || settings.resolution_pct}%` : null} />
                            <DetailItem label="Output format" value={settings.outputFormat || settings.output_format} />
                            <DetailItem label="Scene" value={settings.scene || 'Default'} />
                            <DetailItem label="Camera" value={settings.camera || 'Scene camera'} />
                            {isAnimation && (
                                <>
                                    <DetailItem label="Frame range" value={`${settings.startFrame ?? settings.start_frame ?? 1}–${settings.endFrame ?? settings.end_frame ?? settings.startFrame ?? settings.start_frame ?? 1}`} />
                                    <DetailItem label="Frame step" value={settings.frameStep || settings.frame_step || 1} />
                                </>
                            )}
                        </div>
                    </section>

                    <section className="job-detail-section" aria-labelledby="job-detail-billing">
                        <h3 id="job-detail-billing">Timeline &amp; billing</h3>
                        <div className="job-detail-grid">
                            <DetailItem label="Submitted" value={dateOrDash(job.createdAt)} />
                            <DetailItem label="Last updated" value={dateOrDash(job.updatedAt)} />
                            <DetailItem label="Dispatched" value={dateOrDash(job.dispatchedAt)} />
                            <DetailItem label="Completed" value={dateOrDash(job.completedAt)} />
                            <DetailItem label="Failed" value={dateOrDash(job.failedAt)} />
                            <DetailItem label="Duration" value={job.billableSeconds ? formatDuration(job.billableSeconds) : '—'} />
                            <DetailItem label="Cost" value={job.priceUsd != null ? formatUsd(job.priceUsd) : '—'} />
                            <DetailItem label="Estimated cost" value={job.estimatedCostUsd != null ? formatUsd(job.estimatedCostUsd) : '—'} />
                            <DetailItem label="Reserved credits" value={job.reservedCreditsUsd != null ? formatUsd(job.reservedCreditsUsd) : '—'} />
                            <DetailItem label="Billing state" value={job.billingState} />
                        </div>
                    </section>

                    {job.error && (
                        <div className="job-detail-message job-detail-error">
                            <strong>Render error</strong>
                            <p>{job.error}</p>
                        </div>
                    )}
                    {!ACTIVE_STATUSES.has(status) && job.progress?.message && (
                        <div className="job-detail-message">
                            <strong>Last progress update</strong>
                            <p>{job.progress.message}</p>
                        </div>
                    )}
                    {error && <p className="job-detail-refresh-error" role="status">{error}</p>}
                </div>
            ) : null}
        </section>
    );
}
