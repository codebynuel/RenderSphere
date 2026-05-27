import { Outlet, useLocation } from 'react-router-dom';
import Navbar from './Navbar';
import Footer from './Footer';

export default function Layout() {
    const location = useLocation();
    const isApp = location.pathname.startsWith('/app');

    return (
        <div className={`shell site-frame${isApp ? ' app-frame' : ''}`}>
            <Navbar />
            <Outlet />
            <Footer />
        </div>
    );
}
