import { Routes, Route, useSearchParams } from "react-router-dom";
import { useState } from "react";
import Welcome from "./components/Welcome";
import TextChat from "./components/TextChat";
import VoiceChat from "./components/VoiceChat";
import RecommendationPanel from "./components/RecommendationPanel";
import AdminResults from "./components/AdminResults";
import type { Assessment } from "./lib/assessment";
import { resolveContact } from "./lib/contacts";

type InterviewMode = "text" | "voice";
type AppPhase = "welcome" | "interview" | "results";

function Interview() {
  const [searchParams] = useSearchParams();
  const contactCode = searchParams.get("c")?.trim() ?? null;
  const contact = resolveContact(contactCode);

  const [phase, setPhase] = useState<AppPhase>("welcome");
  const [mode, setMode] = useState<InterviewMode>("text");
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [transcript, setTranscript] = useState<
    { role: "user" | "assistant"; content: string }[]
  >([]);

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
  };

  const handleSwitchMode = (newMode: InterviewMode) => {
    setMode(newMode);
  };

  if (phase === "welcome") {
    return <Welcome contact={contact} onStart={handleStart} />;
  }

  if (phase === "results" && assessment) {
    return (
      <RecommendationPanel
        assessment={assessment}
        transcript={transcript}
        contact={contact}
      />
    );
  }

  if (mode === "voice") {
    return (
      <VoiceChat
        contact={contact}
        transcript={transcript}
        onComplete={handleInterviewComplete}
        onSwitchMode={() => handleSwitchMode("text")}
      />
    );
  }

  return (
    <TextChat
      contact={contact}
      transcript={transcript}
      onComplete={handleInterviewComplete}
      onSwitchMode={() => handleSwitchMode("voice")}
    />
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Interview />} />
      <Route path="/admin" element={<AdminResults />} />
    </Routes>
  );
}
