import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  Lock,
  Download,
  ChevronRight,
  ArrowLeft,
  Users,
  Target,
  MessageSquare,
  Star,
  Link2,
  RefreshCw,
  ExternalLink,
} from "lucide-react";
import { detectToolsUsed, inferIcpTierForDisplay, type Assessment } from "../lib/assessment";
import {
  getSyncStatus,
  listContacts,
  triggerSyncNow,
  type Contact,
  type SyncStatus,
} from "../lib/contacts";
import type { InterviewConfig } from "../interviews/registry";

interface StoredResult {
  sessionId: string;
  assessment: Assessment;
  transcript: { role: "user" | "assistant"; content: string }[];
  storedAt: string;
  partial?: boolean;
  messageCount?: number;
  contactCode?: string;
}

function isStoredResult(value: unknown): value is StoredResult {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<StoredResult>;
  if (typeof record.sessionId !== "string" || record.sessionId.trim() === "") {
    return false;
  }
  if (!record.assessment || typeof record.assessment !== "object") {
    return false;
  }
  const timestamp = (record.assessment as { timestamp?: unknown }).timestamp;
  if (typeof timestamp !== "string" || timestamp.trim() === "") {
    return false;
  }
  return true;
}

function toTimestampMs(value: string | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

function formatDateOnly(value: string | undefined): string {
  const ms = toTimestampMs(value);
  if (ms <= 0) return "Unknown";
  return new Date(ms).toLocaleDateString();
}

const LEGACY_ADMIN_SESSION_KEY = "network_survey_admin_passphrase";

function getAdminSessionKey(interviewSlug: string): string {
  return `interviews_admin_passphrase_${interviewSlug}`;
}

const TIER_LABELS: Record<string, string> = {
  tier1_infra: "Tier 1 — Infra Engineer",
  tier1_agent: "Tier 1 — Agent Builder",
  tier1_operator: "Tier 1 — AI-native Operator",
  tier2_toolchain: "Tier 2 — Toolchain Integrator",
  none: "No match",
};

const TIER_ASSESSMENT_SUMMARY: Record<string, string> = {
  tier1_infra:
    "This contact is in a primary direct-fit ICP segment. Tier 1 profiles are highest-priority near-term users.",
  tier1_agent:
    "This contact is in a primary direct-fit ICP segment. Tier 1 profiles are highest-priority near-term users.",
  tier1_operator:
    "This contact is in a primary direct-fit ICP segment. Tier 1 profiles are highest-priority near-term users.",
  tier2_toolchain:
    "This contact is a secondary-fit Toolchain Integrator. Tier 2 can still be valuable, especially for referrals and ecosystem influence.",
  none: "This interview did not produce a confident ICP match yet.",
};

type CanonicalIcpTier = keyof typeof TIER_LABELS;

function normalizeIcpTier(value: unknown): CanonicalIcpTier {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "none";
  if (raw in TIER_LABELS) return raw as CanonicalIcpTier;

  const compact = raw.replace(/[\s_-]+/g, "");
  if (compact === "tier1infra" || compact === "infrastructureengineer") {
    return "tier1_infra";
  }
  if (compact === "tier1agent" || compact === "agentbuilder") {
    return "tier1_agent";
  }
  if (
    compact === "tier1ainativeoperator" ||
    compact === "tier1operator" ||
    compact === "ainativeoperator"
  ) {
    return "tier1_operator";
  }
  if (
    compact === "tier2" ||
    compact === "tier2toolchain" ||
    compact === "toolchainintegrator"
  ) {
    return "tier2_toolchain";
  }
  return "none";
}

const REFERRAL_COLORS: Record<string, string> = {
  high: "text-green-600 bg-green-50",
  medium: "text-yellow-600 bg-yellow-50",
  low: "text-muted-foreground bg-secondary",
};

const INTERVIEW_STATUS_COLORS = {
  in_progress: "text-blue-700 bg-blue-50",
  completed: "text-green-700 bg-green-50",
} as const;

interface ContactWithCodes {
  id: string;
  name: string;
  email?: string;
  context?: string;
  source?: string;
  codes: string[];
  invited: boolean;
}

interface ContactLifecycleSession {
  sessionId: string;
  status: "in_progress" | "completed";
  timestamp?: string;
  matchConfidence: number;
}

interface ContactLifecycleMetrics {
  invitedCount: number;
  startedCount: number;
  inProgressCount: number;
  completedCount: number;
  startRate: number;
  completionRateFromStarted: number;
  completionRateFromInvited: number;
  sessions: ContactLifecycleSession[];
}

function normalizeText(value: string | undefined): string {
  return String(value || "").trim().toLowerCase();
}

function inferContactInvited(contact: Contact): boolean {
  const record = contact as Contact & Record<string, unknown>;
  if (typeof record.invited === "boolean") return record.invited;
  if (typeof record.invitedAt === "string" && record.invitedAt.trim()) return true;

  const rawStatus = [
    record.inviteStatus,
    record.invitationStatus,
    record.lifecycleStatus,
    record.lifecycleStage,
    record.status,
  ]
    .find((value) => typeof value === "string")
    ?.toString();
  const status = normalizeText(rawStatus);
  if (status) {
    const invitedStatuses = new Set([
      "invited",
      "invite_sent",
      "invite-sent",
      "sent",
      "opened",
      "started",
      "in_progress",
      "in-progress",
      "completed",
    ]);
    return invitedStatuses.has(status);
  }

  return false;
}

function collectContactCodes(contact: Contact): string[] {
  const rawCodes = [contact.code, ...(Array.isArray(contact.codes) ? contact.codes : [])];
  const normalized = rawCodes
    .map((value) => normalizeText(value))
    .filter((value, index, values) => value && values.indexOf(value) === index);
  return normalized.sort((a, b) => a.localeCompare(b));
}

function buildContactRows(contacts: Contact[]): ContactWithCodes[] {
  const rowsByKey = new Map<string, ContactWithCodes>();

  for (const contact of contacts) {
    const emailKey = normalizeText(contact.email);
    const nameKey = normalizeText(contact.name);
    const contextKey = normalizeText(contact.context);
    const sourceKey = normalizeText(contact.source);
    const groupingKey = emailKey || `${nameKey}|${contextKey}|${sourceKey}`;
    if (!groupingKey) continue;

    const existing = rowsByKey.get(groupingKey);
    const nextCodes = collectContactCodes(contact);
    if (!existing) {
      rowsByKey.set(groupingKey, {
        id: groupingKey,
        name: contact.name || "Unnamed contact",
        email: contact.email,
        context: contact.context,
        source: contact.source,
        codes: nextCodes,
        invited: inferContactInvited(contact),
      });
      continue;
    }

    existing.codes = Array.from(new Set([...existing.codes, ...nextCodes])).sort((a, b) =>
      a.localeCompare(b)
    );
    if (!existing.email && contact.email) existing.email = contact.email;
    if (!existing.context && contact.context) existing.context = contact.context;
    if (!existing.source && contact.source) existing.source = contact.source;
    if (existing.name === "Unnamed contact" && contact.name) existing.name = contact.name;
    existing.invited = existing.invited || inferContactInvited(contact);
  }

  return Array.from(rowsByKey.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeCode(value: string | undefined): string {
  return String(value || "").trim().toLowerCase();
}

function isInterviewInProgress(result: StoredResult): boolean {
  const summary = String(result.assessment?.personSummary || "").trim().toLowerCase();
  const referralNotes = String(result.assessment?.referralNotes || "").trim().toLowerCase();
  return (
    result.partial === true ||
    summary === "interview in progress." ||
    referralNotes.includes("not completed yet")
  );
}

function calculateRate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 100);
}

function buildContactLifecycleMetrics(
  contact: ContactWithCodes,
  results: StoredResult[]
): ContactLifecycleMetrics {
  const contactCodes = new Set(contact.codes.map((code) => normalizeCode(code)));
  const linked = results
    .filter((result) => contactCodes.has(normalizeCode(result.contactCode)))
    .sort(
      (a, b) =>
        toTimestampMs(b.assessment?.timestamp) - toTimestampMs(a.assessment?.timestamp)
    );

  const sessions: ContactLifecycleSession[] = linked.map((result) => ({
    sessionId: result.sessionId,
    status: isInterviewInProgress(result) ? "in_progress" : "completed",
    timestamp: result.assessment?.timestamp,
    matchConfidence: Number(result.assessment?.matchConfidence || 0),
  }));

  const invitedCount = contact.codes.length;
  const startedCount = sessions.length;
  const inProgressCount = sessions.filter((session) => session.status === "in_progress").length;
  const completedCount = sessions.filter((session) => session.status === "completed").length;

  return {
    invitedCount,
    startedCount,
    inProgressCount,
    completedCount,
    startRate: calculateRate(startedCount, invitedCount),
    completionRateFromStarted: calculateRate(completedCount, startedCount),
    completionRateFromInvited: calculateRate(completedCount, invitedCount),
    sessions,
  };
}

function getMostAdvancedLifecycleStatus(
  lifecycle: ContactLifecycleMetrics,
  invited: boolean
): { label: string; className: string } {
  if (lifecycle.completedCount > 0) {
    return { label: "Completed", className: "text-green-700 bg-green-50" };
  }
  if (lifecycle.inProgressCount > 0) {
    return { label: "In progress", className: "text-blue-700 bg-blue-50" };
  }
  if (lifecycle.startedCount > 0) {
    return { label: "Started", className: "text-yellow-700 bg-yellow-50" };
  }
  if (invited) {
    return { label: "Invited", className: "text-indigo-700 bg-indigo-50" };
  }
  return { label: "Uninvited", className: "text-muted-foreground bg-secondary" };
}

function ContactDetail({
  contact,
  interviewSlug,
  results,
  onBack,
  onOpenSession,
}: {
  contact: ContactWithCodes;
  interviewSlug: string;
  results: StoredResult[];
  onBack: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const lifecycle = buildContactLifecycleMetrics(contact, results);

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <button
        onClick={onBack}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to contacts
      </button>

      <div className="bg-card border border-border rounded-xl p-5 mb-6">
        <h2 className="text-lg font-semibold text-foreground">{contact.name}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {contact.email || "No email"} · {contact.context || "No context"} ·{" "}
          {contact.source || "unknown"}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {contact.codes.map((code) => (
            <a
              key={`${contact.id}:${code}`}
              href={`/${interviewSlug}/${code}`}
              className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-primary hover:text-primary/80 hover:border-primary/40"
            >
              <Link2 className="w-3 h-3" />
              {code}
            </a>
          ))}
        </div>
      </div>

      <section className="bg-card border border-border rounded-xl p-5 mb-6">
        <h3 className="text-sm font-semibold text-foreground mb-3">
          Pipeline conversion by lifecycle
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs mb-4">
          <div className="rounded-lg border border-border px-3 py-2">
            <p className="text-muted-foreground">Invited</p>
            <p className="text-foreground font-medium mt-0.5">{lifecycle.invitedCount}</p>
          </div>
          <div className="rounded-lg border border-border px-3 py-2">
            <p className="text-muted-foreground">Started</p>
            <p className="text-foreground font-medium mt-0.5">{lifecycle.startedCount}</p>
          </div>
          <div className="rounded-lg border border-border px-3 py-2">
            <p className="text-muted-foreground">In progress</p>
            <p className="text-foreground font-medium mt-0.5">{lifecycle.inProgressCount}</p>
          </div>
          <div className="rounded-lg border border-border px-3 py-2">
            <p className="text-muted-foreground">Completed</p>
            <p className="text-foreground font-medium mt-0.5">{lifecycle.completedCount}</p>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
          <div className="rounded-lg border border-border px-3 py-2">
            <p className="text-muted-foreground">Invite → start</p>
            <p className="text-foreground font-medium mt-0.5">{lifecycle.startRate}%</p>
          </div>
          <div className="rounded-lg border border-border px-3 py-2">
            <p className="text-muted-foreground">Start → complete</p>
            <p className="text-foreground font-medium mt-0.5">
              {lifecycle.completionRateFromStarted}%
            </p>
          </div>
          <div className="rounded-lg border border-border px-3 py-2">
            <p className="text-muted-foreground">Invite → complete</p>
            <p className="text-foreground font-medium mt-0.5">
              {lifecycle.completionRateFromInvited}%
            </p>
          </div>
        </div>
      </section>

      <section className="bg-card border border-border rounded-xl p-5">
        <h3 className="text-sm font-semibold text-foreground mb-3">Interview sessions</h3>
        {lifecycle.sessions.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No sessions have started for this contact yet.
          </p>
        ) : (
          <div className="space-y-2">
            {lifecycle.sessions.map((session) => (
              <button
                key={session.sessionId}
                type="button"
                onClick={() => onOpenSession(session.sessionId)}
                className="w-full text-left border border-border rounded-lg px-3 py-2 hover:bg-secondary/40 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">{session.sessionId}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {formatDateOnly(session.timestamp)} · {session.matchConfidence}% confidence
                    </p>
                  </div>
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                      session.status === "completed"
                        ? INTERVIEW_STATUS_COLORS.completed
                        : INTERVIEW_STATUS_COLORS.in_progress
                    }`}
                  >
                    {session.status === "completed" ? "Completed" : "In progress"}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function LoginForm({ onLogin }: { onLogin: (passphrase: string) => void }) {
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(false);
    onLogin(passphrase);
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <div className="max-w-sm w-full">
        <div className="text-center mb-6">
          <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center mx-auto mb-3">
            <Lock className="w-6 h-6 text-muted-foreground" />
          </div>
          <h1 className="text-xl font-semibold text-foreground">Admin Access</h1>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Enter passphrase"
            className={`w-full px-4 py-2.5 rounded-lg border text-sm focus:outline-none focus:ring-1 ${
              error
                ? "border-red-300 focus:border-red-500 focus:ring-red-500"
                : "border-input focus:border-primary focus:ring-ring"
            }`}
          />
          {error && (
            <p className="text-xs text-red-500">Incorrect passphrase</p>
          )}
          <button
            type="submit"
            className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-medium py-2.5 rounded-lg transition-colors text-sm"
          >
            Access results
          </button>
        </form>
      </div>
    </div>
  );
}

function ResultDetail({
  result,
  onBack,
}: {
  result: StoredResult;
  onBack: () => void;
}) {
  const { assessment: a, transcript } = result;
  const referralContacts = Array.isArray(a.referralContacts)
    ? a.referralContacts
        .map((entry) => ({
          name: typeof entry?.name === "string" ? entry.name.trim() : "",
          contactInfo:
            typeof entry?.contactInfo === "string"
              ? entry.contactInfo.trim()
              : typeof entry?.email === "string"
                ? entry.email.trim()
                : "",
          notes: typeof entry?.notes === "string" ? entry.notes.trim() : "",
        }))
        .filter((entry) => entry.name || entry.contactInfo || entry.notes)
    : [];
  const followUpEmail =
    typeof a.contactEmail === "string" ? a.contactEmail.trim() : "";
  const recommendations = Array.isArray(a.recommendations)
    ? a.recommendations.filter(
        (rec) => rec.tool?.trim() || rec.relevance?.trim() || rec.nextStep?.trim()
      )
    : [];
  const transcriptToolMentions = detectToolsUsed(
    transcript
      .filter((msg) => msg.role === "user")
      .map((msg) => msg.content)
      .join(" ")
  );
  const toolsUsed = Array.from(new Set([...(a.toolsUsed || []), ...transcriptToolMentions]));
  const normalizedIcpTier = normalizeIcpTier(a.icpTier);
  const displayTier =
    normalizedIcpTier !== "none" ? normalizedIcpTier : inferIcpTierForDisplay(a);
  const isTier1Match = displayTier.startsWith("tier1_");
  const isTier2Match = displayTier === "tier2_toolchain";
  const isInProgress =
    result.partial === true ||
    a.personSummary.trim().toLowerCase() === "interview in progress." ||
    a.referralNotes.trim().toLowerCase().includes("not completed yet");
  const interviewStatus = isInProgress ? "In progress" : "Completed";
  const interviewStatusColor = isInProgress
    ? INTERVIEW_STATUS_COLORS.in_progress
    : INTERVIEW_STATUS_COLORS.completed;

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 text-foreground">
      <button
        onClick={onBack}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to results
      </button>

      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-foreground">
            {a.contactName || "Anonymous"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {new Date(a.timestamp).toLocaleDateString()} ·{" "}
            {Math.round(a.durationSeconds / 60)} min
          </p>
        </div>
        <div className="flex gap-2">
          <span
            className={`text-xs font-medium px-2.5 py-1 rounded-full ${interviewStatusColor}`}
          >
            {interviewStatus}
          </span>
          {displayTier !== "none" && (
          <span
            className={`text-xs font-medium px-2.5 py-1 rounded-full ${
              displayTier !== "none"
                ? "bg-primary/10 text-primary"
                : "bg-secondary text-muted-foreground"
            }`}
          >
            {TIER_LABELS[displayTier]}
          </span>
          )}
          <span
            className={`text-xs font-medium px-2.5 py-1 rounded-full ${REFERRAL_COLORS[a.referralPotential]}`}
          >
            {a.referralPotential} referral
          </span>
        </div>
      </div>

      <div className="space-y-6">
        {displayTier !== "none" && (
          <section className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-semibold text-foreground mb-2">Tier assessment</h2>
            <p className="text-sm text-muted-foreground mb-3">
              {TIER_ASSESSMENT_SUMMARY[displayTier]}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div
                className={`rounded-lg border p-3 ${
                  isTier1Match
                    ? "border-primary/50 bg-primary/5 ring-1 ring-primary/30"
                    : "border-border"
                }`}
              >
                <p className="font-medium text-foreground mb-1 flex items-center gap-2">
                  Tier 1 (primary fit)
                  {isTier1Match && (
                    <span className="text-[10px] font-semibold uppercase tracking-wide bg-primary/15 text-primary px-1.5 py-0.5 rounded">
                      Current match
                    </span>
                  )}
                </p>
                <p className="text-muted-foreground">
                  Direct-fit ICPs with strongest near-term adoption potential: Infra Engineer, Agent Builder, and AI-native Operator.
                </p>
              </div>
              <div
                className={`rounded-lg border p-3 ${
                  isTier2Match
                    ? "border-primary/50 bg-primary/5 ring-1 ring-primary/30"
                    : "border-border"
                }`}
              >
                <p className="font-medium text-foreground mb-1 flex items-center gap-2">
                  Tier 2 (secondary fit)
                  {isTier2Match && (
                    <span className="text-[10px] font-semibold uppercase tracking-wide bg-primary/15 text-primary px-1.5 py-0.5 rounded">
                      Current match
                    </span>
                  )}
                </p>
                <p className="text-muted-foreground">
                  Toolchain Integrators who are useful for ecosystem leverage and referrals, but usually lower direct-priority than Tier 1.
                </p>
              </div>
            </div>
          </section>
        )}

        <section className="bg-card border border-border rounded-xl p-5">
          <h2 className="text-sm font-semibold text-foreground mb-2">Summary</h2>
          <p className="text-sm text-muted-foreground">{a.personSummary}</p>
        </section>

        <section className="bg-card border border-border rounded-xl p-5">
          <h2 className="text-sm font-semibold text-foreground mb-3">
            ICP Assessment
          </h2>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground text-xs mb-1">Confidence</p>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-2 bg-secondary rounded-full">
                  <div
                    className="h-full bg-primary rounded-full"
                    style={{ width: `${a.matchConfidence}%` }}
                  />
                </div>
                <span className="text-xs font-medium text-muted-foreground">
                  {a.matchConfidence}%
                </span>
              </div>
            </div>
            <div>
              <p className="text-muted-foreground text-xs mb-1">Tools used</p>
              <div className="flex flex-wrap gap-1">
                {toolsUsed.map((t, i) => (
                  <span
                    key={i}
                    className="text-xs bg-secondary text-muted-foreground px-2 py-0.5 rounded"
                  >
                    {t}
                  </span>
                ))}
                {toolsUsed.length === 0 && (
                  <span className="text-xs text-muted-foreground">None detected yet</span>
                )}
              </div>
            </div>
          </div>
          {a.matchedSignals.length > 0 && (
            <div className="mt-4">
              <p className="text-muted-foreground text-xs mb-1">Matched signals</p>
              <ul className="text-xs text-muted-foreground space-y-1">
                {a.matchedSignals.map((s, i) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <Target className="w-3 h-3 text-green-500 mt-0.5 flex-shrink-0" />
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {a.antiIcpSignals.length > 0 && (
            <div className="mt-3">
              <p className="text-muted-foreground text-xs mb-1">Anti-ICP signals</p>
              <ul className="text-xs text-muted-foreground space-y-1">
                {a.antiIcpSignals.map((s, i) => (
                  <li key={i}>— {s}</li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {a.keyInsights.length > 0 && (
          <section className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-semibold text-foreground mb-2 flex items-center gap-1.5">
              <Star className="w-4 h-4 text-yellow-500" />
              Key insights
            </h2>
            <ul className="text-sm text-muted-foreground space-y-2">
              {a.keyInsights.map((insight, i) => (
                <li key={i} className="leading-relaxed">
                  {insight}
                </li>
              ))}
            </ul>
          </section>
        )}

        {a.referralNotes && (
          <section className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-semibold text-foreground mb-2">
              Referral notes
            </h2>
            <p className="text-sm text-muted-foreground">{a.referralNotes}</p>
          </section>
        )}

        {(referralContacts.length > 0 || followUpEmail) && (
          <section className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-semibold text-foreground mb-3">
              Follow-up details from confirmation form
            </h2>
            {followUpEmail && (
              <div className="mb-3">
                <p className="text-xs text-muted-foreground mb-1">Follow-up email</p>
                <p className="text-sm text-foreground">{followUpEmail}</p>
              </div>
            )}
            {referralContacts.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground mb-2">Referral contacts</p>
                <div className="space-y-2">
                  {referralContacts.map((entry, index) => (
                    <div
                      key={`${entry.name}-${index}`}
                      className="rounded-lg border border-border px-3 py-2"
                    >
                      {entry.name && (
                        <p className="text-sm font-medium text-foreground">{entry.name}</p>
                      )}
                      {entry.contactInfo && (
                        <p className="text-xs text-muted-foreground">{entry.contactInfo}</p>
                      )}
                      {entry.notes && (
                        <p className="text-xs text-foreground/85 mt-1 leading-relaxed">
                          {entry.notes}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {recommendations.length > 0 && (
          <section className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-semibold text-foreground mb-3">
              Recommendations shown on confirmation page
            </h2>
            <div className="space-y-3">
              {recommendations.map((rec, i) => (
                <div
                  key={`${rec.tool}-${i}`}
                  className="rounded-lg border border-border px-3 py-3"
                >
                  <div className="flex items-center justify-between gap-3 mb-1.5">
                    <p className="text-sm font-medium text-foreground">
                      {rec.tool || `Recommendation ${i + 1}`}
                    </p>
                    {rec.url && (
                      <a
                        href={rec.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary/80"
                      >
                        Open
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                  {rec.relevance && (
                    <p className="text-xs text-muted-foreground leading-relaxed mb-1.5">
                      {rec.relevance}
                    </p>
                  )}
                  {rec.nextStep && (
                    <p className="text-xs text-foreground/85 leading-relaxed">
                      Next step: {rec.nextStep}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="bg-card border border-border rounded-xl p-5">
          <h2 className="text-sm font-semibold text-foreground mb-3">
            Transcript
          </h2>
          <div className="space-y-3 max-h-96 overflow-y-auto">
            {transcript.map((msg, i) => (
              <div key={i} className="flex gap-2">
                <span
                  className={`text-xs font-medium w-8 flex-shrink-0 ${
                    msg.role === "user" ? "text-primary" : "text-muted-foreground"
                  }`}
                >
                  {msg.role === "user" ? "You" : "AI"}
                </span>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {msg.content}
                </p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

export default function AdminResults({
  interviewConfig,
  selectedSessionId,
  selectedContactId,
  adminView = "interviews",
}: {
  interviewConfig: InterviewConfig;
  selectedSessionId?: string | null;
  selectedContactId?: string | null;
  adminView?: "interviews" | "codes";
}) {
  const navigate = useNavigate();
  const isCodesView = adminView === "codes";
  const [passphrase, setPassphrase] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return (
      window.sessionStorage.getItem(getAdminSessionKey(interviewConfig.slug)) ||
      window.sessionStorage.getItem(LEGACY_ADMIN_SESSION_KEY)
    );
  });
  const [results, setResults] = useState<StoredResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedResult, setSelectedResult] = useState<StoredResult | null>(
    null
  );
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactError, setContactError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const contactRows = buildContactRows(contacts);

  const setSyncFailureState = useCallback(
    (message: string) => {
      setSyncStatus((previous) => ({
        interviewSlug: previous?.interviewSlug || interviewConfig.slug,
        status: "error",
        lastSyncedAt: previous?.lastSyncedAt,
        lastRequestedAt: previous?.lastRequestedAt,
        lastError: message,
      }));
      setSyncError(message);
    },
    [interviewConfig.slug]
  );

  const refreshContacts = useCallback(async (pass: string) => {
    try {
      const scopedData = await listContacts(pass, interviewConfig.slug);
      setContacts(scopedData.contacts || []);
      setContactError(null);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load contacts";
      if (message === "Unauthorized") {
        setPassphrase(null);
        if (typeof window !== "undefined") {
          window.sessionStorage.removeItem(getAdminSessionKey(interviewConfig.slug));
          window.sessionStorage.removeItem(LEGACY_ADMIN_SESSION_KEY);
        }
      } else {
        setContactError(message);
      }
    }
  }, [interviewConfig.slug]);

  const fetchResults = useCallback(
    async (pass: string, options?: { showLoading?: boolean }) => {
      const showLoading = options?.showLoading ?? false;
      if (showLoading) {
        setLoading(true);
      }
    setError(null);
    try {
      const resp = await fetch(
        `/api/admin?resource=results&interview=${encodeURIComponent(interviewConfig.slug)}`,
        {
        headers: { Authorization: `Bearer ${pass}` },
        }
      );
      if (resp.status === 401) {
        setError("Incorrect passphrase");
        setPassphrase(null);
        if (typeof window !== "undefined") {
          window.sessionStorage.removeItem(getAdminSessionKey(interviewConfig.slug));
          window.sessionStorage.removeItem(LEGACY_ADMIN_SESSION_KEY);
        }
        return;
      }
      const data = await resp.json();
      const rawResults: unknown[] = Array.isArray(data.results) ? data.results : [];
      setResults(rawResults.filter(isStoredResult));
    } catch {
      setError("Failed to load results");
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
    },
    [interviewConfig.slug]
  );

  const refreshSyncStatus = useCallback(async (pass: string) => {
    try {
      const data = await getSyncStatus(pass, interviewConfig.slug);
      setSyncStatus(data.sync);
      setSyncError(null);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load sync status";
      setSyncFailureState(message);
    }
  }, [interviewConfig.slug, setSyncFailureState]);

  const handleLogin = useCallback((pass: string) => {
    setPassphrase(pass);
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem(getAdminSessionKey(interviewConfig.slug), pass);
      window.sessionStorage.removeItem(LEGACY_ADMIN_SESSION_KEY);
    }
  }, [interviewConfig.slug]);

  useEffect(() => {
    if (passphrase) {
      if (isCodesView) {
        void refreshContacts(passphrase);
        void refreshSyncStatus(passphrase);
        void fetchResults(passphrase);
      } else {
        void fetchResults(passphrase, { showLoading: true });
      }
    }
  }, [passphrase, fetchResults, isCodesView, refreshContacts, refreshSyncStatus]);

  useEffect(() => {
    if (!passphrase || isCodesView) return;

    const intervalId = window.setInterval(() => {
      void fetchResults(passphrase);
    }, 3000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [passphrase, isCodesView, fetchResults]);

  useEffect(() => {
    if (!selectedSessionId) {
      setSelectedResult(null);
      return;
    }
    const match = results.find((result) => result.sessionId === selectedSessionId);
    setSelectedResult(match ?? null);
  }, [results, selectedSessionId]);

  const handleSyncNow = async () => {
    if (!passphrase) {
      setSyncFailureState("Unauthorized");
      return;
    }
    setSyncLoading(true);
    try {
      const data = await triggerSyncNow(passphrase, interviewConfig.slug);
      setSyncStatus(data.sync);
      setSyncError(null);
      await refreshContacts(passphrase);
      await fetchResults(passphrase);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to sync now";
      setSyncFailureState(message);
    } finally {
      setSyncLoading(false);
    }
  };

  const formatDateTime = (value: string | undefined): string => {
    if (!value) return "Not yet";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleString();
  };

  const syncFailureMessage = syncError || syncStatus?.lastError || null;
  const hasSyncFailure =
    syncStatus?.status === "error" || Boolean(syncFailureMessage);
  const lastSyncedLabel =
    hasSyncFailure && !syncStatus?.lastSyncedAt
      ? "Failed"
      : formatDateTime(syncStatus?.lastSyncedAt);
  const lastRequestedLabel = formatDateTime(syncStatus?.lastRequestedAt);
  const selectedContact =
    isCodesView && selectedContactId
      ? contactRows.find((contact) => contact.id === selectedContactId) || null
      : null;
  const contactLifecycleById = isCodesView
    ? new Map<string, ContactLifecycleMetrics>(
        contactRows.map((contact) => [contact.id, buildContactLifecycleMetrics(contact, results)])
      )
    : new Map<string, ContactLifecycleMetrics>();

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(results, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${interviewConfig.slug}-results-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!passphrase) {
    return <LoginForm onLogin={handleLogin} />;
  }

  if (selectedResult) {
    return (
      <ResultDetail
        result={selectedResult}
        onBack={() => {
          setSelectedResult(null);
          navigate(`/${interviewConfig.slug}/admin`);
        }}
      />
    );
  }

  if (selectedContact) {
    return (
      <ContactDetail
        contact={selectedContact}
        interviewSlug={interviewConfig.slug}
        results={results}
        onBack={() => navigate(`/${interviewConfig.slug}/admin/codes`)}
        onOpenSession={(sessionId) =>
          navigate(`/${interviewConfig.slug}/admin/${encodeURIComponent(sessionId)}`)
        }
      />
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-card border-b border-border px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Users className="w-5 h-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold text-foreground">
            {isCodesView ? "Contacts" : "Interviews"}
          </h1>
          {isCodesView ? (
            <span className="text-sm text-muted-foreground">
              {contactRows.length} contact{contactRows.length !== 1 ? "s" : ""}
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">
              {results.length} interview{results.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isCodesView ? (
            <button
              onClick={() => navigate(`/${interviewConfig.slug}/admin`)}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground bg-secondary hover:bg-accent px-3 py-1.5 rounded-lg transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Interviews
            </button>
          ) : (
            <>
              <button
                onClick={() => navigate(`/${interviewConfig.slug}/admin/codes`)}
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground bg-secondary hover:bg-accent px-3 py-1.5 rounded-lg transition-colors"
              >
                <Link2 className="w-4 h-4" />
                Contacts
              </button>
              <button
                onClick={handleExport}
                disabled={results.length === 0}
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground bg-secondary hover:bg-accent px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
              >
                <Download className="w-4 h-4" />
                Export JSON
              </button>
            </>
          )}
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-4 py-6">
        {isCodesView && (
          <section className="bg-card border border-border rounded-xl p-5 mb-6">
            <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Contacts</h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Read-only mirror of Neotoma contact data. Each contact can include one or more interview codes.
                </p>
              </div>
              <button
                type="button"
                onClick={handleSyncNow}
                disabled={syncLoading}
                className="inline-flex items-center gap-1.5 rounded-lg bg-secondary hover:bg-accent text-sm text-foreground px-3 py-1.5 transition-colors disabled:opacity-60"
              >
                <RefreshCw className={`w-4 h-4 ${syncLoading ? "animate-spin" : ""}`} />
                {syncLoading ? "Syncing..." : "Sync now"}
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-4 text-xs">
              <div className="rounded-lg border border-border px-3 py-2">
                <p className="text-muted-foreground">Sync status</p>
                <p className="text-foreground font-medium mt-0.5">
                  {syncStatus?.status || "idle"}
                </p>
              </div>
              <div className="rounded-lg border border-border px-3 py-2">
                <p className="text-muted-foreground">Last synced</p>
                <p
                  className={`font-medium mt-0.5 ${hasSyncFailure ? "text-red-500" : "text-foreground"}`}
                >
                  {lastSyncedLabel}
                </p>
              </div>
              <div className="rounded-lg border border-border px-3 py-2">
                <p className="text-muted-foreground">Last sync requested</p>
                <p className="text-foreground font-medium mt-0.5">
                  {lastRequestedLabel}
                </p>
              </div>
            </div>
            {(contactError || syncFailureMessage) && (
              <p className="text-xs text-red-500 mb-3">
                {contactError || syncFailureMessage}
              </p>
            )}
            <div className="space-y-2">
              {contactRows.length === 0 && (
                <p className="text-xs text-muted-foreground">No contacts available yet.</p>
              )}
              {contactRows.map((contact) => (
                (() => {
                  const lifecycle = contactLifecycleById.get(contact.id);
                  const status = lifecycle
                    ? getMostAdvancedLifecycleStatus(lifecycle, contact.invited)
                    : { label: "Uninvited", className: "text-muted-foreground bg-secondary" };
                  return (
                <div
                  key={contact.id}
                  role="button"
                  tabIndex={0}
                  onClick={() =>
                    navigate(
                      `/${interviewConfig.slug}/admin/codes/${encodeURIComponent(contact.id)}`
                    )
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      navigate(
                        `/${interviewConfig.slug}/admin/codes/${encodeURIComponent(contact.id)}`
                      );
                    }
                  }}
                  className="border border-border rounded-lg px-3 py-2 cursor-pointer hover:bg-secondary/30 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-foreground">{contact.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {contact.email || "No email"} · {contact.context || "No context"} · {contact.source || "unknown"}
                      </p>
                    </div>
                    <div className="text-right">
                      <span className="text-xs text-muted-foreground">Read-only</span>
                      <div className="mt-1">
                        <span
                          className={`inline-flex text-xs font-medium px-2 py-0.5 rounded-full ${status.className}`}
                        >
                          {status.label}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {contact.codes.map((code) => (
                      <a
                        key={`${contact.id}:${code}`}
                        href={`/${interviewConfig.slug}/${code}`}
                        onClick={(event) => event.stopPropagation()}
                        className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-primary hover:text-primary/80 hover:border-primary/40"
                      >
                        <Link2 className="w-3 h-3" />
                        {code}
                      </a>
                    ))}
                  </div>
                </div>
                  );
                })()
              ))}
            </div>
          </section>
        )}

        {!isCodesView && loading && (
          <p className="text-sm text-muted-foreground text-center py-12">Loading...</p>
        )}

        {!isCodesView && error && (
          <p className="text-sm text-red-500 text-center py-12">{error}</p>
        )}

        {!isCodesView && !loading && results.length === 0 && (
          <div className="text-center py-16">
            <MessageSquare className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground">No interviews completed yet</p>
            <p className="text-sm text-muted-foreground mt-1">
              Send links to contacts to get started
            </p>
          </div>
        )}

        {!isCodesView && results.length > 0 && (
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">
                    Contact
                  </th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">
                    Date
                  </th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">
                    ICP Match
                  </th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">
                    Confidence
                  </th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">
                    Referral
                  </th>
                  <th className="w-8"></th>
                </tr>
              </thead>
              <tbody>
                {results
                  .sort(
                    (a, b) =>
                      toTimestampMs(b?.assessment?.timestamp) -
                      toTimestampMs(a?.assessment?.timestamp)
                  )
                  .map((result) => (
                    (() => {
                      const normalizedTier = normalizeIcpTier(result.assessment.icpTier);
                      const displayTier =
                        normalizedTier !== "none"
                          ? normalizedTier
                          : inferIcpTierForDisplay(result.assessment);
                      return (
                        <tr
                          key={result.sessionId}
                          onClick={() => {
                            setSelectedResult(result);
                            navigate(
                              `/${interviewConfig.slug}/admin/${encodeURIComponent(result.sessionId)}`
                            );
                          }}
                          className="border-b border-border hover:bg-secondary/40 cursor-pointer transition-colors"
                        >
                          <td className="px-4 py-3 text-sm font-medium text-foreground">
                            {result.assessment.contactName || "Anonymous"}
                          </td>
                          <td className="px-4 py-3 text-sm text-muted-foreground">
                            {formatDateOnly(result.assessment.timestamp)}
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                                displayTier !== "none"
                                  ? "bg-primary/10 text-primary"
                                  : "bg-secondary text-muted-foreground"
                              }`}
                            >
                              {TIER_LABELS[displayTier]}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm text-muted-foreground">
                            {result.assessment.matchConfidence}%
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                                REFERRAL_COLORS[
                                  result.assessment.referralPotential
                                ]
                              }`}
                            >
                              {result.assessment.referralPotential}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <ChevronRight className="w-4 h-4 text-muted-foreground" />
                          </td>
                        </tr>
                      );
                    })()
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
