import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import Navbar from './Navbar';
import Footer from './Footer';

const THEME_STORAGE_KEY = 'rendersphere-theme';

function getPreferredTheme() {
    if (typeof window === 'undefined') return 'dark';

    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (storedTheme === 'light' || storedTheme === 'dark') return storedTheme;

    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export default function Layout() {
    const location = useLocation();
    const isApp = location.pathname.startsWith('/app');
    const [theme, setTheme] = useState(getPreferredTheme);

    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.colorScheme = theme;
        window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    }, [theme]);

    const toggleTheme = () => {
        setTheme((currentTheme) => (currentTheme === 'dark' ? 'light' : 'dark'));
    };

    return (
        <div className={`shell site-frame${isApp ? ' app-frame' : ''}`}>
            <Navbar theme={theme} onToggleTheme={toggleTheme} />
            <AnimatePresence mode="wait">
                <motion.div
                    key={location.pathname}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.18, ease: 'easeInOut' }}
                    style={{ display: 'contents' }}
                >
                    <Outlet />
                </motion.div>
            </AnimatePresence>
            <Footer className={isApp ? 'app-footer' : ''} />
        </div>
    );
}
