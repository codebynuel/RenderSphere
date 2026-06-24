import { motion } from 'framer-motion';
import { CheckCircle2, Clock, Cpu, Gauge, HelpCircle, Users, WalletCards } from 'lucide-react';
import { Link } from 'react-router-dom';

const PRICE_PER_SECOND = 0.01;

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
        seconds: 1000,
        desc: 'A small credit pack to test the workflow and render a few test frames.',
        cta: 'Buy $10 pack',
        href: '/auth',
        featured: false,
    },
    {
        name: 'Creator',
        price: '$25',
        seconds: 2500,
        desc: 'The most popular pack for freelance artists and regular rendering work.',
        cta: 'Buy $25 pack',
        href: '/auth',
        featured: true,
    },
    {
        name: 'Studio',
        price: '$50',
        seconds: 5000,
        desc: 'For studios that need more capacity and longer render sessions.',
        cta: 'Buy $50 pack',
        href: '/auth',
        featured: false,
    },
];

const highlights = [
    { icon: WalletCards, text: 'All features unlocked — no tier restrictions' },
    { icon: Clock, text: 'Pay only for GPU seconds your renders consume' },
    { icon: Cpu, text: 'Flat $0.01/sec across all engines and frame types' },
    { icon: Gauge, text: 'No subscriptions, no recurring bills, no surprises' },
];

const faqs = [
    { q: 'What exactly do I pay for?', a: 'You only pay for GPU render time. Every second your job spends rendering on a worker deducts $0.01 from your prepaid balance. Uploads, storage, and downloads are free.' },
    { q: 'Are there any feature restrictions?', a: 'No. Every account has full access to all features — unlimited projects, still frames and animations, team invites, custom output formats, everything. The only difference is how much render time you have in your balance.' },
    { q: 'What happens when my balance runs out?', a: 'Your renders will stop until you add more credits. You can purchase another prepaid pack or enter a custom top-up amount from the dashboard at any time. Unused credits never expire.' },
    { q: 'How long does a render take?', a: 'That depends on the scene complexity, engine, samples, and resolution. The dashboard shows an estimated cost before you submit, and you can track spend in real time as the job progresses.' },
    { q: 'What render engines are supported?', a: 'We support Cycles and Eevee. Both are billed at the same flat rate of $0.01 per GPU-second.' },
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
                        You only pay for the GPU seconds your renders actually use at a flat <strong>$0.01/second</strong>.
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

            <section className="section pricing-compare-section">
                <motion.div className="section-copy" {...fadeUp}>
                    <p className="eyebrow">How we compare</p>
                    <h2>RenderSphere vs. other render farms.</h2>
                    <p className="muted">
                        Most render farms use complex tiered pricing (GHz-hours, node-hours, Ob-hours) with
                        different rates for different priorities. We keep it simple: one flat rate across all
                        engines, all jobs, all priorities.
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
                                <td className="col-rs">Flat $0.01 / GPU-sec</td>
                                <td>$0.024–$0.072 / GHz-hr<br />$1.12–$25.76 / node-hr</td>
                                <td>1.41¢ / GHz-hr<br />0.53¢ / Ob-hr</td>
                                <td>Varies by project</td>
                                <td>Free (community)</td>
                            </tr>
                            <tr>
                                <td>$10 buys you</td>
                                <td className="col-rs"><strong>~16m 40s</strong> GPU render</td>
                                <td>~46 min (Low, CPU N5)</td>
                                <td>~47 min (CPU, base rate)</td>
                                <td>Varies</td>
                                <td>Free</td>
                            </tr>
                            <tr>
                                <td>$25 buys you</td>
                                <td className="col-rs"><strong>~41m 40s</strong> GPU render</td>
                                <td>~3.5 hrs (Low, CPU N5)</td>
                                <td>~2 hrs (CPU, base rate)</td>
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
