import {
  Routes,
  Route,
  useSearchParams,
  Link,
  Navigate,
  useParams,
} from "react-router-dom";
import { useEffect, useRef, useState } from "react";

const COMPLETED_SESSION_KEY = (slug: string) =>
  `interviews_last_completed_${slug}`;
const COMPLETED_LOCAL_KEY = (slug: string) =>
  `interviews_last_completed_persistent_${slug}`;
import Welcome from "./components/Welcome";
import TextChat from "./components/TextChat";
import VoiceChat from "./components/VoiceChat";
import RecommendationPanel from "./components/RecommendationPanel";
import AdminResults from "./components/AdminResults";
import type { Assessment } from "./lib/assessment";
import { resolveContact, type Contact } from "./lib/contacts";
import { LIVE_SCHEDULING_30_MIN_URL } from "./lib/scheduling";
import {
  getDefaultInterviewConfig,
  getInterviewConfigBySlug,
  listInterviewConfigs,
  type InterviewConfig,
} from "./interviews/registry";
import { recordInterviewEvent } from "./lib/interview_events";

type InterviewMode = "text" | "voice";
type AppPhase = "welcome" | "interview" | "results";

function Interview({
  interviewConfig,
  pathContactCode,
}: {
  interviewConfig: InterviewConfig;
  pathContactCode?: string | null;
}) {
  const [searchParams] = useSearchParams();
  const contactCode =
    pathContactCode?.trim() || searchParams.get("c")?.trim() || null;
  const [contact, setContact] = useState<Contact | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadContact() {
      try {
        const resolved = await resolveContact(contactCode, interviewConfig.slug);
        if (!cancelled) {
          setContact(resolved);
        }
      } catch {
        if (!cancelled) {
          setContact(null);
        }
      }
    }

    void loadContact();

    return () => {
      cancelled = true;
    };
  }, [contactCode, interviewConfig.slug]);

  const [phase, setPhase] = useState<AppPhase>("welcome");
  const [mode, setMode] = useState<InterviewMode>("text");
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [transcript, setTranscript] = useState<
    { role: "user" | "assistant"; content: string }[]
  >([]);
  const hasTrackedOpen = useRef(false);

  useEffect(() => {
    if (!contactCode || hasTrackedOpen.current) return;
    hasTrackedOpen.current = true;
    void recordInterviewEvent({
      eventType: "link_opened",
      interviewSlug: interviewConfig.slug,
      shareCode: contactCode,
      metadata: {
        source: pathContactCode ? "path" : "query",
      },
    }).catch(() => {});
  }, [contactCode, interviewConfig.slug, pathContactCode]);

  useEffect(() => {
    const sessionKey = COMPLETED_SESSION_KEY(interviewConfig.slug);
    const localKey = COMPLETED_LOCAL_KEY(interviewConfig.slug);
    try {
      const raw =
        typeof window !== "undefined"
          ? window.sessionStorage.getItem(sessionKey) ??
            window.localStorage.getItem(localKey)
          : null;
      if (!raw) return;
      const stored = JSON.parse(raw) as {
        assessment: Assessment;
        transcript: { role: "user" | "assistant"; content: string }[];
        mode?: InterviewMode;
      };
      if (stored?.assessment?.sessionId && Array.isArray(stored.transcript)) {
        setAssessment(stored.assessment);
        setTranscript(stored.transcript);
        if (stored.mode) setMode(stored.mode);
        setPhase("results");
      }
    } catch {
      // ignore invalid or missing session
    }
  }, [interviewConfig.slug]);

  const handleStart = (selectedMode: InterviewMode) => {
    setMode(selectedMode);
    setPhase("interview");
  };

  const handleInterviewComplete = (
    finalTranscript: { role: "user" | "assistant"; content: string }[],
    finalAssessment: Assessment
  ) => {
    setTranscript(finalTranscript);
    setAssessment(finalAssessment);
    setPhase("results");
    const sessionKey = COMPLETED_SESSION_KEY(interviewConfig.slug);
    const localKey = COMPLETED_LOCAL_KEY(interviewConfig.slug);
    const payload = JSON.stringify({
      assessment: finalAssessment,
      transcript: finalTranscript,
      mode,
    });
    try {
      window.sessionStorage.setItem(sessionKey, payload);
      window.localStorage.setItem(localKey, payload);
    } catch {
      // ignore quota or serialization errors
    }
  };

  const handleStartNewInterview = () => {
    const sessionKey = COMPLETED_SESSION_KEY(interviewConfig.slug);
    const localKey = COMPLETED_LOCAL_KEY(interviewConfig.slug);
    try {
      window.sessionStorage.removeItem(sessionKey);
      window.localStorage.removeItem(localKey);
    } catch {
      // ignore
    }
    // Reset in-memory state immediately so restart works even on same-route URLs.
    setAssessment(null);
    setTranscript([]);
    setMode("text");
    setPhase("welcome");
  };

  const handleSwitchMode = (newMode: InterviewMode) => {
    setMode(newMode);
  };

  const handleTranscriptChange = (
    nextTranscript: { role: "user" | "assistant"; content: string }[]
  ) => {
    setTranscript(nextTranscript);
  };

  if (phase === "welcome") {
    return (
      <Welcome
        contact={contact}
        onStart={handleStart}
        interviewConfig={interviewConfig}
        liveScheduleUrl={LIVE_SCHEDULING_30_MIN_URL}
      />
    );
  }

  if (phase === "results" && assessment) {
    return (
      <RecommendationPanel
        assessment={assessment}
        transcript={transcript}
        contact={contact}
        interviewConfig={interviewConfig}
        onStartNewInterview={handleStartNewInterview}
      />
    );
  }

  if (mode === "voice") {
    return (
      <VoiceChat
        contact={contact}
        shareCode={contactCode}
        transcript={transcript}
        onTranscriptChange={handleTranscriptChange}
        onComplete={handleInterviewComplete}
        onSwitchMode={() => handleSwitchMode("text")}
        interviewConfig={interviewConfig}
      />
    );
  }

  return (
    <TextChat
      contact={contact}
      shareCode={contactCode}
      transcript={transcript}
      onTranscriptChange={handleTranscriptChange}
      onComplete={handleInterviewComplete}
      onSwitchMode={() => handleSwitchMode("voice")}
      interviewConfig={interviewConfig}
    />
  );
}

