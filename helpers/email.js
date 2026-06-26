import { config } from './config.js';
import { logger } from './logger.js';

const RESEND_API_BASE = 'https://api.resend.com';

function resendHeaders() {
  return {
    'Authorization': `Bearer ${config.resendApiKey}`,
    'Content-Type': 'application/json',
  };
}

function fromAddress() {
  return config.emailFrom || 'RenderSphere <noreply@rendersphere.app>';
}

async function sendEmail({ to, subject, html, text }) {
  if (!config.resendApiKey) {
    logger.warn('Resend API key not configured — email not sent', { to, subject });
    return null;
  }

  try {
    const response = await fetch(`${RESEND_API_BASE}/emails`, {
      method: 'POST',
      headers: resendHeaders(),
      body: JSON.stringify({
        from: fromAddress(),
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        text,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Resend API error ${response.status}: ${errorBody}`);
    }

    const data = await response.json();
    logger.info('Email sent', { to, subject, resendId: data.id });
    return data;
  } catch (error) {
    logger.error('Failed to send email', { to, subject, error: error.message });
    return null;
  }
}

// --- Specific email templates ---

export async function sendVerificationEmail(email, name, token) {
  const url = `${config.publicUrl}/verify-email/${token}`;
  const displayName = name || email;
  const subject = 'Verify your email — RenderSphere';

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:20px;color:#1a1a2e;background:#f5f5f7">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:32px">
    <h2 style="margin:0 0 8px">Welcome to RenderSphere, ${displayName}!</h2>
    <p style="color:#666;line-height:1.6">Please verify your email address by clicking the button below.</p>
    <a href="${url}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px;margin:16px 0;font-weight:600">Verify email</a>
    <p style="color:#999;font-size:13px">Or copy this link into your browser:<br><code style="font-size:12px;word-break:break-all">${url}</code></p>
    <p style="color:#999;font-size:12px;border-top:1px solid #eee;padding-top:12px">If you didn't create this account, you can ignore this email.</p>
  </div>
</body>
</html>`;

  const text = `Welcome to RenderSphere, ${displayName}!\n\nPlease verify your email by visiting:\n${url}\n\nIf you didn't create this account, ignore this email.`;

  return sendEmail({ to: email, subject, html, text });
}

export async function sendPasswordResetEmail(email, name, token) {
  const url = `${config.publicUrl}/reset-password/${token}`;
  const displayName = name || email;
  const subject = 'Reset your password — RenderSphere';

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:20px;color:#1a1a2e;background:#f5f5f7">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:32px">
    <h2 style="margin:0 0 8px">Password reset request</h2>
    <p style="color:#666;line-height:1.6">Hi ${displayName}, we received a request to reset your password. Click the button below to set a new one. This link expires in 1 hour.</p>
    <a href="${url}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px;margin:16px 0;font-weight:600">Reset password</a>
    <p style="color:#999;font-size:13px">Or copy this link into your browser:<br><code style="font-size:12px;word-break:break-all">${url}</code></p>
    <p style="color:#999;font-size:12px;border-top:1px solid #eee;padding-top:12px">If you didn't request this, you can safely ignore this email. Your password won't change.</p>
  </div>
</body>
</html>`;

  const text = `Password reset request\n\nHi ${displayName}, we received a request to reset your password. Visit:\n${url}\n\nThis link expires in 1 hour.\n\nIf you didn't request this, ignore this email.`;

  return sendEmail({ to: email, subject, html, text });
}

export async function sendRenderCompleteEmail(email, name, job) {
  const displayName = name || email;
  const status = job.status === 'COMPLETED' ? 'completed' : 'failed';
  const subject = `Render ${status}: ${job.jobId.slice(0, 8)} — RenderSphere`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:20px;color:#1a1a2e;background:#f5f5f7">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:32px">
    <h2 style="margin:0 0 8px">Render ${status}!</h2>
    <p style="color:#666;line-height:1.6">Hi ${displayName}, your render job <strong>${job.jobId.slice(0, 8)}</strong> has ${status}.</p>
    ${job.status === 'COMPLETED' ? `
    <p style="color:#666">Duration: ${Math.round((job.billableSeconds || 0) / 60)} minutes<br>Cost: $${(job.priceUsd || 0).toFixed(2)}</p>
    <a href="${config.publicUrl}/app" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px;margin:16px 0;font-weight:600">View in dashboard</a>
    ` : `
    <p style="color:#666">Something went wrong during rendering. Check the job details for more information.</p>
    <a href="${config.publicUrl}/app" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px;margin:16px 0;font-weight:600">View details</a>
    `}
  </div>
</body>
</html>`;

  const text = `Render ${status}!\n\nHi ${displayName}, your render job ${job.jobId.slice(0, 8)} has ${status}.\n\nView in dashboard: ${config.publicUrl}/app`;

  return sendEmail({ to: email, subject, html, text });
}

export async function sendSpendAlertEmail(email, name, { jobId, actualCostUsd, alertThresholdUsd }) {
  const displayName = name || email;
  const subject = `Spend alert: $${actualCostUsd.toFixed(2)} for job ${jobId.slice(0, 8)} — RenderSphere`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:20px;color:#1a1a2e;background:#f5f5f7">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:32px">
    <h2 style="margin:0 0 8px">Render cost alert</h2>
    <p style="color:#666;line-height:1.6">Hi ${displayName}, your render job <strong>${jobId.slice(0, 8)}</strong> cost <strong>$${actualCostUsd.toFixed(2)}</strong>, which exceeded your alert threshold of $${alertThresholdUsd.toFixed(2)}.</p>
    <a href="${config.publicUrl}/app" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px;margin:16px 0;font-weight:600">View in dashboard</a>
  </div>
</body>
</html>`;

  const text = `Render cost alert\n\nHi ${displayName}, your render job ${jobId.slice(0, 8)} cost $${actualCostUsd.toFixed(2)}, which exceeded your alert threshold of $${alertThresholdUsd.toFixed(2)}.\n\nView in dashboard: ${config.publicUrl}/app`;

  return sendEmail({ to: email, subject, html, text });
}

export async function sendTeamInviteEmail(email, inviterName, teamName, inviteLink) {
  const subject = `${inviterName} invited you to ${teamName} — RenderSphere`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:20px;color:#1a1a2e;background:#f5f5f7">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:32px">
    <h2 style="margin:0 0 8px">Team invitation</h2>
    <p style="color:#666;line-height:1.6"><strong>${inviterName}</strong> has invited you to join <strong>${teamName}</strong> on RenderSphere.</p>
    <a href="${inviteLink}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px;margin:16px 0;font-weight:600">Join team</a>
    <p style="color:#999;font-size:13px">Or copy this link into your browser:<br><code style="font-size:12px;word-break:break-all">${inviteLink}</code></p>
  </div>
</body>
</html>`;

  const text = `${inviterName} invited you to ${teamName} on RenderSphere.\n\nJoin: ${inviteLink}`;

  return sendEmail({ to: email, subject, html, text });
}
