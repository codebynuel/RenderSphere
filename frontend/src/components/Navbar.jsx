import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { formatBalance } from '../utils/api';
import { LogOut } from 'lucide-react';

export default function Navbar() {
    const location = useLocation();
    const { user, logout } = useAuth();

    const isApp = location.pathname.startsWith('/app');
    const isAuth = location.pathname.startsWith('/auth');

    return (
        <header className="nav">
            <Link className="brand" to="/">RenderSphere</Link>
            <div className="nav-actions">
                {isApp && (
                    <>
                        <span className="route-chip">/app</span>
                        {user && (
                            <span className="balance-chip">
                                Balance {formatBalance(user.starterBalanceUsd)}
                            </span>
                        )}
                        <span className="account-label">{user?.email || 'Not signed in'}</span>
                        <button className="button" type="button" onClick={logout} title="Sign out">
                            <LogOut size={16} /> Sign out
                        </button>
                    </>
                )}
                {isAuth && (
                    <>
                        <span className="route-chip">/auth</span>
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