function LandingPage() {
  const [searchParams] = useSearchParams();
  const contactCode = searchParams.get("c")?.trim() ?? null;

  if (contactCode) {
    return <Navigate to={`/ai?${searchParams.toString()}`} replace />;
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <div className="w-full max-w-2xl rounded-2xl border border-border bg-card p-8">
        <h1 className="text-2xl font-semibold mb-2">Interviews</h1>
        <p className="text-sm text-muted-foreground mb-6">
          Choose an interview flow.
        </p>
        <div className="space-y-3">
          {listInterviewConfigs().map((config) => (
            <Link
              key={config.slug}
              to={`/${config.slug}`}
              className="block rounded-xl border border-border px-4 py-3 hover:bg-secondary/40 transition-colors"
            >
              <p className="font-medium">{config.name}</p>
              <p className="text-xs text-muted-foreground">{config.summary}</p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

function InterviewRoute() {
  const { interviewSlug, contactCode } = useParams();
  const interviewConfig = getInterviewConfigBySlug(interviewSlug);
  if (!interviewConfig) {
    return <Navigate to="/" replace />;
  }
  return (
    <Interview
      interviewConfig={interviewConfig}
      pathContactCode={contactCode ?? null}
    />
  );
}

function InterviewAdminRoute() {
  const { interviewSlug } = useParams();
  const interviewConfig = getInterviewConfigBySlug(interviewSlug);
  if (!interviewConfig) {
    return <Navigate to="/" replace />;
  }
  return <AdminResults interviewConfig={interviewConfig} />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route
        path="/admin"
        element={<Navigate to={`/${getDefaultInterviewConfig().slug}/admin`} replace />}
      />
      <Route path="/:interviewSlug/:contactCode" element={<InterviewRoute />} />
      <Route path="/:interviewSlug" element={<InterviewRoute />} />
      <Route path="/:interviewSlug/admin" element={<InterviewAdminRoute />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
