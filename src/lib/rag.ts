export type RetrievedDocument = {
  id: number;
  source_name: string;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
};

export type AnswerSource = {
  id: number;
  sourceName: string;
  similarity: number;
  metadata: Record<string, unknown>;
};

export type RagAnswer = {
  answer: string;
  sources: AnswerSource[];
};

export type ConversationMessage = {
  role: "assistant" | "user";
  content: string;
};

type RagConfig = {
  geminiApiKey: string;
  generationModel: string;
  embeddingModel: string;
  embeddingDimensions: number;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  matchThreshold: number;
  matchCount: number;
};

type GeminiEmbeddingResponse = {
  embedding?: {
    values?: number[];
  };
  embeddings?: Array<{
    values?: number[];
  }>;
};

type GeminiGenerateResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
};

const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const APP_TIME_ZONE = "Asia/Bangkok";
const THAI_MONTHS: Record<string, string> = {
  มกราคม: "01",
  กุมภาพันธ์: "02",
  มีนาคม: "03",
  เมษายน: "04",
  พฤษภาคม: "05",
  มิถุนายน: "06",
  กรกฎาคม: "07",
  สิงหาคม: "08",
  กันยายน: "09",
  ตุลาคม: "10",
  พฤศจิกายน: "11",
  ธันวาคม: "12",
};

export class RagConfigurationError extends Error {
  constructor(public readonly missingEnv: string[]) {
    super(`Missing required environment variables: ${missingEnv.join(", ")}`);
    this.name = "RagConfigurationError";
  }
}

export async function answerQuestion(
  question: string,
  history: ConversationMessage[] = [],
): Promise<RagAnswer> {
  const config = getRagConfig();
  const dateContext = getDateContext(new Date());
  const standaloneQuestion = await buildStandaloneQuestion(
    question,
    history,
    dateContext,
    config,
  );
  const groundedQuestion = addRelativeDateContext(standaloneQuestion, dateContext);
  const queryEmbedding = await createQueryEmbedding(groundedQuestion, config);
  const documents = await matchDocuments(queryEmbedding, config);
  const scopedDocuments = scopeCalendarDateDocuments(documents, groundedQuestion);

  if (scopedDocuments.length === 0) {
    const targetDateKeys = extractTargetDateKeys(groundedQuestion);

    if (isCalendarDateQuestion(groundedQuestion) && targetDateKeys.length > 0) {
      return {
        answer: `วันที่ ${formatThaiDateKey(
          targetDateKeys[0],
        )} ผมยังไม่เจอรายการกิจกรรมในปฏิทินครับ`,
        sources: [],
      };
    }

    return {
      answer: "ไม่พบข้อมูลที่เกี่ยวข้องในเอกสารของโรงเรียน/วิทยาลัย",
      sources: [],
    };
  }

  const calendarDateAnswer = buildCalendarDateAnswer(scopedDocuments, groundedQuestion);

  if (calendarDateAnswer) {
    return {
      answer: calendarDateAnswer,
      sources: scopedDocuments.map((document) => ({
        id: document.id,
        sourceName: document.source_name,
        similarity: document.similarity,
        metadata: document.metadata,
      })),
    };
  }

  const answer = await generateGroundedAnswer(
    question,
    groundedQuestion,
    dateContext,
    scopedDocuments,
    config,
  );

  return {
    answer: stripSourceCitations(answer),
    sources: scopedDocuments.map((document) => ({
      id: document.id,
      sourceName: document.source_name,
      similarity: document.similarity,
      metadata: document.metadata,
    })),
  };
}

