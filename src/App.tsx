import {
  Routes,
  Route,
  useSearchParams,
  Link,
  Navigate,
  useParams,
  useNavigate,
  useLocation,
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
  pathMode,
}: {
  interviewConfig: InterviewConfig;
  pathContactCode?: string | null;
  pathMode?: InterviewMode | null;
}) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
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
    if (!pathMode) return;
    setMode(pathMode);
    setPhase((currentPhase) =>
      currentPhase === "welcome" ? "interview" : currentPhase
    );
  }, [pathMode]);

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

  const buildInterviewPath = (nextMode?: InterviewMode) => {
    const basePath = pathContactCode
      ? `/${interviewConfig.slug}/${encodeURIComponent(pathContactCode)}`
      : `/${interviewConfig.slug}`;
    if (!nextMode) return `${basePath}${location.search}`;
    return `${basePath}/${nextMode}${location.search}`;
  };

  useEffect(() => {
    // Keep interview mode explicit in the URL so browser back/forward
    // can reliably move between text and voice states.
    if (phase !== "interview") return;
    if (pathMode) return;
    navigate(buildInterviewPath(mode), { replace: true });
  }, [mode, navigate, pathMode, phase]);

  const handleStart = (selectedMode: InterviewMode) => {
    setMode(selectedMode);
    setPhase("interview");
    navigate(buildInterviewPath(selectedMode), { replace: false });
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
    navigate(buildInterviewPath(), { replace: false });
  };

  const handleSwitchMode = (newMode: InterviewMode) => {
    setMode(newMode);
    navigate(buildInterviewPath(newMode), { replace: false });
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
        <h1 className="text-2xl font-semibold mb-2">Conversations</h1>
        <p className="text-sm text-muted-foreground mb-6">
          Choose a conversation to get started.
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
  const { interviewSlug, "*": restPath } = useParams();
  const interviewConfig = getInterviewConfigBySlug(interviewSlug);
  if (!interviewConfig) {
    return <Navigate to="/" replace />;
  }

  const segments = (restPath || "").split("/").filter(Boolean);
  let pathContactCode: string | null = null;
  let pathMode: InterviewMode | null = null;

  if (segments.length === 1) {
    if (segments[0] === "text" || segments[0] === "voice") {
      pathMode = segments[0];
    } else {
      pathContactCode = segments[0];
    }
  } else if (segments.length === 2) {
    if (segments[1] !== "text" && segments[1] !== "voice") {
      return <Navigate to={`/${interviewConfig.slug}`} replace />;
    }
    pathContactCode = segments[0];
    pathMode = segments[1];
  } else if (segments.length > 2) {
    return <Navigate to={`/${interviewConfig.slug}`} replace />;
  }

  return (
    <Interview
      interviewConfig={interviewConfig}
      pathContactCode={pathContactCode}
      pathMode={pathMode}
    />
  );
}

function InterviewAdminRoute() {
  const { interviewSlug, sessionId } = useParams();
  const interviewConfig = getInterviewConfigBySlug(interviewSlug);
  if (!interviewConfig) {
    return <Navigate to="/" replace />;
  }
  return (
    <AdminResults
      interviewConfig={interviewConfig}
      selectedSessionId={sessionId ?? null}
    />
  );
}

function InterviewAdminCodesRoute() {
  const { interviewSlug } = useParams();
  const interviewConfig = getInterviewConfigBySlug(interviewSlug);
  if (!interviewConfig) {
    return <Navigate to="/" replace />;
  }
  return <AdminResults interviewConfig={interviewConfig} adminView="codes" />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route
        path="/admin"
        element={<Navigate to={`/${getDefaultInterviewConfig().slug}/admin`} replace />}
      />
      <Route path="/:interviewSlug/admin/codes" element={<InterviewAdminCodesRoute />} />
      <Route path="/:interviewSlug/admin/:sessionId" element={<InterviewAdminRoute />} />
      <Route path="/:interviewSlug/admin" element={<InterviewAdminRoute />} />
      <Route path="/:interviewSlug/*" element={<InterviewRoute />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
