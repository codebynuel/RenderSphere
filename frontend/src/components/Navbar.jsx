import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { HelpCircle, LogOut, Moon, Shield, Sun, WalletCards } from 'lucide-react';
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
    const [profileOpen, setProfileOpen] = useState(false);
    const profileRef = useRef(null);

    const isApp = location.pathname.startsWith('/app');
    const isAuth = location.pathname.startsWith('/auth');

    const handleClickOutside = useCallback((event) => {
        if (profileRef.current && !profileRef.current.contains(event.target)) {
            setProfileOpen(false);
        }
    }, []);

    useEffect(() => {
        if (!profileOpen) return;
        document.addEventListener('pointerdown', handleClickOutside);
        return () => document.removeEventListener('pointerdown', handleClickOutside);
    }, [profileOpen, handleClickOutside]);

    const handleProfileToggle = () => {
        setProfileOpen((prev) => !prev);
    };

    const handleLogout = async () => {
        setProfileOpen(false);
        await logout();
    };

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
                        <span className="account-balance" title="Current credit balance">
                            <WalletCards size={15} /> {formatUsd(user?.starterBalanceUsd)}
                        </span>
                        <div className="profile-dropdown-wrap" ref={profileRef}>
                            <button
                                className="profile-trigger"
                                type="button"
                                onClick={handleProfileToggle}
                                aria-label="Account menu"
                                aria-expanded={profileOpen}
                            >
                                <span className="profile-avatar" aria-hidden="true">{getUserInitial(user)}</span>
                            </button>
                            {profileOpen && (
                                <div className="profile-dropdown">
                                    <div className="profile-dropdown-head">
                                        <span className="profile-avatar small" aria-hidden="true">{getUserInitial(user)}</span>
                                        <div className="profile-dropdown-copy">
                                            <span className="profile-dropdown-name">{getUserDisplayName(user)}</span>
                                            <span className="profile-dropdown-email">{user?.email || ''}</span>
                                        </div>
                                    </div>
                                    <div className="profile-dropdown-actions">
                                        <button className="profile-dropdown-item" type="button" onClick={() => { setProfileOpen(false); window.dispatchEvent(new CustomEvent('start-tour')); }}>
                                            <HelpCircle size={15} /> Product tour
                                        </button>
                                        {user?.role === 'admin' && (
                                            <Link className="profile-dropdown-item" to="/admin" onClick={() => setProfileOpen(false)}>
                                                <Shield size={15} /> Admin panel
                                            </Link>
                                        )}
                                        <button className="profile-dropdown-item" type="button" onClick={handleLogout}>
                                            <LogOut size={15} /> Sign out
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
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
