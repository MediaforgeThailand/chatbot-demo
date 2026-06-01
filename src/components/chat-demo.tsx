"use client";

import {
  AlertCircle,
  Bot,
  Database,
  FileText,
  Loader2,
  Send,
  User,
} from "lucide-react";
import { FormEvent, useMemo, useState } from "react";

type ChatSource = {
  id: number;
  sourceName: string;
  similarity: number;
  metadata: Record<string, unknown>;
};

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  content: string;
  sources?: ChatSource[];
};

const sampleQuestions = [
  "สมัครเรียนต้องใช้เอกสารอะไรบ้าง",
  "ค่าเทอมของหลักสูตร ปวช. เท่าไหร่",
  "มีทุนการศึกษาแบบไหนบ้าง",
  "ติดต่อฝ่ายทะเบียนได้ช่องทางไหน",
];

const initialMessages: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    content:
      "พร้อมสำหรับ demo chatbot โรงเรียน/วิทยาลัยแล้ว เมื่อตั้งค่า Gemini และ Supabase ระบบจะค้นเอกสารก่อนแล้วค่อยตอบจากข้อมูลอ้างอิง",
  },
];

export function ChatDemo() {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [question, setQuestion] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const canSubmit = useMemo(
    () => question.trim().length > 0 && !isLoading,
    [isLoading, question],
  );

  async function submitQuestion(nextQuestion = question) {
    const trimmedQuestion = nextQuestion.trim();

    if (!trimmedQuestion || isLoading) {
      return;
    }

    setQuestion("");
    setIsLoading(true);
    setLastError(null);

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmedQuestion,
    };

    setMessages((currentMessages) => [...currentMessages, userMessage]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ question: trimmedQuestion }),
      });

      const data = (await response.json()) as {
        answer?: string;
        sources?: ChatSource[];
        error?: string;
        missingEnv?: string[];
      };

      if (!response.ok) {
        const missingEnvText = data.missingEnv?.length
          ? ` (${data.missingEnv.join(", ")})`
          : "";

        throw new Error(`${data.error ?? "Request failed"}${missingEnvText}`);
      }

      setMessages((currentMessages) => [
        ...currentMessages,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: data.answer ?? "ไม่พบคำตอบ",
          sources: data.sources ?? [],
        },
      ]);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "เกิดข้อผิดพลาดระหว่างเรียก backend";

      setLastError(message);
      setMessages((currentMessages) => [
        ...currentMessages,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content:
            "ยังตอบจากฐานข้อมูลไม่ได้ ตรวจสอบ env และ Supabase migration ก่อนใช้งานจริง",
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitQuestion();
  }

  return (
    <main className="min-h-screen bg-[#f6f7f9] text-[#18202f]">
      <div className="mx-auto grid min-h-screen w-full max-w-7xl grid-cols-1 gap-0 lg:grid-cols-[320px_1fr]">
        <aside className="border-b border-[#d7dce5] bg-white px-5 py-5 lg:border-b-0 lg:border-r">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-md bg-[#0f766e] text-white">
              <Bot size={22} aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-lg font-semibold">School RAG Chatbot</h1>
              <p className="text-sm text-[#596579]">Gemini + Supabase Vector</p>
            </div>
          </div>

          <div className="mt-7 space-y-4">
            <div className="rounded-md border border-[#d7dce5] bg-[#fbfcfd] p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Database size={16} aria-hidden="true" />
                Retrieval pipeline
              </div>
              <dl className="mt-3 space-y-2 text-sm text-[#596579]">
                <div className="flex justify-between gap-4">
                  <dt>Vector DB</dt>
                  <dd className="font-medium text-[#18202f]">Supabase pgvector</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt>Embedding</dt>
                  <dd className="font-medium text-[#18202f]">768 dimensions</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt>Answer model</dt>
                  <dd className="font-medium text-[#18202f]">Gemini Flash</dd>
                </div>
              </dl>
            </div>

            <div>
              <h2 className="text-sm font-semibold">ตัวอย่างคำถาม</h2>
              <div className="mt-3 grid gap-2">
                {sampleQuestions.map((sampleQuestion) => (
                  <button
                    key={sampleQuestion}
                    type="button"
                    onClick={() => void submitQuestion(sampleQuestion)}
                    className="min-h-11 rounded-md border border-[#d7dce5] bg-white px-3 py-2 text-left text-sm transition hover:border-[#0f766e] hover:bg-[#f0fdfa] disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={isLoading}
                  >
                    {sampleQuestion}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </aside>

        <section className="flex min-h-screen flex-col">
          <header className="border-b border-[#d7dce5] bg-white px-5 py-4">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-sm font-medium text-[#0f766e]">Demo console</p>
                <h2 className="text-2xl font-semibold">ถามตอบจากเอกสารสถานศึกษา</h2>
              </div>
              <p className="text-sm text-[#596579]">
                คำตอบต้องมาจาก context ที่ค้นเจอเท่านั้น
              </p>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
              {messages.map((message) => (
                <article
                  key={message.id}
                  className={`flex gap-3 ${
                    message.role === "user" ? "justify-end" : "justify-start"
                  }`}
                >
                  {message.role === "assistant" ? (
                    <MessageIcon tone="assistant" />
                  ) : null}

                  <div
                    className={`max-w-[min(42rem,85vw)] rounded-md border px-4 py-3 shadow-sm ${
                      message.role === "user"
                        ? "border-[#1d4ed8] bg-[#1d4ed8] text-white"
                        : "border-[#d7dce5] bg-white text-[#18202f]"
                    }`}
                  >
                    <p className="whitespace-pre-wrap text-sm leading-6">
                      {message.content}
                    </p>

                    {message.sources && message.sources.length > 0 ? (
                      <div className="mt-3 border-t border-[#e4e8ef] pt-3">
                        <div className="flex items-center gap-2 text-xs font-semibold uppercase text-[#596579]">
                          <FileText size={14} aria-hidden="true" />
                          Sources
                        </div>
                        <ul className="mt-2 space-y-2">
                          {message.sources.map((source) => (
                            <li
                              key={source.id}
                              className="rounded border border-[#e4e8ef] bg-[#fbfcfd] px-3 py-2 text-xs text-[#596579]"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <span className="font-medium text-[#18202f]">
                                  {source.sourceName}
                                </span>
                                <span>{Math.round(source.similarity * 100)}%</span>
                              </div>
                              {Object.keys(source.metadata).length > 0 ? (
                                <code className="mt-1 block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px]">
                                  {JSON.stringify(source.metadata)}
                                </code>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>

                  {message.role === "user" ? <MessageIcon tone="user" /> : null}
                </article>
              ))}

              {isLoading ? (
                <div className="flex items-center gap-2 text-sm text-[#596579]">
                  <Loader2 className="animate-spin" size={16} aria-hidden="true" />
                  กำลังค้นเอกสารและสร้างคำตอบ
                </div>
              ) : null}

              {lastError ? (
                <div className="flex items-start gap-2 rounded-md border border-[#f59e0b] bg-[#fff7ed] px-4 py-3 text-sm text-[#92400e]">
                  <AlertCircle
                    className="mt-0.5 shrink-0"
                    size={16}
                    aria-hidden="true"
                  />
                  <span>{lastError}</span>
                </div>
              ) : null}
            </div>
          </div>

          <form
            onSubmit={handleSubmit}
            className="border-t border-[#d7dce5] bg-white px-4 py-4 sm:px-6"
          >
            <div className="mx-auto flex w-full max-w-3xl gap-3">
              <label className="sr-only" htmlFor="question">
                คำถาม
              </label>
              <input
                id="question"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="ถามเรื่องการสมัครเรียน ค่าเทอม หลักสูตร หรือช่องทางติดต่อ"
                className="min-h-12 flex-1 rounded-md border border-[#c9d1df] bg-white px-4 text-sm outline-none transition placeholder:text-[#8a94a6] focus:border-[#0f766e] focus:ring-4 focus:ring-[#99f6e4]"
              />
              <button
                type="submit"
                disabled={!canSubmit}
                className="inline-flex min-h-12 items-center gap-2 rounded-md bg-[#0f766e] px-4 text-sm font-semibold text-white transition hover:bg-[#115e59] disabled:cursor-not-allowed disabled:bg-[#94a3b8]"
              >
                {isLoading ? (
                  <Loader2 className="animate-spin" size={18} aria-hidden="true" />
                ) : (
                  <Send size={18} aria-hidden="true" />
                )}
                ส่ง
              </button>
            </div>
          </form>
        </section>
      </div>
    </main>
  );
}

function MessageIcon({ tone }: { tone: "assistant" | "user" }) {
  const Icon = tone === "assistant" ? Bot : User;

  return (
    <div
      className={`mt-1 flex size-9 shrink-0 items-center justify-center rounded-md ${
        tone === "assistant"
          ? "bg-[#0f766e] text-white"
          : "bg-[#dbeafe] text-[#1d4ed8]"
      }`}
    >
      <Icon size={18} aria-hidden="true" />
    </div>
  );
}
