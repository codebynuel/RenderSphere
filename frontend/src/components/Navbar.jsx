import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { LogOut, Moon, Shield, Sun, WalletCards } from 'lucide-react';
import { formatUsd } from '../utils/api';

function getUserDisplayName(user) {
    return user?.name || user?.displayName || user?.email || 'Account';
}

function getUserInitial(user) {
    const displayName = getUserDisplayName(user).trim();
    return (displayName.charAt(0) || 'U').toUpperCase();
}

export default function Navbar({ theme = 'dark', onToggleTheme }) {
    const location = useLocation();
    const { user, logout } = useAuth();

    const isApp = location.pathname.startsWith('/app');
    const isAuth = location.pathname.startsWith('/auth');

    return (
        <header className="nav">
            <Link className="brand" to="/">RenderSphere</Link>
            <div className="nav-actions">
                <button
                    className="theme-toggle"
                    type="button"
                    onClick={onToggleTheme}
                    aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
                >
                    {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
                    <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
                </button>
                {isApp && (
                    <>
                        <div className="account-summary" aria-label="Signed-in account summary">
                            <div className="profile-avatar" aria-hidden="true">{getUserInitial(user)}</div>
                            <div className="account-copy">
                                <span className="account-name">{getUserDisplayName(user)}</span>
                                <span className="account-email">{user?.email || 'Not signed in'}</span>
                            </div>
                            <span className="account-balance" title="Current credit balance">
                                <WalletCards size={15} /> {formatUsd(user?.starterBalanceUsd)}
                            </span>
                        </div>
                        {user?.role === 'admin' && (
                            <Link className="link-button" to="/admin">
                                <Shield size={15} /> Admin
                            </Link>
                        )}
                        <button className="button" type="button" onClick={logout} title="Sign out">
                            <LogOut size={16} /> Sign out
                        </button>
                    </>
                )}
                {isAuth && (
                    <>
                        <Link className="link-button" to="/">Home</Link>
                    </>
                )}
                {!isApp && !isAuth && (
                    <Link className="link-button" to={user ? '/app' : '/auth'}>
                        {user ? 'Dashboard' : 'Login/Register'}
                    </Link>
                )}
            </div>
        </header>
    );
}
