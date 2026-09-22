'use strict';

// Sends via Resend's HTTP API using the platform's built-in fetch — no npm
// dependency needed, matching this backend's zero-dependency rule. Without
// RESEND_API_KEY set (e.g. running locally before it's configured), falls
// back to logging the code to the console instead of failing signup
// outright — same "demo credential printed to console" pattern already
// used for the admin bootstrap password and the seeded guide password.
const FROM = process.env.RESEND_FROM || 'High Route MTB <onboarding@resend.dev>';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function sendVerificationEmail(toEmail, name, code) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[email:dev-mode] Verification code for ${toEmail}: ${code}  (set RESEND_API_KEY to actually send this)`);
    return { delivered: false, mode: 'console' };
  }
  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [toEmail],
        subject: 'Verify your High Route MTB account',
        html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;">
          <h2 style="color:#C1461E;margin-bottom:4px;">High Route MTB Nepal</h2>
          <p>Hi ${escapeHtml(name)},</p>
          <p>Your verification code is:</p>
          <p style="font-size:32px;font-weight:bold;letter-spacing:6px;margin:16px 0;">${code}</p>
          <p style="color:#666;font-size:13px;">This code expires in 15 minutes. If you didn't request this, you can ignore this email.</p>
        </div>`,
      }),
    });
  } catch (err) {
    console.error('[email] Resend request failed', err.message);
    console.log(`[email:fallback] Verification code for ${toEmail}: ${code}`);
    return { delivered: false, mode: 'error', error: err.message };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('[email] Resend API error', res.status, text);
    // Don't throw — signup already succeeded server-side; log the code so
    // it's still recoverable (e.g. during a demo) even if delivery failed.
    console.log(`[email:fallback] Verification code for ${toEmail}: ${code}`);
    return { delivered: false, mode: 'error', status: res.status };
  }
  return { delivered: true, mode: 'resend' };
}

module.exports = { sendVerificationEmail };
