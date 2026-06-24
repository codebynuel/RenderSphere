import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { toast } from 'react-hot-toast';
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

export default function Auth() {
    const [mode, setMode] = useState('register');
    const [config, setConfig] = useState(null);
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [inviteCode, setInviteCode] = useState('');
    const [loading, setLoading] = useState(false);
    const [errorKey, setErrorKey] = useState(0);
    
    const navigate = useNavigate();
    const { user, reloadUser, loading: authLoading } = useAuth();

    useEffect(() => {
        if (!authLoading && user) {
            navigate('/app');
        }
    }, [user, authLoading, navigate]);

    useEffect(() => {
        const fetchConfig = async () => {
            try {
                const data = await api('/api/config');
                setConfig(data);
            } catch {
                setConfig(null);
            }
        };
        fetchConfig();
    }, []);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);

        const body = { email, password };
        if (mode === 'register') {
            if (name.trim()) body.name = name.trim();
            if (config?.inviteRequired) body.inviteCode = inviteCode;
        }

        try {
            await api(`/api/auth/${mode}`, {
                method: 'POST',
                body: JSON.stringify(body),
            });
            await reloadUser();
            toast.success(mode === 'register' ? 'Account created successfully' : 'Logged in successfully');
            navigate('/app');
        } catch (error) {
            toast.error(error.message || 'Authentication failed');
            setErrorKey((k) => k + 1);
        } finally {
            setLoading(false);
        }
    };

    if (authLoading || user) return null;

    return (
        <main className="auth-page-v2">
            <div className="auth-bg-glow" aria-hidden="true" />

            <motion.div
                className="auth-card-v2"
                key={errorKey}
                initial={{ opacity: 0, y: 24, scale: 0.97 }}
                animate={errorKey > 0 ? { x: [0, -8, 8, -6, 6, -3, 3, 0] } : { opacity: 1, y: 0, scale: 1 }}
                transition={errorKey > 0 ? { duration: 0.35 } : { duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            >
                <div className="auth-card-header">
                    <BrandMark />
                    <h1>RenderSphere</h1>
                    <p className="muted">
                        {mode === 'register'
                            ? 'Create an account to get started with cloud rendering.'
                            : 'Welcome back. Log in to your workspace.'}
                    </p>
                </div>

                <div className="auth-mode-tabs" role="tablist" aria-label="Authentication">
                    <button
                        className={`auth-mode-tab ${mode === 'register' ? 'active' : ''}`}
                        type="button"
                        onClick={() => setMode('register')}
                    >
                        Register
                    </button>
                    <button
                        className={`auth-mode-tab ${mode === 'login' ? 'active' : ''}`}
                        type="button"
                        onClick={() => setMode('login')}
                    >
                        Log in
                    </button>
                </div>

                <form className="auth-form-v2" onSubmit={handleSubmit}>
                    <div className="auth-field">
                        <label htmlFor="auth-email">Email</label>
                        <input
                            id="auth-email"
                            type="email"
                            autoComplete="email"
                            required
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder="you@example.com"
                        />
                    </div>
                    {mode === 'register' && (
                    <div className="auth-field">
                        <label htmlFor="auth-name">Name (optional)</label>
                        <input
                            id="auth-name"
                            type="text"
                            autoComplete="name"
                            maxLength={80}
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Your display name"
                        />
                    </div>
                    )}
                    <div className="auth-field">
                        <label htmlFor="auth-password">Password</label>
                        <input
                            id="auth-password"
                            type="password"
                            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                            minLength={10}
                            required
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder={mode === 'register' ? 'At least 10 characters' : 'Your password'}
                        />
                    </div>
                    {mode === 'register' && config?.inviteRequired && (
                        <div className="auth-field">
                            <label htmlFor="auth-invite">Invite code</label>
                            <input
                                id="auth-invite"
                                type="password"
                                autoComplete="off"
                                required
                                value={inviteCode}
                                onChange={(e) => setInviteCode(e.target.value)}
                                placeholder="Enter your invite code"
                            />
                        </div>
                    )}
                    <button className="auth-submit" type="submit" disabled={loading}>
                        {loading ? (
                            <span className="auth-spinner" />
                        ) : mode === 'register' ? (
                            'Create account'
                        ) : (
                            'Log in'
                        )}
                    </button>
                </form>

                <p className="auth-footer-text">
                    {mode === 'register' ? (
                        <>Already have an account?{' '}<button type="button" className="auth-link-btn" onClick={() => setMode('login')}>Log in</button></>
                    ) : (
                        <>Don't have an account?{' '}<button type="button" className="auth-link-btn" onClick={() => setMode('register')}>Register</button></>
                    )}
                </p>
            </motion.div>
        </main>
    );
}
