import { useState } from "react";
import {
  ExternalLink,
  ArrowRight,
  Mail,
  Plus,
  Trash2,
  CheckCircle2,
  User,
  CalendarDays,
  MessageSquare,
} from "lucide-react";
import type { Assessment, Recommendation, ReferralContact } from "../lib/assessment";
import type { Contact } from "../lib/contacts";
import NeotomaInstallCard from "./NeotomaInstallCard";
import type { InterviewConfig } from "../interviews/registry";
import { LIVE_SCHEDULING_30_MIN_URL } from "../lib/scheduling";

interface RecommendationPanelProps {
  assessment: Assessment;
  transcript: { role: "user" | "assistant"; content: string }[];
  contact: Contact | null;
  interviewConfig: InterviewConfig;
  onStartNewInterview?: () => void;
}

const TOOL_URL_HINTS: Record<string, string> = {
  "chatgpt custom gpts": "https://chat.openai.com/gpts",
  "chatgpt gpts": "https://chat.openai.com/gpts",
  "claude with projects": "https://claude.ai",
  "claude projects": "https://claude.ai",
  perplexity: "https://perplexity.ai",
};

function getRecommendationUrl(rec: Recommendation): string {
  const explicit = rec.url?.trim();
  if (explicit) return explicit;

  const normalizedTool = (rec.tool || "").trim().toLowerCase();
  if (normalizedTool && TOOL_URL_HINTS[normalizedTool]) {
    return TOOL_URL_HINTS[normalizedTool];
  }

  // Ensure every concrete recommendation has a useful destination.
  return `https://www.google.com/search?q=${encodeURIComponent(`${rec.tool} official site`)}`;
}

function ToolCard({ rec }: { rec: Recommendation }) {
  const href = getRecommendationUrl(rec);
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="block bg-card border border-border rounded-xl p-5 hover:border-primary/40 transition-colors shadow-[0px_15px_30px_0px_rgba(0,0,0,0.05)]"
    >
      <div className="flex items-start justify-between mb-2">
        <h3 className="font-semibold text-foreground">{rec.tool}</h3>
        <ExternalLink className="w-4 h-4 text-muted-foreground flex-shrink-0" />
      </div>
      <p className="text-sm text-muted-foreground mb-3 leading-relaxed">
        {rec.relevance}
      </p>
      <div className="flex items-center gap-1.5 text-xs text-primary font-medium">
        <ArrowRight className="w-3.5 h-3.5" />
        {rec.nextStep}
      </div>
    </a>
  );
}

