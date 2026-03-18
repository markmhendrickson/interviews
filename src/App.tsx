import {
  Routes,
  Route,
  useSearchParams,
  Link,
  Navigate,
  useParams,
  useNavigate,
  useLocation,
  useNavigationType,
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
  pathThanks,
}: {
  interviewConfig: InterviewConfig;
  pathContactCode?: string | null;
  pathMode?: InterviewMode | null;
  pathThanks?: boolean;
}) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
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
  const [resumeVoiceFromTranscript, setResumeVoiceFromTranscript] =
    useState(false);
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
    if (pathThanks) return;
    if (!pathMode) return;
    setResumeVoiceFromTranscript(false);
    setMode(pathMode);
    setPhase((currentPhase) =>
      currentPhase === "welcome" ? "interview" : currentPhase
    );
  }, [pathMode, pathThanks]);

  const buildInterviewPath = (nextMode?: InterviewMode) => {
    const basePath = pathContactCode
      ? `/${interviewConfig.slug}/${encodeURIComponent(pathContactCode)}`
      : `/${interviewConfig.slug}`;
    if (!nextMode) return `${basePath}${location.search}`;
    return `${basePath}/${nextMode}${location.search}`;
  };

  const buildThanksPath = () => {
    const q = location.search;
    if (pathContactCode) {
      return `/${interviewConfig.slug}/${encodeURIComponent(pathContactCode)}/thanks${q}`;
    }
    return `/${interviewConfig.slug}/thanks${q}`;
  };

  const buildWelcomePath = () => {
    const basePath = pathContactCode
      ? `/${interviewConfig.slug}/${encodeURIComponent(pathContactCode)}`
      : `/${interviewConfig.slug}`;
    return `${basePath}${location.search}`;
  };

  useEffect(() => {
    // Keep interview mode explicit in the URL so browser back/forward
    // can reliably move between text and voice states.
    if (pathThanks) return;
    if (phase !== "interview") return;
    if (pathMode) return;
    if (navigationType === "POP") {
      // User navigated back/forward to the base interview route.
      // Treat this as returning to the intro screen.
      setPhase("welcome");
      return;
    }
    navigate(buildInterviewPath(mode), { replace: true });
  }, [mode, navigate, navigationType, pathMode, pathThanks, phase]);

  useEffect(() => {
    // If the URL explicitly targets an interview mode, prioritize that intent
    // over restoring a previously completed session to /thanks.
    if (pathMode && !pathThanks) return;

    const sessionKey = COMPLETED_SESSION_KEY(interviewConfig.slug);
    const localKey = COMPLETED_LOCAL_KEY(interviewConfig.slug);
    let raw: string | null = null;
    try {
      raw =
        typeof window !== "undefined"
          ? window.sessionStorage.getItem(sessionKey) ??
            window.localStorage.getItem(localKey)
          : null;
    } catch {
      return;
    }
    type StoredCompletion = {
      assessment: Assessment;
      transcript: { role: "user" | "assistant"; content: string }[];
      mode?: InterviewMode;
    };
    let stored: StoredCompletion | null = null;
    try {
      stored = raw ? (JSON.parse(raw) as StoredCompletion) : null;
    } catch {
      return;
    }
    const valid = Boolean(
      stored?.assessment?.sessionId && Array.isArray(stored?.transcript)
    );

    if (pathThanks) {
      if (valid && stored !== null) {
        setAssessment(stored.assessment);
        setTranscript(stored.transcript);
        if (stored.mode) setMode(stored.mode);
        setPhase("results");
      } else {
        navigate(buildWelcomePath(), { replace: true });
      }
      return;
    }

    if (valid && stored !== null) {
      setAssessment(stored.assessment);
      setTranscript(stored.transcript);
      if (stored.mode) setMode(stored.mode);
      setPhase("results");
      navigate(buildThanksPath(), { replace: true });
    }
  }, [
    interviewConfig.slug,
    pathMode,
    pathThanks,
    pathContactCode,
    location.search,
    navigate,
  ]);

  const handleStart = (selectedMode: InterviewMode) => {
    setResumeVoiceFromTranscript(false);
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
    navigate(buildThanksPath(), { replace: true });
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
    setResumeVoiceFromTranscript(false);
    setMode("text");
    setPhase("welcome");
    navigate(buildWelcomePath(), { replace: true });
  };

  const handleSwitchMode = (newMode: InterviewMode) => {
    const hasPriorUserTurns = transcript.some(
      (item) => item.role === "user" && Boolean(item.content?.trim())
    );
    const shouldResume =
      mode === "text" && newMode === "voice" && hasPriorUserTurns;
    setResumeVoiceFromTranscript(shouldResume);
    setMode(newMode);
    navigate(buildInterviewPath(newMode), { replace: false });
  };

  const handleReturnToStart = () => {
    setPhase("welcome");
    navigate(buildWelcomePath(), { replace: false });
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
        resumeFromTranscript={resumeVoiceFromTranscript}
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
      onReturnToStart={handleReturnToStart}
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
  let pathThanks = false;

  if (segments.length > 0 && segments[segments.length - 1] === "thanks") {
    pathThanks = true;
    const before = segments.slice(0, -1);
    if (before.length === 0) {
      /* /:slug/thanks */
    } else if (before.length === 1) {
      if (before[0] === "text" || before[0] === "voice") {
        pathMode = before[0];
      } else {
        pathContactCode = decodeURIComponent(before[0]);
      }
    } else if (before.length === 2) {
      if (before[1] !== "text" && before[1] !== "voice") {
        return <Navigate to={`/${interviewConfig.slug}`} replace />;
      }
      pathContactCode = decodeURIComponent(before[0]);
      pathMode = before[1];
    } else {
      return <Navigate to={`/${interviewConfig.slug}`} replace />;
    }
  } else if (segments.length === 1) {
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
      pathThanks={pathThanks}
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
  const { interviewSlug, contactId } = useParams();
  const interviewConfig = getInterviewConfigBySlug(interviewSlug);
  if (!interviewConfig) {
    return <Navigate to="/" replace />;
  }
  return (
    <AdminResults
      interviewConfig={interviewConfig}
      adminView="codes"
      selectedContactId={contactId ?? null}
    />
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route
        path="/admin"
        element={<Navigate to={`/${getDefaultInterviewConfig().slug}/admin`} replace />}
      />
      <Route
        path="/:interviewSlug/admin/codes/:contactId"
        element={<InterviewAdminCodesRoute />}
      />
      <Route path="/:interviewSlug/admin/codes" element={<InterviewAdminCodesRoute />} />
      <Route path="/:interviewSlug/admin/:sessionId" element={<InterviewAdminRoute />} />
      <Route path="/:interviewSlug/admin" element={<InterviewAdminRoute />} />
      <Route path="/:interviewSlug/*" element={<InterviewRoute />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
