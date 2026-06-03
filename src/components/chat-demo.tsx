"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type AnswerSource = {
  id: number;
  sourceName: string;
  similarity: number;
  metadata: Record<string, unknown>;
};

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  content: string;
  sources?: AnswerSource[];
  time?: string;
};

type ConversationMemory = {
  calendarYear?: number;
  calendarMonthKey?: string;
  corrections: string[];
};

type GmailConnectorStatus = {
  connected: boolean;
  configured?: boolean;
  email?: string;
  scope?: string;
  missingEnv?: string[];
  error?: string;
};

type GmailMessageSummary = {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  labelIds: string[];
};

const MAX_HISTORY_MESSAGES = 24;

const starters = [
  { label: "สมัครเรียน ปวช.", question: "สมัครเรียน ปวช. ต้องใช้เอกสารอะไรบ้าง" },
  { label: "หลักสูตรที่เปิดสอน", question: "วิทยาลัยเปิดสอนหลักสูตรอะไรบ้าง" },
  { label: "ช่องทางจ่ายค่าเทอม", question: "ชำระค่าเทอมได้ช่องทางไหน" },
  {
    label: "ระเบียบการแต่งกาย",
    question: "ระเบียบการแต่งกายของนักศึกษามีอะไรบ้าง",
  },
  {
    label: "มาสายหรือขาดเรียน",
    question: "ถ้ามาสายหรือขาดเรียนมีระเบียบอย่างไร",
  },
];

const initialMessages: ChatMessage[] = [];

