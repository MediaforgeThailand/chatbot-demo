import { NextResponse, type NextRequest } from "next/server";

import {
  GmailConfigurationError,
  GmailConnectionError,
  GMAIL_SESSION_COOKIE,
  getGmailConfig,
  getUsableAccessToken,
  isUuid,
  searchGmailMessages,
  sendGmailMessage,
} from "@/lib/gmail";
import {
  answerQuestion,
  RagConfigurationError,
  type RagAnswer,
  type ConversationMemory,
  type ConversationMessage,
} from "@/lib/rag";

const MAX_HISTORY_MESSAGES = 24;

export async function POST(request: NextRequest) {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON request body" },
      { status: 400 },
    );
  }

  const question =
    typeof payload === "object" &&
    payload !== null &&
    "question" in payload &&
    typeof payload.question === "string"
      ? payload.question.trim()
      : "";

  if (!question) {
    return NextResponse.json(
      { error: "Question is required" },
      { status: 400 },
    );
  }

  const history = readHistory(payload);
  const memory = readMemory(payload);
  const gmailAnswer = await answerGmailChatAction(request, question);

  if (gmailAnswer) {
    return NextResponse.json(gmailAnswer);
  }

  try {
    const result = await answerQuestion(question, history, memory);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RagConfigurationError) {
      return NextResponse.json(
        {
          error: "RAG backend is not configured",
          missingEnv: error.missingEnv,
        },
        { status: 503 },
      );
    }

    console.error(error);

    return NextResponse.json(
      { error: "Unable to answer from the knowledge base" },
      { status: 500 },
    );
  }
}

function readMemory(payload: unknown): ConversationMemory {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("memory" in payload) ||
    typeof payload.memory !== "object" ||
    payload.memory === null ||
    Array.isArray(payload.memory)
  ) {
    return {};
  }

  const rawMemory = payload.memory as Record<string, unknown>;
  const calendarYear =
    typeof rawMemory.calendarYear === "number" &&
    Number.isInteger(rawMemory.calendarYear) &&
    rawMemory.calendarYear >= 2000 &&
    rawMemory.calendarYear <= 2600
      ? rawMemory.calendarYear
      : undefined;
  const calendarMonthKey =
    typeof rawMemory.calendarMonthKey === "string" &&
    /^20\d{2}-\d{2}$/.test(rawMemory.calendarMonthKey)
      ? rawMemory.calendarMonthKey
      : undefined;
  const corrections = Array.isArray(rawMemory.corrections)
    ? rawMemory.corrections
        .filter((correction): correction is string => typeof correction === "string")
        .map((correction) => correction.trim())
        .filter(Boolean)
        .slice(-8)
    : undefined;

  return {
    calendarYear,
    calendarMonthKey,
    corrections,
  };
}

function readHistory(payload: unknown): ConversationMessage[] {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("history" in payload) ||
    !Array.isArray(payload.history)
  ) {
    return [];
  }

  return payload.history
    .filter(
      (message): message is ConversationMessage =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        (message.role === "user" || message.role === "assistant") &&
        "content" in message &&
        typeof message.content === "string",
    )
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
    }))
    .filter((message) => message.content.length > 0)
    .slice(-MAX_HISTORY_MESSAGES);
}

