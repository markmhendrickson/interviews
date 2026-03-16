import { useState } from "react";
import { Mic, MessageSquare, ArrowRight } from "lucide-react";
import type { Contact } from "../lib/contacts";

type InterviewMode = "text" | "voice";

interface WelcomeProps {
  contact: Contact | null;
  onStart: (mode: InterviewMode) => void;
}

export default function Welcome({ contact, onStart }: WelcomeProps) {
  const [selectedMode, setSelectedMode] = useState<InterviewMode>("text");

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <div className="max-w-lg w-full">
        <div className="text-center mb-8">
          <img
            src="/profile.jpg"
            alt="Mark Hendrickson"
            className="w-24 h-24 rounded-full object-cover mx-auto mb-4 shadow-sm ring-2 ring-border"
          />
          <h1 className="text-2xl font-semibold text-foreground mb-2">
            {contact ? `Hi ${contact.name}!` : "Hi there!"}
          </h1>
          <p className="text-lg text-muted-foreground leading-relaxed max-w-md mx-auto">
            I'm building something and would love to learn how AI fits into your
            life. It's about 5 questions, takes roughly 5 minutes, and you'll
            get personalized recommendations at the end.
          </p>
          <p className="text-sm text-muted-foreground mt-2">— Mark Hendrickson</p>
        </div>

        <div className="bg-card text-card-foreground rounded-xl border border-border p-6 shadow-[0px_15px_30px_0px_rgba(0,0,0,0.05)]">
          <p className="text-sm font-medium text-foreground mb-4">
            How would you like to chat?
          </p>

          <div className="grid grid-cols-2 gap-3 mb-6">
            <button
              onClick={() => setSelectedMode("voice")}
              className={`flex flex-col items-center gap-2 p-4 rounded-lg border-2 transition-all ${
                selectedMode === "voice"
                  ? "border-primary/70 bg-primary/10 text-primary"
                  : "border-border hover:border-primary/40 text-muted-foreground"
              }`}
            >
              <Mic className="w-6 h-6" />
              <span className="text-sm font-medium">Voice</span>
              <span className="text-xs text-muted-foreground">Speak naturally</span>
            </button>

            <button
              onClick={() => setSelectedMode("text")}
              className={`flex flex-col items-center gap-2 p-4 rounded-lg border-2 transition-all ${
                selectedMode === "text"
                  ? "border-primary/70 bg-primary/10 text-primary"
                  : "border-border hover:border-primary/40 text-muted-foreground"
              }`}
            >
              <MessageSquare className="w-6 h-6" />
              <span className="text-sm font-medium">Text</span>
              <span className="text-xs text-muted-foreground">Type your answers</span>
            </button>
          </div>

          <button
            onClick={() => onStart(selectedMode)}
            className="w-full flex items-center justify-center gap-2 bg-primary hover:bg-primary/90 text-primary-foreground font-medium py-3 px-6 rounded-lg transition-colors"
          >
            Start conversation
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>

        <div className="text-center mt-6">
          <p className="text-xs text-muted-foreground leading-relaxed max-w-sm mx-auto">
            This conversation is powered by AI. Your responses will be shared
            only with Mark. He may publish aggregate insights but will never
            publish or share your personal responses or associated identity. No account
            required.
          </p>
        </div>
      </div>
    </div>
  );
}
