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
    name: "Quick conversation",
    summary: "Conversational AI qualification and recommendations.",
    assistantDisplayName: "Mark's assistant",
    welcomeHeadline: "Hi there!",
    welcomeDescription:
      "I'd love to learn what tools and workflows matter most to you — and share personalized recommendations based on what I've seen work for people in similar roles.",
    voiceLabel: "Voice conversation",
    textLabel: "Text conversation",
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
