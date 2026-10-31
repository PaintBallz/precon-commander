// Outgoing email (password resets) over any SMTP server. Turned on by setting
// SMTP_HOST, SMTP_USER, SMTP_PASS and MAIL_FROM (SMTP_PORT defaults to 587).
// Without them the app still works: the admin hands out reset links instead.
import nodemailer from 'nodemailer';

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM } = process.env;
let transport = null;

export const mailEnabled = () => Boolean(SMTP_HOST && MAIL_FROM);

export async function sendMail({ to, subject, text }) {
  if (!mailEnabled()) throw new Error('Email is not configured');
  const port = Number(SMTP_PORT || 587);
  transport ||= nodemailer.createTransport({
    host: SMTP_HOST, port, secure: port === 465,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
  await transport.sendMail({ from: MAIL_FROM, to, subject, text });
}
