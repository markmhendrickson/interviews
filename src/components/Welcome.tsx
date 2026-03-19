import { Mic, MessageSquare, CalendarDays } from "lucide-react";
import type { Contact } from "../lib/contacts";
import type { InterviewConfig } from "../interviews/registry";

interface WelcomeProps {
  contact: Contact | null;
  onStart: (mode: "text" | "voice") => void;
  interviewConfig: InterviewConfig;
  liveScheduleUrl: string;
}

export default function Welcome({
  contact,
  onStart,
  interviewConfig,
  liveScheduleUrl,
}: WelcomeProps) {

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <div className="max-w-lg w-full">
        <div className="mb-8 flex items-start text-left">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold text-foreground mb-2">
              {contact ? `Hi ${contact.name}!` : interviewConfig.welcomeHeadline}
            </h1>
            <div className="text-[15px] text-muted-foreground leading-[1.7] space-y-3">
              <p>{interviewConfig.welcomeDescription}</p>
              <p>
                I set up an AI-powered conversational format so we can do
                this on your schedule — no back-and-forth to find a time.
                Or just book a call if you'd rather talk live.
              </p>
              <p className="text-muted-foreground/80">
                Takes about 5 minutes. You'll get tailored suggestions at the end.
              </p>
            </div>
            <p className="text-sm text-muted-foreground/70 mt-5">
              — Mark
            </p>
          </div>
          <img
            src="/profile.jpg"
            alt="Mark Hendrickson"
            className="mt-0.5 mx-4 h-16 w-16 shrink-0 rounded-full object-cover shadow-sm ring-2 ring-border sm:mx-5 sm:mt-1 sm:h-24 sm:w-24"
          />
        </div>

        <div className="bg-card text-card-foreground rounded-xl border border-border p-6 shadow-[0px_15px_30px_0px_rgba(0,0,0,0.05)]">
          <p className="text-sm font-medium text-foreground mb-4">
            Choose how you want to continue
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
            <button
              onClick={() => onStart("voice")}
              className="flex flex-col items-center gap-2 p-4 rounded-lg border-2 transition-all min-h-[132px] border-violet-500/40 text-violet-700 dark:text-violet-400 hover:border-violet-500/60 hover:bg-violet-500/5"
            >
              <Mic className="w-6 h-6 flex-shrink-0" />
              <span className="text-sm font-semibold">Voice conversation</span>
              <span className="text-xs text-violet-700/80 dark:text-violet-400/80">
                Talk through it naturally
              </span>
              <span className="text-[11px] text-violet-600/80 dark:text-violet-400/80 mt-auto font-medium uppercase tracking-wide">
                ~5 min
              </span>
            </button>

            <button
              onClick={() => onStart("text")}
              className="flex flex-col items-center gap-2 p-4 rounded-lg border-2 transition-all min-h-[132px] border-amber-500/40 text-amber-800 dark:text-amber-400 hover:border-amber-500/60 hover:bg-amber-500/5"
            >
              <MessageSquare className="w-6 h-6 flex-shrink-0" />
              <span className="text-sm font-semibold">Text conversation</span>
              <span className="text-xs text-amber-800/80 dark:text-amber-400/80">
                Chat at your own pace
              </span>
              <span className="text-[11px] text-amber-700/80 dark:text-amber-400/80 mt-auto font-medium uppercase tracking-wide">
                ~5 min
              </span>
            </button>

            <button
              onClick={() => {
                window.location.href = liveScheduleUrl;
              }}
              className="flex flex-col items-center gap-2 p-4 rounded-lg border-2 transition-all min-h-[132px] border-emerald-500/40 text-emerald-700 dark:text-emerald-400 hover:border-emerald-500/60 hover:bg-emerald-500/5"
            >
              <CalendarDays className="w-6 h-6 flex-shrink-0" />
              <span className="text-sm font-semibold">Live with Mark</span>
              <span className="text-xs text-emerald-700/80 dark:text-emerald-400/80">
                One-on-one call with me
              </span>
              <span className="text-[11px] text-emerald-600/80 dark:text-emerald-400/80 mt-auto font-medium uppercase tracking-wide">
                30 min
              </span>
            </button>
          </div>

          <p className="text-xs text-muted-foreground text-center">
            Not either/or — you can still schedule live afterward.
          </p>
        </div>

        <div className="text-center mt-6">
          <p className="text-xs text-muted-foreground leading-relaxed max-w-sm mx-auto">
            Voice and text conversations use AI on Mark's behalf. Your
            responses are shared only with Mark. No account needed, nothing
            public.
          </p>
        </div>
      </div>
    </div>
  );
}
