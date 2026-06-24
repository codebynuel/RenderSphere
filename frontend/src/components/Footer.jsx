import { Link } from 'react-router-dom';

export default function Footer({ className = '' }) {
    return (
        <footer className={`footer${className ? ` ${className}` : ''}`}>
            <span>
                &copy; {new Date().getFullYear()}{' '}
                <a
                    className="footer-brand-link"
                    href="https://github.com/Ella-Labs"
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    Ella Labs &#8599;
                </a>. 
                All rights reserved.
            </span>
            <div className="footer-links">
                <a href="mailto:support@rendersphere.app">Support</a>
                <Link to="/pricing">Pricing</Link>
                <Link to="/legal/terms">Terms</Link>
                <Link to="/legal/privacy">Privacy</Link>
            </div>
        </footer>
    );
}