function getRagConfig(): RagConfig {
  const geminiApiKey =
    process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "";
  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  const missingEnv = [
    ["GEMINI_API_KEY", geminiApiKey],
    ["SUPABASE_URL", supabaseUrl],
    ["SUPABASE_SERVICE_ROLE_KEY", supabaseServiceRoleKey],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missingEnv.length > 0) {
    throw new RagConfigurationError(missingEnv);
  }

  return {
    geminiApiKey,
    generationModel: process.env.GEMINI_GENERATION_MODEL || "gemini-2.5-flash",
    embeddingModel: process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001",
    embeddingDimensions: readNumberEnv("GEMINI_EMBEDDING_DIMENSIONS", 768),
    supabaseUrl: supabaseUrl.replace(/\/$/, ""),
    supabaseServiceRoleKey,
    matchThreshold: readNumberEnv("MATCH_THRESHOLD", 0.75),
    matchCount: readNumberEnv("MATCH_COUNT", 5),
  };
}

async function createQueryEmbedding(
  question: string,
  config: RagConfig,
): Promise<number[]> {
  const contentText =
    config.embeddingModel === "gemini-embedding-2"
      ? `task: question answering | query: ${question}`
      : question;

  const body: Record<string, unknown> = {
    content: {
      parts: [{ text: contentText }],
    },
    output_dimensionality: config.embeddingDimensions,
  };

  if (config.embeddingModel !== "gemini-embedding-2") {
    body.taskType = "RETRIEVAL_QUERY";
  }

  const response = await fetch(
    `${GEMINI_API_BASE_URL}/models/${config.embeddingModel}:embedContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": config.geminiApiKey,
      },
      body: JSON.stringify(body),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new Error(`Gemini embedding request failed: ${response.status}`);
  }

  const data = (await response.json()) as GeminiEmbeddingResponse;
  const values = data.embedding?.values ?? data.embeddings?.[0]?.values;

  if (!values || values.length !== config.embeddingDimensions) {
    throw new Error("Gemini embedding response did not match configured dimension");
  }

  return values;
}

async function matchDocuments(
  embedding: number[],
  config: RagConfig,
): Promise<RetrievedDocument[]> {
  const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/match_documents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: config.supabaseServiceRoleKey,
      Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
    },
    body: JSON.stringify({
      query_embedding: embedding,
      match_threshold: config.matchThreshold,
      match_count: config.matchCount,
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Supabase match_documents request failed: ${response.status}`);
  }

  const documents = (await response.json()) as RetrievedDocument[];
  return documents.filter((document) => document.content.trim().length > 0);
}

