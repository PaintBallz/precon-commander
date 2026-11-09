// Outgoing email (password resets). Two ways to turn it on:
//   Cloudflare Email Sending: CF_EMAIL_ACCOUNT_ID + CF_EMAIL_TOKEN (a token
//     with the Email Sending permission) and MAIL_FROM on a domain that has
//     Email Sending enabled in Cloudflare.
//   Any SMTP server: SMTP_HOST, SMTP_USER, SMTP_PASS and MAIL_FROM
//     (SMTP_PORT defaults to 587).
// Without either the app still works: the admin hands out reset links instead.
import nodemailer from 'nodemailer';

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM, MAIL_FROM_NAME, CF_EMAIL_ACCOUNT_ID, CF_EMAIL_TOKEN } = process.env;
let transport = null;

const viaCloudflare = () => Boolean(CF_EMAIL_ACCOUNT_ID && CF_EMAIL_TOKEN && MAIL_FROM);
export const mailEnabled = () => viaCloudflare() || Boolean(SMTP_HOST && MAIL_FROM);
const fromName = MAIL_FROM_NAME || 'Pre-Con Commander';

// The last send, for the admin dashboard (no addresses kept).
export const lastMail = { at: null, ok: null, error: null };
export async function sendMail(msg) {
  try { await send(msg); Object.assign(lastMail, { at: new Date().toISOString(), ok: true, error: null }); }
  catch (err) {
    // A mail server's error can quote the recipient: keep addresses out of the dashboard and logs.
    err.message = String(err.message).replace(/[^\s<>"']+@[^\s<>"']+/g, '[address hidden]');
    Object.assign(lastMail, { at: new Date().toISOString(), ok: false, error: err.message });
    throw err;
  }
}
async function send({ to, subject, text, html }) {
  if (!mailEnabled()) throw new Error('Email is not configured');
  if (viaCloudflare()) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(CF_EMAIL_ACCOUNT_ID)}/email/sending/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CF_EMAIL_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, from: { address: MAIL_FROM, name: fromName }, subject, text, ...(html ? { html } : {}) }),
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) {
      throw new Error(`Cloudflare Email Sending ${res.status}: ${(json.errors || []).map(e => `${e.code} ${e.message}`).join('; ') || 'unknown error'}`);
    }
    if (json.result?.permanent_bounces?.length) throw new Error(`Email bounced for ${json.result.permanent_bounces.length} recipient(s)`);
    return;
  }
  const port = Number(SMTP_PORT || 587);
  transport ||= nodemailer.createTransport({
    host: SMTP_HOST, port, secure: port === 465,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
  await transport.sendMail({ from: `"${fromName}" <${MAIL_FROM}>`, to, subject, text, ...(html ? { html } : {}) });
}