function formatTime(date: Date): string {
  return date.toLocaleTimeString("th-TH", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ChatDemo() {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [conversationMemory, setConversationMemory] = useState<ConversationMemory>({
    corrections: [],
  });
  const [question, setQuestion] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [connectorsOpen, setConnectorsOpen] = useState(false);
  const [gmailStatus, setGmailStatus] = useState<GmailConnectorStatus>({
    connected: false,
  });
  const [gmailStatusLoading, setGmailStatusLoading] = useState(true);
  const [gmailStatusError, setGmailStatusError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const canSubmit = useMemo(
    () => question.trim().length > 0 && !isLoading,
    [isLoading, question],
  );

  const isEmptyState = messages.length === 0;

  useEffect(() => {
    if (isEmptyState) {
      return;
    }
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, isLoading, isEmptyState]);

  useEffect(() => {
    void refreshGmailStatus();
  }, []);

  async function refreshGmailStatus() {
    setGmailStatusLoading(true);
    setGmailStatusError(null);

    try {
      const response = await fetch("/api/gmail/status", {
        cache: "no-store",
      });
      const data = (await response.json()) as GmailConnectorStatus;

      setGmailStatus({
        connected: data.connected === true,
        configured: data.configured,
        email: data.email,
        scope: data.scope,
        missingEnv: data.missingEnv,
        error: data.error,
      });

      if (!response.ok) {
        setGmailStatusError(
          data.missingEnv?.length
            ? `ยังไม่ได้ตั้งค่า env: ${data.missingEnv.join(", ")}`
            : data.error ?? "อ่านสถานะ Gmail ไม่สำเร็จ",
        );
      }
    } catch (error) {
      setGmailStatus({ connected: false });
      setGmailStatusError(
        error instanceof Error ? error.message : "อ่านสถานะ Gmail ไม่สำเร็จ",
      );
    } finally {
      setGmailStatusLoading(false);
    }
  }

  function connectGmail() {
    window.location.href = "/api/gmail/oauth/start";
  }

  async function disconnectGmail() {
    setGmailStatusLoading(true);
    setGmailStatusError(null);

    try {
      const response = await fetch("/api/gmail/disconnect", {
        method: "POST",
      });
      const data = (await response.json()) as GmailConnectorStatus & {
        error?: string;
      };

      if (!response.ok) {
        throw new Error(data.error ?? "ตัดการเชื่อมต่อ Gmail ไม่สำเร็จ");
      }

      setGmailStatus({ connected: false });
    } catch (error) {
      setGmailStatusError(
        error instanceof Error
          ? error.message
          : "ตัดการเชื่อมต่อ Gmail ไม่สำเร็จ",
      );
    } finally {
      setGmailStatusLoading(false);
    }
  }

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
        sources?: AnswerSource[];
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
            "ตอนนี้ยังเชื่อมต่อฐานข้อมูลเอกสารไม่ได้ กรุณาตรวจสอบการตั้งค่า Gemini และ Supabase ก่อนใช้งานจริง",
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

  function resetConversation() {
    if (isLoading) return;
    setMessages(initialMessages);
    setConversationMemory({ corrections: [] });
    setQuestion("");
    setLastError(null);
  }

  return (
    <div className="flex h-screen overflow-hidden bg-surface text-on-surface">
      <SideNav
        open={navOpen}
        onClose={() => setNavOpen(false)}
        onNewChat={resetConversation}
        onAsk={(q) => void submitQuestion(q)}
        onOpenConnectors={() => setConnectorsOpen(true)}
      />

      <main className="relative flex flex-1 flex-col overflow-hidden bg-surface">
        <MobileTopBar
          onOpenNav={() => setNavOpen(true)}
          onOpenConnectors={() => setConnectorsOpen(true)}
        />

        <div
          ref={scrollRef}
          className="custom-scrollbar relative flex-1 overflow-y-auto"
        >
          {isEmptyState ? (
            <Hero
              onAsk={(q) => void submitQuestion(q)}
              onSubmit={handleSubmit}
              onSubmitQuestion={() => void submitQuestion()}
              question={question}
              onChange={setQuestion}
              canSubmit={canSubmit}
            />
          ) : (
            <Conversation
              messages={messages}
              isLoading={isLoading}
              lastError={lastError}
            />
          )}
        </div>

        <BottomBar
          hideOnDesktopWhenEmpty={isEmptyState}
          question={question}
          onChange={setQuestion}
          onSubmit={handleSubmit}
          onSubmitQuestion={() => void submitQuestion()}
          onAsk={(q) => void submitQuestion(q)}
          canSubmit={canSubmit}
        />
      </main>

      <ConnectorsModal
        open={connectorsOpen}
        gmailStatus={gmailStatus}
        isStatusLoading={gmailStatusLoading}
        statusError={gmailStatusError}
        onClose={() => setConnectorsOpen(false)}
        onConnect={connectGmail}
        onDisconnect={() => void disconnectGmail()}
        onRefreshStatus={() => void refreshGmailStatus()}
      />
    </div>
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

/* ------------------------------ Side navigation ----------------------------- */

function SideNav({
  open,
  onClose,
  onNewChat,
  onAsk,
  onOpenConnectors,
}: {
  open: boolean;
  onClose: () => void;
  onNewChat: () => void;
  onAsk: (question: string) => void;
  onOpenConnectors: () => void;
}) {
  function runAndClose(action: () => void) {
    action();
    onClose();
  }

  return (
    <>
      {/* Backdrop (mobile only) */}
      <div
        onClick={onClose}
        aria-hidden="true"
        className={`fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity duration-300 md:hidden ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex h-full w-72 max-w-[85%] flex-col border-r border-surface-container bg-surface-container-lowest shadow-xl transition-transform duration-300 md:static md:z-auto md:w-64 md:max-w-none md:translate-x-0 md:shadow-sm ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-full flex-col px-4 py-6">
          <div className="mb-8 flex items-center gap-3 px-2">
            <Logo className="h-10 w-10 rounded-lg" size={40} priority />
            <div className="flex min-w-0 flex-col">
              <span className="font-headline-lg text-headline-lg font-bold leading-tight text-primary">
                PSC AI
              </span>
              <span className="font-label-bold text-label-bold text-on-surface-variant opacity-70">
                Student Portal
              </span>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="ปิดเมนู"
              className="ml-auto rounded-full p-2 text-on-surface-variant transition-colors hover:bg-surface-container md:hidden"
            >
              <MIcon name="close" />
            </button>
          </div>

        <nav className="custom-scrollbar flex-1 space-y-1 overflow-y-auto">
          <button
            type="button"
            onClick={() => runAndClose(onNewChat)}
            className="flex w-full items-center gap-3 rounded-xl border-primary bg-primary-container/5 px-3 py-3 font-bold text-primary transition-all duration-150 hover:bg-primary-container/10"
          >
            <MIcon name="add_comment" fill />
            <span className="font-label-bold text-body-md">New Chat</span>
          </button>

          <button
            type="button"
            onClick={() => runAndClose(() => onAsk("วันนี้มีกิจกรรมอะไรบ้าง"))}
            className="group flex w-full items-center gap-3 rounded-xl px-3 py-3 text-on-surface-variant transition-colors hover:bg-primary-container/10"
          >
            <MIcon name="quiz" className="group-hover:text-primary" />
            <span className="font-label-bold text-body-md">Real-time Q&amp;A</span>
          </button>
          <button
            type="button"
            onClick={() =>
              runAndClose(() => onAsk("วิทยาลัยมีกิจกรรมเร็ว ๆ นี้อะไรบ้าง"))
            }
            className="group flex w-full items-center gap-3 rounded-xl px-3 py-3 text-on-surface-variant transition-colors hover:bg-primary-container/10"
          >
            <MIcon name="event" className="group-hover:text-primary" />
            <span className="font-label-bold text-body-md">Upcoming Events</span>
          </button>
          <a
            onClick={onClose}
            className="group flex items-center gap-3 rounded-xl px-3 py-3 text-on-surface-variant transition-colors hover:bg-primary-container/10"
            href="#"
          >
            <MIcon name="history" className="group-hover:text-primary" />
            <span className="font-label-bold text-body-md">History</span>
          </a>
          <button
            type="button"
            onClick={() => runAndClose(onOpenConnectors)}
            className="group flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-on-surface-variant transition-colors hover:bg-primary-container/10"
          >
            <MIcon name="hub" className="group-hover:text-primary" />
            <span className="font-label-bold text-body-md">Connectors</span>
            <span className="ml-auto rounded-full bg-primary-fixed px-2 py-0.5 text-[10px] font-bold text-primary">
              Gmail
            </span>
          </button>
        </nav>

        <div className="mt-auto flex flex-col gap-1 border-t border-surface-container pt-6">
          <a
            onClick={onClose}
            className="group flex items-center gap-3 rounded-xl px-3 py-3 text-on-surface-variant transition-colors hover:bg-primary-container/10"
            href="#"
          >
            <MIcon name="settings" className="group-hover:text-primary" />
            <span className="font-label-bold text-body-md">Settings</span>
          </a>
          <div className="mt-4 flex items-center gap-3 rounded-2xl bg-surface-container-low px-2 py-3">
            <Avatar
              src="https://lh3.googleusercontent.com/aida-public/AB6AXuDX8JRy_uMI7BCfHQuKoq1qpssi1jYQT9wA9khhp7gA6nBNHuo9mV2Vuc16kiLFVZOQZ2iuLdl-lgD43V6-IJ8AYaF4BqTgqXe9wGUT6oNeF1PQpcf2-nscBpRl335hzkUcadf3AeBJWIOT5NXqGm385m5K5oOKuEtZC1jpl8bi9QuRAB4kez0mAr_591ddRgIoz-Qe--JNWYHeSu-VfeZy1V6Ad6efHxbAZlVLuJkzX-2IVF5fhKH4z5dHkH07GiXz6RI3Qo151GKW"
              className="h-10 w-10"
            />
            <div className="flex min-w-0 flex-col">
              <span className="truncate font-label-bold text-body-md">
                Somchai Sukdee
              </span>
              <span className="truncate font-label-bold text-label-bold text-on-surface-variant opacity-60">
                Student ID: 661002
              </span>
            </div>
          </div>
          </div>
        </div>
      </aside>
    </>
  );
}

function MobileTopBar({
  onOpenNav,
  onOpenConnectors,
}: {
  onOpenNav: () => void;
  onOpenConnectors: () => void;
}) {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between bg-surface-container-lowest/80 px-4 backdrop-blur-xl md:hidden">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onOpenNav}
          aria-label="เปิดเมนู"
          className="rounded-full p-2 text-on-surface transition-colors hover:bg-surface-container"
        >
          <MIcon name="menu" />
        </button>
        <Logo className="h-8 w-8 rounded-lg" size={32} priority />
        <span className="font-headline-lg-mobile text-headline-lg-mobile font-bold text-primary">
          PSC AI
        </span>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onOpenConnectors}
          className="rounded-full p-2 text-on-surface-variant transition-colors hover:bg-surface-container"
          aria-label="เปิด Connectors"
        >
          <MIcon name="hub" />
        </button>
        <button
          type="button"
          className="rounded-full p-2 text-on-surface-variant transition-colors hover:bg-surface-container"
          aria-label="การแจ้งเตือน"
        >
          <MIcon name="notifications" />
        </button>
      </div>
    </header>
  );
}

function ConnectorsModal({
  open,
  gmailStatus,
  isStatusLoading,
  statusError,
  onClose,
  onConnect,
  onDisconnect,
  onRefreshStatus,
}: {
  open: boolean;
  gmailStatus: GmailConnectorStatus;
  isStatusLoading: boolean;
  statusError: string | null;
  onClose: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onRefreshStatus: () => void;
}) {
  if (!open) {
    return null;
  }

  const connected = gmailStatus.connected;
  const isConnectorConfigured = gmailStatus.configured !== false;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 px-4 py-6 backdrop-blur-sm">
      <button
        type="button"
        aria-label="ปิด Connectors"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />

      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="connectors-title"
        className="relative flex h-[min(760px,92vh)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-lowest shadow-2xl"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-surface-container px-6 py-5">
          <div className="min-w-0">
            <p className="font-label-bold text-label-bold uppercase text-primary">
              MCP tools
            </p>
            <h2
              id="connectors-title"
              className="mt-1 font-headline-lg-mobile text-headline-lg-mobile font-bold text-on-surface"
            >
              Connectors
            </h2>
            <p className="mt-1 max-w-xl text-body-sm text-on-surface-variant">
              เชื่อมต่อแพลตฟอร์มภายนอกเพื่อให้ PSC AI ทำงานกับเครื่องมือของคุณได้
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิดหน้าต่าง"
            className="rounded-full p-2 text-on-surface-variant transition-colors hover:bg-surface-container"
          >
            <MIcon name="close" />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 md:grid-cols-[280px_1fr]">
          <aside className="flex min-h-0 flex-col border-b border-surface-container bg-surface-container-low px-4 py-4 md:border-r md:border-b-0">
            <label className="relative mb-4 block">
              <MIcon
                name="search"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant"
              />
              <input
                value="Gmail"
                readOnly
                aria-label="ค้นหา Connectors"
                className="w-full rounded-full border border-outline-variant bg-surface-container-lowest py-3 pr-4 pl-11 text-body-sm text-on-surface focus:outline-none"
              />
            </label>

            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-xl border border-primary/20 bg-primary-fixed/60 p-3 text-left shadow-sm"
            >
              <GmailMark className="h-10 w-10" />
              <span className="min-w-0 flex-1">
                <span className="block font-label-bold text-body-md text-on-surface">
                  Gmail
                </span>
                <span className="block truncate text-body-sm text-on-surface-variant">
                  ค้นหา อ่าน ร่าง และส่งอีเมล
                </span>
              </span>
              <MIcon name="chevron_right" className="text-primary" />
            </button>

            <div className="mt-auto hidden rounded-xl bg-surface-container-lowest p-4 text-body-sm text-on-surface-variant md:block">
              <div className="mb-2 flex items-center gap-2 font-label-bold text-label-bold text-primary">
                <MIcon name="shield_lock" />
                Permission scoped
              </div>
              ใช้สิทธิ์เฉพาะงานอีเมล และควรให้ผู้ใช้ยืนยันก่อนส่งเมลจริง
            </div>
          </aside>

          <div className="custom-scrollbar min-h-0 overflow-y-auto px-6 py-6">
            <div className="mx-auto max-w-2xl">
              <div className="mb-8 flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-4">
                  <GmailMark className="h-16 w-16" />
                  <div>
                    <h3 className="font-headline-lg text-headline-lg font-bold text-on-surface">
                      Gmail
                    </h3>
                    <p className="text-body-sm text-on-surface-variant">
                      Email connector สำหรับ MCP workflow
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={connected ? onDisconnect : onConnect}
                  disabled={isStatusLoading || !isConnectorConfigured}
                  className={`inline-flex items-center justify-center gap-2 rounded-full px-5 py-3 font-label-bold text-label-bold shadow-sm transition ${
                    connected
                      ? "bg-surface-container text-primary ring-1 ring-primary/20 hover:bg-primary-fixed"
                      : "bg-on-surface text-surface-container-lowest hover:bg-inverse-surface"
                  } disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  <MIcon name={connected ? "check_circle" : "link"} fill={connected} />
                  {isStatusLoading
                    ? "กำลังตรวจสอบ"
                    : !isConnectorConfigured
                      ? "ยังไม่พร้อม"
                      : connected
                        ? "ตัดการเชื่อมต่อ"
                        : "เชื่อมต่อ"}
                </button>
              </div>

              <p className="mb-8 text-body-md text-on-surface">
                ใช้ Gmail เพื่อให้ PSC AI ส่งอีเมลจากบัญชีที่เชื่อมต่อไว้ได้จริง
                โดยใช้ OAuth และ Gmail API ฝั่ง server
              </p>

              {statusError ? (
                <div className="mb-6 rounded-xl border border-error/20 bg-error-container p-4 text-body-sm text-on-error-container">
                  {statusError}
                </div>
              ) : null}

              <section className="overflow-hidden rounded-xl border border-surface-container bg-surface-container-lowest">
                <div className="border-b border-surface-container px-5 py-4">
                  <h4 className="font-label-bold text-body-md text-on-surface">
                    ข้อมูล
                  </h4>
                </div>
                <ConnectorInfoRow label="หมวดหมู่" value="Productivity" />
                <ConnectorInfoRow label="ความสามารถ" value="OAuth, refresh token และส่งอีเมลผ่าน Gmail API" />
                <ConnectorInfoRow label="แพลตฟอร์ม" value="Gmail / Google Workspace" />
                <ConnectorInfoRow label="วิธีเชื่อมต่อ" value="Google OAuth 2.0 + Gmail API" />
                <ConnectorInfoRow
                  label="บัญชี"
                  value={gmailStatus.email ?? (connected ? "เชื่อมต่อแล้ว" : "-")}
                />
                <ConnectorInfoRow
                  label="สถานะ"
                  value={
                    isStatusLoading
                      ? "กำลังตรวจสอบ"
                      : connected
                        ? "เชื่อมต่อจริงแล้ว"
                        : "ยังไม่เชื่อมต่อ"
                  }
                />
              </section>

              <GmailSendTester
                enabled={connected}
                onSent={onRefreshStatus}
              />

              <GmailMailboxExplorer enabled={connected} />

              <section className="mt-6 grid gap-3 sm:grid-cols-2">
                {[
                  ["verified_user", "OAuth จริง", "เก็บ token ใน Supabase แบบเข้ารหัส"],
                  ["refresh", "Refresh token", "ต่ออายุ access token อัตโนมัติฝั่ง server"],
                  ["send", "ส่งเมล", "ส่งอีเมลหลังผู้ใช้ตรวจและยืนยัน"],
                  ["lock", "Server-only", "ไม่ส่ง Google token ไปที่ frontend"],
                ].map(([icon, title, detail]) => (
                  <div
                    key={title}
                    className="rounded-xl border border-surface-container bg-surface-container-low p-4"
                  >
                    <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-primary-fixed text-primary">
                      <MIcon name={icon} />
                    </div>
                    <h5 className="font-label-bold text-body-md text-on-surface">
                      {title}
                    </h5>
                    <p className="mt-1 text-body-sm text-on-surface-variant">
                      {detail}
                    </p>
                  </div>
                ))}
              </section>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function ConnectorInfoRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="grid grid-cols-[140px_1fr] border-b border-surface-container px-5 py-4 last:border-b-0">
      <span className="font-label-bold text-label-bold text-on-surface-variant">
        {label}
      </span>
      <span className="font-label-bold text-body-sm text-on-surface">{value}</span>
    </div>
  );
}

function GmailSendTester({
  enabled,
  onSent,
}: {
  enabled: boolean;
  onSent: () => void;
}) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("ทดสอบส่งอีเมลจาก PSC AI");
  const [body, setBody] = useState(
    "สวัสดีครับ นี่คืออีเมลทดสอบจาก Gmail connector ของ PSC AI",
  );
  const [isSending, setIsSending] = useState(false);
  const [sendResult, setSendResult] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  async function sendTestEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!enabled || isSending) {
      return;
    }

    setIsSending(true);
    setSendResult(null);
    setSendError(null);

    try {
      const response = await fetch("/api/gmail/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to,
          subject,
          body,
        }),
      });
      const data = (await response.json()) as {
        sent?: boolean;
        id?: string;
        error?: string;
      };

      if (!response.ok || !data.sent) {
        throw new Error(data.error ?? "ส่งอีเมลไม่สำเร็จ");
      }

      setSendResult(data.id ? `ส่งสำเร็จแล้ว Message ID: ${data.id}` : "ส่งสำเร็จแล้ว");
      onSent();
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "ส่งอีเมลไม่สำเร็จ");
    } finally {
      setIsSending(false);
    }
  }

  return (
    <section className="mt-6 rounded-xl border border-surface-container bg-surface-container-low p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h4 className="font-label-bold text-body-md text-on-surface">
            ทดสอบส่งอีเมล
          </h4>
          <p className="mt-1 text-body-sm text-on-surface-variant">
            ส่งผ่าน Gmail API จากบัญชีที่เชื่อมต่อไว้จริง
          </p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-wide ${
            enabled
              ? "bg-primary text-on-primary"
              : "bg-surface-container-high text-on-surface-variant"
          }`}
        >
          {enabled ? "Ready" : "Connect first"}
        </span>
      </div>

      <form onSubmit={sendTestEmail} className="space-y-3">
        <label className="block">
          <span className="mb-1 block font-label-bold text-label-bold text-on-surface-variant">
            ส่งถึง
          </span>
          <input
            value={to}
            onChange={(event) => setTo(event.target.value)}
            disabled={!enabled || isSending}
            className="w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-4 py-3 text-body-sm text-on-surface focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            placeholder="name@example.com"
            type="email"
            autoComplete="email"
            required
          />
        </label>
        <label className="block">
          <span className="mb-1 block font-label-bold text-label-bold text-on-surface-variant">
            หัวข้อ
          </span>
          <input
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            disabled={!enabled || isSending}
            className="w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-4 py-3 text-body-sm text-on-surface focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            required
          />
        </label>
        <label className="block">
          <span className="mb-1 block font-label-bold text-label-bold text-on-surface-variant">
            ข้อความ
          </span>
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            disabled={!enabled || isSending}
            className="min-h-28 w-full resize-y rounded-lg border border-outline-variant bg-surface-container-lowest px-4 py-3 text-body-sm text-on-surface focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            required
          />
        </label>

        {sendError ? (
          <div className="rounded-lg bg-error-container px-4 py-3 text-body-sm text-on-error-container">
            {sendError}
          </div>
        ) : null}
        {sendResult ? (
          <div className="rounded-lg bg-primary-fixed px-4 py-3 text-body-sm text-primary">
            {sendResult}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={!enabled || isSending}
          className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-3 font-label-bold text-label-bold text-on-primary transition hover:bg-primary-container disabled:cursor-not-allowed disabled:opacity-60"
        >
          <MIcon name="send" fill />
          {isSending ? "กำลังส่ง" : "ส่งอีเมลทดสอบ"}
        </button>
      </form>
    </section>
  );
}

function GmailMailboxExplorer({ enabled }: { enabled: boolean }) {
  const [query, setQuery] = useState("in:inbox newer_than:30d");
  const [messages, setMessages] = useState<GmailMessageSummary[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isSummarizingThreadId, setIsSummarizingThreadId] = useState<string | null>(
    null,
  );
  const [summary, setSummary] = useState<string | null>(null);
  const [mailError, setMailError] = useState<string | null>(null);

  async function searchMessages(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();

    if (!enabled || isSearching) {
      return;
    }

    setIsSearching(true);
    setMailError(null);
    setSummary(null);

    try {
      const params = new URLSearchParams({
        q: query.trim() || "in:inbox newer_than:30d",
        maxResults: "8",
      });
      const response = await fetch(`/api/gmail/messages?${params.toString()}`, {
        cache: "no-store",
      });
      const data = (await response.json()) as {
        messages?: GmailMessageSummary[];
        error?: string;
      };

      if (!response.ok) {
        throw new Error(data.error ?? "ค้นหาอีเมลไม่สำเร็จ");
      }

      setMessages(data.messages ?? []);
    } catch (error) {
      setMessages([]);
      setMailError(error instanceof Error ? error.message : "ค้นหาอีเมลไม่สำเร็จ");
    } finally {
      setIsSearching(false);
    }
  }

  async function summarizeThread(threadId: string) {
    if (!enabled || isSummarizingThreadId) {
      return;
    }

    setIsSummarizingThreadId(threadId);
    setMailError(null);
    setSummary(null);

    try {
      const response = await fetch(
        `/api/gmail/threads/${encodeURIComponent(threadId)}/summary`,
        {
          cache: "no-store",
        },
      );
      const data = (await response.json()) as {
        summary?: string;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(data.error ?? "สรุป thread ไม่สำเร็จ");
      }

      setSummary(data.summary ?? "ไม่พบข้อมูลสำหรับสรุปครับ");
    } catch (error) {
      setMailError(error instanceof Error ? error.message : "สรุป thread ไม่สำเร็จ");
    } finally {
      setIsSummarizingThreadId(null);
    }
  }

  return (
    <section className="mt-6 rounded-xl border border-surface-container bg-surface-container-low p-5">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h4 className="font-label-bold text-body-md text-on-surface">
            อ่าน ค้นหา และสรุป Gmail
          </h4>
          <p className="mt-1 text-body-sm text-on-surface-variant">
            ใช้ Gmail API อ่าน inbox/search จริง แล้วส่งเนื้อหา thread ให้ Gemini สรุป
          </p>
        </div>
        <span
          className={`w-fit rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-wide ${
            enabled
              ? "bg-primary text-on-primary"
              : "bg-surface-container-high text-on-surface-variant"
          }`}
        >
          {enabled ? "Readonly ready" : "Connect first"}
        </span>
      </div>

      <p className="mb-4 rounded-lg bg-surface-container-lowest px-4 py-3 text-body-sm text-on-surface-variant">
        ถ้าเคยเชื่อม Gmail ก่อนเพิ่มระบบอ่านเมล ให้กดตัดการเชื่อมต่อแล้วเชื่อมใหม่
        เพื่อขอสิทธิ์ `gmail.readonly`
      </p>

      <form onSubmit={searchMessages} className="flex flex-col gap-3 sm:flex-row">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          disabled={!enabled || isSearching}
          className="min-w-0 flex-1 rounded-lg border border-outline-variant bg-surface-container-lowest px-4 py-3 text-body-sm text-on-surface focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          placeholder="เช่น from:someone@example.com newer_than:7d"
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setQuery("in:inbox newer_than:30d")}
            disabled={!enabled || isSearching}
            className="rounded-full border border-outline-variant bg-surface-container-lowest px-4 py-3 font-label-bold text-label-bold text-on-surface transition hover:bg-primary-fixed disabled:cursor-not-allowed disabled:opacity-60"
          >
            Inbox
          </button>
          <button
            type="submit"
            disabled={!enabled || isSearching}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-3 font-label-bold text-label-bold text-on-primary transition hover:bg-primary-container disabled:cursor-not-allowed disabled:opacity-60"
          >
            <MIcon name="search" />
            {isSearching ? "กำลังค้น" : "ค้นเมล"}
          </button>
        </div>
      </form>

      {mailError ? (
        <div className="mt-4 rounded-lg bg-error-container px-4 py-3 text-body-sm text-on-error-container">
          {mailError}
        </div>
      ) : null}

      {messages.length > 0 ? (
        <div className="mt-4 space-y-3">
          {messages.map((message) => (
            <article
              key={message.id}
              className="rounded-lg border border-surface-container bg-surface-container-lowest p-4"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h5 className="truncate font-label-bold text-body-md text-on-surface">
                    {message.subject}
                  </h5>
                  <p className="mt-1 truncate text-body-sm text-on-surface-variant">
                    จาก {message.from || "-"}
                  </p>
                  <p className="mt-2 line-clamp-2 text-body-sm text-on-surface-variant">
                    {message.snippet || "ไม่มี snippet"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void summarizeThread(message.threadId)}
                  disabled={!enabled || Boolean(isSummarizingThreadId)}
                  className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full border border-primary/20 bg-primary-fixed px-4 py-2 font-label-bold text-label-bold text-primary transition hover:bg-primary-fixed-dim disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <MIcon name="summarize" />
                  {isSummarizingThreadId === message.threadId
                    ? "กำลังสรุป"
                    : "สรุป thread"}
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {summary ? (
        <div className="mt-4 rounded-lg border border-primary/20 bg-primary-fixed px-4 py-3">
          <h5 className="mb-2 font-label-bold text-body-md text-primary">
            สรุป thread
          </h5>
          <p className="whitespace-pre-wrap text-body-sm text-on-primary-fixed">
            {summary}
          </p>
        </div>
      ) : null}
    </section>
  );
}

function GmailMark({ className = "" }: { className?: string }) {
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-outline-variant bg-white shadow-sm ${className}`}
      aria-hidden="true"
    >
      <span className="absolute left-[24%] top-[33%] h-[34%] w-[10%] rotate-[-35deg] rounded-full bg-[#4285f4]" />
      <span className="absolute left-[35%] top-[30%] h-[10%] w-[31%] rotate-[35deg] rounded-full bg-[#ea4335]" />
      <span className="absolute right-[24%] top-[33%] h-[34%] w-[10%] rotate-[35deg] rounded-full bg-[#34a853]" />
      <span className="absolute bottom-[26%] left-[24%] h-[10%] w-[22%] rounded-full bg-[#fbbc04]" />
      <span className="absolute bottom-[26%] right-[24%] h-[10%] w-[22%] rounded-full bg-[#ea4335]" />
    </span>
  );
}

