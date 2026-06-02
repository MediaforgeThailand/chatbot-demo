"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  content: string;
  time?: string;
};

type ConversationMemory = {
  calendarYear?: number;
  calendarMonthKey?: string;
  corrections: string[];
};

const MAX_HISTORY_MESSAGES = 24;

const starterQuestions = [
  { label: "ค่าเทอม", question: "ค่าเทอมของวิทยาลัยเป็นยังไง" },
  { label: "ทุนการศึกษา", question: "มีทุนการศึกษาอะไรบ้าง" },
  { label: "สมัครเรียน", question: "สมัครเรียนต้องใช้อะไรบ้าง" },
  { label: "หลักสูตร", question: "วิทยาลัยเปิดสอนหลักสูตรอะไรบ้าง" },
];

const initialMessages: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    content:
      "สวัสดีครับ ผมเป็น PSC Assistant ถามเรื่องสมัครเรียน ค่าเทอม หลักสูตร หรือข้อมูลของวิทยาลัยได้เลยครับ",
  },
];

function formatTime(date: Date): string {
  return date.toLocaleTimeString("th-TH", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function WebChatWidget() {
  const [isOpen, setIsOpen] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [conversationMemory, setConversationMemory] = useState<ConversationMemory>({
    corrections: [],
  });
  const [question, setQuestion] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const canSubmit = useMemo(
    () => question.trim().length > 0 && !isLoading,
    [isLoading, question],
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, isLoading]);

  async function submitQuestion(nextQuestion = question) {
    const trimmedQuestion = nextQuestion.trim();

    if (!trimmedQuestion || isLoading) {
      return;
    }

    const repeatedAnswer = getRepeatedQuestionAnswer(trimmedQuestion, messages);

    setQuestion("");
    setLastError(null);
    setIsOpen(true);

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmedQuestion,
      time: formatTime(new Date()),
    };

    if (repeatedAnswer) {
      setMessages((currentMessages) => [
        ...currentMessages,
        userMessage,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: repeatedAnswer,
          time: formatTime(new Date()),
        },
      ]);
      return;
    }

    setIsLoading(true);
    setMessages((currentMessages) => [...currentMessages, userMessage]);

    try {
      const history = messages
        .filter((message) => message.id !== "welcome")
        .slice(-MAX_HISTORY_MESSAGES)
        .map(({ role, content }) => ({ role, content }));

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
          time: formatTime(new Date()),
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
            "ตอนนี้ยังเชื่อมต่อระบบตอบคำถามไม่ได้ กรุณาตรวจสอบการตั้งค่า Gemini และ Supabase ก่อนใช้งานจริง",
          time: formatTime(new Date()),
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

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        aria-label="เปิด PSC Assistant"
        className="fixed right-margin-mobile bottom-margin-mobile z-50 flex h-16 w-16 items-center justify-center rounded-full bg-primary-container text-on-primary-container shadow-lg shadow-primary/30 transition hover:scale-105 active:scale-95 md:right-margin-desktop md:bottom-margin-desktop"
      >
        <MIcon name="forum" fill className="text-[28px]" />
      </button>
    );
  }

  return (
    <section className="fixed right-margin-mobile bottom-margin-mobile z-50 flex w-[calc(100vw-2.5rem)] max-w-[420px] flex-col items-end gap-4 md:right-margin-desktop md:bottom-margin-desktop">
      <div className="flex h-[min(600px,calc(100vh-6rem))] w-full origin-bottom-right flex-col overflow-hidden rounded-lg border border-surface-container-high bg-surface-bright shadow-lg shadow-primary/10 transition-all duration-300">
        <header className="flex w-full items-center justify-between rounded-t-lg bg-surface-bright/90 px-gutter py-unit shadow-md shadow-primary/20 backdrop-blur-xl">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              alt="ตราวิทยาลัยเทคโนโลยีพงษ์สวัสดิ์"
              className="h-8 w-8 rounded-full border border-primary/20 object-contain"
              src="/logo-pongsawadi.png"
            />
            <div>
              <h1 className="font-headline-lg-mobile text-headline-lg-mobile font-bold leading-none text-primary">
                PSC Assistant
              </h1>
              <p className="font-label-bold text-[10px] text-on-surface-variant">
                Online - Admissions AI
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              aria-label="ย่อหน้าต่างแชท"
              className="rounded-full p-1 text-on-surface-variant transition hover:bg-primary-container/10 active:scale-95"
            >
              <MIcon name="minimize" />
            </button>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              aria-label="ปิดหน้าต่างแชท"
              className="rounded-full p-1 text-on-surface-variant transition hover:bg-primary-container/10 active:scale-95"
            >
              <MIcon name="close" />
            </button>
          </div>
        </header>

        <div
          ref={scrollRef}
          className="custom-scrollbar flex-1 space-y-gutter overflow-y-auto bg-surface-container-lowest p-gutter scroll-smooth"
        >
          {messages.map((message) =>
            message.role === "user" ? (
              <UserMessage key={message.id} message={message} />
            ) : (
              <AssistantMessage key={message.id} message={message} />
            ),
          )}

          {isLoading ? <TypingIndicator /> : null}

          {lastError ? (
            <div className="rounded-[24px] rounded-tl-none bg-error-container p-4 text-body-sm text-on-error-container">
              {lastError}
            </div>
          ) : null}
        </div>

        <div className="bg-surface-container-lowest p-gutter pt-0">
          <form onSubmit={handleSubmit}>
            <div className="relative flex items-center rounded-full border border-surface-container-high bg-surface-container-low transition focus-within:border-primary focus-within:shadow-[0_0_12px_rgba(179,0,105,0.15)]">
              <input
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                className="min-w-0 flex-1 border-none bg-transparent px-6 py-4 text-body-md text-on-surface focus:ring-0 focus:outline-none"
                placeholder="ถาม PSC Assistant..."
                type="text"
                autoComplete="off"
              />
              <div className="pr-2">
                <button
                  type="submit"
                  disabled={!canSubmit}
                  aria-label="ส่งคำถาม"
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-on-primary transition hover:bg-primary-container active:scale-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <MIcon name="send" fill className="text-[20px]" />
                </button>
              </div>
            </div>
          </form>

          <div className="mt-3 flex flex-wrap gap-2">
            {starterQuestions.map((starter) => (
              <button
                key={starter.question}
                type="button"
                onClick={() => void submitQuestion(starter.question)}
                disabled={isLoading}
                className="rounded-full border border-outline-variant bg-secondary-container px-3 py-1.5 text-body-sm font-semibold text-on-secondary-fixed transition hover:bg-primary-fixed-dim active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {starter.label}
              </button>
            ))}
          </div>

          <footer className="flex flex-col items-center gap-1 bg-transparent py-2">
            <div className="font-label-bold flex gap-4 text-label-bold text-on-surface-variant">
              <span className="opacity-80">Privacy Policy</span>
              <span className="opacity-80">Help Center</span>
            </div>
            <p className="text-[10px] text-on-surface-variant opacity-60">
              © 2026 PSC Admissions AI
            </p>
          </footer>
        </div>
      </div>
    </section>
  );
}

function AssistantMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="flex max-w-[85%] gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary">
        <MIcon name="smart_toy" fill className="text-[18px] text-white" />
      </div>
      <div className="space-y-1">
        <div className="rounded-[24px] rounded-tl-none bg-surface-container-low p-4 text-body-md text-on-surface shadow-sm">
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
            {message.content}
          </p>
        </div>
        {message.time ? (
          <p className="pl-1 text-[10px] text-on-surface-variant/60">
            {message.time}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] space-y-1">
        <div className="rounded-[24px] rounded-tr-none bg-primary p-4 text-body-md text-on-primary shadow-md shadow-primary/20">
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
            {message.content}
          </p>
        </div>
        {message.time ? (
          <p className="pr-1 text-right text-[10px] text-on-surface-variant/60">
            {message.time}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex max-w-[85%] gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary">
        <MIcon name="smart_toy" fill className="text-[18px] text-white" />
      </div>
      <div className="flex items-center gap-1 rounded-[24px] rounded-tl-none bg-surface-container-low p-4">
        <span className="h-2 w-2 animate-bounce rounded-full bg-primary" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-primary [animation-delay:0.2s]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-primary [animation-delay:0.4s]" />
      </div>
    </div>
  );
}

function MIcon({
  name,
  className = "",
  fill = false,
}: {
  name: string;
  className?: string;
  fill?: boolean;
}) {
  return (
    <span
      className={`material-symbols-outlined ${className}`}
      style={fill ? { fontVariationSettings: "'FILL' 1" } : undefined}
      aria-hidden="true"
    >
      {name}
    </span>
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
