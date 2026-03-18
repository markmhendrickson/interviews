import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Mic, Loader2, Phone } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Contact } from "../lib/contacts";
import type { Assessment } from "../lib/assessment";
import { buildFallbackAssessment, generateSessionId } from "../lib/assessment";
import { extractAnonymousContactIdentity } from "../lib/contact_identity";
import { buildSystemPrompt } from "../lib/system_prompt";
import { getInterviewOpeningMessage } from "../lib/interview_opening";
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

interface TextChatProps {
  contact: Contact | null;
  shareCode?: string | null;
  transcript: Message[];
  onTranscriptChange: (transcript: Message[]) => void;
  onComplete: (transcript: Message[], assessment: Assessment) => void;
  onSwitchMode: () => void;
  interviewConfig: InterviewConfig;
}

function parseAssessment(text: string): Assessment | null {
  const match = text.match(/<ASSESSMENT>([\s\S]*?)<\/ASSESSMENT>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim());
  } catch {
    return null;
  }
}

function stripAssessment(text: string): string {
  return text.replace(/<ASSESSMENT>[\s\S]*?<\/ASSESSMENT>/, "").trim();
}

function stripAssessmentProgressive(text: string): string {
  const startTagIndex = text.indexOf("<ASSESSMENT>");
  if (startTagIndex === -1) {
    return text;
  }
  // Hide everything from the opening tag onward while streaming
  return text.slice(0, startTagIndex).trimEnd();
}

