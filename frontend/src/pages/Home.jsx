import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAuth } from '../context/AuthContext';
import { Activity, CheckCircle2, CloudUpload, Download, FolderKanban, KeyRound, LayoutDashboard, ShieldCheck, Timer, WalletCards } from 'lucide-react';

const fadeUp = {
    initial: { opacity: 0, y: 18 },
    whileInView: { opacity: 1, y: 0 },
    viewport: { once: true },
    transition: { duration: 0.45 },
};

const metrics = [
    { label: 'Production flow', value: '5 steps', detail: 'Key, project, submit, monitor, deliver' },
    { label: 'Render types', value: 'Still + animation', detail: 'Single frames and zipped frame ranges' },
    { label: 'Storage path', value: 'Direct R2', detail: 'Authenticated downloads after completion' },
];

const workflow = [
    { icon: KeyRound, title: 'Secure access keys', text: 'Create scoped keys from the dashboard and connect Blender without exposing your account password.' },
    { icon: FolderKanban, title: 'Project organization', text: 'Group jobs by client, shot, sequence, experiment, or delivery milestone.' },
    { icon: CloudUpload, title: 'Blender submission', text: 'Choose engine, samples, frames, output format, then submit directly from your scene.' },
    { icon: Activity, title: 'Live job tracking', text: 'Follow queue state, render progress, costs, failures, and completed outputs in real time.' },
];

const assurances = [
    { icon: ShieldCheck, title: 'Private by default', text: 'Uploaded scenes and results are only used to fulfill your render request.' },
    { icon: Timer, title: 'Usage-aware rendering', text: 'Costs are tied to billable render time so teams can watch spend as jobs complete.' },
    { icon: WalletCards, title: 'Starter balance ready', text: 'Accounts can start testing renders without setting up complicated billing flows first.' },
];

export default function Home() {
    const { user } = useAuth();

    return (
        <>
            <main className="marketing-hero">
                <motion.div
                    className="marketing-copy"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5 }}
                >
                    <p className="eyebrow">Cloud rendering for Blender teams</p>
                    <h1>Render from Blender without babysitting infrastructure.</h1>
                    <p className="lede">
                        RenderSphere gives artists a clean path from scene submission to completed files: connect Blender,
                        organize projects, dispatch jobs, monitor progress, and download results from one production workspace.
                    </p>
                    <div className="hero-actions">
                        <Link className="link-button primary" to={user ? '/app' : '/auth'}>
                            <LayoutDashboard size={18} /> {user ? 'Open dashboard' : 'Start rendering'}
                        </Link>
                        <a className="link-button" href="/downloads/rendersphere-blender-addon.zip">
                            <Download size={18} /> Download add-on
                        </a>
                    </div>
                    <div className="hero-proof">
                        <span><CheckCircle2 size={16} /> Live progress updates</span>
                        <span><CheckCircle2 size={16} /> Project-scoped jobs</span>
                        <span><CheckCircle2 size={16} /> Authenticated file delivery</span>
                    </div>
                </motion.div>

                <motion.div
                    className="product-console"
                    initial={{ opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.5, delay: 0.12 }}
                    aria-label="RenderSphere product summary"
                >
                    <div className="console-topbar">
                        <span />
                        <span />
                        <span />
                    </div>
                    <div className="console-status">
                        <div>
                            <small>Current job</small>
                            <strong>Shot_040_product_turntable</strong>
                        </div>
                        <span className="pill pending">IN_PROGRESS</span>
                    </div>
                    <div className="console-progress">
                        <span style={{ width: '68%' }} />
                    </div>
                    <div className="console-grid">
                        <div><small>Engine</small><strong>Cycles</strong></div>
                        <div><small>Frames</small><strong>120</strong></div>
                        <div><small>Output</small><strong>PNG ZIP</strong></div>
                        <div><small>Project</small><strong>Client launch</strong></div>
                    </div>
                    <div className="console-list">
                        <span><CheckCircle2 size={16} /> Scene uploaded to R2</span>
                        <span><Activity size={16} /> Worker rendering frame range</span>
                        <span><Download size={16} /> Delivery link generated on completion</span>
                    </div>
                </motion.div>
            </main>

            <section className="metric-strip" aria-label="RenderSphere highlights">
                {metrics.map((metric, index) => (
                    <motion.div className="metric-tile" key={metric.label} {...fadeUp} transition={{ duration: 0.45, delay: index * 0.06 }}>
                        <span>{metric.label}</span>
                        <strong>{metric.value}</strong>
                        <p>{metric.detail}</p>
                    </motion.div>
                ))}
            </section>

            <section id="workflow" className="section product-section">
                <motion.div className="section-copy" {...fadeUp}>
                    <p className="eyebrow">Production workflow</p>
                    <h2>A render pipeline artists can understand in minutes.</h2>
                    <p className="muted">The dashboard mirrors the real production flow instead of hiding work behind infrastructure jargon.</p>
                </motion.div>
                <div className="feature-grid">
                    {workflow.map((item, index) => {
                        const Icon = item.icon;
                        return (
                            <motion.article className="feature-card" key={item.title} {...fadeUp} transition={{ duration: 0.45, delay: index * 0.08 }}>
                                <div className="feature-icon"><Icon size={20} /></div>
                                <h3>{item.title}</h3>
                                <p>{item.text}</p>
                            </motion.article>
                        );
                    })}
                </div>
            </section>

            <section className="section assurance-section">
                <motion.div className="section-copy" {...fadeUp}>
                    <p className="eyebrow">Built for confidence</p>
                    <h2>Clear controls for jobs, files, access, and cost.</h2>
                </motion.div>
                <div className="assurance-grid">
                    {assurances.map((item, index) => {
                        const Icon = item.icon;
                        return (
                            <motion.article className="assurance-card" key={item.title} {...fadeUp} transition={{ duration: 0.45, delay: index * 0.08 }}>
                                <Icon size={20} />
                                <div>
                                    <h3>{item.title}</h3>
                                    <p>{item.text}</p>
                                </div>
                            </motion.article>
                        );
                    })}
                </div>
            </section>
        </>
    );
}
