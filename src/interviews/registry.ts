export interface InterviewConfig {
  slug: string;
  name: string;
  summary: string;
  assistantDisplayName: string;
  welcomeHeadline: string;
  welcomeDescription: string;
  voiceLabel: string;
  textLabel: string;
  adminTitle: string;
}

const interviewConfigs: InterviewConfig[] = [
  {
    slug: "ai",
    name: "AI interview",
    summary: "Conversational AI qualification and recommendations.",
    assistantDisplayName: "Mark's AI Assistant",
    welcomeHeadline: "Hi there!",
    welcomeDescription:
      "I'm building something and would love to learn how AI fits into your life.",
    voiceLabel: "Voice interview",
    textLabel: "Network survey",
    adminTitle: "AI interview results",
  },
];

const interviewConfigMap = new Map(
  interviewConfigs.map((config) => [config.slug, config])
);

export function listInterviewConfigs(): InterviewConfig[] {
  return interviewConfigs;
}

export function getInterviewConfigBySlug(
  slug: string | undefined
): InterviewConfig | null {
  if (!slug) return null;
  return interviewConfigMap.get(slug) ?? null;
}

export function getDefaultInterviewConfig(): InterviewConfig {
  return interviewConfigs[0];
}
