import { motion } from 'framer-motion';

export default function Terms() {
    return (
        <main className="legal">
            <motion.article
                className="legal-card"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
            >
                <p className="eyebrow">Legal</p>
                <h1>Terms of Service</h1>
                <p className="legal-lede">By using RenderSphere, you agree to these terms.</p>
                
                <h2>1. Service Description</h2>
                <p>RenderSphere provides cloud rendering services for Blender files via RunPod infrastructure. We process your .blend files, execute the render using the specified settings, and return the output.</p>
                
                <h2>2. Acceptable Use</h2>
                <p>You may only upload valid .blend files. You agree not to upload malicious content, attempt to execute arbitrary code, or use the service for any illegal purpose.</p>

                <h2>3. Billing</h2>
                <p>Charges are calculated based on the actual render time (execution seconds) on RunPod. RenderSphere deducts this amount from your starter balance. We are not responsible for renders that take longer than expected due to complex scene settings.</p>

                <h2>4. Data Privacy</h2>
                <p>Your uploaded .blend files and rendered outputs are stored securely on Cloudflare R2. We do not use your files for any purpose other than fulfilling your render request. Please see our Privacy Policy for more details.</p>

                <h2>5. Limitation of Liability</h2>
                <p>RenderSphere is provided "as is" without warranties. We are not liable for any lost data, failed renders, or project delays. Please always keep backups of your original files.</p>
            </motion.article>
        </main>
    );
}