async function generateGroundedAnswer(
  question: string,
  groundedQuestion: string,
  dateContext: DateContext,
  documents: RetrievedDocument[],
  config: RagConfig,
): Promise<string> {
  const response = await fetch(
    `${GEMINI_API_BASE_URL}/models/${config.generationModel}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": config.geminiApiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: buildPrompt(question, groundedQuestion, dateContext, documents),
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
        },
      }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new Error(`Gemini generation request failed: ${response.status}`);
  }

  const data = (await response.json()) as GeminiGenerateResponse;
  const text =
    data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text)
      .filter(Boolean)
      .join("\n")
      .trim() ?? "";

  return text || "ไม่พบข้อมูลที่เพียงพอสำหรับตอบจากเอกสารที่ค้นเจอ";
}

type DateContext = {
  todayKey: string;
  todayText: string;
  tomorrowKey: string;
  tomorrowText: string;
  yesterdayKey: string;
  yesterdayText: string;
};

function buildPrompt(
  question: string,
  groundedQuestion: string,
  dateContext: DateContext,
  documents: RetrievedDocument[],
): string {
  const context = documents
    .map((document, index) => {
      const metadata =
        Object.keys(document.metadata).length > 0
          ? `\nmetadata: ${JSON.stringify(document.metadata)}`
          : "";

      return `[${index + 1}] source: ${document.source_name}${metadata}\n${document.content}`;
    })
    .join("\n\n---\n\n");

  return `คุณคือ chatbot สำหรับตอบคำถามเกี่ยวกับโรงเรียนหรือวิทยาลัย

กติกา:
- ตอบเป็นภาษาไทย กระชับ และเป็นทางการพอสำหรับสถานศึกษา
- ใช้เฉพาะข้อมูลใน CONTEXT เท่านั้น
- ถ้า CONTEXT ไม่มีคำตอบตรงกับคำถาม ให้ตอบว่า "ไม่พบข้อมูลในเอกสารที่มี"
- ห้ามเดาข้อมูล เช่น ค่าเทอม วันที่ ช่องทางติดต่อ หรือระเบียบ
- ห้ามอนุมานจากข้อมูลใกล้เคียง ถ้าไม่แน่ใจให้ตอบว่าไม่พบข้อมูล
- ห้ามแสดงเลขอ้างอิง ชื่อ source URL หรือรูปแบบ [1], [2] ในคำตอบ
- วันนี้ตามเวลาไทยคือ ${dateContext.todayText} (${dateContext.todayKey})
- ถ้าคำถามถาม "วันนี้", "พรุ่งนี้" หรือ "เมื่อวาน" ให้ใช้วันที่ตามเวลาไทยด้านบนเท่านั้น
- สำหรับข้อมูลปฏิทิน ให้ตอบเฉพาะกิจกรรมที่ตรงกับวันที่ในคำถาม อย่าถือบรรทัด End เป็นกิจกรรมวันใหม่แยกต่างหาก
- ข้อมูลปฏิทินที่ ingest แล้วจะมี Event type, Is school activity และ Answer guidance ให้ใช้ค่านี้เป็นหลัก
- ถ้าวันที่ถามเจอเฉพาะ Event type: public_holiday หรือ school_holiday และไม่มี Is school activity: yes ตรงวันนั้น ให้ตอบว่า "ไม่พบกิจกรรมของวิทยาลัยในข้อมูลที่มีสำหรับวันนั้น" แล้วอธิบายต่อว่าเป็นวันหยุดอะไรด้วยภาษาธรรมชาติ
- ถ้าวันที่ถามมีทั้ง Is school activity: yes และวันหยุด ให้แยกตอบเป็น "กิจกรรมของวิทยาลัย" และ "วันหยุด/หมายเหตุ" อย่าปนวันหยุดเป็นกิจกรรม
- อย่าเรียก public_holiday หรือ school_holiday ว่าเป็นกิจกรรมของวิทยาลัย

QUESTION:
${question}

QUESTION_WITH_DATE_CONTEXT:
${groundedQuestion}

CONTEXT:
${context}`;
}

function addRelativeDateContext(question: string, dateContext: DateContext): string {
  const dateReferences = [];

  if (question.includes("วันนี้")) {
    dateReferences.push(`วันนี้ = ${dateContext.todayText} (${dateContext.todayKey})`);
  }

  if (question.includes("พรุ่งนี้")) {
    dateReferences.push(
      `พรุ่งนี้ = ${dateContext.tomorrowText} (${dateContext.tomorrowKey})`,
    );
  }

  if (question.includes("เมื่อวาน")) {
    dateReferences.push(
      `เมื่อวาน = ${dateContext.yesterdayText} (${dateContext.yesterdayKey})`,
    );
  }

  if (dateReferences.length === 0) {
    return question;
  }

  return `${question}\n${dateReferences.join("\n")}`;
}

function buildCalendarDateAnswer(
  documents: RetrievedDocument[],
  groundedQuestion: string,
): string | null {
  if (!isCalendarDateQuestion(groundedQuestion)) {
    return null;
  }

  const targetDateKeys = extractTargetDateKeys(groundedQuestion);

  if (targetDateKeys.length === 0) {
    return null;
  }

  const exactDateDocuments = documents.filter((document) => {
    const dateKey = document.metadata?.date_key;
    return typeof dateKey === "string" && targetDateKeys.includes(dateKey);
  });

  if (exactDateDocuments.length === 0) {
    return null;
  }

  const dateText = formatThaiDateKey(targetDateKeys[0]);
  const schoolEvents = uniqueCalendarItems(
    exactDateDocuments.filter(
      (document) =>
        document.metadata?.is_school_activity === true ||
        document.metadata?.event_type === "school_event",
    ),
  );
  const nonActivityDays = uniqueCalendarItems(
    exactDateDocuments.filter(
      (document) =>
        document.metadata?.is_school_activity === false &&
        document.metadata?.event_type !== "school_event",
    ),
  );

  if (schoolEvents.length > 0) {
    const eventText =
      schoolEvents.length === 1
        ? buildSingleCalendarEventSentence(dateText, schoolEvents[0])
        : `วันที่ ${dateText} มีรายการในปฏิทินดังนี้:\n${schoolEvents
            .map((event, index) => `${index + 1}. ${event}`)
            .join("\n")}`;
    const noteText =
      nonActivityDays.length > 0
        ? `\n\nหมายเหตุ: วันเดียวกันมีข้อมูลวันหยุด/หมายเหตุคือ ${nonActivityDays.join(
            ", ",
          )}`
        : "";

    return `${eventText}${noteText}`;
  }

  if (nonActivityDays.length > 0) {
    const eventTypes = new Set(
      exactDateDocuments
        .map((document) => document.metadata?.event_type)
        .filter(Boolean),
    );
    const dayLabel = eventTypes.has("public_holiday")
      ? "วันหยุดนักขัตฤกษ์/วันหยุดราชการ"
      : "วันหยุดหรือหมายเหตุตามปฏิทินวิทยาลัย";

    return `วันที่ ${dateText} ไม่มีรายการกิจกรรมของวิทยาลัยในปฏิทินที่ผมมีครับ วันนั้นเป็น${dayLabel}: ${nonActivityDays.join(
      ", ",
    )}`;
  }

  return `วันที่ ${dateText} ผมยังไม่เจอรายการกิจกรรมในปฏิทินครับ`;
}

function uniqueCalendarItems(documents: RetrievedDocument[]): string[] {
  return [
    ...new Set(
      documents
        .map((document) => document.metadata?.summary)
        .filter((summary): summary is string => typeof summary === "string")
        .map((summary) => summary.trim())
        .filter(Boolean),
    ),
  ];
}

function buildSingleCalendarEventSentence(dateText: string, event: string): string {
  if (event.startsWith("เปิดภาคเรียน")) {
    return `วันที่ ${dateText} เป็นวัน${event} ครับ`;
  }

  if (event.startsWith("วัน")) {
    return `วันที่ ${dateText} เป็น${event} ครับ`;
  }

  return `วันที่ ${dateText} มี${event} ครับ`;
}

async function buildStandaloneQuestion(
  question: string,
  history: ConversationMessage[],
  dateContext: DateContext,
  config: RagConfig,
): Promise<string> {
  const relativeDateQuestion = contextualizeRelativeDateQuestion(question, dateContext);

  if (relativeDateQuestion) {
    return relativeDateQuestion;
  }

  const dateQuestion = contextualizeDateQuestion(question, history, dateContext);

  if (dateQuestion) {
    return dateQuestion;
  }

  if (history.length === 0 || !isLikelyFollowUpQuestion(question)) {
    return question;
  }

  try {
    const rewrittenQuestion = await rewriteFollowUpQuestion(
      question,
      history,
      dateContext,
      config,
    );

    return rewrittenQuestion || question;
  } catch {
    return question;
  }
}

function contextualizeRelativeDateQuestion(
  question: string,
  dateContext: DateContext,
): string | null {
  if (!/(?:กิจกรรม|งาน|ปฏิทิน|กำหนดการ|วันหยุด|มีอะไร)/.test(question)) {
    return null;
  }

  if (question.includes("วันนี้")) {
    return `วันที่ ${dateContext.todayText} (${dateContext.todayKey}) มีกิจกรรมอะไร`;
  }

  if (question.includes("พรุ่งนี้")) {
    return `วันที่ ${dateContext.tomorrowText} (${dateContext.tomorrowKey}) มีกิจกรรมอะไร`;
  }

  if (question.includes("เมื่อวาน")) {
    return `วันที่ ${dateContext.yesterdayText} (${dateContext.yesterdayKey}) มีกิจกรรมอะไร`;
  }

  return null;
}

function contextualizeDateQuestion(
  question: string,
  history: ConversationMessage[],
  dateContext: DateContext,
): string | null {
  if (extractTargetDateKeys(question).length > 0 || containsThaiMonth(question)) {
    const partialThaiDateKey = extractPartialThaiDateKey(question, history, dateContext);

    if (partialThaiDateKey && isCalendarFollowUp(question, history)) {
      return `วันที่ ${formatThaiDateKey(
        partialThaiDateKey,
      )} (${partialThaiDateKey}) มีกิจกรรมอะไร`;
    }

    return null;
  }

  const day = extractShortDayReference(question);

  if (!day || !isCalendarFollowUp(question, history)) {
    return null;
  }

  const baseDateKey = findLatestDateKey(history) ?? dateContext.todayKey;
  const [year, month] = baseDateKey.split("-");
  const dateKey = `${year}-${month}-${String(day).padStart(2, "0")}`;

  return `วันที่ ${formatThaiDateKey(dateKey)} (${dateKey}) มีกิจกรรมอะไร`;
}

function extractShortDayReference(question: string): number | null {
  const normalizedQuestion = question.replace(/[?？]/g, " ").trim();
  const match = normalizedQuestion.match(
    /(?:^|\s)(\d{1,2})(?:\s*(?:จ|จันทร์|อ|อังคาร|พ|พุธ|พฤ|พฤหัส|พฤหัสบดี|ศ|ศุกร์|ส|เสาร์|อา|อาทิตย์))?(?=\s|$)/,
  );

  if (!match) {
    return null;
  }

  const day = Number(match[1]);
  return day >= 1 && day <= 31 ? day : null;
}

function isCalendarFollowUp(question: string, history: ConversationMessage[]): boolean {
  return (
    /(?:กิจกรรม|งาน|ปฏิทิน|กำหนดการ|วันหยุด|อะไร|หละ|ล่ะ|ละ)/.test(question) &&
    (isCalendarDateQuestion(question) ||
      history
        .slice(-6)
        .some((message) =>
          /(?:กิจกรรม|งาน|ปฏิทิน|กำหนดการ|วันหยุด|วันที่|วันนี้|พรุ่งนี้)/.test(
            message.content,
          ),
        ))
  );
}

function findLatestDateKey(history: ConversationMessage[]): string | null {
  for (const message of [...history].reverse()) {
    const dateKeys = extractTargetDateKeys(message.content);

    if (dateKeys.length > 0) {
      return dateKeys.at(-1) ?? null;
    }
  }

  return null;
}

function isLikelyFollowUpQuestion(question: string): boolean {
  const normalizedQuestion = question.trim();

  return (
    normalizedQuestion.length <= 40 ||
    /(?:หละ|ล่ะ|ละ|แล้ว|อันนี้|แบบนี้|ของปวช|ของปวส|ปวช\.?|ปวส\.?)/i.test(
      normalizedQuestion,
    )
  );
}

async function rewriteFollowUpQuestion(
  question: string,
  history: ConversationMessage[],
  dateContext: DateContext,
  config: RagConfig,
): Promise<string> {
  const recentHistory = history
    .slice(-8)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
  const prompt = `Rewrite the latest user question into one standalone Thai question for document retrieval.
Use only the conversation history to resolve references. Do not answer the question.
If the latest question is already standalone, return it unchanged.
Today in Thailand is ${dateContext.todayText} (${dateContext.todayKey}).
Return only the rewritten question, no quotes, no explanation.

CONVERSATION:
${recentHistory}

LATEST USER QUESTION:
${question}`;

  const response = await fetch(
    `${GEMINI_API_BASE_URL}/models/${config.generationModel}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": config.geminiApiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          maxOutputTokens: 96,
          temperature: 0,
        },
      }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new Error(`Gemini question rewrite request failed: ${response.status}`);
  }

  const data = (await response.json()) as GeminiGenerateResponse;
  const text =
    data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text)
      .filter(Boolean)
      .join(" ")
      .trim() ?? "";

  return text.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
}

