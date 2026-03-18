import { useState, useRef, useEffect, useCallback } from "react";
import {
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  MessageSquare,
  Loader2,
  Phone,
  RotateCcw,
  Copy,
  Check,
} from "lucide-react";
import { Conversation } from "@elevenlabs/client";
import type { Contact } from "../lib/contacts";
import type { Assessment } from "../lib/assessment";
import { buildFallbackAssessment, generateSessionId } from "../lib/assessment";
import { enforceSingleTrailingQuestion } from "../lib/turn_rules";
import type { InterviewConfig } from "../interviews/registry";
import {
  countUserMessages,
  recordInterviewEvent,
  sendAbandonBeacon,
} from "../lib/interview_events";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface VoiceChatProps {
  contact: Contact | null;
  shareCode?: string | null;
  transcript: Message[];
  onTranscriptChange: (transcript: Message[]) => void;
  onComplete: (transcript: Message[], assessment: Assessment) => void;
  onSwitchMode: () => void;
  interviewConfig: InterviewConfig;
}

type VoiceStatus = "connecting" | "connected" | "speaking" | "listening" | "error";

function extractAgentId(rawValue: string): string {
  if (!rawValue) return "";
  const trimmed = rawValue.trim();

  // Accept full dashboard URLs and extract the raw agent id.
  const fromUrl = trimmed.match(/agent_[a-zA-Z0-9]+/);
  if (fromUrl) return fromUrl[0];

  // Accept plain env values with accidental query strings.
  const noQuery = trimmed.split("?")[0];
  const plain = noQuery.match(/agent_[a-zA-Z0-9]+/);
  return plain ? plain[0] : "";
}

const RAW_AGENT_ENV = import.meta.env.ELEVENLABS_AGENT_ID || "";
const AGENT_ID = extractAgentId(RAW_AGENT_ENV);
const AGENT_ID_LOOKS_MALFORMED =
  !!RAW_AGENT_ENV &&
  !AGENT_ID &&
  (RAW_AGENT_ENV.includes("elevenlabs.io") ||
    RAW_AGENT_ENV.includes("branchId") ||
    RAW_AGENT_ENV.includes("?"));

const HARD_END_SESSION_TOKEN = "[[END_SESSION]]";

