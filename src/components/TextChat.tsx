import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Mic, Loader2 } from "lucide-react";
import type { Contact } from "../lib/contacts";
import type { Assessment } from "../lib/assessment";
import { generateSessionId } from "../lib/assessment";
import { buildSystemPrompt } from "../lib/system_prompt";
import { getInterviewOpeningMessage } from "../lib/interview_opening";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface TextChatProps {
  contact: Contact | null;
  transcript: Message[];
  onComplete: (transcript: Message[], assessment: Assessment) => void;
  onSwitchMode: () => void;
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

export default function TextChat({
  contact,
  transcript: initialTranscript,
  onComplete,
  onSwitchMode,
}: TextChatProps) {
  const [messages, setMessages] = useState<Message[]>(initialTranscript);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId] = useState(generateSessionId);
  const [startTime] = useState(Date.now);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const systemPrompt = useRef(buildSystemPrompt(contact));
  const hasInitialized = useRef(false);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(scrollToBottom, [messages]);

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
                    content: stripAssessment(accumulated),
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
          assessment.sessionId = sessionId;
          assessment.timestamp = new Date().toISOString();
          assessment.durationSeconds = Math.round(
            (Date.now() - startTime) / 1000
          );
          if (contact?.name) assessment.contactName = contact.name;

          const finalTranscript = [
            ...allMessages,
            { role: "assistant" as const, content: stripAssessment(accumulated) },
          ];

          await fetch("/api/results", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ assessment, transcript: finalTranscript }),
          }).catch(() => {});

          setTimeout(() => onComplete(finalTranscript, assessment), 1500);
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
    [contact, sessionId, startTime, onComplete]
  );

  useEffect(() => {
    if (hasInitialized.current) return;
    hasInitialized.current = true;

    if (messages.length === 0) {
      setMessages([
        { role: "assistant", content: getInterviewOpeningMessage(contact) },
      ]);
    }
  }, [messages.length, contact]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;

    const newMessages: Message[] = [
      ...messages,
      { role: "user", content: trimmed },
    ];
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
              Mark's AI Assistant
            </p>
            <p className="text-xs text-muted-foreground">Network survey</p>
          </div>
        </div>
        <button
          onClick={onSwitchMode}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground bg-secondary hover:bg-accent px-3 py-1.5 rounded-full transition-colors"
        >
          <Mic className="w-3.5 h-3.5" />
          Switch to voice
        </button>
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
              <p className="text-sm leading-relaxed whitespace-pre-wrap">
                {msg.content}
              </p>
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
