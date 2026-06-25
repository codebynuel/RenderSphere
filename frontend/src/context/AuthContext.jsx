/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api } from '../utils/api';

const AuthContext = createContext();

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);
    const [activeTeamId, setActiveTeamIdState] = useState(() => {
        try { return localStorage.getItem('renderSphere_activeTeamId') || ''; } catch { return ''; }
    });

    const setActiveTeamId = useCallback((id) => {
        setActiveTeamIdState(id);
        try { localStorage.setItem('renderSphere_activeTeamId', id || ''); } catch { /* noop */ }
    }, []);

    const loadMe = async () => {
        try {
            const data = await api('/api/auth/me');
            setUser(data.user);
        } catch {
            setUser(null);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        const timer = window.setTimeout(() => {
            loadMe();
        }, 0);
        return () => window.clearTimeout(timer);
    }, []);

    const logout = async () => {
        try {
            await api('/api/auth/logout', { method: 'POST', body: '{}' });
        } catch {
            // Ignore
        }
        setUser(null);
        setActiveTeamId('');
    };

    return (
        <AuthContext.Provider value={{ user, loading, logout, reloadUser: loadMe, setUser, activeTeamId, setActiveTeamId }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    return useContext(AuthContext);
}
