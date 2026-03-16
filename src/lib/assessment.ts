export interface Recommendation {
  tool: string;
  relevance: string;
  nextStep: string;
  isNeotoma?: boolean;
}

export interface ReferralContact {
  name: string;
  email?: string;
  notes?: string;
}

export interface Assessment {
  sessionId: string;
  contactName: string | null;
  timestamp: string;
  durationSeconds: number;
  icpTier: "tier1_infra" | "tier1_agent" | "tier1_operator" | "tier2_toolchain" | "none";
  icpProfile: string | null;
  matchConfidence: number;
  matchedSignals: string[];
  antiIcpSignals: string[];
  personSummary: string;
  recommendations: Recommendation[];
  referralPotential: "high" | "medium" | "low";
  referralNotes: string;
  referralContacts?: ReferralContact[];
  keyInsights: string[];
  contactEmail?: string;
  toolsUsed: string[];
  preferredAiTool?: string;
}

export function generateSessionId(): string {
  return `int_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
