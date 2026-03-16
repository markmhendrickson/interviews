import type { Contact } from "./contacts";

export function getInterviewOpeningMessage(contact: Contact | null): string {
  if (contact?.name) {
    return `Hi ${contact.name} — thanks for taking the time. Mark asked me to learn how AI fits into your life and share personalized recommendations at the end. What do you do, and where does AI show up most for you right now — whether that's work, personal projects, or everyday life?`;
  }

  return "Hi — thanks for taking the time. Mark asked me to learn how AI fits into your life and share personalized recommendations at the end. What do you do, and where does AI show up most for you right now — whether that's work, personal projects, or everyday life?";
}
