import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { toast } from 'react-hot-toast';
import { api } from '../utils/api';
import { useAuth } from '../context/AuthContext';

export default function Auth() {
    const [mode, setMode] = useState('register');
    const [config, setConfig] = useState(null);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [inviteCode, setInviteCode] = useState('');
    const [loading, setLoading] = useState(false);
    
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
        if (mode === 'register' && config?.inviteRequired) {
            body.inviteCode = inviteCode;
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
        } finally {
            setLoading(false);
        }
    };

    if (authLoading || user) return null; // Avoid flashing the page while checking auth

    return (
        <main className="page">
            <section className="auth-layout">
                <motion.div 
                    className="workbench"
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.5 }}
                >
                    <div>
                        <p className="eyebrow">RenderSphere account</p>
                        <h2 style={{ margin: 0, fontSize: '32px', fontWeight: 500, lineHeight: 1.1, color: 'var(--text)' }}>
                            Sign in and continue to your render dashboard.
                        </h2>
                        <p className="lede">Use your account to manage access keys, submit renders from Blender, and track completed files.</p>
                    </div>
                    <div className="placeholder-shot image-shot" data-label="Account access">
                        <img src="https://images.unsplash.com/photo-1497366754035-f200968a6e72?auto=format&fit=crop&w=900&q=80" alt="Clean workstation for managing cloud rendering projects" />
                    </div>
                </motion.div>

                <motion.aside 
                    className="panel auth-panel"
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.5, delay: 0.1 }}
                >
                    <div className="panel-head">
                        <div>
                            <h2>{mode === 'register' ? 'Create account' : 'Log in'}</h2>
                            <p className="muted">After sign in you will be taken to /app.</p>
                        </div>
                    </div>

                    <div className="tabs" role="tablist" aria-label="Authentication">
                        <button 
                            className={`tab ${mode === 'register' ? 'active' : ''}`} 
                            type="button"
                            onClick={() => setMode('register')}
                        >
                            Register
                        </button>
                        <button 
                            className={`tab ${mode === 'login' ? 'active' : ''}`} 
                            type="button"
                            onClick={() => setMode('login')}
                        >
                            Log in
                        </button>
                    </div>

                    <form className="form" onSubmit={handleSubmit}>
                        <label>
                            Email
                            <input 
                                type="email" 
                                autoComplete="email" 
                                required 
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                            />
                        </label>
                        <label>
                            Password
                            <input 
                                type="password" 
                                autoComplete={mode === 'register' ? 'new-password' : 'current-password'} 
                                minLength={10} 
                                required 
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                            />
                        </label>
                        {mode === 'register' && config?.inviteRequired && (
                            <label>
                                Invite code
                                <input 
                                    type="password" 
                                    autoComplete="off" 
                                    required 
                                    value={inviteCode}
                                    onChange={(e) => setInviteCode(e.target.value)}
                                />
                            </label>
                        )}
                        <button className="button primary" type="submit" disabled={loading}>
                            {loading ? 'Processing...' : (mode === 'register' ? 'Create account' : 'Log in')}
                        </button>
                    </form>
                </motion.aside>
            </section>
        </main>
    );
}