/* --------------------------------- Hero ------------------------------------ */

function Hero({
  onAsk,
  onSubmit,
  onSubmitQuestion,
  question,
  onChange,
  canSubmit,
}: {
  onAsk: (question: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSubmitQuestion: () => void;
  question: string;
  onChange: (value: string) => void;
  canSubmit: boolean;
}) {
  return (
    <div className="relative flex min-h-full flex-col items-center justify-center px-6 py-12">
      <div className="gemini-gradient pointer-events-none absolute inset-0" />

      <div className="rise-in z-10 mb-10 flex flex-col items-center text-center">
        <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-3xl bg-primary-container text-on-primary-container shadow-lg shadow-primary/20">
          <MIcon name="auto_awesome" className="text-[32px]" />
        </div>
        <h1 className="font-headline-lg-mobile text-headline-lg-mobile tracking-tight text-on-surface sm:font-headline-xl sm:text-headline-xl">
          Ready when you are
        </h1>
        <p className="mx-auto mt-2 max-w-lg text-body-md text-on-surface-variant opacity-70">
          พร้อมตอบเรื่องการเรียนและข้อมูลของวิทยาลัย ถามเป็นภาษาไทยได้เลย
        </p>
      </div>

      {/* Desktop search bar */}
      <div className="z-10 mb-16 hidden w-full max-w-3xl px-4 md:block">
        <form
          onSubmit={onSubmit}
          className="group relative flex items-center rounded-full border border-surface-container-high bg-white p-2 shadow-lg ring-4 ring-primary/5 transition-all duration-300 focus-within:ring-primary/20 hover:shadow-xl"
        >
          <div className="pl-4 pr-3 text-primary">
            <MIcon name="auto_awesome" fill />
          </div>
          <input
            value={question}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) {
                return;
              }

              event.preventDefault();
              onSubmitQuestion();
            }}
            className="flex-1 border-none bg-transparent py-4 text-body-md placeholder:text-on-surface-variant/40 focus:ring-0 focus:outline-none"
            placeholder="ถาม PSC AI..."
            type="text"
            autoComplete="off"
          />
          <div className="flex items-center gap-2 pr-2">
            <button
              type="button"
              aria-label="พูดด้วยเสียง"
              className="rounded-full p-3 text-on-surface-variant transition-colors hover:bg-surface-container"
            >
              <MIcon name="mic" />
            </button>
            <button
              type="button"
              aria-label="แนบไฟล์"
              className="rounded-full p-3 text-on-surface-variant transition-colors hover:bg-surface-container"
            >
              <MIcon name="attach_file" />
            </button>
            <button
              type="button"
              onClick={onSubmitQuestion}
              disabled={!canSubmit}
              aria-label="ส่งคำถาม"
              className="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-on-primary shadow-md transition-transform hover:scale-105 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100"
            >
              <MIcon name="arrow_forward" />
            </button>
          </div>
        </form>

        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {starters.map((starter) => (
            <button
              key={starter.question}
              type="button"
              onClick={() => onAsk(starter.question)}
              className="whitespace-nowrap rounded-full border border-surface-container-high bg-white/50 px-4 py-2 font-label-bold text-label-bold text-on-surface-variant backdrop-blur-sm transition-all hover:border-primary/40 hover:text-primary"
            >
              {starter.label}
            </button>
          ))}
        </div>
      </div>

      {/* Desktop bento cards */}
      <div className="z-10 hidden w-full max-w-4xl grid-cols-1 gap-gutter md:grid md:grid-cols-3">
        <button
          type="button"
          onClick={() => onAsk("วิทยาลัยเปิดสอนหลักสูตรอะไรบ้าง")}
          className="group relative cursor-pointer overflow-hidden rounded-xl border border-white/40 bg-white/60 p-6 text-left shadow-sm backdrop-blur-md transition-all hover:shadow-md"
        >
          <div className="ai-shimmer absolute inset-0 opacity-0 transition-opacity group-hover:opacity-100" />
          <div className="relative flex h-full flex-col">
            <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-fixed text-primary transition-transform group-hover:scale-110">
              <MIcon name="school" fill />
            </div>
            <h3 className="mb-2 font-label-bold text-label-bold text-on-surface">
              College Q&amp;A
            </h3>
            <p className="text-body-sm text-on-surface-variant opacity-70">
              ถามข้อมูลหลักสูตร ระเบียบ และการใช้ชีวิตในวิทยาลัยได้ทันที
            </p>
          </div>
        </button>

        <div className="group relative overflow-hidden rounded-xl border border-white/40 bg-white/60 p-6 shadow-sm backdrop-blur-md transition-all hover:shadow-md">
          <div className="relative flex h-full flex-col">
            <div className="mb-6 flex items-start justify-between">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-secondary-fixed text-secondary transition-transform group-hover:scale-110">
                <MIcon name="event_available" fill />
              </div>
              <span className="rounded-full bg-primary-container px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-on-primary-container">
                Live Now
              </span>
            </div>
            <h3 className="mb-2 font-label-bold text-label-bold text-on-surface">
              Open House 2024
            </h3>
            <p className="text-body-sm text-on-surface-variant opacity-70">
              หอประชุมใหญ่ · 14:00 น.
            </p>
          </div>
        </div>

        <div className="group relative overflow-hidden rounded-xl border border-white/40 bg-white/60 p-6 shadow-sm backdrop-blur-md transition-all hover:shadow-md">
          <div className="relative flex h-full flex-col">
            <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-tertiary-fixed text-tertiary transition-transform group-hover:scale-110">
              <MIcon name="insights" fill />
            </div>
            <h3 className="mb-2 font-label-bold text-label-bold text-on-surface">
              Grade Analysis
            </h3>
            <p className="text-body-sm text-on-surface-variant opacity-70">
              GPA: 3.85 · ผลการเรียนดีเยี่ยม
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ Conversation ------------------------------- */

