import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Mail, Loader2, RefreshCw, AlertCircle, CheckCircle2 } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import { useAuth } from '../context/AuthContext';

function BrandMark() {
    return (
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <circle cx="16" cy="16" r="15" stroke="currentColor" strokeWidth="1.5" opacity="0.3" />
            <circle cx="16" cy="16" r="8" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="16" cy="16" r="3" fill="currentColor" />
        </svg>
    );
}

export default function VerifyEmailRequired() {
    const { user, reloadUser } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    const [resending, setResending] = useState(false);
    const [message, setMessage] = useState(null);

    const from = location.state?.from?.pathname || '/app';

    const handleResend = async () => {
        setResending(true);
        setMessage(null);
        try {
            await api('/api/auth/resend-verification', { method: 'POST', body: '{}' });
            setMessage({ type: 'success', text: 'Verification email sent! Check your inbox.' });
        } catch (error) {
            setMessage({ type: 'error', text: error.message || 'Failed to send verification email' });
        } finally {
            setResending(false);
        }
    };

    const handleCheckVerified = async () => {
        try {
            await reloadUser();
            // If we get here and user is verified, the RequireEmailVerified wrapper will redirect
        } catch {
            // Ignore
        }
    };

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
                    <h1>Verify your email</h1>
                    <p className="muted">
                        You need to verify your email address before accessing the dashboard.
                        We've sent a verification link to <strong>{user?.email}</strong>.
                    </p>
                </div>

                <div className="verify-email-content">
                    <div className="verify-email-icon">
                        <Mail size={48} style={{ color: 'var(--accent)' }} />
                    </div>

                    <p className="verify-email-desc">
                        Check your inbox (and spam folder) for an email from RenderSphere.
                        Click the link in that email to verify your address.
                    </p>

                    {message && (
                        <motion.div
                            className={`verify-message ${message.type}`}
                            initial={{ opacity: 0, y: -8 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.2 }}
                        >
                            {message.type === 'success' && <CheckCircle2 size={16} />}
                            {message.type === 'error' && <AlertCircle size={16} />}
                            <span>{message.text}</span>
                        </motion.div>
                    )}

                    <div className="verify-email-actions">
                        <button
                            className="button primary"
                            onClick={handleResend}
                            disabled={resending}
                        >
                            {resending ? (
                                <>
                                    <Loader2 size={16} className="spin" />
                                    Sending...
                                </>
                            ) : (
                                <>
                                    <RefreshCw size={16} />
                                    Resend verification email
                                </>
                            )}
                        </button>
                        <button
                            className="button"
                            onClick={handleCheckVerified}
                        >
                            I've verified — check again
                        </button>
                    </div>

                    <p className="verify-email-note">
                        Didn't receive the email? Make sure <code>noreply@rendersphere.app</code> isn't blocked,
                        then try resending.
                    </p>

                    <Link to="/auth" className="verify-email-back">
                        ← Back to login
                    </Link>
                </div>
            </motion.div>
            <style>{`
                @keyframes spin { to { transform: rotate(360deg); } }
                .spin { animation: spin 1s linear infinite; }
            `}</style>
        </main>
    );
}