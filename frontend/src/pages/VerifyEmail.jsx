import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { api } from '../utils/api';

function BrandMark() {
    return (
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <circle cx="16" cy="16" r="15" stroke="currentColor" strokeWidth="1.5" opacity="0.3" />
            <circle cx="16" cy="16" r="8" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="16" cy="16" r="3" fill="currentColor" />
        </svg>
    );
}

export default function VerifyEmail() {
    const { token } = useParams();
    const [status, setStatus] = useState('loading'); // loading, success, error
    const [errorMsg, setErrorMsg] = useState('');

    useEffect(() => {
        if (!token) {
            setStatus('error');
            setErrorMsg('No verification token provided.');
            return;
        }

        let cancelled = false;
        (async () => {
            try {
                await api(`/api/auth/verify-email/${token}`);
                if (!cancelled) setStatus('success');
            } catch (error) {
                if (!cancelled) {
                    setErrorMsg(error.message || 'Failed to verify email');
                    setStatus('error');
                }
            }
        })();

        return () => { cancelled = true; };
    }, [token]);

    return (
        <main className="auth-page-v2">
            <div className="auth-bg-glow" aria-hidden="true" />
            <motion.div
                className="auth-card-v2"
                initial={{ opacity: 0, y: 24, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            >
                <div className="auth-card-header">
                    <BrandMark />
                    {status === 'loading' && (
                        <>
                            <Loader2 size={32} className="spin" />
                            <h1>Verifying email...</h1>
                        </>
                    )}
                    {status === 'success' && (
                        <>
                            <CheckCircle2 size={32} style={{ color: 'var(--green)' }} />
                            <h1>Email verified!</h1>
                            <p className="muted">Your email has been verified. You can now receive notifications.</p>
                            <Link to="/app" className="auth-submit" style={{ display: 'inline-block', textAlign: 'center', marginTop: 16, textDecoration: 'none' }}>
                                Go to dashboard
                            </Link>
                        </>
                    )}
                    {status === 'error' && (
                        <>
                            <XCircle size={32} style={{ color: 'var(--danger)' }} />
                            <h1>Verification failed</h1>
                            <p className="muted">{errorMsg}</p>
                            <Link to="/app" className="auth-submit" style={{ display: 'inline-block', textAlign: 'center', marginTop: 16, textDecoration: 'none' }}>
                                Go to dashboard
                            </Link>
                        </>
                    )}
                </div>
            </motion.div>
            <style>{`
                @keyframes spin { to { transform: rotate(360deg); } }
                .spin { animation: spin 1s linear infinite; }
            `}</style>
        </main>
    );
}