function scopeCalendarDateDocuments(
  documents: RetrievedDocument[],
  groundedQuestion: string,
): RetrievedDocument[] {
  if (!isCalendarDateQuestion(groundedQuestion)) {
    return documents;
  }

  const targetDateKeys = extractTargetDateKeys(groundedQuestion);

  if (targetDateKeys.length === 0) {
    return documents;
  }

  const exactCalendarDocuments = documents.filter((document) => {
    const dateKey = document.metadata?.date_key;
    return typeof dateKey === "string" && targetDateKeys.includes(dateKey);
  });

  if (exactCalendarDocuments.length > 0) {
    return exactCalendarDocuments;
  }

  const hasCalendarDocuments = documents.some(
    (document) =>
      typeof document.metadata?.chunk_kind === "string" &&
      document.metadata.chunk_kind.startsWith("calendar_"),
  );

  return hasCalendarDocuments ? [] : documents;
}

function isCalendarDateQuestion(question: string): boolean {
  return /(?:กิจกรรม|งาน|ปฏิทิน|กำหนดการ|วันหยุด|วันนี้|พรุ่งนี้|เมื่อวาน)/.test(
    question,
  );
}

function extractTargetDateKeys(question: string): string[] {
  const dateKeys = new Set<string>();

  for (const match of question.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) {
    dateKeys.add(`${match[1]}-${match[2]}-${match[3]}`);
  }

  for (const match of question.matchAll(
    /(\d{1,2})\s*(มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)\s*(\d{4})/g,
  )) {
    const day = match[1].padStart(2, "0");
    const month = THAI_MONTHS[match[2]];
    const rawYear = Number(match[3]);
    const year = rawYear > 2400 ? rawYear - 543 : rawYear;

    dateKeys.add(`${year}-${month}-${day}`);
  }

  return [...dateKeys];
}

