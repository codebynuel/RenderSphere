import { motion } from 'framer-motion';
import { Activity, ArrowRight, CheckCircle2, Clock, CloudUpload, Download, FolderKanban, KeyRound, ShieldCheck, Timer, Users, WalletCards } from 'lucide-react';
import { Link } from 'react-router-dom';

const fadeUp = {
    initial: { opacity: 0, y: 18 },
    whileInView: { opacity: 1, y: 0 },
    viewport: { once: true },
    transition: { duration: 0.45 },
};

const metrics = [
    { label: 'Production flow', value: '5 steps', detail: 'Key, project, submit, monitor, deliver' },
    { label: 'Render types', value: 'Still + animation', detail: 'Single frames and zipped frame ranges' },
    { label: 'Pricing', value: '$0.01/GPU-sec', detail: 'One flat rate across all engines and jobs' },
];

const steps = [
    {
        number: '1',
        title: 'Connect Blender',
        text: 'Install the add-on, generate a scoped access key from the dashboard, and pair your Blender instance in seconds — no passwords exposed.',
    },
    {
        number: '2',
        title: 'Submit your scene',
        text: 'Choose Cycles or Eevee, set samples, frame range, and output format. One click dispatches your job to the render queue.',
    },
    {
        number: '3',
        title: 'Download results',
        text: 'Track progress live, watch costs in real time, and grab authenticated delivery links when your frames are ready.',
    },
];

const benefits = [
    { icon: Clock, title: 'Save time', text: 'No infrastructure to manage. From install to first render in under five minutes.' },
    { icon: Star, title: 'Simple pricing', text: 'One flat rate. No tiered feature gates, no complex node-hour formulas.' },
    { icon: Users, title: 'Team ready', text: 'Projects, keys, and billing are designed for teams, not just individuals.' },
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
    return (
        <>
            {/* ─── Hero ─────────────────────────────────────── */}
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
                        <a className="link-button primary" href="/downloads/rendersphere-blender-addon.zip">
                            <Download size={18} /> Download add-on
                        </a>
                        <Link className="link-button" to="/auth">
                            Get Started Free <ArrowRight size={16} />
                        </Link>
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

            {/* ─── Metrics strip ────────────────────────────── */}
            <section className="metric-strip" aria-label="RenderSphere highlights">
                {metrics.map((metric, index) => (
                    <motion.div className="metric-tile" key={metric.label} {...fadeUp} transition={{ duration: 0.45, delay: index * 0.06 }}>
                        <span>{metric.label}</span>
                        <strong>{metric.value}</strong>
                        <p>{metric.detail}</p>
                    </motion.div>
                ))}
            </section>

            {/* ─── How it works (numbered steps) ────────────── */}
            <section id="workflow" className="section steps-section">
                <motion.div className="section-copy" {...fadeUp}>
                    <p className="eyebrow">How it works</p>
                    <h2>Render in three steps.</h2>
                    <p className="muted">
                        No complex setup. Install the add-on, submit your scene, and download the results.
                    </p>
                </motion.div>
                <div className="steps-grid">
                    {steps.map((step, index) => (
                        <motion.article className="step-card" key={step.number} {...fadeUp} transition={{ duration: 0.45, delay: index * 0.1 }}>
                            <span className="step-number">{step.number}</span>
                            <h3>{step.title}</h3>
                            <p>{step.text}</p>
                        </motion.article>
                    ))}
                </div>
            </section>

            {/* ─── Benefits ─────────────────────────────────── */}
            <section id="benefits" className="section benefits-section">
                <motion.div className="section-copy" {...fadeUp}>
                    <p className="eyebrow">Why RenderSphere</p>
                    <h2>Built for artists who just want to render.</h2>
                </motion.div>
                <div className="benefits-grid">
                    {benefits.map((item, index) => {
                        const Icon = item.icon;
                        return (
                            <motion.article className="benefit-card" key={item.title} {...fadeUp} transition={{ duration: 0.45, delay: index * 0.08 }}>
                                <div className="benefit-icon-wrap">
                                    <Icon size={24} />
                                </div>
                                <h3>{item.title}</h3>
                                <p>{item.text}</p>
                            </motion.article>
                        );
                    })}
                </div>
            </section>

            {/* ─── Production workflow (existing) ─────────── */}
            <section className="section product-section">
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

            {/* ─── Assurance ────────────────────────────────── */}
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

            {/* ─── Pricing preview ──────────────────────────── */}
            <section className="section pricing-preview-section">
                <motion.div className="section-copy" {...fadeUp}>
                    <p className="eyebrow">Simple pricing</p>
                    <h2>Full access. One rate. No subscriptions.</h2>
                    <p className="muted">
                        Every account gets every feature. You only pay for GPU seconds at a flat <strong>$0.01/second</strong>.
                    </p>
                </motion.div>
                <motion.div className="pricing-preview-grid" {...fadeUp} transition={{ duration: 0.45, delay: 0.1 }}>
                    <div className="pricing-preview-card">
                        <h3>Starter</h3>
                        <div className="pricing-preview-price"><strong>$10</strong> <span>one-time</span></div>
                        <p>1,000 GPU-seconds to test the workflow.</p>
                        <Link className="button primary" to="/auth">Get Started</Link>
                    </div>
                    <div className="pricing-preview-card pricing-preview-card--featured">
                        <span className="pricing-preview-badge">Most popular</span>
                        <h3>Creator</h3>
                        <div className="pricing-preview-price"><strong>$25</strong> <span>one-time</span></div>
                        <p>2,500 GPU-seconds for regular rendering work.</p>
                        <Link className="button primary" to="/auth">Get Started</Link>
                    </div>
                    <div className="pricing-preview-card">
                        <h3>Studio</h3>
                        <div className="pricing-preview-price"><strong>$50</strong> <span>one-time</span></div>
                        <p>5,000 GPU-seconds for studios and heavy jobs.</p>
                        <Link className="button primary" to="/auth">Get Started</Link>
                    </div>
                </motion.div>
                <motion.div className="pricing-preview-cta" {...fadeUp} transition={{ duration: 0.45, delay: 0.2 }}>
                    <Link to="/pricing">View full pricing details <ArrowRight size={14} /></Link>
                </motion.div>
            </section>

            {/* ─── Final CTA ────────────────────────────────── */}
            <section className="section final-cta-section">
                <motion.div {...fadeUp}>
                    <p className="eyebrow">Ready to get started?</p>
                    <h2>From install to render in minutes.</h2>
                    <p className="muted">
                        Download the Blender add-on, create an account, and submit your first job — no credit card required to start.
                    </p>
                    <div className="hero-actions" style={{ justifyContent: 'center' }}>
                        <a className="link-button primary" href="/downloads/rendersphere-blender-addon.zip">
                            <Download size={18} /> Download add-on
                        </a>
                        <Link className="link-button" to="/auth">
                            Create free account <ArrowRight size={16} />
                        </Link>
                    </div>
                </motion.div>
            </section>
        </>
    );
}