export default function TextChat({
  contact,
  shareCode,
  transcript: initialTranscript,
  onTranscriptChange,
  onComplete,
  onSwitchMode,
  interviewConfig,
}: TextChatProps) {
  const [messages, setMessages] = useState<Message[]>(initialTranscript);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [sessionId] = useState(generateSessionId);
  const [startTime] = useState(Date.now);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const systemPrompt = useRef(buildSystemPrompt(contact, interviewConfig));
  const hasInitialized = useRef(false);
  const hasCompleted = useRef(false);
  const hasStarted = useRef(false);
  const hasSentAbandon = useRef(false);
  const userProgressMilestone = useRef(0);
  const messagesRef = useRef<Message[]>(initialTranscript);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(scrollToBottom, [messages]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    onTranscriptChange(messages);
  }, [messages, onTranscriptChange]);

  const completeInterview = useCallback(
    (finalTranscript: Message[], finalAssessment: Assessment) => {
      if (hasCompleted.current) return;
      hasCompleted.current = true;
      const userMessages = countUserMessages(finalTranscript);
      void recordInterviewEvent({
        eventType: "interview_completed",
        interviewSlug: interviewConfig.slug,
        sessionId: finalAssessment.sessionId,
        shareCode: shareCode || contact?.code,
        messageCount: userMessages,
        metadata: {
          channel: "text",
        },
      }).catch(() => {});
      onComplete(finalTranscript, finalAssessment);
    },
    [contact?.code, interviewConfig.slug, onComplete, shareCode]
  );

  const finalizeFromCurrentTranscript = useCallback(async () => {
    if (hasCompleted.current || isFinalizing) return;
    setIsFinalizing(true);
    const finalTranscript = messages.filter((m) => m.content?.trim());
    const anonymousIdentity = extractAnonymousContactIdentity(finalTranscript);
    const resolvedContactName = contact?.name || anonymousIdentity.name || null;
    const durationSeconds = Math.round((Date.now() - startTime) / 1000);
    let finalAssessment: Assessment;

    try {
      const resp = await fetch("/api/assess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: finalTranscript,
          sessionId,
          contactName: resolvedContactName,
          durationSeconds,
          interviewSlug: interviewConfig.slug,
        }),
      });
      if (!resp.ok) throw new Error("Assessment request failed");
      finalAssessment = (await resp.json()) as Assessment;
    } catch {
      finalAssessment = buildFallbackAssessment({
        transcript: finalTranscript,
        sessionId,
          contactName: resolvedContactName,
        durationSeconds,
      });
    }
    if (!finalAssessment.contactName && resolvedContactName) {
      finalAssessment.contactName = resolvedContactName;
    }
    if (!finalAssessment.contactEmail && anonymousIdentity.email) {
      finalAssessment.contactEmail = anonymousIdentity.email;
    }

    void fetch("/api/results", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assessment: finalAssessment,
        transcript: finalTranscript,
        interviewSlug: interviewConfig.slug,
      }),
    }).catch(() => {});

    completeInterview(finalTranscript, finalAssessment);
    setIsFinalizing(false);
  }, [
    completeInterview,
    contact?.name,
    interviewConfig.slug,
    isFinalizing,
    messages,
    sessionId,
    startTime,
  ]);

  const streamResponse = useCallback(
    async (allMessages: Message[]) => {
      setIsStreaming(true);
      let streamFailedWithMessage: string | null = null;

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: allMessages,
            systemPrompt: systemPrompt.current,
          }),
        });

        if (!response.ok || !response.body) {
          throw new Error("Stream failed");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";

        setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6);
            if (data === "[DONE]") break;

            try {
              const parsed = JSON.parse(data);
              if (parsed.error) {
                streamFailedWithMessage = parsed.error;
                break;
              }
              if (parsed.text) {
                accumulated += parsed.text;
                setMessages((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    role: "assistant",
                    content: enforceSingleTrailingQuestion(
                      stripAssessmentProgressive(accumulated)
                    ),
                  };
                  return updated;
                });
              }
            } catch {
              // skip malformed chunks
            }
          }

          if (streamFailedWithMessage) {
            break;
          }
        }

        if (streamFailedWithMessage) {
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              role: "assistant",
              content:
                "I hit a technical issue starting the interview. Please try again in a moment.",
            };
            return updated;
          });
          return;
        }

        const assessment = parseAssessment(accumulated);
        if (assessment) {
          const anonymousIdentity = extractAnonymousContactIdentity(allMessages);
          const resolvedContactName = contact?.name || anonymousIdentity.name || null;
          assessment.sessionId = sessionId;
          assessment.timestamp = new Date().toISOString();
          assessment.durationSeconds = Math.round(
            (Date.now() - startTime) / 1000
          );
          if (resolvedContactName) assessment.contactName = resolvedContactName;
          if (!assessment.contactEmail && anonymousIdentity.email) {
            assessment.contactEmail = anonymousIdentity.email;
          }

          const finalTranscript = [
            ...allMessages,
            {
              role: "assistant" as const,
              content: enforceSingleTrailingQuestion(
                stripAssessment(accumulated)
              ),
            },
          ];

          void fetch("/api/results", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              assessment,
              transcript: finalTranscript,
              interviewSlug: interviewConfig.slug,
            }),
          }).catch(() => {});

          completeInterview(finalTranscript, assessment);
        }
      } catch (error) {
        console.error("Stream error:", error);
        setMessages((prev) => {
          if (prev.length === 0) {
            return [
              {
                role: "assistant",
                content:
                  "Sorry, I ran into a technical issue. Could you try again?",
              },
            ];
          }

          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === "assistant") {
            updated[updated.length - 1] = {
              role: "assistant",
              content:
                "Sorry, I ran into a technical issue. Could you try again?",
            };
            return updated;
          }

          return [
            ...updated,
            {
              role: "assistant",
              content:
                "Sorry, I ran into a technical issue. Could you try again?",
            },
          ];
        });
      } finally {
        setIsStreaming(false);
      }
    },
    [completeInterview, contact, interviewConfig.slug, sessionId, startTime]
  );

  useEffect(() => {
    if (hasInitialized.current) return;
    hasInitialized.current = true;

    if (messages.length === 0) {
      setMessages([
        {
          role: "assistant",
          content: getInterviewOpeningMessage(contact, interviewConfig),
        },
      ]);
    }
  }, [messages.length, contact, interviewConfig]);

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
          shareCode: shareCode || contact?.code,
          messageCount: userMessages,
          metadata: {
            channel: "text",
          },
        },
        {
          interviewSlug: interviewConfig.slug,
          sessionId,
          transcript,
          contactCode: shareCode || contact?.code || undefined,
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
  }, [contact?.code, interviewConfig.slug, sessionId, shareCode]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;

    const newMessages: Message[] = [
      ...messages,
      { role: "user", content: trimmed },
    ];
    const userMessageCount = countUserMessages(newMessages);
    if (!hasStarted.current) {
      hasStarted.current = true;
      void recordInterviewEvent({
        eventType: "interview_started",
        interviewSlug: interviewConfig.slug,
        sessionId,
        shareCode: shareCode || contact?.code,
        messageCount: userMessageCount,
        metadata: {
          channel: "text",
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
          shareCode: shareCode || contact?.code,
          messageCount: userMessageCount,
          metadata: {
            channel: "text",
            milestone: currentMilestone,
          },
        }).catch(() => {});
      }
    }
    setMessages(newMessages);
    setInput("");
    streamResponse(newMessages);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

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
              {interviewConfig.textLabel}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onSwitchMode}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground bg-secondary hover:bg-accent px-3 py-1.5 rounded-full transition-colors"
          >
            <Mic className="w-3.5 h-3.5" />
            Switch to voice
          </button>
          <button
            onClick={() => void finalizeFromCurrentTranscript()}
            disabled={isFinalizing}
            className="flex items-center gap-1.5 text-xs bg-[#a85f50] hover:bg-[#925244] text-white px-3 py-1.5 rounded-full transition-colors disabled:opacity-60"
          >
            {isFinalizing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Phone className="w-3.5 h-3.5 rotate-[135deg]" />
            )}
            Finish now
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4 max-w-2xl mx-auto w-full">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"} animate-fade-in`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                msg.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "bg-card border border-border text-card-foreground"
              }`}
            >
              {msg.role === "assistant" ? (
                <div className="text-sm leading-relaxed prose prose-sm max-w-none prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-1 prose-code:text-current prose-code:bg-secondary/60 prose-code:px-1 prose-code:py-0.5 prose-code:rounded">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {msg.content}
                  </ReactMarkdown>
                </div>
              ) : (
                <p className="text-sm leading-relaxed whitespace-pre-wrap">
                  {msg.content}
                </p>
              )}
            </div>
          </div>
        ))}

        {isStreaming && messages[messages.length - 1]?.role !== "assistant" && (
          <div className="flex justify-start animate-fade-in">
            <div className="bg-card border border-border rounded-2xl px-4 py-3">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="bg-card border-t border-border px-4 py-3">
        <div className="max-w-2xl mx-auto flex gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type your message..."
            disabled={isStreaming}
            rows={1}
            className="flex-1 resize-none rounded-xl border border-input bg-background px-4 py-2.5 text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-ring disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isStreaming}
            className="bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl p-2.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
