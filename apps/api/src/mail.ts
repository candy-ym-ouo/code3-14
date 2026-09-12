import nodemailer from 'nodemailer';
import { config } from './config.js';

export const mailEnabled = Boolean(config.SMTP_HOST);

export const mailer = mailEnabled
  ? nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth:
        config.SMTP_USER && config.SMTP_PASSWORD
          ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD }
          : undefined,
    })
  : null;

export async function sendMail(to: string, subject: string, text: string) {
  if (!mailer) {
    throw new Error('SMTP is not configured');
  }
  await mailer.sendMail({ from: config.MAIL_FROM, to, subject, text });
}
