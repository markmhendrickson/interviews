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
import {
  buildHeuristicRecommendations,
  type Assessment,
  type Recommendation,
  type ReferralContact,
} from "../lib/assessment";
import type { Contact } from "../lib/contacts";
import NeotomaInstallCard from "./NeotomaInstallCard";
import type { InterviewConfig } from "../interviews/registry";
import { LIVE_SCHEDULING_30_MIN_URL } from "../lib/scheduling";
import {
  NEOTOMA_DEEP_URL,
  resolveRecommendationToolUrl,
} from "../../shared/recommendation_tool_urls";
import { getRecommendationBrandingFromUrl } from "../../shared/recommendation_branding.ts";
import { sanitizeContactIdentityName } from "../../shared/contact_identity";
import { personSummaryWorthShowing } from "../../shared/person_summary_display";

interface RecommendationPanelProps {
  assessment: Assessment;
  transcript: { role: "user" | "assistant"; content: string }[];
  contact: Contact | null;
  interviewConfig: InterviewConfig;
  onStartNewInterview?: () => void;
}

function getRecommendationUrl(
  rec: Recommendation,
  interviewSlug: string
): string {
  const normalizedTool = (rec.tool || "").trim().toLowerCase();
  if (
    normalizedTool === "continue interview" ||
    normalizedTool === "continue the interview"
  ) {
    return `/${encodeURIComponent(interviewSlug)}`;
  }

  const explicit = rec.url?.trim();
  if (explicit) return explicit;

  const resolved = resolveRecommendationToolUrl(rec.tool || "");
  if (resolved) return resolved;

  return `https://www.google.com/search?q=${encodeURIComponent(`${rec.tool} official documentation OR getting started`)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatDisplayName(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function RecommendationIcon({ tool, href }: { tool: string; href: string }) {
  const { iconUrls, monogram } = getRecommendationBrandingFromUrl(tool, href);
  const [iconIndex, setIconIndex] = useState(0);
  const activeIconUrl = iconUrls[iconIndex];

  return (
    <div className="w-8 h-8 rounded-lg bg-secondary border border-border flex items-center justify-center overflow-hidden flex-shrink-0">
      {activeIconUrl ? (
        <img
          src={activeIconUrl}
          alt=""
          aria-hidden="true"
          className="w-4 h-4 object-contain"
          loading="lazy"
          onError={() => setIconIndex((prev) => prev + 1)}
        />
      ) : (
        <span className="text-xs font-semibold text-muted-foreground">
          {monogram}
        </span>
      )}
    </div>
  );
}

function ToolCard({
  rec,
  interviewSlug,
}: {
  rec: Recommendation;
  interviewSlug: string;
}) {
  const href = getRecommendationUrl(rec, interviewSlug);
  const isInternalLink = href.startsWith("/");
  return (
    <a
      href={href}
      target={isInternalLink ? undefined : "_blank"}
      rel={isInternalLink ? undefined : "noopener noreferrer"}
      className="block bg-card border border-border rounded-xl p-5 hover:border-primary/40 transition-colors shadow-[0px_15px_30px_0px_rgba(0,0,0,0.05)]"
    >
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-start gap-2.5 min-w-0">
          <RecommendationIcon tool={rec.tool || ""} href={href} />
          <h3 className="font-semibold text-foreground leading-8 truncate">
            {rec.tool}
          </h3>
        </div>
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
  const safeRecommendations = Array.isArray(assessment.recommendations)
    ? assessment.recommendations
    : [];
  const safeMatchedSignals = Array.isArray(assessment.matchedSignals)
    ? assessment.matchedSignals
    : [];
  const safeAntiIcpSignals = Array.isArray(assessment.antiIcpSignals)
    ? assessment.antiIcpSignals
    : [];
  const safePersonSummary = typeof assessment.personSummary === "string"
    ? assessment.personSummary
    : "";
  const safeReferralNotes = typeof assessment.referralNotes === "string"
    ? assessment.referralNotes
    : "";
  const safeMatchConfidence =
    typeof assessment.matchConfidence === "number" ? assessment.matchConfidence : 0;
  const safeReferralPotential =
    assessment.referralPotential === "high" ||
    assessment.referralPotential === "medium" ||
    assessment.referralPotential === "low"
      ? assessment.referralPotential
      : "low";
  const displayNameRaw =
    sanitizeContactIdentityName(contact?.name || assessment.contactName) || "";
  const displayName = displayNameRaw ? formatDisplayName(displayNameRaw) : "";
  const isNeotomaRecommendation = (rec: Recommendation) =>
    Boolean(rec.isNeotoma || /neotoma/i.test(rec.tool || ""));
  const initialEmail = (assessment.contactEmail || "").trim();
  const initialReferralContacts = Array.isArray(assessment.referralContacts)
    ? assessment.referralContacts
        .map((entry) => ({
          name: (entry?.name || "").trim(),
          contactInfo: ((entry?.contactInfo || entry?.email || "") as string).trim(),
          notes: (entry?.notes || "").trim(),
        }))
        .filter((entry) => entry.name || entry.contactInfo || entry.notes)
    : [];
  const [email, setEmail] = useState(initialEmail);
  const [emailSubmitted, setEmailSubmitted] = useState(Boolean(initialEmail));
  const [isEditingEmail, setIsEditingEmail] = useState(false);
  const [referrals, setReferrals] = useState<ReferralContact[]>(
    initialReferralContacts.length > 0
      ? initialReferralContacts
      : [{ name: "", contactInfo: "", notes: "" }]
  );
  const [referralsSubmitted, setReferralsSubmitted] = useState(
    initialReferralContacts.length > 0
  );
  const [isEditingReferrals, setIsEditingReferrals] = useState(false);

  const populatedRecommendations = safeRecommendations.filter(
    (r) => r.tool?.trim() || r.relevance?.trim() || r.nextStep?.trim()
  );
  const nonContinueRecommendations = populatedRecommendations.filter((rec) => {
    const tool = String(rec.tool || "").trim().toLowerCase();
    return tool !== "continue interview" && tool !== "continue the interview";
  });
  const heuristicRecommendations = buildHeuristicRecommendations({
    assessment,
    transcript,
  });
  const effectiveRecommendations =
    nonContinueRecommendations.length > 0
      ? populatedRecommendations
      : heuristicRecommendations;
  const neotomaConfidenceThreshold = 70;
  const hasStrongIcpMatchForFallback =
    assessment.icpTier !== "none" &&
    safeMatchConfidence >= neotomaConfidenceThreshold &&
    safeMatchedSignals.length >= 2 &&
    safeAntiIcpSignals.length === 0;
  const neotomaRec =
    effectiveRecommendations.find(isNeotomaRecommendation) ||
    (hasStrongIcpMatchForFallback
      ? {
          tool: "Neotoma",
          relevance:
            "You appear to match Neotoma's target profile for deterministic agent memory workflows.",
          nextStep: "Follow the install guide, then run neotoma init and connect your editor via MCP.",
          isNeotoma: true,
          url: NEOTOMA_DEEP_URL,
        }
      : undefined);
  const otherRecs = populatedRecommendations.filter(
    (r) => !isNeotomaRecommendation(r)
  );
  const visibleOtherRecs = (
    effectiveRecommendations.length > 0 ? effectiveRecommendations : otherRecs
  ).filter((r) => !isNeotomaRecommendation(r));

  const transcriptText = transcript
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join(" ")
    .toLowerCase();
  const transcriptForDisplay = transcript.filter((m) => m.content?.trim());
  const referralHints = `${safeReferralNotes} ${transcriptText}`.toLowerCase();
  const shouldShowReferralForm =
    safeReferralPotential !== "low" ||
    /\b(referral|intro|introduce|colleague|friend|know someone|pass along)\b/.test(
      referralHints
    );
  const personSummaryWithNameNormalized = displayNameRaw
    ? safePersonSummary
        .replace(new RegExp(`^${escapeRegExp(displayNameRaw)}\\b\\s*`, "i"), "You ")
        .replace(
          new RegExp(`\\b${escapeRegExp(displayNameRaw)}'s\\b`, "gi"),
          "your"
        )
        .replace(new RegExp(`\\b${escapeRegExp(displayNameRaw)}\\b`, "gi"), "you")
    : safePersonSummary;
  const personSummaryForDisplay = personSummaryWithNameNormalized
    .replace(/\b[Tt]he contact\b/g, "You")
    .replace(/\b[Cc]ontact\b/g, "You")
    .replace(/\btheir\b/g, "your")
    .replace(/\b[Tt]hey\b/g, "you")
    .replace(/\b[Yy]ou builds\b/g, "You build")
    .replace(/\b[Yy]ou works\b/g, "You work")
    .replace(/\b[Yy]ou deals\b/g, "You deal")
    .replace(/\b[Yy]ou has\b/g, "You have")
    .replace(/\b[Yy]ou is\b/g, "You are")
    .replace(/\b[Yy]ou was\b/g, "You were");
  const personSummaryTrimmed = personSummaryForDisplay.trim();
  const showPersonSummary =
    personSummaryTrimmed.length > 0 &&
    personSummaryWorthShowing(safePersonSummary);
  const hasContactEmail =
    typeof contact?.email === "string" && contact.email.trim().length > 0;
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
    setIsEditingEmail(false);
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
    setIsEditingReferrals(false);
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-4 py-12">
        <div className="text-center mb-10">
          <div className="w-12 h-12 rounded-full bg-primary/10 text-primary flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 className="w-6 h-6" />
          </div>
          <h1 className="text-2xl font-semibold text-foreground mb-2">
            {displayName
              ? `Thanks for the conversation, ${displayName}`
              : "Thanks for the conversation"}
          </h1>
          <p className="text-muted-foreground">
            {displayName
              ? `Here's your summary and next steps, ${displayName}`
              : "Here's your summary and next steps"}
          </p>
        </div>

        {showPersonSummary && (
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
                  {personSummaryTrimmed}
                </p>
              </div>
            </div>
          </div>
        )}

        {(neotomaRec || visibleOtherRecs.length > 0) && (
          <div className="space-y-4 mb-8">
            <h2 className="text-lg font-semibold text-foreground">
              Recommendations for you
            </h2>

            {neotomaRec && <NeotomaInstallCard relevance={neotomaRec.relevance} />}

            {visibleOtherRecs.map((rec, i) => (
              <ToolCard key={i} rec={rec} interviewSlug={interviewConfig.slug} />
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
            {referralsSubmitted && !isEditingReferrals ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-primary">
                  <CheckCircle2 className="w-4 h-4" />
                  Thanks! Referral details saved.
                </div>
                <div className="space-y-2 rounded-lg border border-border px-3 py-3">
                  <p className="text-xs font-medium text-foreground">
                    Submitted referrals
                  </p>
                  {referrals
                    .map((entry) => ({
                      name: (entry.name || "").trim(),
                      contactInfo: (entry.contactInfo || entry.email || "").trim(),
                      notes: (entry.notes || "").trim(),
                    }))
                    .filter((entry) => entry.name || entry.contactInfo || entry.notes)
                    .map((entry, index) => (
                      <div
                        key={`${entry.name}-${index}`}
                        className="rounded-md border border-border px-3 py-2"
                      >
                        {entry.name && (
                          <p className="text-sm font-medium text-foreground">
                            {entry.name}
                          </p>
                        )}
                        {entry.contactInfo && (
                          <p className="text-xs text-muted-foreground">
                            {entry.contactInfo}
                          </p>
                        )}
                        {entry.notes && (
                          <p className="text-xs text-foreground/85 mt-1 leading-relaxed">
                            {entry.notes}
                          </p>
                        )}
                      </div>
                    ))}
                </div>
                <button
                  type="button"
                  onClick={() => setIsEditingReferrals(true)}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                >
                  Edit referrals
                </button>
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
                      placeholder="Email, phone, or @handle"
                      title="Email, phone, or @handle"
                      className="md:col-span-4 rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-ring"
                    />
                    <input
                      type="text"
                      value={referral.notes || ""}
                      onChange={(e) => handleReferralChange(index, "notes", e.target.value)}
                      placeholder="Why relevant? (or platform for @handle)"
                      className={
                        referrals.length > 1
                          ? "md:col-span-4 rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-ring"
                          : "md:col-span-5 rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-ring"
                      }
                    />
                    {referrals.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeReferralRow(index)}
                        className="md:col-span-1 inline-flex items-center justify-center rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">
                  If you share a handle, include platform in notes (for example:
                  @name on X, LinkedIn, GitHub, or Discord).
                </p>
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
                    {referralsSubmitted ? "Save referral updates" : "Save referrals"}
                  </button>
                  {referralsSubmitted && (
                    <button
                      type="button"
                      onClick={() => setIsEditingReferrals(false)}
                      className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                    >
                      Cancel
                    </button>
                  )}
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
                Book a 30-minute conversation if you want to go deeper.
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

        {!hasContactEmail && (
          <div className="bg-card border border-border rounded-xl p-5">
            <h3 className="text-sm font-semibold text-foreground mb-2">
              Want Mark to follow up?
            </h3>
            {emailSubmitted && !isEditingEmail ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-primary">
                  <CheckCircle2 className="w-4 h-4" />
                  Thanks! Mark will be in touch.
                </div>
                <div className="rounded-lg border border-border px-3 py-2">
                  <p className="text-xs text-muted-foreground">Submitted email</p>
                  <p className="text-sm text-foreground mt-0.5">{email}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsEditingEmail(true)}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                >
                  Edit email
                </button>
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
                  {emailSubmitted ? "Save update" : "Send"}
                </button>
                {emailSubmitted && (
                  <button
                    type="button"
                    onClick={() => setIsEditingEmail(false)}
                    className="rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                  >
                    Cancel
                  </button>
                )}
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
              Start a new conversation
            </button>
            <p className="text-xs text-muted-foreground mt-2">
              Choose voice, text, or live with Mark again.
            </p>
          </div>
        )}

        {transcriptForDisplay.length > 0 && (
          <div className="bg-card border border-border rounded-xl p-5 mt-6">
            <h3 className="text-sm font-semibold text-foreground mb-2">Transcript</h3>
            <div className="space-y-2">
              {transcriptForDisplay.map((msg, i) => (
                <p
                  key={`${msg.role}-${i}`}
                  className="text-xs text-muted-foreground leading-relaxed"
                >
                  <span className="font-medium text-foreground">
                    {msg.role === "user" ? "You" : interviewConfig.assistantDisplayName}:
                  </span>{" "}
                  {msg.content}
                </p>
              ))}
            </div>
          </div>
        )}

        <div className="text-center mt-8">
          <p className="text-xs text-muted-foreground">
            Curated by Mark with help from AI
          </p>
        </div>
      </div>
    </div>
  );
}
