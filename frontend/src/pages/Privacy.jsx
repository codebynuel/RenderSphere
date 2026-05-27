import { motion } from 'framer-motion';

export default function Privacy() {
    return (
        <main className="legal">
            <motion.article
                className="legal-card"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
            >
                <p className="eyebrow">Privacy</p>
                <h1>Privacy Policy</h1>
                <p className="legal-lede">How we handle your data.</p>

                <h2>Information Collection</h2>
                <p>We collect your email address for account management. Render jobs generate metadata (job IDs, duration, costs) which we store to provide you with your dashboard history.</p>

                <h2>File Storage</h2>
                <p>Your uploaded .blend files and completed renders are stored in our Cloudflare R2 buckets. These files are strictly used for your render jobs and are not accessed for any other purpose.</p>

                <h2>Third-Party Services</h2>
                <p>We use cloud render infrastructure to process your renders. When a job is dispatched, your file key and render settings are sent to our render processing environment. No personally identifiable information, such as your email, is included in render job payloads.</p>
                
                <h2>Data Deletion</h2>
                <p>You can request account deletion at any time by contacting support. This will remove your account details, access keys, and associated file references from our database.</p>
            </motion.article>
        </main>
    );
}
