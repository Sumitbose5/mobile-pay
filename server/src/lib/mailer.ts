import nodemailer from 'nodemailer';
import { env, isTest } from '../config/env.js';
import { logger } from './logger.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

const transport = isTest
  ? nodemailer.createTransport({ jsonTransport: true })
  : nodemailer.createTransport(
      env.SMTP_HOST === 'smtp.gmail.com' || env.SMTP_USER?.endsWith('@gmail.com')
        ? {
            service: 'gmail',
            auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
          }
        : {
            host: env.SMTP_HOST,
            port: env.SMTP_PORT,
            secure: env.SMTP_PORT === 465,
            auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
          },
    );

/** Test-only inbox so integration tests can read verification and reset links. */
export const sentMail: MailMessage[] = [];

/** Test hook: swap the transport to simulate SMTP outages. */
let activeTransport: Pick<typeof transport, 'sendMail'> = transport;
export const __setMailTransportForTests = (t: Pick<typeof transport, 'sendMail'> | null): void => {
  activeTransport = t ?? transport;
};

/** The real send. Throws on failure so the email worker can retry with backoff. */
export async function deliverMail(message: MailMessage): Promise<void> {
  await activeTransport.sendMail({ from: env.MAIL_FROM, ...message });
}

/** Called by the email worker after a successful send, so tests can observe what actually went out. */
export const recordDelivered = (message: MailMessage): void => {
  if (isTest) sentMail.push(message);
};

const useQueue = !isTest || env.MAIL_VIA_QUEUE;

/**
 * Fire-and-forget. In production the message becomes a BullMQ `send-email` job (retried with backoff by the
 * worker), so an HTTP request never waits on SMTP and an SMTP outage never loses mail. Tests deliver inline
 * so existing flows stay synchronous, unless MAIL_VIA_QUEUE=true.
 */
export async function sendMail(message: MailMessage): Promise<void> {
  if (useQueue) {
    try {
      const { enqueueEmail } = await import('../queues/jobs.js');
      await enqueueEmail(message);
      return;
    } catch (err) {
      logger.error({ err, to: message.to }, 'Could not enqueue email; delivering inline');
    }
  }
  if (isTest) sentMail.push(message);
  try {
    await deliverMail(message);
  } catch (err) {
    logger.error({ err, to: message.to, subject: message.subject }, 'Failed to send email');
  }
}

const layout = (title: string, body: string) =>
  `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;color:#0f1f2e">
     <h2 style="margin:0 0 16px">${title}</h2>${body}
     <p style="color:#52606d;font-size:12px;margin-top:32px">MobilePay</p></div>`;

const button = (href: string, label: string) =>
  `<p><a href="${href}" style="background:#0f1f2e;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">${label}</a></p>
   <p style="font-size:12px;color:#52606d">Or open: ${href}</p>`;

export const mails = {
  verifyEmail: (to: string, name: string, token: string): MailMessage => {
    const link = `${env.CLIENT_ORIGIN}/verify-email?token=${token}`;
    return {
      to,
      subject: 'Verify your MobilePay email',
      text: `Hi ${name}, verify your email (valid for 24 hours): ${link}`,
      html: layout('Verify your email', `<p>Hi ${name}, confirm your email to activate your wallet.</p>${button(link, 'Verify email')}`),
    };
  },
  alreadyRegistered: (to: string): MailMessage => ({
    to,
    subject: 'You already have a MobilePay account',
    text: `Someone tried to sign up with this email. You already have an account: ${env.CLIENT_ORIGIN}/login. If this was not you, ignore this email.`,
    html: layout('You already have an account', `<p>Someone tried to sign up with this email.</p>${button(`${env.CLIENT_ORIGIN}/login`, 'Log in')}`),
  }),
  resetPassword: (to: string, token: string): MailMessage => {
    const link = `${env.CLIENT_ORIGIN}/reset-password?token=${token}`;
    return {
      to,
      subject: 'Reset your MobilePay password',
      text: `Reset your password (valid for 30 minutes): ${link}. If you did not request this, ignore this email.`,
      html: layout('Reset your password', `<p>This link is valid for 30 minutes.</p>${button(link, 'Reset password')}`),
    };
  },
  resetPin: (to: string, token: string): MailMessage => {
    const link = `${env.CLIENT_ORIGIN}/reset-pin?token=${token}`;
    return {
      to,
      subject: 'Reset your MobilePay transaction PIN',
      text: `Reset your transaction PIN (valid for 30 minutes): ${link}. If you did not request this, change your password.`,
      html: layout('Reset your transaction PIN', `<p>This link is valid for 30 minutes.</p>${button(link, 'Reset PIN')}`),
    };
  },
  security: (to: string, event: string): MailMessage => ({
    to,
    subject: `MobilePay security alert: ${event}`,
    text: `${event}. If this was not you, reset your password immediately.`,
    html: layout('Security alert', `<p>${event}.</p><p>If this was not you, reset your password immediately.</p>`),
  }),
};

/** Generic notification email used by the outbox-driven money events. */
export const notice = (to: string, subject: string, lines: string[]): MailMessage => ({
  to,
  subject,
  text: lines.join('\n'),
  html: layout(subject, lines.map((l) => `<p>${l}</p>`).join('') + button(`${env.CLIENT_ORIGIN}/transactions`, 'View activity')),
});
