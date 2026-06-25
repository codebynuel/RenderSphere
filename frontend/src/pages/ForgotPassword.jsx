import { useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { toast } from 'react-hot-toast';
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

export default function ForgotPassword() {
    const [email, setEmail] = useState('');
    const [loading, setLoading] = useState(false);
    const [sent, setSent] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        try {
            await api('/api/auth/forgot-password', {
                method: 'POST',
                body: JSON.stringify({ email }),
            });
            setSent(true);
        } catch (error) {
            toast.error(error.message || 'Failed to send reset email');
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
                    <h1>Reset password</h1>
                    {!sent ? (
                        <p className="muted">Enter your email and we'll send you a reset link.</p>
                    ) : (
                        <p className="muted">If an account exists with that email, we've sent a reset link. Check your inbox.</p>
                    )}
                </div>

                {!sent ? (
                    <form className="auth-form-v2" onSubmit={handleSubmit}>
                        <div className="auth-field">
                            <label htmlFor="reset-email">Email</label>
                            <input
                                id="reset-email"
                                type="email"
                                autoComplete="email"
                                required
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                placeholder="you@example.com"
                            />
                        </div>
                        <button className="auth-submit" type="submit" disabled={loading || !email.trim()}>
                            {loading ? <span className="auth-spinner" /> : 'Send reset link'}
                        </button>
                    </form>
                ) : (
                    <p className="auth-footer-text">
                        <Link to="/auth" className="auth-link-btn">Back to log in</Link>
                    </p>
                )}

                <p className="auth-footer-text">
                    <Link to="/auth" className="auth-link-btn">← Back to log in</Link>
                </p>
            </motion.div>
        </main>
    );
}
