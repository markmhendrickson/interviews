import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sendgrid from "@sendgrid/mail";
import type { Contact } from "./store.js";

interface InviteTemplateContext {
  name: string;
  share_url: string;
  interview_name: string;
  sender_name: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EMAIL_TEMPLATE_PATH = path.resolve(__dirname, "../../src/templates/invite_email.html");
const TEXT_TEMPLATE_PATH = path.resolve(__dirname, "../../src/templates/invite_text.txt");

function renderTemplate(
  template: string,
  context: InviteTemplateContext
): string {
  return template.replace(/\{\{(name|share_url|interview_name|sender_name)\}\}/g, (_, key) => {
    return context[key as keyof InviteTemplateContext] ?? "";
  });
}

function getBaseUrl(): string {
  return (
    process.env.INTERVIEWS_BASE_URL ||
    process.env.PUBLIC_APP_BASE_URL ||
    "https://interviews.markmhendrickson.com"
  ).replace(/\/+$/, "");
}

export function buildShareUrl(interviewSlug: string, shareCode: string): string {
  const slug = String(interviewSlug || "ai").trim().toLowerCase() || "ai";
  const code = String(shareCode || "").trim().toLowerCase();
  return `${getBaseUrl()}/${slug}/${encodeURIComponent(code)}`;
}

export async function generateTextInvite(
  contact: Contact,
  interviewSlug: string,
  options?: {
    interviewName?: string;
    senderName?: string;
  }
): Promise<{ message: string; shareUrl: string }> {
  const template = await readFile(TEXT_TEMPLATE_PATH, "utf8");
  const shareUrl = buildShareUrl(interviewSlug, contact.code);
  const message = renderTemplate(template, {
    name: contact.name,
    share_url: shareUrl,
    interview_name: options?.interviewName || "conversation",
    sender_name: options?.senderName || "Mark",
  }).trim();
  return { message, shareUrl };
}

export async function sendInviteEmail(
  contact: Contact,
  interviewSlug: string,
  options?: {
    interviewName?: string;
    senderName?: string;
    fromEmail?: string;
  }
): Promise<{ sent: true; shareUrl: string; to: string }> {
  const to = contact.email?.trim().toLowerCase();
  if (!to) {
    throw new Error("Contact is missing an email address");
  }

  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    throw new Error("Missing SENDGRID_API_KEY");
  }

  const fromEmail = options?.fromEmail || process.env.SENDGRID_FROM_EMAIL;
  if (!fromEmail) {
    throw new Error("Missing SENDGRID_FROM_EMAIL");
  }

  const fromName =
    options?.senderName ||
    process.env.SENDGRID_FROM_NAME ||
    "Mark";

  const interviewName = options?.interviewName || "conversation";
  const shareUrl = buildShareUrl(interviewSlug, contact.code);
  const emailTemplate = await readFile(EMAIL_TEMPLATE_PATH, "utf8");
  const textTemplate = await readFile(TEXT_TEMPLATE_PATH, "utf8");
  const html = renderTemplate(emailTemplate, {
    name: contact.name,
    share_url: shareUrl,
    interview_name: interviewName,
    sender_name: fromName,
  });
  const text = renderTemplate(textTemplate, {
    name: contact.name,
    share_url: shareUrl,
    interview_name: interviewName,
    sender_name: fromName,
  });

  sendgrid.setApiKey(apiKey);
  await sendgrid.send({
    to,
    from: {
      email: fromEmail,
      name: fromName,
    },
    subject: `Quick conversation — would love your input`,
    text,
    html,
  });

  return { sent: true, shareUrl, to };
}
