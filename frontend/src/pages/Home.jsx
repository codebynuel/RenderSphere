import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAuth } from '../context/AuthContext';
import { Download, LayoutDashboard } from 'lucide-react';

export default function Home() {
    const { user } = useAuth();

    return (
        <>
            <main className="hero">
                <motion.div 
                    className="hero-copy"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5 }}
                >
                    <h1>Experience Lightning⚡ fast renders</h1>
                    <p className="lede">
                        RenderSphere automatically packs the Blender scene, renders the frames and pulls the
                        result back without leaving your project.
                    </p>

                    <ul className="check-list">
                        <li>Access keys for Blender and automation</li>
                        <li>Still frames and zipped animation output</li>
                    </ul>

                    <div className="hero-actions">
                        <a className="link-button primary" href="/downloads/rendersphere-blender-addon.zip">
                            <Download size={18} /> Download add-on
                        </a>
                        <Link className="link-button" to={user ? '/app' : '/auth'}>
                            <LayoutDashboard size={18} /> {user ? 'Open dashboard' : 'Login/Register'}
                        </Link>
                    </div>
                </motion.div>

                <motion.div 
                    className="orbit-note"
                    initial={{ opacity: 0, scale: 0.8, rotate: -30 }}
                    animate={{ opacity: 1, scale: 1, rotate: -18 }}
                    transition={{ duration: 0.6, delay: 0.2 }}
                >
                    Direct R2<br />uploads and<br />cloud renders
                </motion.div>
            </main>

            <section className="screenshot-grid" aria-label="Product screenshots">
                <motion.div 
                    className="placeholder-shot image-shot" 
                    data-label="Blender add-on preview"
                    initial={{ opacity: 0, x: -20 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.5 }}
                >
                    <img src="https://images.unsplash.com/photo-1550745165-9bc0b252726f?auto=format&fit=crop&w=1200&q=80" alt="Computer workstation with visual production software" />
                </motion.div>
                <div className="mini-stack">
                    <motion.div 
                        className="mini-shot image-shot" 
                        data-label="Dashboard preview"
                        initial={{ opacity: 0, x: 20 }}
                        whileInView={{ opacity: 1, x: 0 }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.5, delay: 0.1 }}
                    >
                        <img src="https://images.unsplash.com/photo-1515879218367-8466d910aaa4?auto=format&fit=crop&w=800&q=80" alt="Dashboard and code interface on a monitor" />
                    </motion.div>
                    <motion.div 
                        className="mini-shot image-shot" 
                        data-label="Render output preview"
                        initial={{ opacity: 0, x: 20 }}
                        whileInView={{ opacity: 1, x: 0 }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.5, delay: 0.2 }}
                    >
                        <img src="https://images.unsplash.com/photo-1558494949-ef010cbdcc31?auto=format&fit=crop&w=800&q=80" alt="Cloud server infrastructure" />
                    </motion.div>
                </div>
            </section>

            <section id="workflow" className="section">
                <motion.h2
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.5 }}
                >
                    Built for direct uploads, fast dispatch, and clean delivery.
                </motion.h2>
                <div className="steps">
                    {[
                        { step: '01 / Connect', text: 'Install the add-on, paste your dashboard access key, and test the connection from Blender preferences.' },
                        { step: '02 / Submit', text: 'Pick engine, samples, frame range, output format, and confirm the render before any upload starts.' },
                        { step: '03 / Receive', text: 'Finished stills open back in Blender. Animation jobs download as zip files to your chosen folder.' }
                    ].map((item, index) => (
                        <motion.div 
                            className="card" 
                            key={index}
                            initial={{ opacity: 0, y: 20 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true }}
                            transition={{ duration: 0.5, delay: index * 0.1 }}
                        >
                            <strong>{item.step}</strong>
                            <p>{item.text}</p>
                        </motion.div>
                    ))}
                </div>
            </section>
        </>
    );
}
