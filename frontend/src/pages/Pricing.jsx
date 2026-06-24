import { useCallback, useState } from 'react';
import { motion } from 'framer-motion';
import { Calculator, CheckCircle2, Clock, Cpu, Gauge, HelpCircle, Users, WalletCards } from 'lucide-react';
import { Link } from 'react-router-dom';

const PRICE_PER_SECOND = 0.00028;
const PRICE_PER_HOUR = PRICE_PER_SECOND * 3600;

const fadeUp = {
    initial: { opacity: 0, y: 18 },
    whileInView: { opacity: 1, y: 0 },
    viewport: { once: true },
    transition: { duration: 0.45 },
};

const packs = [
    {
        name: 'Starter',
        price: '$10',
        seconds: 36000,
        desc: 'A small credit pack to test the workflow and render a few test frames.',
        cta: 'Buy $10 pack',
        href: '/auth',
        featured: false,
    },
    {
        name: 'Creator',
        price: '$25',
        seconds: 90000,
        desc: 'The most popular pack for freelance artists and regular rendering work.',
        cta: 'Buy $25 pack',
        href: '/auth',
        featured: true,
    },
    {
        name: 'Studio',
        price: '$50',
        seconds: 180000,
        desc: 'For studios that need more capacity and longer render sessions.',
        cta: 'Buy $50 pack',
        href: '/auth',
        featured: false,
    },
];

const highlights = [
    { icon: WalletCards, text: 'All features unlocked — no tier restrictions' },
    { icon: Clock, text: 'Pay only for GPU seconds your renders consume' },
    { icon: Cpu, text: 'Flat $0.00028/sec ($1.00/hr) across all engines and frame types' },
    { icon: Gauge, text: 'No subscriptions, no recurring bills, no surprises' },
];

const faqs = [
    { q: 'What exactly do I pay for?', a: 'You only pay for GPU render time. Every second your job spends rendering on a worker deducts $0.00028 from your prepaid balance. Uploads, storage, and downloads are free.' },
    { q: 'Are there any feature restrictions?', a: 'No. Every account has full access to all features — unlimited projects, still frames and animations, team invites, custom output formats, everything. The only difference is how much render time you have in your balance.' },
    { q: 'What happens when my balance runs out?', a: 'Your renders will stop until you add more credits. You can purchase another prepaid pack or enter a custom top-up amount from the dashboard at any time. Unused credits never expire.' },
    { q: 'How long does a render take?', a: 'That depends on the scene complexity, engine, samples, and resolution. The dashboard shows an estimated cost before you submit, and you can track spend in real time as the job progresses.' },
    { q: 'What render engines are supported?', a: 'We support Cycles and Eevee. Both are billed at the same flat rate of $0.00028 per GPU-second.' },
    { q: 'Can I top up with a custom amount?', a: 'Yes. The dashboard supports entering any custom top-up amount within configurable limits, so you can add exactly the credits you need.' },
    { q: 'Do you offer education or non-profit discounts?', a: 'Yes. Contact us at support@rendersphere.app with your details and we will get back to you.' },
];

function formatSeconds(secs) {
    if (secs >= 3600) {
        const h = Math.floor(secs / 3600);
        const m = Math.round((secs % 3600) / 60);
        return m ? `${h}h ${m}m` : `${h}h`;
    }
    if (secs >= 60) return `${Math.round(secs / 60)}m`;
    return `${secs}s`;
}