export default function RecommendationPanel({
  assessment,
  transcript,
  contact,
  interviewConfig,
  onStartNewInterview,
}: RecommendationPanelProps) {
  const isNeotomaRecommendation = (rec: Recommendation) =>
    Boolean(rec.isNeotoma || /neotoma/i.test(rec.tool || ""));
  const [email, setEmail] = useState("");
  const [emailSubmitted, setEmailSubmitted] = useState(false);
  const [referrals, setReferrals] = useState<ReferralContact[]>([
    { name: "", contactInfo: "", notes: "" },
  ]);
  const [referralsSubmitted, setReferralsSubmitted] = useState(false);

  const populatedRecommendations = assessment.recommendations.filter(
    (r) => r.tool?.trim() || r.relevance?.trim() || r.nextStep?.trim()
  );
  const neotomaConfidenceThreshold = 70;
  const hasStrongIcpMatchForFallback =
    assessment.icpTier !== "none" &&
    assessment.matchConfidence >= neotomaConfidenceThreshold &&
    assessment.matchedSignals.length >= 2 &&
    assessment.antiIcpSignals.length === 0;
  const neotomaRec =
    populatedRecommendations.find(isNeotomaRecommendation) ||
    (hasStrongIcpMatchForFallback
      ? {
          tool: "Neotoma",
          relevance:
            "You appear to match Neotoma's target profile for deterministic agent memory workflows.",
          nextStep: "Visit neotoma.io to review fit and implementation options.",
          isNeotoma: true,
        }
      : undefined);
  const otherRecs = populatedRecommendations.filter(
    (r) => !isNeotomaRecommendation(r)
  );

  const transcriptText = transcript
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join(" ")
    .toLowerCase();
  const referralHints = `${assessment.referralNotes || ""} ${transcriptText}`.toLowerCase();
  const shouldShowReferralForm =
    assessment.referralPotential !== "low" ||
    /\b(referral|intro|introduce|colleague|friend|know someone|pass along)\b/.test(
      referralHints
    );
  const personSummaryForDisplay = assessment.personSummary
    .replace(/\b[Tt]he contact\b/g, "You")
    .replace(/\b[Cc]ontact\b/g, "You")
    .replace(/\btheir\b/g, "your")
    .replace(/\b[Tt]hey\b/g, "you")
    .replace(/\b[Yy]ou was\b/g, "You were");
  const summaryIndicatesNoEngagement =
    /minimal engagement|did not share|no substantive|no engagement|provided minimal|despite multiple prompts|ended conversation immediately|without sharing/i.test(
      assessment.personSummary
    );

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;

    assessment.contactEmail = email.trim();

    await fetch("/api/results", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assessment, interviewSlug: interviewConfig.slug }),
    }).catch(() => {});

    setEmailSubmitted(true);
  };

  const handleReferralChange = (
    index: number,
    field: keyof ReferralContact,
    value: string
  ) => {
    setReferrals((prev) =>
      prev.map((entry, i) => (i === index ? { ...entry, [field]: value } : entry))
    );
  };

  const addReferralRow = () => {
    setReferrals((prev) => [...prev, { name: "", contactInfo: "", notes: "" }]);
  };

  const removeReferralRow = (index: number) => {
    setReferrals((prev) => prev.filter((_, i) => i !== index));
  };

  const handleReferralSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = referrals
      .map((entry) => ({
        name: entry.name.trim(),
        contactInfo: (entry.contactInfo || entry.email || "").trim(),
        notes: entry.notes?.trim(),
      }))
      .filter((entry) => entry.name);

    if (cleaned.length === 0) return;

    assessment.referralContacts = cleaned;
    await fetch("/api/results", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assessment, interviewSlug: interviewConfig.slug }),
    }).catch(() => {});

    setReferralsSubmitted(true);
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-4 py-12">
        <div className="text-center mb-10">
          <div className="w-12 h-12 rounded-full bg-primary/10 text-primary flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 className="w-6 h-6" />
          </div>
          <h1 className="text-2xl font-semibold text-foreground mb-2">
            Thanks for the conversation
          </h1>
          <p className="text-muted-foreground">
            {contact?.name
              ? `Here's your summary and next steps, ${contact.name}`
              : "Here's your summary and next steps"}
          </p>
        </div>

        {!summaryIndicatesNoEngagement && (
          <div className="bg-card border border-border rounded-xl p-5 mb-8">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center flex-shrink-0">
                <User className="w-4 h-4 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground mb-1">
                  What you told me
                </p>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {personSummaryForDisplay}
                </p>
              </div>
            </div>
          </div>
        )}

        {(neotomaRec || otherRecs.length > 0) && (
          <div className="space-y-4 mb-8">
            <h2 className="text-lg font-semibold text-foreground">
              Recommendations for you
            </h2>

            {neotomaRec && <NeotomaInstallCard relevance={neotomaRec.relevance} />}

            {otherRecs.map((rec, i) => (
              <ToolCard key={i} rec={rec} />
            ))}
          </div>
        )}

        {shouldShowReferralForm && (
          <div className="bg-card border border-border rounded-xl p-5 mb-6">
            <h3 className="text-sm font-semibold text-foreground mb-2">
              Know people Mark should talk to?
            </h3>
            <p className="text-xs text-muted-foreground mb-4">
              Optional — share referral contacts and context.
            </p>
            {referralsSubmitted ? (
              <div className="flex items-center gap-2 text-sm text-primary">
                <CheckCircle2 className="w-4 h-4" />
                Thanks! Referral details saved.
              </div>
            ) : (
              <form onSubmit={handleReferralSubmit} className="space-y-3">
                {referrals.map((referral, index) => (
                  <div key={index} className="grid grid-cols-1 gap-2 md:grid-cols-12">
                    <input
                      type="text"
                      value={referral.name}
                      onChange={(e) => handleReferralChange(index, "name", e.target.value)}
                      placeholder="Name"
                      className="md:col-span-3 rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-ring"
                    />
                    <input
                      type="text"
                      value={referral.contactInfo || referral.email || ""}
                      onChange={(e) =>
                        handleReferralChange(index, "contactInfo", e.target.value)
                      }
                      placeholder="Email, phone, or handle (optional)"
                      className="md:col-span-3 rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-ring"
                    />
                    <input
                      type="text"
                      value={referral.notes || ""}
                      onChange={(e) => handleReferralChange(index, "notes", e.target.value)}
                      placeholder="Why relevant? (optional)"
                      className="md:col-span-5 rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-ring"
                    />
                    <button
                      type="button"
                      onClick={() => removeReferralRow(index)}
                      disabled={referrals.length === 1}
                      className="md:col-span-1 inline-flex items-center justify-center rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-40"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={addReferralRow}
                    className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                    Add contact
                  </button>
                  <button
                    type="submit"
                    disabled={!referrals.some((r) => r.name.trim())}
                    className="bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
                  >
                    Save referrals
                  </button>
                </div>
              </form>
            )}
          </div>
        )}

        <div className="bg-card border border-border rounded-xl p-5 mb-8">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center flex-shrink-0">
              <CalendarDays className="w-4 h-4 text-muted-foreground" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-foreground mb-1">
                Want to continue this live with Mark?
              </p>
              <p className="text-sm text-muted-foreground leading-relaxed mb-3">
                Book a 30-minute conversation if you want to go deeper after this AI interview.
              </p>
              <a
                href={LIVE_SCHEDULING_30_MIN_URL}
                className="inline-flex items-center gap-2 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium px-4 py-2 rounded-lg transition-colors"
              >
                Schedule 30-minute live time
                <ExternalLink className="w-4 h-4" />
              </a>
            </div>
          </div>
        </div>

        {!contact && (
          <div className="bg-card border border-border rounded-xl p-5">
            <h3 className="text-sm font-semibold text-foreground mb-2">
              Want Mark to follow up?
            </h3>
            {emailSubmitted ? (
              <div className="flex items-center gap-2 text-sm text-primary">
                <CheckCircle2 className="w-4 h-4" />
                Thanks! Mark will be in touch.
              </div>
            ) : (
              <form onSubmit={handleEmailSubmit} className="flex gap-2">
                <div className="relative flex-1">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="your@email.com"
                    className="w-full pl-10 pr-4 py-2 text-sm rounded-lg border border-input bg-background focus:outline-none focus:border-primary focus:ring-1 focus:ring-ring"
                  />
                </div>
                <button
                  type="submit"
                  disabled={!email.trim()}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
                >
                  Send
                </button>
              </form>
            )}
            <p className="text-xs text-muted-foreground mt-2">
              Optional — leave blank and just close the tab if you prefer.
            </p>
          </div>
        )}

        {onStartNewInterview && (
          <div className="text-center mt-6">
            <button
              type="button"
              onClick={onStartNewInterview}
              className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground border border-border hover:border-primary/40 rounded-lg px-4 py-2.5 transition-colors"
            >
              <MessageSquare className="w-4 h-4" />
              Start new interview
            </button>
            <p className="text-xs text-muted-foreground mt-2">
              Choose voice, text, or live with Mark again.
            </p>
          </div>
        )}

        <div className="text-center mt-8">
          <p className="text-xs text-muted-foreground">
            Powered by AI on behalf of Mark Hendrickson
          </p>
        </div>
      </div>
    </div>
  );
}
