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
import { extractAnonymousContactIdentity } from "../lib/contact_identity";
import { getAnonymousNameFirstMessage } from "../lib/interview_opening";

import { enforceSingleTrailingQuestion } from "../lib/turn_rules";
import type { InterviewConfig } from "../interviews/registry";
import {
  countUserMessages,
  recordInterviewEvent,
  sendAbandonBeacon,
  upsertPartialResult,
} from "../lib/interview_events";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface VoiceChatProps {
  contact: Contact | null;
  shareCode?: string | null;
  transcript: Message[];
  resumeFromTranscript?: boolean;
  onTranscriptChange: (transcript: Message[]) => void;
  onComplete: (transcript: Message[], assessment: Assessment) => void;
  onSwitchMode: () => void;
  interviewConfig: InterviewConfig;
}

type VoiceStatus = "connecting" | "connected" | "speaking" | "listening" | "error";

function buildResumeContext(messages: Message[]): string {
  const meaningfulMessages = messages
    .filter((m) => m.content?.trim())
    .slice(-8)
    .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content.trim()}`);
  if (meaningfulMessages.length === 0) return "";
  return [
    "Resume an in-progress interview.",
    "Do not re-introduce yourself or restart the interview.",
    "Continue naturally from the latest context below:",
    meaningfulMessages.join("\n"),
  ].join("\n");
}

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
const RESUME_VERBALIZE_PROMPT_TOKEN = "[[RESUME_VERBALIZE_LAST_AI_TURN]]";

function getReplayAssistantExcerpt(messages: Message[]): string | null {
  const lastAssistantMessage = [...messages]
    .reverse()
    .find((item) => item.role === "assistant" && item.content?.trim())?.content;
  if (!lastAssistantMessage) return null;
  const normalized = lastAssistantMessage.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.slice(0, 400);
}

function buildResumeVerbalizePrompt(replayExcerpt: string): string {
  return `${RESUME_VERBALIZE_PROMPT_TOKEN} Please say your latest assistant response out loud first. Use this exact response once: "${replayExcerpt}". Then continue naturally from there with one concise follow-up question.`;
}

function normalizeReplayCompare(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/["'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isSameReplayTurn(incoming: string, expected: string): boolean {
  const a = normalizeReplayCompare(incoming);
  const b = normalizeReplayCompare(expected);
  if (!a || !b) return false;
  if (a === b) return true;
  const nearPrefix = a.startsWith(b) || b.startsWith(a);
  return nearPrefix && Math.abs(a.length - b.length) <= 30;
}

function isLikelyRestartIntroMessage(message: string): boolean {
  const s = String(message || "").trim().toLowerCase();
  if (!s) return false;
  return (
    /thanks for taking the time/.test(s) ||
    /before we get into tools/.test(s) ||
    /what'?s your name\??$/.test(s) ||
    /where does ai come in for you\??$/.test(s) ||
    /^hi[!,. ]/.test(s)
  );
}

function buildVoiceProsodyGuidance(contact: Contact | null): string {
  const baseRules = [
    "Voice style guidance:",
    "- Keep cadence smooth and conversational with no dramatic pauses around names.",
    "- Use the contact name sparingly (greeting and occasional confirmation only).",
    "- Do not address the contact by name in consecutive turns.",
    "- Avoid vocative phrasing like ', Name,' in the middle of a sentence.",
  ];
  const contactName = String(contact?.name || "").trim();
  if (!contactName) {
    return baseRules.join("\n");
  }
  return [
    ...baseRules,
    `- For this session, if you use the name "${contactName}", keep it naturally integrated and no more than once every 3-4 turns.`,
  ].join("\n");
}

function estimateAutoEndDelayMs(finalAssistantText: string): number {
  const text = String(finalAssistantText || "").trim();
  if (!text) return 3200;
  const words = text.split(/\s+/).filter(Boolean).length;
  const punctuationPauses = (text.match(/[,.!?;:]/g) || []).length;
  const estimated =
    2200 + words * 260 + Math.min(8, punctuationPauses) * 140;
  return Math.max(3200, Math.min(10000, estimated));
}

export default function VoiceChat({
  contact,
  shareCode,
  transcript: initialTranscript,
  resumeFromTranscript = false,
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
  const [isEndingConversation, setIsEndingConversation] = useState(false);
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
  const isSwitchingMode = useRef(false);
  const hasRequestedSessionClose = useRef(false);
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
  const shouldResumeFromTranscript =
    resumeFromTranscript &&
    initialTranscript.some(
      (item) => item.role === "user" && Boolean(item.content?.trim())
    );
  const isSpeakerMutedRef = useRef(isSpeakerMuted);
  const isResumeAudioGuardActive = useRef(false);
  const resumeStartedAtRef = useRef<number | null>(null);
  const expectedReplayAssistantMessageRef = useRef<string | null>(null);
  const resumeAudioUnmuteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoEndFallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastIncomingMessageRef = useRef<{
    role: "user" | "assistant";
    content: string;
    receivedAt: number;
  } | null>(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    isSpeakerMutedRef.current = isSpeakerMuted;
  }, [isSpeakerMuted]);

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

  const clearResumeAudioUnmuteTimer = () => {
    if (resumeAudioUnmuteTimer.current) {
      clearTimeout(resumeAudioUnmuteTimer.current);
      resumeAudioUnmuteTimer.current = null;
    }
  };

  const clearAutoEndFallbackTimer = () => {
    if (autoEndFallbackTimer.current) {
      clearTimeout(autoEndFallbackTimer.current);
      autoEndFallbackTimer.current = null;
    }
  };

  const requestSessionClose = useCallback(async (session: Conversation | null) => {
    if (!session) return;
    if (hasRequestedSessionClose.current) return;
    hasRequestedSessionClose.current = true;
    try {
      if (session.isOpen()) {
        await session.endSession();
      }
    } catch (error) {
      console.warn("Failed to end active voice session:", error);
    }
  }, []);

  const stopConversation = useCallback(async () => {
    const activeConversation = conversationRef.current;
    conversationRef.current = null;
    if (!activeConversation) return;
    await requestSessionClose(activeConversation);
  }, [requestSessionClose]);

  const completeInterview = useCallback(
    async (finalTranscript: Message[]) => {
      if (hasCompleted.current) return;
      const cleanedTranscript = finalTranscript.filter((m) => m.content?.trim());
      const anonymousIdentity = extractAnonymousContactIdentity(cleanedTranscript);
      const resolvedContactName = contactRef.current?.name || anonymousIdentity.name || null;
      const durationSeconds = Math.round((Date.now() - startTime) / 1000);
      let assessment: Assessment;

      try {
        const resp = await fetch("/api/assess", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transcript: cleanedTranscript,
            sessionId,
            contactName: resolvedContactName,
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
          contactName: resolvedContactName,
          durationSeconds,
        });
      }
      if (!assessment.contactName && resolvedContactName) {
        assessment.contactName = resolvedContactName;
      }
      if (!assessment.contactEmail && anonymousIdentity.email) {
        assessment.contactEmail = anonymousIdentity.email;
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

  const finalizeAutoEndAfterSpeech = useCallback(() => {
    if (hasTriggeredAutoEnd.current || hasHandledEnd.current) return;
    hasTriggeredAutoEnd.current = true;
    clearAutoEndFallbackTimer();
    const activeConversation = conversationRef.current;
    if (activeConversation) {
      void requestSessionClose(activeConversation).finally(() => {
        void handleEnd();
      });
      return;
    }
    void handleEnd();
  }, [handleEnd, requestSessionClose]);

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
    isSwitchingMode.current = false;
    hasRequestedSessionClose.current = false;
    isResumeAudioGuardActive.current = false;
    resumeStartedAtRef.current = null;
    expectedReplayAssistantMessageRef.current = null;
    clearResumeAudioUnmuteTimer();
    clearAutoEndFallbackTimer();
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
            const userMsgCount = countUserMessages(messagesRef.current);
            if (cancelled) return;
            if (isUnmounting.current) return;
            if (isSwitchingMode.current) return;
            const isExpectedTeardown =
              hasUserEnded.current ||
              hasHandledEnd.current ||
              hasCompleted.current ||
              hasRequestedSessionClose.current;
            if (isExpectedTeardown) return;
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
            // Do not finalize interview on startup/transport disconnect if no
            // user content exists yet; keep user on voice screen with error state.
            if (userMsgCount === 0) {
              hasTerminalError.current = true;
              clearConnectFailSafe();
              setStatus("error");
              setErrorMessage(
                "Voice disconnected before interview content was captured. Please retry voice or switch to text."
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
            if (
              msg.source === "user" &&
              String(msg.message || "").includes(RESUME_VERBALIZE_PROMPT_TOKEN)
            ) {
              return;
            }
            if (
              shouldResumeFromTranscript &&
              msg.source === "ai" &&
              isResumeAudioGuardActive.current
            ) {
              // During resume, drop only clear restart-intro turns.
              // If the first AI turn is genuine continuation, unmute and keep it.
              const resumedMessage = enforceSingleTrailingQuestion(
                String(msg.message || "")
              );
              if (
                resumedMessage &&
                isLikelyRestartIntroMessage(resumedMessage)
              ) {
                return;
              }
              isResumeAudioGuardActive.current = false;
              clearResumeAudioUnmuteTimer();
              const convo = conversationRef.current;
              if (!isSpeakerMutedRef.current && convo?.isOpen()) {
                convo.setVolume({ volume: 1 });
              }
            }
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
            if (
              role === "assistant" &&
              expectedReplayAssistantMessageRef.current &&
              isSameReplayTurn(
                normalizedMessage,
                expectedReplayAssistantMessageRef.current
              )
            ) {
              expectedReplayAssistantMessageRef.current = null;
              return;
            }
            const isResumeWindowActive =
              shouldResumeFromTranscript &&
              Boolean(resumeStartedAtRef.current) &&
              Date.now() - (resumeStartedAtRef.current || 0) < 10000;
            if (
              role === "assistant" &&
              isResumeWindowActive &&
              normalizedMessage
            ) {
              const duplicateAssistantTurn = messagesRef.current.some(
                (item) =>
                  item.role === "assistant" &&
                  item.content?.trim() === normalizedMessage.trim()
              );
              if (
                duplicateAssistantTurn ||
                isLikelyRestartIntroMessage(normalizedMessage)
              ) {
                return;
              }
            }
            if (normalizedMessage) {
              const now = Date.now();
              const lastIncomingMessage = lastIncomingMessageRef.current;
              if (
                lastIncomingMessage &&
                lastIncomingMessage.role === role &&
                lastIncomingMessage.content === normalizedMessage &&
                now - lastIncomingMessage.receivedAt < 2000
              ) {
                return;
              }
              lastIncomingMessageRef.current = {
                role,
                content: normalizedMessage,
                receivedAt: now,
              };
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

                  // Persist in-progress sessions so admin can see them immediately.
                  void upsertPartialResult({
                    interviewSlug: interviewConfig.slug,
                    sessionId,
                    transcript: next,
                    contactName: contactRef.current?.name || null,
                    contactCode: shareCode || contactRef.current?.code || undefined,
                    messageCount: userMessageCount,
                    durationSeconds: Math.round((Date.now() - startTime) / 1000),
                  }).catch(() => {});
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
              clearAutoEndFallbackTimer();
              // Estimate playback window from final message length, then end.
              const autoEndDelayMs = estimateAutoEndDelayMs(displayMessage);
              autoEndFallbackTimer.current = setTimeout(() => {
                if (cancelled || isUnmounting.current) return;
                finalizeAutoEndAfterSpeech();
              }, autoEndDelayMs);
            }
          },
          onError: (message: string) => {
            const normalizedMessage = String(message || "");
            if (cancelled) return;
            const isClosedStateError = /CLOSING or CLOSED state/i.test(
              normalizedMessage
            );
            const isExpectedTeardown =
              isUnmounting.current ||
              isSwitchingMode.current ||
              hasHandledEnd.current ||
              hasUserEnded.current ||
              hasCompleted.current;
            if (isClosedStateError && isExpectedTeardown) return;
            console.error("ElevenLabs error:", normalizedMessage);
            if (hasTerminalError.current) return;
            clearConnectFailSafe();
            if (isClosedStateError) {
              hasTerminalError.current = true;
              setErrorMessage(
                "Voice websocket closed unexpectedly. Please retry voice or switch to text."
              );
              if (!isUnmounting.current) {
                setStatus("error");
              }
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
        const authOrder: Array<"signed_url" | "agent_id"> = signedUrl
          ? ["signed_url", "agent_id"]
          : ["agent_id"];
        let lastError: unknown = null;
        const connectTimeoutMs = 4000;

        const startSessionWithTimeout = async (
          connectionType: "websocket",
          authMode: "signed_url" | "agent_id"
        ) => {
          let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
          try {
            const contactSnapshot = contactRef.current;
            const isAnonymous = !contactSnapshot?.name?.trim();
            const dynamicVariables: Record<string, string> = {
              contact_name: contactSnapshot?.name?.trim() || "there",
              contact_context: contactSnapshot?.context?.trim() || "",
            };
            const overrides = isAnonymous
              ? {
                  agent: {
                    firstMessage: getAnonymousNameFirstMessage(interviewConfig),
                  },
                }
              : undefined;
            // Signed URL config does not allow first_message override; only pass overrides when using agentId.
            const useOverrides = overrides && authMode !== "signed_url";
            const sessionConfig =
              authMode === "signed_url" && signedUrl
                ? {
                    ...baseConfig,
                    dynamicVariables,
                    ...(useOverrides ? { overrides } : {}),
                    signedUrl,
                    connectionType,
                  }
                : {
                    ...baseConfig,
                    dynamicVariables,
                    ...(useOverrides ? { overrides } : {}),
                    agentId: AGENT_ID,
                    connectionType,
                  };
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

        auth_loop: for (const authMode of authOrder) {
          for (const connectionType of connectionOrder) {
            if (cancelled) return;
            try {
              lastAuthMode.current = authMode;
              lastTransportAttempt.current = connectionType;
              const session = await startSessionWithTimeout(connectionType, authMode);
              if (cancelled) {
                // Cleanup: effect was torn down while we were connecting
                try {
                  if (session.isOpen()) await session.endSession();
                } catch {
                  /* ignore */
                }
                return;
              }
              conversationRef.current = session;
              try {
                session.sendContextualUpdate(
                  buildVoiceProsodyGuidance(contactRef.current)
                );
              } catch {
                // Best-effort guidance only.
              }
              
              if (shouldResumeFromTranscript) {
                isResumeAudioGuardActive.current = true;
                resumeStartedAtRef.current = Date.now();
                try {
                  session.setVolume({ volume: 0 });
                } catch {
                  // ignore volume race
                }
                const resumeContext = buildResumeContext(messagesRef.current);
                if (resumeContext) {
                  try {
                    session.sendContextualUpdate(resumeContext);
                  } catch {
                    // ignore contextual update failure
                  }
                }
                const replayExcerpt = getReplayAssistantExcerpt(messagesRef.current);
                if (replayExcerpt) {
                  expectedReplayAssistantMessageRef.current = replayExcerpt;
                  try {
                    session.sendUserMessage(buildResumeVerbalizePrompt(replayExcerpt));
                  } catch {
                    expectedReplayAssistantMessageRef.current = null;
                    // ignore resume verbalization failure
                  }
                }
                clearResumeAudioUnmuteTimer();
                resumeAudioUnmuteTimer.current = setTimeout(() => {
                  if (cancelled || isUnmounting.current) return;
                  isResumeAudioGuardActive.current = false;
                  resumeStartedAtRef.current = null;
                  const convo = conversationRef.current;
                  if (!isSpeakerMutedRef.current && convo?.isOpen()) {
                    convo.setVolume({ volume: 1 });
                  }
                }, 2000);
              }
              setErrorMessage("");
              hasConnectTimedOut.current = false;
              break auth_loop;
            } catch (err) {
              lastError = err;
              console.warn(
                `${connectionType} init failed with ${authMode}, trying next option:`,
                err
              );
            }
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
      clearResumeAudioUnmuteTimer();
      clearAutoEndFallbackTimer();
      isResumeAudioGuardActive.current = false;
      resumeStartedAtRef.current = null;
      expectedReplayAssistantMessageRef.current = null;
      const activeConversation = conversationRef.current;
      conversationRef.current = null;
      if (activeConversation) {
        void requestSessionClose(activeConversation);
      }
    };
  }, [
    handleEnd,
    interviewConfig.slug,
    requestSessionClose,
    sessionAttempt,
    sessionId,
    shareCode,
    shouldResumeFromTranscript,
    stopConversation,
    finalizeAutoEndAfterSpeech,
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
    if (isEndingConversation) return;
    setIsEndingConversation(true);
    hasUserEnded.current = true;
    hasHandledEnd.current = true;
    const finalTranscript = messagesRef.current;
    const activeConversation = conversationRef.current;
    conversationRef.current = null;

    try {
      await requestSessionClose(activeConversation);
      await completeInterview(finalTranscript);
    } finally {
      // In the normal flow we redirect away; this is a safety reset if completion fails.
      setIsEndingConversation(false);
    }
  };

  const retryConnection = () => {
    hasHandledEnd.current = false;
    hasUserEnded.current = false;
    hasConnectTimedOut.current = false;
    hasTerminalError.current = false;
    hasTriggeredAutoEnd.current = false;
    isSwitchingMode.current = false;
    hasRequestedSessionClose.current = false;
    isResumeAudioGuardActive.current = false;
    resumeStartedAtRef.current = null;
    expectedReplayAssistantMessageRef.current = null;
    clearResumeAudioUnmuteTimer();
    clearAutoEndFallbackTimer();
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
    speaking: "Speaking...",
    listening: "Listening...",
    error: "Connection error",
  };

  const switchToTextMode = async () => {
    isSwitchingMode.current = true;
    hasHandledEnd.current = true;
    hasUserEnded.current = true;
    const activeConversation = conversationRef.current;
    if (activeConversation?.isOpen()) {
      try {
        activeConversation.setVolume({ volume: 0 });
      } catch {
        // ignore
      }
      try {
        activeConversation.setMicMuted(true);
      } catch {
        // ignore
      }
    }
    await stopConversation();
    onSwitchMode();
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
            onClick={() => {
              void switchToTextMode();
            }}
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
                disabled={isEndingConversation}
                aria-label={
                  isEndingConversation ? "Ending conversation" : "End conversation"
                }
                className="flex h-12 w-12 items-center justify-center rounded-full bg-[#a85f50] text-white transition-colors hover:bg-[#925244] disabled:opacity-70 disabled:cursor-not-allowed"
              >
                {isEndingConversation ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Phone className="w-5 h-5 rotate-[135deg]" />
                )}
              </button>
            </>
          )}
        </div>
      </div>

      {messages.length > 0 && (
        <div className="bg-card border-t border-border max-h-72 overflow-y-auto px-4 py-3">
          <div className="space-y-2">
            {messages.slice(-8).map((msg, i) => (
              <p
                key={i}
                className={`text-xs ${
                  msg.role === "user" ? "text-primary" : "text-muted-foreground"
                }`}
              >
                <span className="font-medium">
                  {msg.role === "user" ? "You" : "Mark's assistant"}:
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
