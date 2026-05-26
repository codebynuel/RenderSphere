import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { toast } from 'react-hot-toast';
import { RefreshCcw, Eye, EyeOff, Copy, Trash2, Plus, ExternalLink } from 'lucide-react';
import { api, formatDate, formatDuration, formatUsd } from '../utils/api';
import { useAuth } from '../context/AuthContext';

export default function Dashboard() {
    const { user, loading: authLoading } = useAuth();
    const navigate = useNavigate();

    const [accessKeys, setAccessKeys] = useState([]);
    const [files, setFiles] = useState([]);
    const [jobs, setJobs] = useState([]);
    const [visibleKeyIds, setVisibleKeyIds] = useState(new Set());
    const [newKeyName, setNewKeyName] = useState('');
    const [creatingKey, setCreatingKey] = useState(false);
    
    // UI state
    const [loadingKeys, setLoadingKeys] = useState(true);
    const [loadingFiles, setLoadingFiles] = useState(true);
    const [loadingJobs, setLoadingJobs] = useState(true);
    
    useEffect(() => {
        if (!authLoading && !user) {
            navigate('/auth');
        }
    }, [user, authLoading, navigate]);

    const loadAccessKeys = async () => {
        setLoadingKeys(true);
        try {
            const data = await api('/api/auth/access-keys');
            setAccessKeys(data.accessKeys || []);
        } catch (error) {
            toast.error('Failed to load access keys: ' + error.message);
        } finally {
            setLoadingKeys(false);
        }
    };

    const loadFiles = async () => {
        setLoadingFiles(true);
        try {
            const data = await api('/api/rendered-files');
            setFiles(data.files || []);
            const unavailableCount = (data.files || []).filter((f) => f.downloadError).length;
            if (unavailableCount > 0) {
                toast.error(`${unavailableCount} download link(s) temporarily unavailable.`);
            }
        } catch (error) {
            toast.error('Failed to load files: ' + error.message);
        } finally {
            setLoadingFiles(false);
        }
    };

    const loadJobs = async () => {
        setLoadingJobs(true);
        try {
            const data = await api('/api/jobs');
            setJobs(data.jobs || []);
        } catch (error) {
            toast.error('Failed to load jobs: ' + error.message);
        } finally {
            setLoadingJobs(false);
        }
    };

    useEffect(() => {
        if (user) {
            setTimeout(() => {
                loadAccessKeys();
                loadFiles();
                loadJobs();
            }, 0);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user]);

    const handleCreateKey = async (e) => {
        e.preventDefault();
        if (!newKeyName.trim()) return;
        setCreatingKey(true);
        try {
            await api('/api/auth/access-keys', {
                method: 'POST',
                body: JSON.stringify({ name: newKeyName.trim() }),
            });
            setNewKeyName('');
            await loadAccessKeys();
            toast.success('Access key created.');
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
            setVisibleKeyIds(prev => {
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
            await loadAccessKeys();
            toast.success('Access key deleted.');
        } catch (error) {
            toast.error(error.message || 'Failed to delete key');
        }
    };

    const toggleKeyVisibility = (id) => {
        setVisibleKeyIds(prev => {
            const next = new Set(prev);
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

    if (authLoading || !user) return null;

    return (
        <main className="page">
            <section className="dashboard app-dashboard active">
                
                {/* Access Keys Panel */}
                <motion.div 
                    className="panel"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.4 }}
                >
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
                            onChange={e => setNewKeyName(e.target.value)}
                            disabled={creatingKey}
                        />
                        <button className="button primary" type="submit" disabled={creatingKey || !newKeyName.trim()}>
                            <Plus size={16} /> Create access key
                        </button>
                    </form>
                    
                    <div className="stack-list">
                        {loadingKeys ? <div className="muted">Loading access keys...</div> : 
                         accessKeys.length === 0 ? <div className="muted">No access keys yet.</div> :
                         accessKeys.map(key => (
                             <div className="stack-item" key={key.id}>
                                 <div className="stack-meta">
                                     <strong>{key.name || 'Access key'}</strong>
                                     <div className="subtle">Created {formatDate(key.createdAt)}</div>
                                 </div>
                                 <input 
                                     readOnly 
                                     value={visibleKeyIds.has(key.id) ? (key.token || key.preview) : key.preview}
                                     type={visibleKeyIds.has(key.id) ? 'text' : 'password'}
                                 />
                                 <div className="button-row compact-row">
                                     <button 
                                         className="button" 
                                         type="button" 
                                         disabled={!key.token}
                                         onClick={() => toggleKeyVisibility(key.id)}
                                         title={!key.token ? 'Full access keys are only shown when first created.' : ''}
                                     >
                                         {visibleKeyIds.has(key.id) ? <><EyeOff size={16} /> Hide</> : <><Eye size={16} /> Show</>}
                                     </button>
                                     <button 
                                         className="button" 
                                         type="button" 
                                         disabled={!key.token}
                                         onClick={() => copyToClipboard(key.token, key.name || 'access key')}
                                         title={!key.token ? 'Full access keys are only shown when first created.' : ''}
                                     >
                                         <Copy size={16} /> Copy
                                     </button>
                                     <button 
                                         className="button danger" 
                                         type="button"
                                         onClick={() => handleDeleteKey(key.id, key.name)}
                                     >
                                         <Trash2 size={16} /> Delete
                                     </button>
                                 </div>
                             </div>
                         ))}
                    </div>
                </motion.div>

                {/* Rendered Files Panel */}
                <motion.div 
                    className="panel"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.4, delay: 0.1 }}
                >
                    <div className="panel-head">
                        <div>
                            <h2>Rendered files</h2>
                            <p className="muted">Open completed outputs directly from the workspace.</p>
                        </div>
                        <button className="button" type="button" onClick={loadFiles} disabled={loadingFiles}>
                            <RefreshCcw size={16} className={loadingFiles ? 'spin' : ''} /> Refresh
                        </button>
                    </div>
                    <div className="stack-list">
                        {loadingFiles ? <div className="muted">Loading files...</div> : 
                         files.length === 0 ? <div className="muted">No rendered files yet.</div> :
                         files.map(file => (
                             <div className="stack-item" key={file.jobId}>
                                 <div className="stack-meta">
                                     <strong>{file.fileName || file.resultKey}</strong>
                                     <div className="subtle">Completed {formatDate(file.completedAt || file.createdAt)}</div>
                                     <div className="subtle">{formatDuration(file.billableSeconds)} render time / {formatUsd(file.priceUsd)} deducted</div>
                                 </div>
                                 <div className="button-row compact-row">
                                     {file.downloadUrl ? (
                                         <a 
                                             className="link-button" 
                                             href={file.downloadUrl} 
                                             target="_blank" 
                                             rel="noopener noreferrer"
                                         >
                                             <ExternalLink size={16} /> Open file
                                         </a>
                                     ) : (
                                         <button className="button" disabled>Open file</button>
                                     )}
                                     <button 
                                         className="button" 
                                         type="button" 
                                         disabled={!file.downloadUrl}
                                         onClick={() => copyToClipboard(new URL(file.downloadUrl, window.location.origin).href, 'link')}
                                     >
                                         <Copy size={16} /> Copy link
                                     </button>
                                 </div>
                             </div>
                         ))}
                    </div>
                </motion.div>

                {/* Recent Jobs Panel */}
                <motion.div 
                    className="panel full"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.4, delay: 0.2 }}
                >
                    <div className="panel-head">
                        <div>
                            <h2>Recent jobs</h2>
                            <p className="muted">Track queue, render, completion, and failure states here.</p>
                        </div>
                        <button className="button" type="button" onClick={loadJobs} disabled={loadingJobs}>
                            <RefreshCcw size={16} className={loadingJobs ? 'spin' : ''} /> Refresh
                        </button>
                    </div>
                    <div className="job-list">
                        {loadingJobs ? <div className="muted">Loading jobs...</div> : 
                         jobs.length === 0 ? <div className="muted">No jobs yet.</div> :
                         jobs.map(job => (
                             <div className="job-row" key={job.jobId}>
                                 <div>
                                     <div className="job-id">{job.jobId}</div>
                                     <div className="subtle" style={{ fontSize: '12px' }}>Submitted {formatDate(job.createdAt)}</div>
                                     <div className="subtle" style={{ fontSize: '12px' }}>
                                         {job.status === 'COMPLETED'
                                             ? `${formatDuration(job.billableSeconds)} / ${formatUsd(job.priceUsd)} deducted`
                                             : 'Billing appears after completion'}
                                     </div>
                                 </div>
                                 <div className={`pill ${job.status === 'FAILED' ? 'failed' : (job.status === 'COMPLETED' || job.status === 'CANCELLED' ? '' : 'pending')}`}>
                                     {job.status || 'SUBMITTED'}
                                 </div>
                             </div>
                         ))}
                    </div>
                </motion.div>
                
            </section>
        </main>
    );
}
