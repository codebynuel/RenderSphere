import { createContext, useContext, useState, useEffect } from 'react';
import { api } from '../utils/api';

const AuthContext = createContext();

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);

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
        loadMe();
    }, []);

    const logout = async () => {
        try {
            await api('/api/auth/logout', { method: 'POST', body: '{}' });
        } catch {
            // Ignore
        }
        setUser(null);
    };

    return (
        <AuthContext.Provider value={{ user, loading, logout, reloadUser: loadMe, setUser }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    return useContext(AuthContext);
}
