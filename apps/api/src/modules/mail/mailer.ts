import nodemailer, { type Transporter } from 'nodemailer';
import type { Env } from '../../env';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/** Messages "sent" when SMTP_URL is `json:`. For development and tests: nothing leaves the process. */
export const outbox: Mail[] = [];

export function mailEnabled(env: Pick<Env, 'SMTP_URL'>): boolean {
  return Boolean(env.SMTP_URL);
}

/** `Jumper <noreply@host>` derived from PUBLIC_URL unless MAIL_FROM is set. */
export function fromAddress(env: Pick<Env, 'MAIL_FROM' | 'PUBLIC_URL'>): string {
  if (env.MAIL_FROM) return env.MAIL_FROM;
  return `Jumper <noreply@${new URL(env.PUBLIC_URL).hostname}>`;
}

let transport: Transporter | null = null;
let transportUrl = '';

/**
 * Send an email. Without SMTP configured the message is written to the server log instead and `sent` is false, so a
 * self-hoster without a mail server can still copy a reset link out of the log (or generate one in Admin → Users).
 */
export async function sendMail(env: Env, mail: Mail, log: (msg: string) => void = (m) => process.stderr.write(`${m}\n`)): Promise<{ sent: boolean }> {
  if (!env.SMTP_URL) {
    log(JSON.stringify({ level: 'warn', msg: 'SMTP is not configured; email was not sent', to: mail.to, subject: mail.subject, body: mail.text, time: new Date().toISOString() }));
    return { sent: false };
  }
  if (env.SMTP_URL.startsWith('json:')) {
    outbox.push(mail);
    return { sent: true };
  }
  if (!transport || transportUrl !== env.SMTP_URL) {
    transport = nodemailer.createTransport(env.SMTP_URL);
    transportUrl = env.SMTP_URL;
  }
  await transport.sendMail({ from: fromAddress(env), to: mail.to, subject: mail.subject, text: mail.text });
  return { sent: true };
}