async function answerGmailChatAction(
  request: NextRequest,
  question: string,
): Promise<RagAnswer | null> {
  const action = parseGmailChatAction(question);

  if (!action) {
    return null;
  }

  try {
    const config = getGmailConfig();
    const sessionId = request.cookies.get(GMAIL_SESSION_COOKIE)?.value;

    if (!isUuid(sessionId)) {
      return {
        answer:
          "ยังไม่ได้เชื่อม Gmail ในเบราว์เซอร์นี้ครับ กด Connectors > Gmail > เชื่อมต่อก่อน แล้วค่อยสั่งส่งหรือค้นเมลอีกครั้ง",
        sources: [],
      };
    }

    const { accessToken } = await getUsableAccessToken(sessionId, config);

    if (action.type === "search") {
      const messages = await searchGmailMessages({
        accessToken,
        query: action.query,
        maxResults: 5,
      });

      if (messages.length === 0) {
        return {
          answer: `ค้น Gmail ด้วย "${action.query}" แล้วไม่เจอเมลที่ตรงครับ`,
          sources: [],
        };
      }

      return {
        answer: `เจออีเมลที่ใกล้เคียง ${messages.length} รายการครับ:\n${messages
          .map(
            (message, index) =>
              `${index + 1}. ${message.subject}\n   จาก: ${
                message.from || "-"
              }\n   ตัวอย่าง: ${message.snippet || "-"}`,
          )
          .join("\n")}`,
        sources: [],
      };
    }

    const result = await sendGmailMessage({
      accessToken,
      to: action.to,
      subject: action.subject,
      body: action.body,
    });

    return {
      answer: `ส่งอีเมลผ่าน Gmail เรียบร้อยครับ\n\nถึง: ${action.to}\nหัวข้อ: ${
        action.subject
      }${result.id ? `\nMessage ID: ${result.id}` : ""}`,
      sources: [],
    };
  } catch (error) {
    if (error instanceof GmailConfigurationError) {
      return {
        answer: `Gmail connector ยังตั้งค่าไม่ครบครับ ขาด env: ${error.missingEnv.join(
          ", ",
        )}`,
        sources: [],
      };
    }

    if (error instanceof GmailConnectionError) {
      const reconnectHint = /insufficient|permission|scope|forbidden|403/i.test(
        error.message,
      )
        ? "\n\nถ้าเพิ่งเพิ่มสิทธิ์ Gmail ให้กดตัดการเชื่อมต่อแล้วเชื่อมใหม่ก่อนครับ"
        : "";

      return {
        answer: `ยังทำคำสั่ง Gmail ไม่สำเร็จครับ: ${error.message}${reconnectHint}`,
        sources: [],
      };
    }

    console.error(error);

    return {
      answer: "ยังทำคำสั่ง Gmail ไม่สำเร็จครับ",
      sources: [],
    };
  }
}

type GmailChatAction =
  | {
      type: "send";
      to: string;
      subject: string;
      body: string;
    }
  | {
      type: "search";
      query: string;
    };

function parseGmailChatAction(question: string): GmailChatAction | null {
  const normalizedQuestion = question.replace(/\s+/g, " ").trim();
  const hasMailSignal = /(?:gmail|อีเมล|email|เมล)/i.test(normalizedQuestion);

  if (!hasMailSignal) {
    return null;
  }

  const recipient = extractEmailAddress(normalizedQuestion);
  const hasSendIntent = /(?:ส่ง|ส่งให้|ส่งเลย|พร้อมส่ง|send)/i.test(
    normalizedQuestion,
  );

  if (recipient && hasSendIntent) {
    return {
      type: "send",
      to: recipient,
      subject: extractExplicitSubject(question) ?? "ทดสอบส่งอีเมลจาก PSC AI",
      body: extractExplicitBody(question) ?? buildDefaultEmailBody(),
    };
  }

  const hasSearchIntent = /(?:ค้น|หา|อ่าน|ดู|inbox|กล่องจดหมาย)/i.test(
    normalizedQuestion,
  );

  if (hasSearchIntent) {
    return {
      type: "search",
      query: buildGmailSearchQuery(normalizedQuestion),
    };
  }

  return null;
}

function extractEmailAddress(text: string): string | null {
  return text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null;
}

function extractExplicitSubject(text: string): string | null {
  const match = text.match(
    /(?:subject|หัวข้อ)\s*[:：]\s*([\s\S]+?)(?=\s+(?:body|เนื้อหา|ข้อความ)\s*[:：]|$)/i,
  );

  if (!match) {
    return null;
  }

  const subject = match[1].trim();
  return subject.length > 0 ? subject.slice(0, 160) : null;
}

function extractExplicitBody(text: string): string | null {
  const match = text.match(/(?:body|เนื้อหา|ข้อความ)\s*[:：]\s*([\s\S]+)/i);

  if (!match) {
    return null;
  }

  const body = match[1].trim();
  return body.length > 0 ? body.slice(0, 4000) : null;
}

function buildDefaultEmailBody(): string {
  return [
    "สวัสดีครับ",
    "",
    "นี่คืออีเมลทดสอบจาก PSC AI เพื่อยืนยันว่า Gmail connector สามารถส่งอีเมลได้จริง",
    "",
    "ขอบคุณครับ",
  ].join("\n");
}

function buildGmailSearchQuery(question: string): string {
  const email = extractEmailAddress(question);

  if (email) {
    return `from:${email} OR to:${email}`;
  }

  if (/inbox|กล่องจดหมาย/i.test(question)) {
    return "in:inbox newer_than:30d";
  }

  return question
    .replace(/(?:gmail|อีเมล|email|เมล|ค้น|หา|อ่าน|ดู|ให้หน่อย|หน่อย)/gi, " ")
    .replace(/\s+/g, " ")
    .trim() || "in:inbox newer_than:30d";
}
