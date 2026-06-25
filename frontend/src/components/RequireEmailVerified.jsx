import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function RequireEmailVerified() {
    const { user, loading } = useAuth();
    const location = useLocation();

    if (loading) {
        return null;
    }

    if (!user) {
        return <Navigate to="/auth" state={{ from: location }} replace />;
    }

    if (!user.emailVerifiedAt) {
        return <Navigate to="/verify-email-required" state={{ from: location }} replace />;
    }

    return <Outlet />;
}