export default function Pricing() {
    const [secondsPerFrame, setSecondsPerFrame] = useState(120);
    const [frameCount, setFrameCount] = useState(1);
    const [engine, setEngine] = useState('cycles');

    const costPerFrame = secondsPerFrame * PRICE_PER_SECOND;
    const totalCost = costPerFrame * frameCount;
    const totalSeconds = secondsPerFrame * frameCount;

    const handleSecondsChange = useCallback((event) => {
        const value = parseInt(event.target.value, 10);
        if (!isNaN(value) && value >= 1) setSecondsPerFrame(value);
    }, []);

    const handleFramesChange = useCallback((event) => {
        const value = parseInt(event.target.value, 10);
        if (!isNaN(value) && value >= 1) setFrameCount(value);
    }, []);

    return (
        <>
            <main className="pricing-hero">
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5 }}
                >
                    <p className="eyebrow">Simple pricing</p>
                    <h1 className="page-title">One rate. Full access. No subscriptions.</h1>
                    <p className="lede">
                        Every account gets every feature — unlimited projects, animations, team access, the works.
                        You only pay for the GPU seconds your renders actually use at a flat <strong>$0.00028/second ($1.00/hr)</strong>.
                        Buy prepaid credit packs, add them to your balance, and render until they run out.
                    </p>
                </motion.div>
            </main>

            <section className="pricing-highlights">
                {highlights.map((item, index) => {
                    const Icon = item.icon;
                    return (
                        <motion.div className="pricing-highlight-card" key={item.text} {...fadeUp} transition={{ duration: 0.45, delay: index * 0.06 }}>
                            <Icon size={20} />
                            <span>{item.text}</span>
                        </motion.div>
                    );
                })}
            </section>

            <section className="pricing-tiers">
                {packs.map((pack, index) => (
                    <motion.article
                        className={`pricing-card${pack.featured ? ' pricing-card--featured' : ''}`}
                        key={pack.name}
                        {...fadeUp}
                        transition={{ duration: 0.45, delay: index * 0.1 }}
                    >
                        {pack.featured && <span className="pricing-badge">Most popular</span>}
                        <div className="pricing-card-head">
                            <h2 className="pricing-name">{pack.name}</h2>
                            <div className="pricing-price">
                                <strong>{pack.price}</strong>
                                <span>one-time</span>
                            </div>
                            <p className="pricing-desc">{pack.desc}</p>
                        </div>
                        <div className="pricing-render-time">
                            <Clock size={18} />
                            <div>
                                <strong>{formatSeconds(pack.seconds)}</strong>
                                <span>of GPU render time</span>
                            </div>
                        </div>
                        <div className="pricing-card-foot">
                            <Link className="button primary" to={pack.href}>
                                {pack.cta}
                            </Link>
                        </div>
                    </motion.article>
                ))}
            </section>

            <section className="section pricing-calc-section">
                <motion.div className="section-copy" {...fadeUp}>
                    <p className="eyebrow">Cost calculator</p>
                    <h2>Estimate what your render will cost.</h2>
                    <p className="muted">
                        Tell us about your scene and we'll estimate the cost at our flat rate.
                        All prices are in USD.
                    </p>
                </motion.div>
                <motion.div className="pricing-calc" {...fadeUp} transition={{ duration: 0.45, delay: 0.1 }}>
                    <div className="pricing-calc-controls">
                        <div className="pricing-calc-field">
                            <label htmlFor="calc-engine">Render engine</label>
                            <select id="calc-engine" value={engine} onChange={(e) => setEngine(e.target.value)}>
                                <option value="cycles">Cycles (GPU)</option>
                                <option value="eevee">Eevee (GPU)</option>
                            </select>
                        </div>
                        <div className="pricing-calc-field">
                            <label htmlFor="calc-seconds">
                                Render time per frame <span className="subtle">(seconds)</span>
                            </label>
                            <div className="pricing-calc-slider-wrap">
                                <input
                                    id="calc-seconds"
                                    type="range"
                                    min={5}
                                    max={3600}
                                    step={5}
                                    value={secondsPerFrame}
                                    onChange={(e) => setSecondsPerFrame(Number(e.target.value))}
                                    className="pricing-calc-slider"
                                />
                                <input
                                    type="text"
                                    inputMode="numeric"
                                    value={secondsPerFrame}
                                    onChange={handleSecondsChange}
                                    className="pricing-calc-number"
                                />
                            </div>
                        </div>
                        <div className="pricing-calc-field">
                            <label htmlFor="calc-frames">
                                Number of frames <span className="subtle">(1 = still frame)</span>
                            </label>
                            <div className="pricing-calc-slider-wrap">
                                <input
                                    id="calc-frames"
                                    type="range"
                                    min={1}
                                    max={250}
                                    step={1}
                                    value={frameCount}
                                    onChange={(e) => setFrameCount(Number(e.target.value))}
                                    className="pricing-calc-slider"
                                />
                                <input
                                    type="text"
                                    inputMode="numeric"
                                    value={frameCount}
                                    onChange={handleFramesChange}
                                    className="pricing-calc-number"
                                />
                            </div>
                        </div>
                    </div>
                    <div className="pricing-calc-results">
                        <div className="pricing-calc-result-card">
                            <span className="pricing-calc-result-label">Cost per frame</span>
                            <strong className="pricing-calc-result-value">${costPerFrame.toFixed(4)}</strong>
                            <span className="pricing-calc-result-hint">{formatSeconds(secondsPerFrame)} @ $0.00028/sec</span>
                        </div>
                        <div className="pricing-calc-result-card pricing-calc-result-card--total">
                            <span className="pricing-calc-result-label">Total estimated cost</span>
                            <strong className="pricing-calc-result-value">${totalCost.toFixed(2)}</strong>
                            <span className="pricing-calc-result-hint">{formatSeconds(totalSeconds)} total GPU time</span>
                        </div>
                        <div className="pricing-calc-result-card pricing-calc-result-card--pack">
                            <span className="pricing-calc-result-label">Recommended pack</span>
                            <strong className="pricing-calc-result-value">
                                {totalCost <= 10 ? '$10 Starter' : totalCost <= 25 ? '$25 Creator' : totalCost <= 50 ? '$50 Studio' : '$50 Studio + custom top-up'}
                            </strong>
                            <span className="pricing-calc-result-hint">
                                {totalCost <= 10
                                    ? `$${(10 - totalCost).toFixed(2)} credit remaining`
                                    : totalCost <= 25
                                        ? `$${(25 - totalCost).toFixed(2)} credit remaining`
                                        : totalCost <= 50
                                            ? `$${(50 - totalCost).toFixed(2)} credit remaining`
                                            : 'Contact sales for bulk pricing'}
                            </span>
                        </div>
                    </div>
                </motion.div>
            </section>

            <section className="section pricing-compare-section">
                <motion.div className="section-copy" {...fadeUp}>
                    <p className="eyebrow">How we compare</p>
                    <h2>RenderSphere vs. other render farms.</h2>
                    <p className="muted">
                        Most render farms use complex tiered pricing (GHz-hours, node-hours, Ob-hours) with
                        different rates for different priorities. We keep it simple: one flat rate across a
                        dedicated <strong>24 GB GPU</strong>, all engines, all jobs, all priorities — starting at <strong>$1.00/hr</strong>.
                    </p>
                </motion.div>
                <motion.div className="pricing-compare-wrap" {...fadeUp} transition={{ duration: 0.45, delay: 0.15 }}>
                    <table className="pricing-compare">
                        <thead>
                            <tr>
                                <th>Feature</th>
                                <th className="col-rs">RenderSphere</th>
                                <th>GarageFarm</th>
                                <th>RebusFarm</th>
                                <th>Fox Renderfarm</th>
                                <th>SheepIt</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td>Pricing model</td>
                                <td className="col-rs"><strong>$0.00028 / GPU-sec</strong><br /><small>$1.00 / hr · 24 GB GPU</small></td>
                                <td>$0.024–$0.072 / GHz-hr<br />$1.12–$25.76 / node-hr</td>
                                <td>1.41¢ / GHz-hr<br />0.53¢ / Ob-hr</td>
                                <td>Varies by project</td>
                                <td>Free (community)</td>
                            </tr>
                            <tr>
                                <td>$10 buys you</td>
                                <td className="col-rs"><strong>~10h</strong> GPU render</td>
                                <td>~8.9 hrs (low, RTX 4000 Ada)<br />~6.7 hrs (med-low, A5000 24GB)</td>
                                <td>~7 hrs (GPU, estimate)</td>
                                <td>Varies</td>
                                <td>Free</td>
                            </tr>
                            <tr>
                                <td>$25 buys you</td>
                                <td className="col-rs"><strong>~25h</strong> GPU render</td>
                                <td>~22 hrs (low, RTX 4000 Ada)<br />~16.8 hrs (med-low, A5000 24GB)</td>
                                <td>~17.5 hrs (GPU, estimate)</td>
                                <td>Varies</td>
                                <td>Free</td>
                            </tr>
                            <tr>
                                <td>Engine pricing</td>
                                <td className="col-rs">Same rate for Cycles &amp; Eevee</td>
                                <td>Different rates per node type</td>
                                <td>Different rates CPU vs GPU</td>
                                <td>Different rates</td>
                                <td>N/A</td>
                            </tr>
                            <tr>
                                <td>Feature tiers</td>
                                <td className="col-rs"><strong>None</strong> — full access for all</td>
                                <td>Priority-based (3 tiers)</td>
                                <td>Single tier + volume discounts</td>
                                <td>Single tier</td>
                                <td>Single tier</td>
                            </tr>
                            <tr>
                                <td>Free trial</td>
                                <td className="col-rs">No — buy a pack, use it</td>
                                <td>Available</td>
                                <td>$29.38 free RenderPoints</td>
                                <td>$25 free trial</td>
                                <td>Always free</td>
                            </tr>
                            <tr>
                                <td>Subscriptions</td>
                                <td className="col-rs"><strong>No</strong> — prepaid only</td>
                                <td>No (prepaid credits)</td>
                                <td>No (RenderPoints)</td>
                                <td>No</td>
                                <td>No</td>
                            </tr>
                            <tr>
                                <td>Blender support</td>
                                <td className="col-rs">Cycles, Eevee</td>
                                <td>Cycles (CPU + GPU)</td>
                                <td>Cycles</td>
                                <td>Cycles, Eevee</td>
                                <td>Cycles, Eevee, Workbench</td>
                            </tr>
                            <tr>
                                <td>Security</td>
                                <td className="col-rs">Encrypted transfers &amp; storage</td>
                                <td>ISO 27001</td>
                                <td>ISO 27001, NDA</td>
                                <td>TPN-accredited</td>
                                <td>Community-run</td>
                            </tr>
                        </tbody>
                    </table>
                </motion.div>
            </section>

            <section className="section pricing-faq-section">
                <motion.div className="section-copy" {...fadeUp}>
                    <p className="eyebrow">FAQ</p>
                    <h2>Common questions about render pricing.</h2>
                </motion.div>
                <motion.div className="pricing-faq-grid" {...fadeUp} transition={{ duration: 0.45, delay: 0.15 }}>
                    {faqs.map((faq) => (
                        <details className="pricing-faq-item" key={faq.q}>
                            <summary>
                                <HelpCircle size={16} />
                                {faq.q}
                            </summary>
                            <p>{faq.a}</p>
                        </details>
                    ))}
                </motion.div>
            </section>
        </>
    );
}