export default function VoiceChat({
  contact,
  shareCode,
  transcript: initialTranscript,
  onTranscriptChange,
  onComplete,
  onSwitchMode,
  interviewConfig,
}: VoiceChatProps) {
  const [status, setStatus] = useState<VoiceStatus>("connecting");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>(initialTranscript);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isSpeakerMuted, setIsSpeakerMuted] = useState(false);
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [copiedDebugInfo, setCopiedDebugInfo] = useState(false);
  const [sessionId] = useState(generateSessionId);
  const [startTime] = useState(Date.now);
  const conversationRef = useRef<Conversation | null>(null);
  const onCompleteRef = useRef(onComplete);
  const contactRef = useRef(contact);
  const messagesRef = useRef<Message[]>(initialTranscript);
  const hasHandledEnd = useRef(false);
  const hasCompleted = useRef(false);
  const isUnmounting = useRef(false);
  const hasUserEnded = useRef(false);
  const hasConnectTimedOut = useRef(false);
  const hasTerminalError = useRef(false);
  const hasTriggeredAutoEnd = useRef(false);
  const hasStarted = useRef(false);
  const hasSentAbandon = useRef(false);
  const userProgressMilestone = useRef(0);
  const connectFailSafeTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const connectingSince = useRef<number>(Date.now());
  const lastTransportAttempt = useRef<"websocket" | "webrtc" | null>(null);
  const lastAuthMode = useRef<"signed_url" | "agent_id">("agent_id");
  const [clockTick, setClockTick] = useState(Date.now());

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    onTranscriptChange(messages);
  }, [messages, onTranscriptChange]);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    contactRef.current = contact;
  }, [contact]);

  useEffect(() => {
    if (status !== "connecting") return;
    const timer = setInterval(() => setClockTick(Date.now()), 500);
    return () => clearInterval(timer);
  }, [status]);

  const clearConnectFailSafe = () => {
    if (connectFailSafeTimer.current) {
      clearTimeout(connectFailSafeTimer.current);
      connectFailSafeTimer.current = null;
    }
  };

  const stopConversation = useCallback(async () => {
    const activeConversation = conversationRef.current;
    conversationRef.current = null;
    if (!activeConversation) return;
    try {
      if (activeConversation.isOpen()) {
        await activeConversation.endSession();
      }
    } catch (error) {
      console.warn("Failed to end active voice session:", error);
    }
  }, []);

  const completeInterview = useCallback(
    async (finalTranscript: Message[]) => {
      if (hasCompleted.current) return;
      const cleanedTranscript = finalTranscript.filter((m) => m.content?.trim());
      const durationSeconds = Math.round((Date.now() - startTime) / 1000);
      let assessment: Assessment;

      try {
        const resp = await fetch("/api/assess", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transcript: cleanedTranscript,
            sessionId,
            contactName: contactRef.current?.name,
            durationSeconds,
            interviewSlug: interviewConfig.slug,
          }),
        });
        if (!resp.ok) throw new Error("Assessment request failed");
        assessment = (await resp.json()) as Assessment;
      } catch {
        assessment = buildFallbackAssessment({
          transcript: cleanedTranscript,
          sessionId,
          contactName: contactRef.current?.name,
          durationSeconds,
        });
      }

      void fetch("/api/results", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assessment,
          transcript: cleanedTranscript,
          interviewSlug: interviewConfig.slug,
        }),
      }).catch(() => {});

      const userMessages = countUserMessages(cleanedTranscript);
      void recordInterviewEvent({
        eventType: "interview_completed",
        interviewSlug: interviewConfig.slug,
        sessionId,
        shareCode: shareCode || contactRef.current?.code,
        messageCount: userMessages,
        metadata: {
          channel: "voice",
        },
      }).catch(() => {});

      hasCompleted.current = true;
      onCompleteRef.current(cleanedTranscript, assessment);
    },
    [interviewConfig.slug, sessionId, shareCode, startTime]
  );

  const handleEnd = useCallback(async () => {
    if (hasHandledEnd.current) return;

    const finalTranscript = messagesRef.current;
    hasHandledEnd.current = true;
    await completeInterview(finalTranscript);
  }, [completeInterview]);

  useEffect(() => {
    const sendAbandon = () => {
      if (hasCompleted.current || hasSentAbandon.current || !hasStarted.current) return;
      const transcript = messagesRef.current.filter((item) => item.content?.trim());
      const userMessages = countUserMessages(transcript);
      if (userMessages === 0) return;
      hasSentAbandon.current = true;
      sendAbandonBeacon(
        {
          eventType: "interview_abandoned",
          interviewSlug: interviewConfig.slug,
          sessionId,
          shareCode: shareCode || contactRef.current?.code,
          messageCount: userMessages,
          metadata: {
            channel: "voice",
          },
        },
        {
          interviewSlug: interviewConfig.slug,
          sessionId,
          transcript,
          contactCode: shareCode || contactRef.current?.code || undefined,
          messageCount: userMessages,
        }
      );
    };

    const handleBeforeUnload = () => {
      sendAbandon();
    };

    const handleVisibilityChange = () => {
      if (document.hidden) sendAbandon();
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [interviewConfig.slug, sessionId, shareCode]);

  useEffect(() => {
    if (!AGENT_ID) return;
    let cancelled = false;
    hasHandledEnd.current = false;
    isUnmounting.current = false;
    hasUserEnded.current = false;
    hasConnectTimedOut.current = false;
    hasTerminalError.current = false;
    hasTriggeredAutoEnd.current = false;
    connectingSince.current = Date.now();

    async function startVoice() {
      try {
        clearConnectFailSafe();
        connectFailSafeTimer.current = setTimeout(() => {
          if (cancelled || isUnmounting.current) return;
          hasConnectTimedOut.current = true;
          hasTerminalError.current = true;
          setErrorMessage(
            "Voice connection timed out. Please try again or switch to text."
          );
          setStatus("error");
          void stopConversation();
        }, 5000);

        if (cancelled) return;

        let signedUrl: string | null = null;
        try {
          for (const endpoint of ["/api/elevenlabs/signed-url"]) {
            const resp = await fetch(endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ agentId: AGENT_ID }),
            });
            if (resp.ok) {
              const data = (await resp.json()) as { signedUrl?: string };
              if (data?.signedUrl) {
                signedUrl = data.signedUrl;
                lastAuthMode.current = "signed_url";
                break;
              }
            }
          }
          if (!signedUrl) {
            lastAuthMode.current = "agent_id";
          }
        } catch {
          lastAuthMode.current = "agent_id";
        }
        if (cancelled) return;

        const baseConfig = {
          onConnect: () => {
            if (cancelled) return;
            if (hasConnectTimedOut.current) return;
            if (!isUnmounting.current) {
              clearConnectFailSafe();
              hasTerminalError.current = false;
              setStatus("connected" as const);
            }
          },
          onDisconnect: (details?: {
            reason?: string;
            message?: string;
            closeCode?: number;
            closeReason?: string;
          }) => {
            if (cancelled) return;
            if (isUnmounting.current) return;
            if (hasTerminalError.current) return;
            const disconnectText = `${details?.message ?? ""} ${details?.closeReason ?? ""}`.toLowerCase();
            if (details?.reason === "error" && /quota|limit|billing|payment/.test(disconnectText)) {
              hasTerminalError.current = true;
              clearConnectFailSafe();
              setStatus("error");
              setErrorMessage(
                "Voice service quota reached for this ElevenLabs account. Add credits or raise limits, then retry voice."
              );
              return;
            }
            clearConnectFailSafe();
            void handleEnd();
          },
          onModeChange: ({ mode }: { mode: string }) => {
            if (cancelled) return;
            if (mode === "speaking") setStatus("speaking");
            else if (mode === "listening") setStatus("listening");
            else setStatus("connected");
          },
          onMessage: (msg: { source: "user" | "ai"; message: string }) => {
            if (cancelled) return;
            const rawMessage = String(msg.message || "");
            const hasHardEndToken =
              msg.source === "ai" && rawMessage.includes(HARD_END_SESSION_TOKEN);
            const displayMessage = hasHardEndToken
              ? rawMessage
                  .split(HARD_END_SESSION_TOKEN)
                  .join("")
                  .trim()
              : rawMessage;
            const role = msg.source === "user" ? ("user" as const) : ("assistant" as const);
            const normalizedMessage =
              role === "assistant"
                ? enforceSingleTrailingQuestion(displayMessage)
                : displayMessage;
            if (normalizedMessage) {
              setMessages((prev) => {
                const next = [...prev, { role, content: normalizedMessage }];
                if (role === "user") {
                  const userMessageCount = countUserMessages(next);
                  if (!hasStarted.current) {
                    hasStarted.current = true;
                    void recordInterviewEvent({
                      eventType: "interview_started",
                      interviewSlug: interviewConfig.slug,
                      sessionId,
                      shareCode: shareCode || contactRef.current?.code,
                      messageCount: userMessageCount,
                      metadata: {
                        channel: "voice",
                      },
                    }).catch(() => {});
                  }
                  const currentMilestone = Math.floor(userMessageCount / 3);
                  if (currentMilestone > userProgressMilestone.current) {
                    userProgressMilestone.current = currentMilestone;
                    if (currentMilestone >= 1) {
                      void recordInterviewEvent({
                        eventType: "interview_progressed",
                        interviewSlug: interviewConfig.slug,
                        sessionId,
                        shareCode: shareCode || contactRef.current?.code,
                        messageCount: userMessageCount,
                        metadata: {
                          channel: "voice",
                          milestone: currentMilestone,
                        },
                      }).catch(() => {});
                    }
                  }
                }
                return next;
              });
            }
            if (
              msg.source === "ai" &&
              hasHardEndToken &&
              !hasTriggeredAutoEnd.current &&
              !hasHandledEnd.current
            ) {
              hasTriggeredAutoEnd.current = true;
              const activeConversation = conversationRef.current;
              if (activeConversation?.isOpen()) {
                void activeConversation
                  .endSession()
                  .catch(() => {})
                  .finally(() => {
                    void handleEnd();
                  });
              } else {
                void handleEnd();
              }
            }
          },
          onError: (message: string) => {
            const normalizedMessage = String(message || "");
            if (cancelled) return;
            console.error("ElevenLabs error:", normalizedMessage);
            if (hasTerminalError.current) return;
            clearConnectFailSafe();
            if (/CLOSING or CLOSED state/i.test(normalizedMessage)) {
              hasTerminalError.current = true;
              setErrorMessage(
                "Voice websocket closed unexpectedly. Please retry voice or switch to text."
              );
              if (!isUnmounting.current) {
                setStatus("error");
              }
              void stopConversation();
              return;
            }
            setErrorMessage(normalizedMessage);
            if (!isUnmounting.current) {
              hasTerminalError.current = true;
              setStatus("error");
            }
          },
        };

        // Use websocket only. The WebRTC transport has shown repeated
        // compatibility issues in this environment (rtc path / error_type).
        const connectionOrder: Array<"websocket"> = ["websocket"];
        let lastError: unknown = null;
        const connectTimeoutMs = 4000;

        const startSessionWithTimeout = async (connectionType: "websocket") => {
          let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
          try {
            const sessionConfig = signedUrl
              ? { ...baseConfig, signedUrl, connectionType }
              : { ...baseConfig, agentId: AGENT_ID, connectionType };
            const sessionPromise = Conversation.startSession(sessionConfig);
            const timeoutPromise = new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(() => {
                reject(
                  new Error(
                    `Voice connection timed out using ${connectionType}.`
                  )
                );
              }, connectTimeoutMs);
            });

            return await Promise.race([sessionPromise, timeoutPromise]);
          } finally {
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
            }
          }
        };

        for (const connectionType of connectionOrder) {
          if (cancelled) return;
          try {
            lastTransportAttempt.current = connectionType;
            const session = await startSessionWithTimeout(connectionType);
            if (cancelled) {
              // Cleanup: effect was torn down while we were connecting
              try { await session.endSession(); } catch { /* ignore */ }
              return;
            }
            conversationRef.current = session;
            setErrorMessage("");
            hasConnectTimedOut.current = false;
            break;
          } catch (err) {
            lastError = err;
            console.warn(
              `${connectionType} init failed, trying next transport:`,
              err
            );
          }
        }

        if (cancelled) return;
        if (!conversationRef.current) {
          throw lastError instanceof Error
            ? lastError
            : new Error("Could not initialize voice session.");
        }
      } catch (error) {
        clearConnectFailSafe();
        console.error("Failed to start voice:", error);
        const message =
          error instanceof Error ? error.message : "Could not initialize voice session.";
        setErrorMessage(message);
        setStatus("error");
      }
    }

    startVoice();

    return () => {
      cancelled = true;
      isUnmounting.current = true;
      clearConnectFailSafe();
      const activeConversation = conversationRef.current;
      conversationRef.current = null;
      if (activeConversation) {
        try { activeConversation.endSession().catch(() => {}); } catch { /* ignore */ }
      }
    };
  }, [
    contact?.name,
    contact?.context,
    handleEnd,
    interviewConfig.slug,
    sessionAttempt,
    sessionId,
    shareCode,
    stopConversation,
  ]);

  const toggleMicMute = () => {
    if (!conversationRef.current) return;
    setIsMicMuted((prev) => {
      const next = !prev;
      conversationRef.current?.setMicMuted(next);
      return next;
    });
  };

  const toggleSpeakerMute = () => {
    if (!conversationRef.current) return;
    setIsSpeakerMuted((prev) => {
      const next = !prev;
      conversationRef.current?.setVolume({ volume: next ? 0 : 1 });
      return next;
    });
  };

  const endConversation = async () => {
    hasUserEnded.current = true;
    hasHandledEnd.current = true;
    const finalTranscript = messagesRef.current;
    const activeConversation = conversationRef.current;
    conversationRef.current = null;

    try {
      if (activeConversation?.isOpen()) {
        await activeConversation.endSession();
      }
    } catch (error) {
      console.warn("Manual endSession failed:", error);
    }

    await completeInterview(finalTranscript);
  };

  const retryConnection = () => {
    hasHandledEnd.current = false;
    hasUserEnded.current = false;
    hasConnectTimedOut.current = false;
    hasTerminalError.current = false;
    hasTriggeredAutoEnd.current = false;
    connectingSince.current = Date.now();
    setErrorMessage("");
    setStatus("connecting");
    setCopiedDebugInfo(false);
    setSessionAttempt((prev) => prev + 1);
  };

  const getDebugInfoText = () => {
    const timeoutReason = forcedConnectTimeout
      ? "Voice connection timed out."
      : errorMessage || "Unknown voice connection error.";
    return [
      "interviews_voice_debug",
      `interview=${interviewConfig.slug}`,
      `transport=${lastTransportAttempt.current ?? "unknown"}`,
      `auth_mode=${lastAuthMode.current}`,
      `attempt=${sessionAttempt + 1}`,
      `elapsed_seconds=${diagnosticsElapsedSeconds}`,
      `status=${effectiveStatus}`,
      `reason=${timeoutReason}`,
      `agent_id=${AGENT_ID || "missing"}`,
    ].join(" | ");
  };

  const copyDebugInfo = async () => {
    try {
      await navigator.clipboard.writeText(getDebugInfoText());
      setCopiedDebugInfo(true);
      setTimeout(() => setCopiedDebugInfo(false), 1500);
    } catch (error) {
      console.warn("Failed to copy debug info:", error);
    }
  };

  const statusLabel: Record<VoiceStatus, string> = {
    connecting: "Connecting...",
    connected: "Connected",
    speaking: "AI is speaking...",
    listening: "Listening...",
    error: "Connection error",
  };

  const forcedConnectTimeout =
    status === "connecting" && clockTick - connectingSince.current > 5000;
  const effectiveStatus: VoiceStatus = forcedConnectTimeout ? "error" : status;
  const diagnosticsElapsedSeconds = Math.max(
    0,
    Math.round((Date.now() - connectingSince.current) / 1000)
  );

  if (!AGENT_ID) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-background">
        <div className="text-center max-w-md">
          <p className="text-muted-foreground mb-4">
            Voice mode requires an ElevenLabs agent to be configured. Falling
            back to text mode.
          </p>
          {AGENT_ID_LOOKS_MALFORMED && (
            <p className="text-xs text-muted-foreground mb-3">
              Use the raw `agent_...` ID only (not the full ElevenLabs URL with
              `branchId`).
            </p>
          )}
          <button
            onClick={onSwitchMode}
            className="bg-primary hover:bg-primary/90 text-primary-foreground font-medium py-2 px-6 rounded-lg transition-colors"
          >
            Switch to text mode
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="bg-card border-b border-border px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">
            M
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">
              {interviewConfig.assistantDisplayName}
            </p>
            <p className="text-xs text-muted-foreground">
              {interviewConfig.voiceLabel}
            </p>
          </div>
        </div>
        <button
          onClick={onSwitchMode}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground bg-secondary hover:bg-accent px-3 py-1.5 rounded-full transition-colors"
        >
          <MessageSquare className="w-3.5 h-3.5" />
          Switch to text
        </button>
      </header>

      <div className="flex-1 flex flex-col items-center justify-center px-4">
        <div className="relative mb-8">
          <div
            className={`w-32 h-32 rounded-full flex items-center justify-center transition-all duration-500 ${
              effectiveStatus === "speaking"
                ? "bg-primary/15 scale-110"
                : effectiveStatus === "listening"
                  ? "bg-accent scale-105"
                  : effectiveStatus === "connecting"
                    ? "bg-secondary"
                    : effectiveStatus === "error"
                      ? "bg-destructive/10"
                      : "bg-secondary"
            }`}
          >
            {effectiveStatus === "connecting" ? (
              <Loader2 className="w-12 h-12 text-muted-foreground animate-spin" />
            ) : effectiveStatus === "speaking" ? (
              <div className="flex gap-1.5 items-end h-8">
                {[...Array(5)].map((_, i) => (
                  <div
                    key={i}
                    className="w-1.5 bg-primary rounded-full animate-pulse"
                    style={{
                      height: `${12 + Math.random() * 20}px`,
                      animationDelay: `${i * 0.1}s`,
                    }}
                  />
                ))}
              </div>
            ) : effectiveStatus === "listening" ? (
              <Mic className="w-12 h-12 text-primary" />
            ) : effectiveStatus === "error" ? (
              <MicOff className="w-12 h-12 text-destructive" />
            ) : (
              <Mic className="w-12 h-12 text-muted-foreground" />
            )}
          </div>

          {(effectiveStatus === "listening" || effectiveStatus === "speaking") && (
            <div className="absolute inset-0 rounded-full animate-ping opacity-20 bg-primary" />
          )}
        </div>

        <p className="text-lg font-medium text-foreground mb-2">
          {statusLabel[effectiveStatus]}
        </p>

        {effectiveStatus === "error" && (
          <div className="mb-4 text-center max-w-xs">
            <p className="text-sm text-muted-foreground">
              Could not connect to voice service. Try text mode instead.
              {forcedConnectTimeout
                ? " Voice connection timed out."
                : errorMessage
                  ? ` ${errorMessage}`
                  : ""}
            </p>
            <p className="mt-2 text-[11px] text-muted-foreground/90">
              Diagnostics: transport {lastTransportAttempt.current ?? "unknown"} ·
              auth {lastAuthMode.current} · attempt {sessionAttempt + 1} · elapsed{" "}
              {diagnosticsElapsedSeconds}s
            </p>
            <button
              onClick={retryConnection}
              className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-secondary hover:bg-accent px-3 py-1.5 text-xs text-secondary-foreground transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Retry voice
            </button>
            <button
              onClick={copyDebugInfo}
              className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-secondary hover:bg-accent px-3 py-1.5 text-xs text-secondary-foreground transition-colors"
            >
              {copiedDebugInfo ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  Copied debug info
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  Copy debug info
                </>
              )}
            </button>
          </div>
        )}

        <div className="mt-4 inline-flex items-center justify-center gap-3 self-center">
          {effectiveStatus !== "error" &&
            effectiveStatus !== "connecting" && (
            <>
              <button
                onClick={toggleMicMute}
                aria-label={isMicMuted ? "Unmute microphone" : "Mute microphone"}
                className={`flex h-12 w-12 items-center justify-center rounded-full transition-colors ${
                  isMicMuted
                    ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
                    : "bg-secondary text-secondary-foreground hover:bg-accent"
                }`}
              >
                {isMicMuted ? (
                  <MicOff className="w-5 h-5" />
                ) : (
                  <Mic className="w-5 h-5" />
                )}
              </button>
              <button
                onClick={toggleSpeakerMute}
                aria-label={isSpeakerMuted ? "Unmute speaker" : "Mute speaker"}
                className={`flex h-12 w-12 items-center justify-center rounded-full transition-colors ${
                  isSpeakerMuted
                    ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
                    : "bg-secondary text-secondary-foreground hover:bg-accent"
                }`}
              >
                {isSpeakerMuted ? (
                  <VolumeX className="w-5 h-5" />
                ) : (
                  <Volume2 className="w-5 h-5" />
                )}
              </button>
              <button
                onClick={endConversation}
                className="flex h-12 w-12 items-center justify-center rounded-full bg-[#a85f50] text-white transition-colors hover:bg-[#925244]"
              >
                <Phone className="w-5 h-5 rotate-[135deg]" />
              </button>
            </>
          )}
        </div>
      </div>

      {messages.length > 0 && (
        <div className="bg-card border-t border-border max-h-48 overflow-y-auto px-4 py-3">
          <p className="text-xs text-muted-foreground mb-2 font-medium uppercase tracking-wide">
            Transcript
          </p>
          <div className="space-y-2">
            {messages.slice(-4).map((msg, i) => (
              <p
                key={i}
                className={`text-xs ${
                  msg.role === "user" ? "text-primary" : "text-muted-foreground"
                }`}
              >
                <span className="font-medium">
                  {msg.role === "user" ? "You" : "AI"}:
                </span>{" "}
                {msg.content}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