function Conversation({
  messages,
  isLoading,
  lastError,
}: {
  messages: ChatMessage[];
  isLoading: boolean;
  lastError: string | null;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-6 py-8">
      {messages.map((message) =>
        message.role === "user" ? (
          <UserBubble
            key={message.id}
            content={message.content}
            time={message.time}
          />
        ) : (
          <AssistantBubble
            key={message.id}
            content={message.content}
            time={message.time}
          />
        ),
      )}

      {isLoading ? (
        <div className="animate-message-in flex max-w-[85%] flex-col items-start">
          <div className="message-glow flex items-center gap-2.5 rounded-t-lg rounded-br-lg bg-surface-container-high px-5 py-4">
            <span className="typing flex items-center gap-1" aria-hidden="true">
              <span className="h-1.5 w-1.5 rounded-full bg-primary" />
              <span className="h-1.5 w-1.5 rounded-full bg-primary" />
              <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            </span>
            <span className="text-body-sm text-on-surface-variant">
              กำลังเรียบเรียงคำตอบ
            </span>
          </div>
        </div>
      ) : null}

      {lastError ? (
        <div className="flex items-start gap-3 rounded-xl border border-outline-variant bg-surface-container-low p-4">
          <MIcon name="error" className="mt-0.5 text-error" />
          <p className="text-body-sm text-on-surface-variant">
            <span className="font-bold text-on-surface">เชื่อมต่อไม่สำเร็จ:</span>{" "}
            {lastError}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function UserBubble({ content, time }: { content: string; time?: string }) {
  return (
    <div className="animate-message-in ml-auto flex max-w-[85%] flex-col items-end space-y-2">
      <div className="rounded-t-lg rounded-bl-lg bg-primary p-5 text-on-primary shadow-sm">
        <p className="text-body-md whitespace-pre-wrap [overflow-wrap:anywhere]">
          {content}
        </p>
      </div>
      {time ? (
        <span className="mr-1 font-label-bold text-label-bold text-on-surface-variant/60">
          {time}
        </span>
      ) : null}
    </div>
  );
}

function AssistantBubble({
  content,
  time,
}: {
  content: string;
  time?: string;
}) {
  return (
    <div className="animate-message-in flex max-w-[85%] flex-col items-start space-y-2">
      <div className="message-glow rounded-t-lg rounded-br-lg bg-surface-container-high p-5">
        <p className="text-body-md whitespace-pre-wrap text-on-surface [overflow-wrap:anywhere]">
          {content}
        </p>
      </div>
      {time ? (
        <span className="ml-1 font-label-bold text-label-bold text-on-surface-variant/60">
          {time}
        </span>
      ) : null}
    </div>
  );
}

/* ------------------------------- Bottom bar -------------------------------- */

function BottomBar({
  hideOnDesktopWhenEmpty,
  question,
  onChange,
  onSubmit,
  onSubmitQuestion,
  onAsk,
  canSubmit,
}: {
  hideOnDesktopWhenEmpty: boolean;
  question: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSubmitQuestion: () => void;
  onAsk: (question: string) => void;
  canSubmit: boolean;
}) {
  return (
    <div
      className={`pointer-events-none bg-gradient-to-t from-background via-background to-transparent px-6 pt-8 pb-5 ${
        hideOnDesktopWhenEmpty ? "md:hidden" : ""
      }`}
    >
      <div className="pointer-events-auto mx-auto max-w-3xl space-y-4">
        <div className="no-scrollbar flex gap-3 overflow-x-auto pb-1">
          {starters.map((starter) => (
            <button
              key={starter.question}
              type="button"
              onClick={() => onAsk(starter.question)}
              className="flex flex-shrink-0 items-center gap-2 rounded-full bg-secondary-container px-5 py-2.5 font-label-bold text-label-bold text-on-secondary-fixed transition-colors hover:bg-primary-fixed-dim"
            >
              {starter.label}
            </button>
          ))}
        </div>

        <form onSubmit={onSubmit} className="group relative">
          <div className="absolute inset-0 rounded-full bg-primary/5 blur-xl transition-all group-focus-within:bg-primary/10" />
          <div className="relative flex items-center rounded-full border border-outline-variant bg-surface-container-lowest p-2 pl-6 shadow-sm transition-all focus-within:border-primary focus-within:ring-1 focus-within:ring-primary/20">
            <input
              value={question}
              onChange={(event) => onChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) {
                  return;
                }

                event.preventDefault();
                onSubmitQuestion();
              }}
              className="flex-1 border-none bg-transparent text-body-md text-on-surface placeholder:text-on-surface-variant/50 focus:ring-0 focus:outline-none"
              placeholder="ถาม PSC AI ได้ทุกเรื่อง..."
              type="text"
              autoComplete="off"
            />
            <button
              type="button"
              onClick={onSubmitQuestion}
              disabled={!canSubmit}
              aria-label="ส่งคำถาม"
              className="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-on-primary shadow-md transition-transform duration-150 hover:scale-105 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100"
            >
              <MIcon name="arrow_upward" />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* --------------------------------- Atoms ----------------------------------- */

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

function Logo({
  size = 40,
  className = "",
  priority = false,
}: {
  size?: number;
  className?: string;
  priority?: boolean;
}) {
  // Show the logo by default; fall back to the "PSC" mark only on load error.
  // Visibility is never gated on onLoad, which does not fire when the image is
  // already cached before React attaches the handler.
  const [failed, setFailed] = useState(false);

  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden ${className}`}
    >
      {failed ? (
        <span className="absolute inset-0 flex items-center justify-center rounded-[inherit] bg-primary-container text-[0.62rem] font-bold tracking-tight text-on-primary">
          PSC
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src="/logo-pongsawadi.png"
          alt="ตราวิทยาลัยเทคโนโลยีพงษ์สวัสดิ์"
          width={size}
          height={size}
          loading={priority ? "eager" : "lazy"}
          onError={() => setFailed(true)}
          className="h-full w-full object-contain"
        />
      )}
    </span>
  );
}

function Avatar({ src, className = "" }: { src: string; className?: string }) {
  const [failed, setFailed] = useState(false);

  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary-fixed text-primary ${className}`}
    >
      {failed ? (
        <MIcon name="person" fill />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt="รูปโปรไฟล์นักศึกษา"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      )}
    </span>
  );
}