function containsThaiMonth(question: string): boolean {
  return Object.keys(THAI_MONTHS).some((month) => question.includes(month));
}

function extractPartialThaiDateKey(
  question: string,
  history: ConversationMessage[],
  dateContext: DateContext,
): string | null {
  const match = question.match(
    /(\d{1,2})\s*(มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)(?!\s*\d{4})/,
  );

  if (!match) {
    return null;
  }

  const baseDateKey = findLatestDateKey(history) ?? dateContext.todayKey;
  const [year] = baseDateKey.split("-");
  const day = match[1].padStart(2, "0");
  const month = THAI_MONTHS[match[2]];

  return `${year}-${month}-${day}`;
}

function getDateContext(now: Date): DateContext {
  const todayKey = formatDateKeyInTimeZone(now);
  const tomorrowKey = addDays(todayKey, 1);
  const yesterdayKey = addDays(todayKey, -1);

  return {
    todayKey,
    todayText: formatThaiDateKey(todayKey),
    tomorrowKey,
    tomorrowText: formatThaiDateKey(tomorrowKey),
    yesterdayKey,
    yesterdayText: formatThaiDateKey(yesterdayKey),
  };
}

function formatDateKeyInTimeZone(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${values.year}-${values.month}-${values.day}`;
}

function formatThaiDateKey(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));

  return date.toLocaleDateString("th-TH", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function addDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12));

  return date.toISOString().slice(0, 10);
}

function stripSourceCitations(answer: string): string {
  return answer.replace(/\s*\[(?:\d+\s*(?:,\s*)?)+\]/g, "").trim();
}

function readNumberEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const numberValue = Number(rawValue);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}
