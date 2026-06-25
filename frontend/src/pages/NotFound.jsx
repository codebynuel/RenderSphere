import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Compass, Home, ArrowLeft } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';

const floatKeyframes = {
    animate: {
        y: [0, -8, 0],
        transition: {
            duration: 3.5,
            repeat: Infinity,
            ease: 'easeInOut',
        },
    },
};

const sphereGlow = {
    initial: { opacity: 0, scale: 0.6 },
    animate: {
        opacity: 1,
        scale: 1,
        transition: { duration: 0.6, ease: 'easeOut' },
    },
};

export default function NotFound() {
    const location = useLocation();
    const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

    useEffect(() => {
        const handleMouse = (e) => {
            setMousePos({ x: e.clientX, y: e.clientY });
        };
        window.addEventListener('mousemove', handleMouse);
        return () => window.removeEventListener('mousemove', handleMouse);
    }, []);

    const rotateX = ((mousePos.y / window.innerHeight) - 0.5) * 12;
    const rotateY = ((mousePos.x / window.innerWidth) - 0.5) * 12;

    return (
        <div className="not-found-page">
            {/* Background gradient spot that follows the mouse */}
            <div
                className="not-found-spot"
                style={{
                    left: `${mousePos.x}px`,
                    top: `${mousePos.y}px`,
                }}
            />

            <div className="not-found-content">
                {/* 404 Sphere */}
                <motion.div
                    className="not-found-sphere-wrap"
                    variants={sphereGlow}
                    initial="initial"
                    animate="animate"
                    style={{
                        perspective: '800px',
                    }}
                >
                    <motion.div
                        className="not-found-sphere"
                        animate={{
                            rotateX,
                            rotateY,
                        }}
                        transition={{ type: 'spring', stiffness: 60, damping: 30 }}
                    >
                        <div className="not-found-sphere-ring" />
                        <div className="not-found-sphere-ring ring-2" />
                        <div className="not-found-sphere-ring ring-3" />
                        <span className="not-found-404">404</span>
                    </motion.div>
                </motion.div>

                {/* Message */}
                <motion.div
                    className="not-found-text"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: 0.3 }}
                >
                    <h1 className="not-found-title">Lost in the sphere?</h1>
                    <p className="not-found-desc">
                        The page <span className="not-found-path">{location.pathname}</span> doesn't exist or has been moved.
                    </p>
                </motion.div>

                {/* Actions */}
                <motion.div
                    className="not-found-actions"
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.4, delay: 0.55 }}
                >
                    <Link to="/" className="not-found-btn not-found-btn-primary">
                        <Home size={16} />
                        Back to Home
                    </Link>
                    <button
                        className="not-found-btn not-found-btn-secondary"
                        onClick={() => window.history.back()}
                    >
                        <ArrowLeft size={16} />
                        Go Back
                    </button>
                    <Link to="/pricing" className="not-found-btn not-found-btn-ghost">
                        <Compass size={16} />
                        Explore Pricing
                    </Link>
                </motion.div>
            </div>
        </div>
    );
}
