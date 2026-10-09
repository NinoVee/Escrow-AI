import { env } from "../env";

/**
 * Email delivery. SMTP is a standard protocol, so a live adapter is provided
 * (nodemailer). Without SMTP configuration, messages are captured in the demo
 * outbox (the OutboundMessage row) and never delivered.
 */
export interface EmailProvider {
  readonly id: string;
  readonly delivers: boolean;
  send(msg: { messageId: string; to: string[]; subject: string; text: string }): Promise<{ providerMessageId: string }>;
}

export const demoOutbox: EmailProvider = {
  id: "demo-outbox",
  delivers: false,
  async send(msg) {
    return { providerMessageId: `demo-${msg.messageId}` };
  },
};

export async function smtpProvider(): Promise<EmailProvider | null> {
  const e = env();
  if (!e.SMTP_HOST || !e.SMTP_FROM) return null;
  const nodemailer = await import("nodemailer");
  const transport = nodemailer.createTransport({
    host: e.SMTP_HOST,
    port: e.SMTP_PORT ?? 587,
    secure: (e.SMTP_PORT ?? 587) === 465,
    auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASSWORD } : undefined,
  });
  return {
    id: `smtp:${e.SMTP_HOST}`,
    delivers: true,
    async send(msg) {
      // A stable Message-ID lets the receiving side de-duplicate retries.
      const info = await transport.sendMail({ from: e.SMTP_FROM, to: msg.to, subject: msg.subject, text: msg.text, messageId: `<${msg.messageId}@escrowflow.local>` });
      return { providerMessageId: info.messageId };
    },
  };
}
