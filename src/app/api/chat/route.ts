import { NextResponse, type NextRequest } from "next/server";

import {
  GmailConfigurationError,
  GmailConnectionError,
  GMAIL_SESSION_COOKIE,
  createGmailDraft,
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
const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

type GeminiGenerateResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
};

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
          "ยังไม่ได้เชื่อม Gmail ในเบราว์เซอร์นี้ครับ กด Connectors > Gmail > เชื่อมต่อก่อน แล้วค่อยสั่งร่าง ส่ง หรือค้นเมลอีกครั้ง",
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

    const email = await composeEmailForChatAction(action);

    if (action.type === "draft") {
      const result = await createGmailDraft({
        accessToken,
        to: action.to,
        subject: email.subject,
        body: email.body,
      });

      return {
        answer: `สร้าง draft ใน Gmail เรียบร้อยครับ ยังไม่ได้ส่งออกไป\n\nถึง: ${
          action.to
        }\nหัวข้อ: ${email.subject}\n\nเนื้อหา:\n${email.body}${
          result.id ? `\n\nDraft ID: ${result.id}` : ""
        }`,
        sources: [],
      };
    }

    const result = await sendGmailMessage({
      accessToken,
      to: action.to,
      subject: email.subject,
      body: email.body,
    });

    return {
      answer: `ส่งอีเมลผ่าน Gmail เรียบร้อยครับ\n\nถึง: ${action.to}\nหัวข้อ: ${
        email.subject
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
      type: "draft";
      to: string;
      subject?: string;
      body?: string;
      instruction: string;
    }
  | {
      type: "send";
      to: string;
      subject?: string;
      body?: string;
      instruction: string;
    }
  | {
      type: "search";
      query: string;
    };

function parseGmailChatAction(question: string): GmailChatAction | null {
  const normalizedQuestion = question.replace(/\s+/g, " ").trim();
  const hasMailSignal = /(?:gmail|อีเมล|email|เมล)/i.test(normalizedQuestion);
  const recipient = extractEmailAddress(normalizedQuestion);
  const hasComposeIntent = /(?:เขียน|ร่าง|draft|ดราฟ|compose|แต่ง|ช่วยเขียน|ส่งเมล|ส่งอีเมล|ส่งให้|ส่งไป|ยังไม่ต้องส่ง|ไม่ต้องส่ง|อย่าเพิ่งส่ง)/i.test(
    normalizedQuestion,
  );
  const hasDraftIntent = /(?:ร่าง|draft|ดราฟ|แค่ร่าง|ยังไม่ต้องส่ง|ไม่ต้องส่ง|อย่าเพิ่งส่ง|ให้ผมกดเอง|ให้ user กดเอง|กดเอง)/i.test(
    normalizedQuestion,
  );
  const hasExplicitSendIntent = /(?:ส่งเลย|ส่งจริง|ส่งทันที|ส่งไปเลย|ส่งให้เลย|send now|send it now|send immediately)/i.test(
    normalizedQuestion,
  );

  if (
    recipient &&
    hasComposeIntent &&
    (hasMailSignal || normalizedQuestion.includes("@"))
  ) {
    return {
      type: hasExplicitSendIntent && !hasDraftIntent ? "send" : "draft",
      to: recipient,
      subject: extractExplicitSubject(question) ?? undefined,
      body: extractExplicitBody(question) ?? undefined,
      instruction: question,
    };
  }

  if (!hasMailSignal) {
    return null;
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

async function composeEmailForChatAction(
  action: Extract<GmailChatAction, { type: "draft" | "send" }>,
): Promise<{ subject: string; body: string }> {
  if (action.subject && action.body) {
    return {
      subject: action.subject,
      body: action.body,
    };
  }

  const fallback = {
    subject: action.subject ?? "ร่างอีเมลจาก PSC AI",
    body: action.body ?? buildDefaultEmailBody(action.instruction),
  };
  const geminiApiKey =
    process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "";

  if (!geminiApiKey) {
    return fallback;
  }

  const generationModel = process.env.GEMINI_GENERATION_MODEL || "gemini-3.5-flash";
  const prompt = `คุณคือผู้ช่วยเขียนอีเมลภาษาไทยให้ผู้ใช้
สร้างหัวข้อและเนื้อหาอีเมลจากคำสั่งนี้ โดยให้อ่านเป็นธรรมชาติ สุภาพ และพร้อมให้ผู้ใช้ตรวจใน Gmail Draft

กติกา:
- อย่าใส่ข้อมูลส่วนตัวจริงที่ผู้ใช้ไม่ได้ให้มา
- ถ้าผู้ใช้บอกว่า mockup หรือข้อมูลไม่ชัด ให้ทำเป็นอีเมลตัวอย่างทั่วไปที่ปลอดภัย
- ห้ามบอกว่าส่งแล้ว เพราะระบบจะสร้าง draft ให้ตรวจเท่านั้น ยกเว้น route ภายนอกจะส่งเอง
- ตอบเป็น JSON object เท่านั้น รูปแบบ {"subject":"...","body":"..."}
- body ใช้บรรทัดใหม่ได้ และต้องไม่เกินประมาณ 3500 ตัวอักษร

ผู้รับ: ${action.to}
คำสั่งผู้ใช้:
${action.instruction}

หัวข้อที่ผู้ใช้ระบุไว้ ถ้ามี:
${action.subject ?? "(ไม่มี)"}

เนื้อหาที่ผู้ใช้ระบุไว้ ถ้ามี:
${action.body ?? "(ไม่มี)"}`;

  try {
    const response = await fetch(
      `${GEMINI_API_BASE_URL}/models/${generationModel}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": geminiApiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            temperature: 0.35,
            responseMimeType: "application/json",
          },
        }),
        cache: "no-store",
      },
    );

    if (!response.ok) {
      return fallback;
    }

    const data = (await response.json()) as GeminiGenerateResponse;
    const text =
      data.candidates?.[0]?.content?.parts
        ?.map((part) => part.text)
        .filter(Boolean)
        .join("\n")
        .trim() ?? "";
    const parsed = parseGeneratedEmailJson(text);

    return {
      subject: action.subject ?? parsed?.subject ?? fallback.subject,
      body: action.body ?? parsed?.body ?? fallback.body,
    };
  } catch {
    return fallback;
  }
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

function parseGeneratedEmailJson(
  text: string,
): { subject: string; body: string } | null {
  const jsonText = text.match(/\{[\s\S]*\}/)?.[0] ?? text;

  try {
    const parsed = JSON.parse(jsonText) as {
      subject?: unknown;
      body?: unknown;
    };
    const subject = typeof parsed.subject === "string" ? parsed.subject.trim() : "";
    const body = typeof parsed.body === "string" ? parsed.body.trim() : "";

    if (!subject || !body) {
      return null;
    }

    return {
      subject: subject.slice(0, 160),
      body: body.slice(0, 4000),
    };
  } catch {
    return null;
  }
}

function buildDefaultEmailBody(instruction: string): string {
  return [
    "สวัสดีครับ",
    "",
    "ผมร่างอีเมลฉบับนี้จากคำสั่งที่ได้รับใน PSC AI ครับ",
    "",
    `คำสั่งต้นทาง: ${instruction.slice(0, 500)}`,
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
