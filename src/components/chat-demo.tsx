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

const starters = [
  { label: "สมัครเรียน ปวช.", question: "สมัครเรียน ปวช. ต้องใช้เอกสารอะไรบ้าง" },
  { label: "หลักสูตรที่เปิดสอน", question: "วิทยาลัยเปิดสอนหลักสูตรอะไรบ้าง" },
  { label: "ช่องทางจ่ายค่าเทอม", question: "ชำระค่าเทอมได้ช่องทางไหน" },
  {
    label: "ระเบียบการแต่งกาย",
    question: "ระเบียบการแต่งกายของนักศึกษามีอะไรบ้าง",
  },
];

const initialMessages: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    content:
      "สวัสดีครับ ผมเป็นผู้ช่วยตอบคำถามของวิทยาลัย ตอบจากเอกสารจริงเท่านั้นและแนบแหล่งอ้างอิงให้ตรวจสอบได้ทุกครั้ง เริ่มถามได้เลยครับ",
  },
];

function formatTime(date: Date): string {
  return date.toLocaleTimeString("th-TH", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ChatDemo() {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [question, setQuestion] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const canSubmit = useMemo(
    () => question.trim().length > 0 && !isLoading,
    [isLoading, question],
  );

  const isEmptyState = messages.length === 1 && messages[0].id === "welcome";

  useEffect(() => {
    if (isEmptyState) {
      return;
    }
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, isLoading, isEmptyState]);

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
      time: formatTime(new Date()),
    };

    setMessages((currentMessages) => [...currentMessages, userMessage]);

    try {
      const history = messages
        .filter((message) => message.id !== "welcome")
        .slice(-8)
        .map(({ role, content }) => ({ role, content }));

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmedQuestion, history }),
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

      setMessages((currentMessages) => [
        ...currentMessages,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: data.answer ?? "ไม่พบคำตอบ",
          sources: data.sources ?? [],
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
      />

      <main className="relative flex flex-1 flex-col overflow-hidden bg-surface">
        <MobileTopBar onOpenNav={() => setNavOpen(true)} />

        <div
          ref={scrollRef}
          className="custom-scrollbar relative flex-1 overflow-y-auto"
        >
          {isEmptyState ? (
            <Hero
              onAsk={(q) => void submitQuestion(q)}
              onSubmit={handleSubmit}
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
          onAsk={(q) => void submitQuestion(q)}
          canSubmit={canSubmit}
        />
      </main>
    </div>
  );
}

/* ------------------------------ Side navigation ----------------------------- */

function SideNav({
  open,
  onClose,
  onNewChat,
  onAsk,
}: {
  open: boolean;
  onClose: () => void;
  onNewChat: () => void;
  onAsk: (question: string) => void;
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

function MobileTopBar({ onOpenNav }: { onOpenNav: () => void }) {
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
      <button
        type="button"
        className="rounded-full p-2 text-on-surface-variant transition-colors hover:bg-surface-container"
        aria-label="การแจ้งเตือน"
      >
        <MIcon name="notifications" />
      </button>
    </header>
  );
}

/* --------------------------------- Hero ------------------------------------ */

function Hero({
  onAsk,
  onSubmit,
  question,
  onChange,
  canSubmit,
}: {
  onAsk: (question: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
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
              type="submit"
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
            sources={message.sources}
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
  sources,
  time,
}: {
  content: string;
  sources?: AnswerSource[];
  time?: string;
}) {
  const visibleSources = dedupeSources(sources ?? []);

  return (
    <div className="animate-message-in flex max-w-[85%] flex-col items-start space-y-2">
      <div className="message-glow rounded-t-lg rounded-br-lg bg-surface-container-high p-5">
        <p className="text-body-md whitespace-pre-wrap text-on-surface [overflow-wrap:anywhere]">
          {content}
        </p>

        {visibleSources.length > 0 ? (
          <div className="mt-4 border-t border-outline-variant pt-3">
            <p className="mb-2 font-label-bold text-label-bold text-on-surface-variant">
              แหล่งอ้างอิง
            </p>
            <ol className="flex flex-wrap gap-2">
              {visibleSources.map((source, index) => (
                <li key={source.id}>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-outline-variant bg-surface-container-lowest py-1 pl-1.5 pr-3 text-body-sm text-on-surface-variant">
                    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary-fixed text-[11px] font-bold text-primary">
                      {index + 1}
                    </span>
                    <span className="max-w-[14rem] truncate text-on-surface">
                      {source.sourceName}
                    </span>
                    <span className="tabular-nums text-on-surface-variant/60">
                      {Math.round(source.similarity * 100)}%
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
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
  onAsk,
  canSubmit,
}: {
  hideOnDesktopWhenEmpty: boolean;
  question: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
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
              className="flex-1 border-none bg-transparent text-body-md text-on-surface placeholder:text-on-surface-variant/50 focus:ring-0 focus:outline-none"
              placeholder="ถาม PSC AI ได้ทุกเรื่อง..."
              type="text"
              autoComplete="off"
            />
            <button
              type="submit"
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

function dedupeSources(sources: AnswerSource[]): AnswerSource[] {
  const seen = new Set<string>();
  const unique: AnswerSource[] = [];

  for (const source of sources) {
    const key = source.sourceName.trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      unique.push(source);
    }
  }

  return unique.slice(0, 4);
}
