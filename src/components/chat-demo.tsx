"use client";

import {
  AlertCircle,
  Bot,
  Database,
  Loader2,
  Send,
  User,
} from "lucide-react";
import { FormEvent, useMemo, useState } from "react";

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  content: string;
};

type ConversationMemory = {
  calendarYear?: number;
  calendarMonthKey?: string;
  corrections: string[];
};

const sampleQuestions = [
  "สมัครเรียน ปวช. ต้องใช้เอกสารอะไรบ้าง",
  "วิทยาลัยเปิดสอนหลักสูตรอะไรบ้าง",
  "ชำระค่าเทอมได้ช่องทางไหน",
  "ระเบียบการแต่งกายของนักศึกษามีอะไรบ้าง",
  "ถ้ามาสายหรือขาดเรียนมีระเบียบอย่างไร",
];
const MAX_HISTORY_MESSAGES = 24;

export function ChatDemo() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationMemory, setConversationMemory] = useState<ConversationMemory>({
    corrections: [],
  });
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

    const repeatedAnswer = getRepeatedQuestionAnswer(trimmedQuestion, messages);

    setQuestion("");
    setLastError(null);

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmedQuestion,
    };

    if (repeatedAnswer) {
      setMessages((currentMessages) => [
        ...currentMessages,
        userMessage,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: repeatedAnswer,
        },
      ]);
      return;
    }

    setIsLoading(true);
    setMessages((currentMessages) => [...currentMessages, userMessage]);

    try {
      const history = messages
        .slice(-MAX_HISTORY_MESSAGES)
        .map(({ role, content }) => ({ role, content }));

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          question: trimmedQuestion,
          history,
          memory: conversationMemory,
        }),
      });

      const data = (await response.json()) as {
        answer?: string;
        error?: string;
        missingEnv?: string[];
      };

      if (!response.ok) {
        const missingEnvText = data.missingEnv?.length
          ? ` (${data.missingEnv.join(", ")})`
          : "";

        throw new Error(`${data.error ?? "Request failed"}${missingEnvText}`);
      }

      setConversationMemory((currentMemory) =>
        updateConversationMemory(currentMemory, trimmedQuestion, data.answer, messages),
      );
      setMessages((currentMessages) => [
        ...currentMessages,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: data.answer ?? "ไม่พบคำตอบ",
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
    <main className="h-screen overflow-hidden bg-[#f6f7f9] text-[#18202f]">
      <div className="mx-auto grid h-screen w-full max-w-7xl grid-cols-1 grid-rows-[auto_1fr] gap-0 overflow-hidden lg:grid-cols-[320px_1fr] lg:grid-rows-1">
        <aside className="overflow-y-auto border-b border-[#d7dce5] bg-white px-5 py-5 lg:h-screen lg:border-b-0 lg:border-r">
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
                  <dd className="font-medium text-[#18202f]">Gemini 3.5 Flash</dd>
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

        <section className="flex min-h-0 flex-col overflow-hidden">
          <header className="border-b border-[#d7dce5] bg-white px-5 py-4">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-sm font-medium text-[#0f766e]">Demo console</p>
                <h2 className="text-2xl font-semibold">ถามตอบจากเอกสารสถานศึกษา</h2>
              </div>
              <p className="text-sm text-[#596579]">
                ถามเรื่องวิทยาลัยก่อน ถ้าไม่เกี่ยวข้องจึงค้นเว็บ
              </p>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
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
                  </div>

                  {message.role === "user" ? <MessageIcon tone="user" /> : null}
                </article>
              ))}

              {isLoading ? (
                <div className="flex items-center gap-2 text-sm text-[#596579]">
                  <Loader2 className="animate-spin" size={16} aria-hidden="true" />
                  กำลังวิเคราะห์คำถาม ค้นเอกสาร และสร้างคำตอบ
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

function updateConversationMemory(
  currentMemory: ConversationMemory,
  question: string,
  answer: string | undefined,
  messages: ChatMessage[],
): ConversationMemory {
  const answerMonthKey = answer ? extractMonthKey(answer) : null;
  const questionMonthKey = extractMonthKey(question);
  const calendarMonthKey = answerMonthKey ?? questionMonthKey;

  if (!calendarMonthKey) {
    return currentMemory;
  }

  const calendarYear = Number(calendarMonthKey.slice(0, 4));
  const corrections = [...currentMemory.corrections];

  if (isCorrectionQuestion(question)) {
    const previousUserQuestion = [...messages]
      .reverse()
      .find((message) => message.role === "user")?.content;
    const correction = previousUserQuestion
      ? `ผู้ใช้แก้ความหมายของ "${previousUserQuestion}" ให้หมายถึง ${formatThaiMonthKey(
          calendarMonthKey,
        )}`
      : `ผู้ใช้แก้ความหมายให้หมายถึง ${formatThaiMonthKey(calendarMonthKey)}`;

    if (!corrections.includes(correction)) {
      corrections.push(correction);
    }
  }

  return {
    calendarYear,
    calendarMonthKey,
    corrections: corrections.slice(-8),
  };
}

function isCorrectionQuestion(question: string): boolean {
  return /(?:หมายถึง|ไม่ใช่|เอา|คือ|ขอเป็น|แก้เป็น)/.test(question);
}

function extractMonthKey(text: string): string | null {
  const monthPattern =
    "มกราคม|มกรา|ม\\.ค\\.?|มค|กุมภาพันธ์|กุมภา|ก\\.พ\\.?|กพ|มีนาคม|มีนา|มี\\.ค\\.?|มีค|เมษายน|เมษา|เม\\.ย\\.?|เมย|พฤศจิกายน|พฤศจิกา|พ\\.ย\\.?|พย|พฤษภาคม|พฤษภา|พ\\.ค\\.?|พค|มิถุนายน|มิถุนา|มิ\\.ย\\.?|มิย|กรกฎาคม|กรกฎา|ก\\.ค\\.?|กค|สิงหาคม|สิงหา|ส\\.ค\\.?|สค|กันยายน|กันยา|ก\\.ย\\.?|กย|ตุลาคม|ตุลา|ต\\.ค\\.?|ตค|ธันวาคม|ธันวา|ธ\\.ค\\.?|ธค";
  const monthThenYear = text.match(
    new RegExp(`(${monthPattern})\\s*(20\\d{2}|25\\d{2})`, "i"),
  );
  const yearThenMonth = text.match(
    new RegExp(`(20\\d{2}|25\\d{2})\\s*(${monthPattern})`, "i"),
  );
  const monthText = monthThenYear?.[1] ?? yearThenMonth?.[2];
  const yearText = monthThenYear?.[2] ?? yearThenMonth?.[1];

  if (!monthText || !yearText) {
    return null;
  }

  const month = parseThaiMonth(monthText);
  const rawYear = Number(yearText);
  const year = rawYear > 2400 ? rawYear - 543 : rawYear;

  return month && Number.isInteger(year) ? `${year}-${month}` : null;
}

function parseThaiMonth(monthText: string): string | null {
  const normalizedMonth = monthText.replace(/\./g, "").trim().toLowerCase();
  const months: Record<string, string> = {
    มกราคม: "01",
    มกรา: "01",
    มค: "01",
    กุมภาพันธ์: "02",
    กุมภา: "02",
    กพ: "02",
    มีนาคม: "03",
    มีนา: "03",
    มีค: "03",
    เมษายน: "04",
    เมษา: "04",
    เมย: "04",
    พฤษภาคม: "05",
    พฤษภา: "05",
    พค: "05",
    มิถุนายน: "06",
    มิถุนา: "06",
    มิย: "06",
    กรกฎาคม: "07",
    กรกฎา: "07",
    กค: "07",
    สิงหาคม: "08",
    สิงหา: "08",
    สค: "08",
    กันยายน: "09",
    กันยา: "09",
    กย: "09",
    ตุลาคม: "10",
    ตุลา: "10",
    ตค: "10",
    พฤศจิกายน: "11",
    พฤศจิกา: "11",
    พย: "11",
    ธันวาคม: "12",
    ธันวา: "12",
    ธค: "12",
  };

  return months[normalizedMonth] ?? null;
}

function formatThaiMonthKey(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, 1, 12));

  return date.toLocaleDateString("th-TH", {
    year: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

function getRepeatedQuestionAnswer(
  question: string,
  messages: ChatMessage[],
): string | null {
  const lastUserIndex = findLastMessageIndex(messages, "user");

  if (lastUserIndex === -1) {
    return null;
  }

  const lastUserMessage = messages[lastUserIndex];

  if (normalizeQuestion(lastUserMessage.content) !== normalizeQuestion(question)) {
    return null;
  }

  const previousAnswer = messages
    .slice(lastUserIndex + 1)
    .find((message) => message.role === "assistant")?.content;

  if (!previousAnswer || isFallbackAnswer(previousAnswer)) {
    return null;
  }

  return `คำตอบเดียวกับเมื่อกี้ครับ: ${trimRepeatedAnswer(previousAnswer)}`;
}

function findLastMessageIndex(
  messages: ChatMessage[],
  role: ChatMessage["role"],
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === role) {
      return index;
    }
  }

  return -1;
}

function normalizeQuestion(question: string): string {
  return question
    .replace(/[?？!！.。]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function trimRepeatedAnswer(answer: string): string {
  return answer.replace(/^คำตอบเดียวกับเมื่อกี้ครับ:\s*/g, "").trim();
}

function isFallbackAnswer(answer: string): boolean {
  return /ยังตอบจากฐานข้อมูลไม่ได้|ไม่พบคำตอบ/.test(answer);
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
