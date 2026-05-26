import { Link } from 'react-router-dom';

export default function Footer() {
    return (
        <footer className="footer">
            <span>
                &copy; {new Date().getFullYear()}{' '}
                <a 
                    href="https://github.com/Ella-Labs" 
                    target="_blank" 
                    rel="noopener noreferrer" 
                    style={{ color: 'aquamarine', textDecoration: 'none' }}
                >
                    Ella Labs &#8599;
                </a>. 
                All rights reserved.
            </span>
            <div className="footer-links">
                <a href="mailto:support@rendersphere.app">Support</a>
                <Link to="/legal/terms">Terms</Link>
                <Link to="/legal/privacy">Privacy</Link>
            </div>
        </footer>
    );
}
