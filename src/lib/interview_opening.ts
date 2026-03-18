import type { Contact } from "./contacts";
import type { InterviewConfig } from "../interviews/registry";

export function getInterviewOpeningMessage(
  contact: Contact | null,
  interviewConfig: InterviewConfig
): string {
  const openingLead = interviewConfig.welcomeDescription;

  if (contact?.name) {
    return `Hi ${contact.name} — thanks for taking the time. ${openingLead} What do you do, and where does AI show up most for you right now — whether that's work, personal projects, or everyday life?`;
  }

  return `Hi — thanks for taking the time. ${openingLead} What do you do, and where does AI show up most for you right now — whether that's work, personal projects, or everyday life?`;
}
