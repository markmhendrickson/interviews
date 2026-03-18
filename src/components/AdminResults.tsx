import { useState, useEffect, useCallback } from "react";
import {
  Lock,
  Download,
  ChevronRight,
  ArrowLeft,
  Users,
  Target,
  MessageSquare,
  Star,
  Plus,
  Trash2,
  Link2,
} from "lucide-react";
import type { Assessment } from "../lib/assessment";
import {
  addOrUpdateContact,
  listContacts,
  removeContact,
  type Contact,
} from "../lib/contacts";
import type { InterviewConfig } from "../interviews/registry";

interface StoredResult {
  sessionId: string;
  assessment: Assessment;
  transcript: { role: "user" | "assistant"; content: string }[];
  storedAt: string;
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

const REFERRAL_COLORS: Record<string, string> = {
  high: "text-green-600 bg-green-50",
  medium: "text-yellow-600 bg-yellow-50",
  low: "text-muted-foreground bg-secondary",
};

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
            className={`text-xs font-medium px-2.5 py-1 rounded-full ${
              a.icpTier !== "none"
                ? "bg-primary/10 text-primary"
                : "bg-secondary text-muted-foreground"
            }`}
          >
            {TIER_LABELS[a.icpTier] || a.icpTier}
          </span>
          <span
            className={`text-xs font-medium px-2.5 py-1 rounded-full ${REFERRAL_COLORS[a.referralPotential]}`}
          >
            {a.referralPotential} referral
          </span>
        </div>
      </div>

      <div className="space-y-6">
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
                {a.toolsUsed.map((t, i) => (
                  <span
                    key={i}
                    className="text-xs bg-secondary text-muted-foreground px-2 py-0.5 rounded"
                  >
                    {t}
                  </span>
                ))}
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
}: {
  interviewConfig: InterviewConfig;
}) {
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
  const [contactCode, setContactCode] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactContext, setContactContext] = useState("");
  const [contactSource, setContactSource] = useState("manual");
  const [contactError, setContactError] = useState<string | null>(null);

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

  const fetchResults = useCallback(async (pass: string) => {
    setLoading(true);
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
      setResults(data.results || []);
    } catch {
      setError("Failed to load results");
    } finally {
      setLoading(false);
    }
  }, [interviewConfig.slug]);

  const handleLogin = useCallback((pass: string) => {
    setPassphrase(pass);
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem(getAdminSessionKey(interviewConfig.slug), pass);
      window.sessionStorage.removeItem(LEGACY_ADMIN_SESSION_KEY);
    }
  }, [interviewConfig.slug]);

  useEffect(() => {
    if (passphrase) {
      void fetchResults(passphrase);
      void refreshContacts(passphrase);
    }
  }, [passphrase, fetchResults, refreshContacts]);

  const handleAddContact = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passphrase) {
      setContactError("Unauthorized");
      return;
    }
    try {
      await addOrUpdateContact(
        {
          code: contactCode,
          name: contactName,
          email: contactEmail,
          context: contactContext,
          source: contactSource,
        },
        passphrase,
        interviewConfig.slug
      );
      setContactCode("");
      setContactName("");
      setContactEmail("");
      setContactContext("");
      setContactSource("manual");
      setContactError(null);
      await refreshContacts(passphrase);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to save contact";
      setContactError(message);
    }
  };

  const handleRemoveContact = async (code: string) => {
    if (!passphrase) {
      setContactError("Unauthorized");
      return;
    }
    try {
      await removeContact(code, passphrase, interviewConfig.slug);
      await refreshContacts(passphrase);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to remove contact";
      setContactError(message);
    }
  };

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
        onBack={() => setSelectedResult(null)}
      />
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-card border-b border-border px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Users className="w-5 h-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold text-foreground">
            {interviewConfig.adminTitle}
          </h1>
          <span className="text-sm text-muted-foreground">
            {results.length} interview{results.length !== 1 ? "s" : ""}
          </span>
        </div>
        <button
          onClick={handleExport}
          disabled={results.length === 0}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground bg-secondary hover:bg-accent px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
        >
          <Download className="w-4 h-4" />
          Export JSON
        </button>
      </header>

      <div className="max-w-4xl mx-auto px-4 py-6">
        <section className="bg-card border border-border rounded-xl p-5 mb-6">
          <h2 className="text-sm font-semibold text-foreground mb-3">
            Contact codes
          </h2>
          <form onSubmit={handleAddContact} className="grid grid-cols-1 md:grid-cols-12 gap-2 mb-4">
            <input
              value={contactCode}
              onChange={(e) => setContactCode(e.target.value)}
              placeholder="Code (e.g. sb26)"
              className="md:col-span-2 rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-ring"
            />
            <input
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              placeholder="Name"
              className="md:col-span-2 rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-ring"
            />
            <input
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              placeholder="Email"
              className="md:col-span-3 rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-ring"
            />
            <input
              value={contactContext}
              onChange={(e) => setContactContext(e.target.value)}
              placeholder="Context"
              className="md:col-span-2 rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-ring"
            />
            <input
              value={contactSource}
              onChange={(e) => setContactSource(e.target.value)}
              placeholder="Source"
              className="md:col-span-2 rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-ring"
            />
            <button
              type="submit"
              className="md:col-span-1 inline-flex items-center justify-center gap-1 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium px-3 py-2 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add
            </button>
          </form>
          {contactError && <p className="text-xs text-red-500 mb-3">{contactError}</p>}
          <div className="space-y-2 max-h-56 overflow-y-auto">
            {contacts.map((contact) => (
              <div key={contact.code} className="flex items-center justify-between border border-border rounded-lg px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {contact.code} · {contact.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {contact.email || "No email"} · {contact.context || "No context"} · {contact.source || "unknown"}
                  </p>
                  <a
                    href={`/${interviewConfig.slug}/${contact.code}`}
                    className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary/80 mt-1"
                  >
                    <Link2 className="w-3 h-3" />
                    /{interviewConfig.slug}/{contact.code}
                  </a>
                </div>
                <button
                  type="button"
                  onClick={() => handleRemoveContact(contact.code)}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-red-500 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Remove
                </button>
              </div>
            ))}
          </div>
        </section>

        {loading && (
          <p className="text-sm text-muted-foreground text-center py-12">Loading...</p>
        )}

        {error && (
          <p className="text-sm text-red-500 text-center py-12">{error}</p>
        )}

        {!loading && results.length === 0 && (
          <div className="text-center py-16">
            <MessageSquare className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground">No interviews completed yet</p>
            <p className="text-sm text-muted-foreground mt-1">
              Send links to contacts to get started
            </p>
          </div>
        )}

        {results.length > 0 && (
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
                      new Date(b.assessment.timestamp).getTime() -
                      new Date(a.assessment.timestamp).getTime()
                  )
                  .map((result) => (
                    <tr
                      key={result.sessionId}
                      onClick={() => setSelectedResult(result)}
                      className="border-b border-border hover:bg-secondary/40 cursor-pointer transition-colors"
                    >
                      <td className="px-4 py-3 text-sm font-medium text-foreground">
                        {result.assessment.contactName || "Anonymous"}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {new Date(
                          result.assessment.timestamp
                        ).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                            result.assessment.icpTier !== "none"
                              ? "bg-primary/10 text-primary"
                              : "bg-secondary text-muted-foreground"
                          }`}
                        >
                          {TIER_LABELS[result.assessment.icpTier] ||
                            result.assessment.icpTier}
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
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
