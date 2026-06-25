import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { toast } from 'react-hot-toast';
import { api } from '../utils/api';
import { CheckCircle2, XCircle } from 'lucide-react';

function BrandMark() {
    return (
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <circle cx="16" cy="16" r="15" stroke="currentColor" strokeWidth="1.5" opacity="0.3" />
            <circle cx="16" cy="16" r="8" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="16" cy="16" r="3" fill="currentColor" />
        </svg>
    );
}

export default function ResetPassword() {
    const { token } = useParams();
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState('form'); // form, success, error
    const [errorMsg, setErrorMsg] = useState('');

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (password.length < 10) {
            toast.error('Password must be at least 10 characters');
            return;
        }
        if (password !== confirmPassword) {
            toast.error('Passwords do not match');
            return;
        }
        setLoading(true);
        try {
            await api(`/api/auth/reset-password/${token}`, {
                method: 'POST',
                body: JSON.stringify({ password }),
            });
            setStatus('success');
        } catch (error) {
            setErrorMsg(error.message || 'Failed to reset password');
            setStatus('error');
        } finally {
            setLoading(false);
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
                    {status === 'form' && <h1>Set new password</h1>}
                    {status === 'success' && <h1>Password updated</h1>}
                    {status === 'error' && <h1>Reset failed</h1>}
                </div>

                {status === 'form' && (
                    <form className="auth-form-v2" onSubmit={handleSubmit}>
                        <div className="auth-field">
                            <label htmlFor="new-password">New password</label>
                            <input
                                id="new-password"
                                type="password"
                                autoComplete="new-password"
                                minLength={10}
                                required
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="At least 10 characters"
                            />
                        </div>
                        <div className="auth-field">
                            <label htmlFor="confirm-password">Confirm password</label>
                            <input
                                id="confirm-password"
                                type="password"
                                autoComplete="new-password"
                                minLength={10}
                                required
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                placeholder="Repeat your password"
                            />
                        </div>
                        <button className="auth-submit" type="submit" disabled={loading || !password.trim() || !confirmPassword.trim()}>
                            {loading ? <span className="auth-spinner" /> : 'Reset password'}
                        </button>
                    </form>
                )}

                {status === 'success' && (
                    <div style={{ textAlign: 'center', padding: '20px 0' }}>
                        <CheckCircle2 size={40} style={{ color: 'var(--green)', marginBottom: 12 }} />
                        <p className="muted">Your password has been reset successfully.</p>
                        <Link to="/auth" className="auth-submit" style={{ display: 'inline-block', textAlign: 'center', marginTop: 16, textDecoration: 'none' }}>
                            Log in
                        </Link>
                    </div>
                )}

                {status === 'error' && (
                    <div style={{ textAlign: 'center', padding: '20px 0' }}>
                        <XCircle size={40} style={{ color: 'var(--danger)', marginBottom: 12 }} />
                        <p className="muted">{errorMsg}</p>
                        <Link to="/forgot-password" className="auth-submit" style={{ display: 'inline-block', textAlign: 'center', marginTop: 16, textDecoration: 'none' }}>
                            Request new reset link
                        </Link>
                    </div>
                )}
            </motion.div>
        </main>
    );
}
