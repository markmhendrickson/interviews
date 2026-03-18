import type { Contact } from "./contacts";
import type { InterviewConfig } from "../interviews/registry";

export function getAnonymousNameFirstMessage(
  interviewConfig: InterviewConfig
): string {
  const openingLead = interviewConfig.welcomeDescription;
  return `Hi — thanks for taking the time. ${openingLead} Before we get into tools, what's your name?`;
}

export function getInterviewOpeningMessage(
  contact: Contact | null,
  interviewConfig: InterviewConfig
): string {
  const openingLead = interviewConfig.welcomeDescription;

  if (contact?.name) {
    return `Hi ${contact.name} — thanks for taking the time. ${openingLead} What do you do, and where does AI show up most for you right now — whether that's work, personal projects, or everyday life?`;
  }

  return getAnonymousNameFirstMessage(interviewConfig);
}
