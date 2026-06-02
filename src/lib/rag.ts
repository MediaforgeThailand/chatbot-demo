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

export type ConversationMemory = {
  calendarYear?: number;
  calendarMonthKey?: string;
  corrections?: string[];
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
    groundingMetadata?: {
      webSearchQueries?: string[];
      groundingChunks?: Array<{
        web?: {
          uri?: string;
          title?: string;
        };
      }>;
    };
  }>;
};

type QueryUnderstanding = {
  intent: string;
  searchMode: "metadata_date" | "metadata_month" | "semantic";
  schoolScope: "school" | "off_topic" | "unclear";
  shouldUseWebSearch: boolean;
  standaloneQuestion: string;
  retrievalQueries: string[];
  keywords: string[];
  sourceTypes: string[];
  confidence: number;
  resolvedTime?: {
    type: "date" | "month" | "none";
    dateKey?: string;
    monthKey?: string;
    confidence?: number;
  };
};

type AnswerMode = "general" | "program";

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
const THAI_MONTH_PATTERN =
  "มกราคม|มกรา|ม\\.ค\\.?|มค|กุมภาพันธ์|กุมภา|ก\\.พ\\.?|กพ|มีนาคม|มีนา|มี\\.ค\\.?|มีค|เมษายน|เมษา|เม\\.ย\\.?|เมย|พฤศจิกายน|พฤศจิกา|พ\\.ย\\.?|พย|พฤษภาคม|พฤษภา|พ\\.ค\\.?|พค|มิถุนายน|มิถุนา|มิ\\.ย\\.?|มิย|กรกฎาคม|กรกฎา|ก\\.ค\\.?|กค|สิงหาคม|สิงหา|ส\\.ค\\.?|สค|กันยายน|กันยา|ก\\.ย\\.?|กย|ตุลาคม|ตุลา|ต\\.ค\\.?|ตค|ธันวาคม|ธันวา|ธ\\.ค\\.?|ธค";
const THAI_DATE_MONTH_PATTERN = `${THAI_MONTH_PATTERN}|พฤ(?!หัส)`;
const THAI_MONTH_REGEX = new RegExp(`(?:${THAI_MONTH_PATTERN})`, "i");
const MAX_HISTORY_MESSAGES = 24;
const MAX_MONTH_EVENTS_IN_ANSWER = 6;
const MAX_RETRIEVAL_QUERIES = 3;
const MAX_KEYWORD_TERMS = 12;

export class RagConfigurationError extends Error {
  constructor(public readonly missingEnv: string[]) {
    super(`Missing required environment variables: ${missingEnv.join(", ")}`);
    this.name = "RagConfigurationError";
  }
}

export async function answerQuestion(
  question: string,
  history: ConversationMessage[] = [],
  memory: ConversationMemory = {},
): Promise<RagAnswer> {
  const repeatedAnswer = answerRepeatedQuestion(question, history);

  if (repeatedAnswer) {
    return {
      answer: repeatedAnswer,
      sources: [],
    };
  }

  const dateContext = getDateContext(new Date());
  const clarificationAnswer = buildClarificationAnswer(
    question,
    history,
    memory,
    dateContext,
  );

  if (clarificationAnswer) {
    return {
      answer: clarificationAnswer,
      sources: [],
    };
  }

  const config = getRagConfig();
  const queryUnderstanding = await understandQuestion(
    question,
    history,
    memory,
    dateContext,
    config,
  );
  const deterministicStandaloneQuestion = buildDeterministicStandaloneQuestion(
    question,
    history,
    memory,
    dateContext,
  );
  const standaloneQuestion =
    deterministicStandaloneQuestion ||
    queryUnderstanding?.standaloneQuestion ||
    (await buildStandaloneQuestion(question, history, memory, dateContext, config));
  const groundedQuestion = addRelativeDateContext(standaloneQuestion, dateContext);
  const understoodDateKey = getUnderstoodDateKey(queryUnderstanding);
  const understoodMonthKey = getUnderstoodMonthKey(queryUnderstanding);
  const deterministicDateKey = extractTargetDateKeys(groundedQuestion)[0];
  const targetDateKey = deterministicDateKey ?? understoodDateKey;
  const originalMonthKey = extractTargetMonthKey(
    question,
    dateContext,
    history,
    memory,
  );
  const groundedMonthKey = extractTargetMonthKey(
    groundedQuestion,
    dateContext,
    history,
    memory,
  );
  const targetMonthKey =
    groundedMonthKey ?? originalMonthKey ?? understoodMonthKey;

  if (shouldUseWebAnswer(question, history, queryUnderstanding)) {
    const answer = await generateWebGroundedAnswer(
      question,
      history,
      dateContext,
      config,
    );

    return {
      answer,
      sources: [],
    };
  }

  if (
    targetDateKey &&
    shouldUseExactCalendarDate(queryUnderstanding, groundedQuestion)
  ) {
    const dateDocuments = await fetchCalendarDateDocuments(targetDateKey, config);
    const exactDateQuestion = `วันที่ ${formatThaiDateKey(
      targetDateKey,
    )} (${targetDateKey}) มีกิจกรรมอะไร`;
    const answer =
      buildCalendarDateAnswer(dateDocuments, exactDateQuestion) ??
      `วันที่ ${formatThaiDateKey(
        targetDateKey,
      )} ผมยังไม่เจอรายการกิจกรรมในปฏิทินครับ`;

    return {
      answer,
      sources: toAnswerSources(dateDocuments),
    };
  }

  if (
    targetMonthKey &&
    shouldUseExactCalendarMonth(queryUnderstanding, groundedQuestion, question, history) &&
    !targetDateKey
  ) {
    const monthDocuments = await fetchCalendarMonthDocuments(targetMonthKey, config);

    return {
      answer: buildCalendarMonthAnswer(
        monthDocuments,
        targetMonthKey,
        groundedQuestion,
      ),
      sources: toAnswerSources(monthDocuments),
    };
  }

  const documents = await retrieveSchoolDocuments(
    question,
    groundedQuestion,
    queryUnderstanding,
    config,
  );
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

    if (shouldUseSchoolWebFallback(question, history, queryUnderstanding)) {
      return {
        answer: await generateSchoolWebGroundedAnswer(
          question,
          groundedQuestion,
          history,
          dateContext,
          config,
        ),
        sources: [],
      };
    }

    return {
      answer: "ผมยังค้นข้อมูลที่ยืนยันได้ไม่เจอครับ",
      sources: [],
    };
  }

  const directProgramAnswer = buildDirectProgramAnswer(
    question,
    groundedQuestion,
    scopedDocuments,
  );

  if (directProgramAnswer) {
    return {
      answer: directProgramAnswer,
      sources: toAnswerSources(scopedDocuments),
    };
  }

  const calendarDateAnswer = buildCalendarDateAnswer(scopedDocuments, groundedQuestion);

  if (calendarDateAnswer) {
    return {
      answer: calendarDateAnswer,
      sources: toAnswerSources(scopedDocuments),
    };
  }

  const answer = await generateGroundedAnswer(
    question,
    shouldUseProgramDocumentLookup(
      `${question}\n${groundedQuestion}`,
      queryUnderstanding,
    )
      ? buildProgramGroundedQuestion(question, groundedQuestion)
      : groundedQuestion,
    dateContext,
    scopedDocuments,
    config,
    shouldUseProgramDocumentLookup(`${question}\n${groundedQuestion}`, queryUnderstanding)
      ? "program"
      : "general",
  );

  const strippedAnswer = stripSourceCitations(answer);

  if (
    isFallbackAnswer(strippedAnswer) &&
    shouldUseSchoolWebFallback(question, history, queryUnderstanding)
  ) {
    return {
      answer: await generateSchoolWebGroundedAnswer(
        question,
        groundedQuestion,
        history,
        dateContext,
        config,
      ),
      sources: [],
    };
  }

  return {
    answer: strippedAnswer,
    sources: toAnswerSources(scopedDocuments),
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
    generationModel: process.env.GEMINI_GENERATION_MODEL || "gemini-3.5-flash",
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
  options: {
    matchThreshold?: number;
    matchCount?: number;
  } = {},
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
      match_threshold: options.matchThreshold ?? config.matchThreshold,
      match_count: options.matchCount ?? config.matchCount,
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Supabase match_documents request failed: ${response.status}`);
  }

  const documents = (await response.json()) as RetrievedDocument[];
  return documents.filter((document) => document.content.trim().length > 0);
}

async function retrieveSchoolDocuments(
  question: string,
  groundedQuestion: string,
  understanding: QueryUnderstanding | null,
  config: RagConfig,
): Promise<RetrievedDocument[]> {
  const searchText = [
    question,
    groundedQuestion,
    understanding?.standaloneQuestion ?? "",
    ...(understanding?.retrievalQueries ?? []),
    ...(understanding?.keywords ?? []),
  ].join("\n");
  const retrievalQueries = buildRetrievalQueries(
    question,
    groundedQuestion,
    understanding,
  );
  const keywordTerms = buildKeywordTerms(searchText, understanding);
  const [programDocuments, keywordDocuments, vectorDocuments] = await Promise.all([
    fetchProgramDocuments(question, groundedQuestion, understanding, config),
    fetchKeywordDocuments(keywordTerms, understanding, config),
    fetchVectorDocuments(retrievalQueries, config),
  ]);

  return mergeRetrievedDocuments([
    ...programDocuments,
    ...keywordDocuments,
    ...vectorDocuments,
  ]).slice(0, Math.max(config.matchCount, 8));
}

async function fetchVectorDocuments(
  retrievalQueries: string[],
  config: RagConfig,
): Promise<RetrievedDocument[]> {
  const queries = retrievalQueries.slice(0, MAX_RETRIEVAL_QUERIES);
  const results = await Promise.all(
    queries.map(async (query, index) => {
      const embedding = await createQueryEmbedding(query, config);
      const threshold = Math.max(0.55, config.matchThreshold - (index === 0 ? 0 : 0.08));
      return matchDocuments(embedding, config, {
        matchThreshold: threshold,
        matchCount: Math.max(config.matchCount, 8),
      });
    }),
  );

  return results.flat();
}

async function fetchKeywordDocuments(
  terms: string[],
  understanding: QueryUnderstanding | null,
  config: RagConfig,
): Promise<RetrievedDocument[]> {
  const safeTerms = terms.map(sanitizePostgrestPattern).filter(Boolean);

  if (safeTerms.length === 0) {
    return [];
  }

  const filters = safeTerms.flatMap((term) => [
    `content.ilike.*${term}*`,
    `source_name.ilike.*${term}*`,
  ]);
  const query = new URLSearchParams({
    select: "id,source_name,content,metadata",
    order: "id.asc",
    limit: "180",
  });

  if (!isCalendarIntent(understanding)) {
    query.set("source_type", "in.(website,pdf,text)");
  }

  query.set("or", `(${filters.join(",")})`);

  const response = await fetch(`${config.supabaseUrl}/rest/v1/document_chunks?${query}`, {
    headers: {
      apikey: config.supabaseServiceRoleKey,
      Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Supabase keyword documents request failed: ${response.status}`);
  }

  const documents = (await response.json()) as Array<
    Omit<RetrievedDocument, "similarity"> & { similarity?: number }
  >;

  return documents
    .filter((document) => document.content.trim().length > 0)
    .map((document) => ({
      ...document,
      similarity: Math.min(
        1.25,
        document.similarity ?? 0.78 + scoreKeywordDocument(document, safeTerms) / 100,
      ),
    }))
    .sort((first, second) => {
      if (second.similarity !== first.similarity) {
        return second.similarity - first.similarity;
      }

      return first.id - second.id;
    });
}

function buildRetrievalQueries(
  question: string,
  groundedQuestion: string,
  understanding: QueryUnderstanding | null,
): string[] {
  const queries = [
    groundedQuestion,
    understanding?.standaloneQuestion,
    ...(understanding?.retrievalQueries ?? []),
    question,
  ];
  const uniqueQueries = uniqueStrings(
    queries.filter((query): query is string => typeof query === "string"),
  );

  return uniqueQueries
    .filter((query) => query.trim().length > 0)
    .slice(0, MAX_RETRIEVAL_QUERIES);
}

function buildKeywordTerms(
  searchText: string,
  understanding: QueryUnderstanding | null,
): string[] {
  const terms = new Set<string>();

  for (const keyword of understanding?.keywords ?? []) {
    if (keyword.trim().length >= 2) {
      terms.add(keyword.trim());
    }
  }

  for (const term of buildIntentKeywordTerms(searchText, understanding)) {
    terms.add(term);
  }

  if (shouldUseProgramDocumentLookup(searchText, understanding)) {
    for (const term of buildProgramLookupTerms(searchText)) {
      terms.add(term);
    }
  }

  for (const match of searchText.matchAll(
    /[\p{Script=Thai}A-Za-z0-9][\p{Script=Thai}A-Za-z0-9.]{1,}/gu,
  )) {
    const term = normalizeKeywordTerm(match[0]);

    if (isUsefulKeywordTerm(term)) {
      terms.add(term);
    }
  }

  return [...terms].slice(0, MAX_KEYWORD_TERMS);
}

function buildIntentKeywordTerms(
  searchText: string,
  understanding: QueryUnderstanding | null,
): string[] {
  const terms = new Set<string>();

  if (
    understanding?.intent === "admissions" ||
    /(?:สมัคร|รับสมัคร|เข้าเรียน|เรียนต่อ|เอกสาร|หลักฐาน|ใช้อะไร|ใช้ไร)/.test(
      searchText,
    )
  ) {
    [
      "สมัครเรียน",
      "รับสมัคร",
      "เอกสาร",
      "หลักฐาน",
      "ใบ ปพ",
      "สูติบัตร",
      "บัตรประชาชน",
      "ทะเบียนบ้าน",
    ].forEach((term) => terms.add(term));
  }

  if (
    understanding?.intent === "tuition" ||
    /(?:ค่าเทอม|ชำระ|จ่ายเงิน|โอนเงิน|คิวอาร์|qr|ธนาคาร)/i.test(searchText)
  ) {
    ["ค่าเทอม", "ชำระ", "ช่องทางการชำระ", "ธนาคาร", "การเงิน"].forEach((term) =>
      terms.add(term),
    );
  }

  if (
    understanding?.intent === "rules" ||
    /(?:ระเบียบ|แต่งกาย|ชุด|มาสาย|ขาดเรียน|ลาเรียน)/.test(searchText)
  ) {
    ["ระเบียบ", "แต่งกาย", "มาสาย", "ขาดเรียน", "ลาเรียน"].forEach((term) =>
      terms.add(term),
    );
  }

  if (
    understanding?.intent === "contact" ||
    /(?:ติดต่อ|เบอร์|โทร|facebook|line|แผนที่|ที่อยู่)/i.test(searchText)
  ) {
    ["ติดต่อ", "เบอร์โทร", "ที่อยู่", "Facebook", "LINE"].forEach((term) =>
      terms.add(term),
    );
  }

  return [...terms];
}

function normalizeKeywordTerm(term: string): string {
  return term.replace(/[?？!！,，.。:;'"“”‘’()[\]{}]/g, "").trim();
}

function isUsefulKeywordTerm(term: string): boolean {
  if (term.length < 2) {
    return false;
  }

  return !/^(ครับ|ค่ะ|คะ|ไหม|มั้ย|อะไร|ยังไง|อย่างไร|ขอ|ถาม|อยาก|สนใจ|คือ|และ|หรือ|ของ|ที่|ใน|มี)$/.test(
    term,
  );
}

function scoreKeywordDocument(
  document: Omit<RetrievedDocument, "similarity"> & { similarity?: number },
  terms: string[],
): number {
  const title =
    typeof document.metadata?.title === "string" ? document.metadata.title : "";
  const sourceName = document.source_name.toLowerCase();
  const content = document.content;
  let score = 0;

  for (const term of terms) {
    if (!term) {
      continue;
    }

    if (title.includes(term)) {
      score += 22;
    }

    if (content.includes(term)) {
      score += 12;
    }

    if (sourceName.includes(encodeURIComponent(term).toLowerCase())) {
      score += 8;
    }
  }

  if (sourceName.includes("/wp-content/uploads/") && !title) {
    score -= 15;
  }

  if (/history|about-psc|basic-information|blog-2|สมัคร|contact|recruitment/.test(sourceName)) {
    score += 8;
  }

  return score;
}

function mergeRetrievedDocuments(documents: RetrievedDocument[]): RetrievedDocument[] {
  const documentsById = new Map<number, RetrievedDocument>();

  for (const document of documents) {
    const existing = documentsById.get(document.id);

    if (!existing || document.similarity > existing.similarity) {
      documentsById.set(document.id, document);
    }
  }

  return [...documentsById.values()].sort((first, second) => {
    if (second.similarity !== first.similarity) {
      return second.similarity - first.similarity;
    }

    return first.id - second.id;
  });
}

async function fetchCalendarMonthDocuments(
  monthKey: string,
  config: RagConfig,
): Promise<RetrievedDocument[]> {
  const query = new URLSearchParams({
    select: "id,source_name,content,metadata",
    source_type: "eq.calendar",
    "metadata->>month_key": `eq.${monthKey}`,
    "metadata->>chunk_kind": "eq.calendar_event",
    order: "id.asc",
    limit: "200",
  });
  const response = await fetch(`${config.supabaseUrl}/rest/v1/document_chunks?${query}`, {
    headers: {
      apikey: config.supabaseServiceRoleKey,
      Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Supabase calendar month request failed: ${response.status}`);
  }

  const documents = (await response.json()) as Array<
    Omit<RetrievedDocument, "similarity"> & { similarity?: number }
  >;

  return documents
    .filter((document) => document.content.trim().length > 0)
    .map((document) => ({
      ...document,
      similarity: document.similarity ?? 1,
    }));
}

async function fetchCalendarDateDocuments(
  dateKey: string,
  config: RagConfig,
): Promise<RetrievedDocument[]> {
  const query = new URLSearchParams({
    select: "id,source_name,content,metadata",
    source_type: "eq.calendar",
    "metadata->>date_key": `eq.${dateKey}`,
    "metadata->>chunk_kind": "eq.calendar_event",
    order: "id.asc",
    limit: "100",
  });
  const response = await fetch(`${config.supabaseUrl}/rest/v1/document_chunks?${query}`, {
    headers: {
      apikey: config.supabaseServiceRoleKey,
      Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Supabase calendar date request failed: ${response.status}`);
  }

  const documents = (await response.json()) as Array<
    Omit<RetrievedDocument, "similarity"> & { similarity?: number }
  >;

  return documents
    .filter((document) => document.content.trim().length > 0)
    .map((document) => ({
      ...document,
      similarity: document.similarity ?? 1,
    }));
}

async function fetchProgramDocuments(
  question: string,
  groundedQuestion: string,
  understanding: QueryUnderstanding | null,
  config: RagConfig,
): Promise<RetrievedDocument[]> {
  const searchText = [
    question,
    groundedQuestion,
    understanding?.standaloneQuestion ?? "",
  ].join("\n");

  if (!shouldUseProgramDocumentLookup(searchText, understanding)) {
    return [];
  }

  const terms = buildProgramLookupTerms(searchText);

  if (terms.length === 0) {
    return [];
  }

  const filters = [
    "source_name.ilike.*academic*",
    ...terms.map((term) => `content.ilike.*${sanitizePostgrestPattern(term)}*`),
  ];
  const query = new URLSearchParams({
    select: "id,source_name,content,metadata",
    source_type: "eq.website",
    order: "id.asc",
    limit: "30",
  });
  query.set("or", `(${filters.join(",")})`);

  const response = await fetch(`${config.supabaseUrl}/rest/v1/document_chunks?${query}`, {
    headers: {
      apikey: config.supabaseServiceRoleKey,
      Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Supabase program documents request failed: ${response.status}`);
  }

  const documents = (await response.json()) as Array<
    Omit<RetrievedDocument, "similarity"> & { similarity?: number }
  >;

  return rankProgramDocuments(
    documents
      .filter((document) => document.content.trim().length > 0)
      .map((document) => ({
        ...document,
        similarity: document.similarity ?? 1,
      })),
    terms,
  ).slice(0, 8);
}

function toAnswerSources(documents: RetrievedDocument[]): AnswerSource[] {
  return documents.map((document) => ({
    id: document.id,
    sourceName: document.source_name,
    similarity: document.similarity,
    metadata: document.metadata,
  }));
}

function shouldUseWebAnswer(
  question: string,
  history: ConversationMessage[],
  understanding: QueryUnderstanding | null,
): boolean {
  if (hasSchoolSignal(question)) {
    return false;
  }

  if (hasRecentSchoolContext(history) && isLikelyFollowUpQuestion(question)) {
    return false;
  }

  const plannerSaysWeb =
    understanding?.shouldUseWebSearch === true &&
    understanding.schoolScope === "off_topic" &&
    understanding.confidence >= 0.6;

  return plannerSaysWeb || isClearlyGeneralQuestion(question);
}

function shouldUseSchoolWebFallback(
  question: string,
  history: ConversationMessage[],
  understanding: QueryUnderstanding | null,
): boolean {
  if (understanding?.schoolScope === "off_topic") {
    return false;
  }

  return (
    hasSchoolSignal(question) ||
    hasRecentSchoolContext(history) ||
    understanding?.schoolScope === "school" ||
    understanding?.schoolScope === "unclear"
  );
}

function hasSchoolSignal(question: string): boolean {
  return /(?:วิทยาลัย|โรงเรียน|พงษ์สวัสดิ์|pongsawadi|psc|สมัคร|ค่าเทอม|หลักสูตร|สาขา|ปวช|ปวส|นักศึกษา|นักเรียน|เอกสาร|ปฏิทิน|กิจกรรม|ระเบียบ|แต่งกาย|ทุน|กยศ|ติดต่อ|ครู|อาจารย์|ห้องเรียน|เปิดเทอม)/i.test(
    question,
  );
}

function hasRecentSchoolContext(history: ConversationMessage[]): boolean {
  return history
    .slice(-6)
    .some((message) => hasSchoolSignal(message.content));
}

function isClearlyGeneralQuestion(question: string): boolean {
  return /(?:หุ้น|ราคา|ข่าว|วันนี้.*(?:เป็นยังไง|เท่าไหร่)|พยากรณ์อากาศ|อากาศ|สูตร|ต้ม|ผัด|ทอด|อบ|ทำอาหาร|ทำยังไง|วิธีทำ|โค้ด|โปรแกรม|javascript|python|bitcoin|คริปโต|ฟุตบอล|หนัง|เพลง|แปลว่า|คืออะไร)/i.test(
    question,
  );
}

async function generateWebGroundedAnswer(
  question: string,
  history: ConversationMessage[],
  dateContext: DateContext,
  config: RagConfig,
): Promise<string> {
  return generateGoogleSearchAnswer(
    buildWebAnswerPrompt(question, history, dateContext),
    config,
    "web-grounded",
  );
}

async function generateSchoolWebGroundedAnswer(
  question: string,
  groundedQuestion: string,
  history: ConversationMessage[],
  dateContext: DateContext,
  config: RagConfig,
): Promise<string> {
  return generateGoogleSearchAnswer(
    buildSchoolWebAnswerPrompt(question, groundedQuestion, history, dateContext),
    config,
    "school-web-grounded",
  );
}

async function generateGoogleSearchAnswer(
  prompt: string,
  config: RagConfig,
  label: string,
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
                text: prompt,
              },
            ],
          },
        ],
        tools: [
          {
            google_search: {},
          },
        ],
        generationConfig: {
          temperature: 0.35,
        },
      }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new Error(`Gemini ${label} request failed: ${response.status}`);
  }

  const data = (await response.json()) as GeminiGenerateResponse;
  const text =
    data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text)
      .filter(Boolean)
      .join("\n")
      .trim() ?? "";

  return text || "ผมยังค้นเว็บแล้วไม่พบข้อมูลที่พอจะตอบได้ครับ";
}

function buildWebAnswerPrompt(
  question: string,
  history: ConversationMessage[],
  dateContext: DateContext,
): string {
  const recentHistory = history
    .slice(-MAX_HISTORY_MESSAGES)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");

  return `คุณคือแชทบอทภาษาไทยที่ตอบคำถามทั่วไปได้เหมือนผู้ช่วย Gemini ทั่วไป
คำถามนี้ถูกจัดว่าไม่เกี่ยวกับวิทยาลัยเทคโนโลยีพงษ์สวัสดิ์แล้ว จึงตอบแบบความรู้ทั่วไปโดยใช้ Google Search เมื่อจำเป็น
วันนี้ตามเวลาไทยคือ ${dateContext.todayText} (${dateContext.todayKey})

กติกา:
- ตอบภาษาไทยให้เป็นธรรมชาติ กระชับ และใช้ "ครับ"
- ถ้าคำถามต้องใช้ข้อมูลล่าสุด ให้ใช้ข้อมูลจาก Google Search ที่ค้นได้
- ถ้าข้อมูลไม่แน่ชัด ให้บอกข้อจำกัด ไม่เดา
- อย่าพยายามโยงกลับไปเรื่องวิทยาลัย เว้นแต่ผู้ใช้ถามเอง

CONVERSATION:
${recentHistory || "(none)"}

QUESTION:
${question}`;
}

function buildSchoolWebAnswerPrompt(
  question: string,
  groundedQuestion: string,
  history: ConversationMessage[],
  dateContext: DateContext,
): string {
  const recentHistory = history
    .slice(-MAX_HISTORY_MESSAGES)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
  const webSearchQuestion = buildSchoolWebSearchQuestion(question, groundedQuestion);

  return `คุณคือแชทบอทของวิทยาลัยเทคโนโลยีพงษ์สวัสดิ์ (PSC)
คำถามนี้เกี่ยวกับวิทยาลัย แต่ข้อมูลในฐานเอกสารภายในอาจไม่พอ จึงต้องใช้ Google Search เพื่อหาข้อมูลยืนยัน
วันนี้ตามเวลาไทยคือ ${dateContext.todayText} (${dateContext.todayKey})

กติกา:
- ตอบภาษาไทยแบบคุยกับนักเรียน/ผู้ปกครอง ใช้ "ครับ"
- ให้ค้นเว็บโดยยึดบริบท "วิทยาลัยเทคโนโลยีพงษ์สวัสดิ์" / "Pongsawadi Technological College" / "PSC"
- ให้ให้ความสำคัญกับเว็บทางการ www3.pongsawadi.ac.th, Facebook ทางการ, หรือแหล่งที่เกี่ยวกับ PSC โดยตรง
- ถ้าค้นเว็บแล้วมีข้อมูลยืนยันได้ ให้ตอบจากข้อมูลนั้น
- ถ้าค้นเว็บแล้วยังไม่มีแหล่งที่น่าเชื่อถือพอ ให้บอกว่า "ผมยังไม่เจอข้อมูลที่ยืนยันได้ครับ" และอย่าเดา
- อย่าตอบเรื่องโรงเรียนหรือองค์กรอื่นที่ชื่อคล้ายกัน

CONVERSATION:
${recentHistory || "(none)"}

USER_QUESTION:
${question}

SCHOOL_SEARCH_QUESTION:
${webSearchQuestion}`;
}

function buildSchoolWebSearchQuestion(
  question: string,
  groundedQuestion: string,
): string {
  const schoolName = "วิทยาลัยเทคโนโลยีพงษ์สวัสดิ์ Pongsawadi Technological College PSC";
  const searchQuestion =
    groundedQuestion.trim().length > 0 ? groundedQuestion.trim() : question.trim();

  if (hasSchoolSignal(searchQuestion)) {
    return searchQuestion;
  }

  return `${schoolName} ${searchQuestion}`;
}

async function understandQuestion(
  question: string,
  history: ConversationMessage[],
  memory: ConversationMemory,
  dateContext: DateContext,
  config: RagConfig,
): Promise<QueryUnderstanding | null> {
  try {
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
                  text: buildUnderstandingPrompt(question, history, memory, dateContext),
                },
              ],
            },
          ],
          generationConfig: {
            maxOutputTokens: 384,
            temperature: 0,
          },
        }),
        cache: "no-store",
      },
    );

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as GeminiGenerateResponse;
    const text =
      data.candidates?.[0]?.content?.parts
        ?.map((part) => part.text)
        .filter(Boolean)
        .join(" ")
        .trim() ?? "";

    return normalizeQueryUnderstanding(text, question);
  } catch {
    return null;
  }
}

function buildUnderstandingPrompt(
  question: string,
  history: ConversationMessage[],
  memory: ConversationMemory,
  dateContext: DateContext,
): string {
  const recentHistory = history
    .slice(-MAX_HISTORY_MESSAGES)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");

  return `Analyze the latest Thai user question for a school RAG chatbot.
Return JSON only. Do not answer the user.

Today in Thailand is ${dateContext.todayText} (${dateContext.todayKey}).
Use Gregorian keys in JSON: date_key as YYYY-MM-DD, month_key as YYYY-MM.

This chatbot is primarily for วิทยาลัยเทคโนโลยีพงษ์สวัสดิ์ / PSC and school-college topics.
Classify scope carefully:
- school: any question that could reasonably be about the school/college, admissions, tuition, courses, calendar, rules, documents, contact, student life, or follow-up to those topics.
- unclear: ambiguous short follow-ups where school context is possible. Prefer school over web search.
- off_topic: clearly not about the school/college in any reasonable meaning, such as general world knowledge, recipes, coding, entertainment, weather outside campus, finance, politics, or casual general questions.
- Set should_use_web_search true only for off_topic. Never use web search for school-related questions just because school documents might be missing.

Interpret ambiguous Thai naturally:
- "เมื่อ", "ที่ผ่านมา", "ที่แล้ว", "ก่อน", "รอบก่อน" usually mean the nearest past matching date/month unless conversation history says otherwise.
- "นี้", "ตอนนี้", "ปัจจุบัน", "ล่าสุด" usually mean the current or most recent relevant period.
- For short date follow-ups, "13 นี้หละ" or "วันที่ 13 นี้" means day 13 of the current Thailand month/year.
- "หน้า", "ถัดไป", "ที่จะถึง" usually mean the nearest future matching period.
- Short follow-ups such as "13 หละ", "แล้ววันที่ 4", "เดือนนั้น", "วันนั้น" must use the conversation history.
- Short date questions with a day number but no month/year, such as "วันที่ 5 มีอะไร", are ambiguous if conversation history or MEMORY does not clearly point to a calendar month. Prefer asking for the month/year instead of guessing.
- If the user writes a number followed by "พฤ" exactly, treat it as a likely typo for พ.ค. (May). If they write "พฤหัส" or "พฤหัสบดี", treat it as Thursday.
- Choose the best interpretation when context strongly points to one. Ask for clarification only if no reasonable best choice exists.
- Use MEMORY as a correction preference. If MEMORY says the user corrected a calendar year/month, apply it to later ambiguous month follow-ups unless the latest question explicitly gives another year/month.
- Short program-interest questions such as "สนใจบริหารธุรกิจ", "อยากเรียนบัญชี", or "มีสาขาการตลาดไหม" are courses intent. Rewrite them as a standalone question about relevant programs/branches.
- Create retrieval_queries for school-related questions. These are search queries for Supabase vector/keyword retrieval, not final answers. Include natural synonyms and school document terms when useful.
- Create keywords with important Thai terms and synonyms for keyword search. Do not hallucinate facts, but synonyms for searching are allowed.

Intents:
- calendar_date_events
- calendar_month_events
- admissions
- tuition
- courses
- rules
- contact
- general
- unknown

Search modes:
- metadata_date: exact calendar date lookup
- metadata_month: exact calendar month lookup
- semantic: normal RAG search

Return this JSON shape:
{
  "intent": "calendar_month_events",
  "search_mode": "metadata_month",
  "school_scope": "school",
  "should_use_web_search": false,
  "standalone_question": "เดือนมกราคม 2569 มีกิจกรรมอะไรบ้าง",
  "retrieval_queries": ["ปฏิทินกิจกรรม เดือนมกราคม 2569", "กิจกรรมวิทยาลัย มกราคม 2569"],
  "keywords": ["ปฏิทิน", "กิจกรรม", "มกราคม", "2569"],
  "source_types": ["calendar"],
  "confidence": 0.9,
  "resolved_time": {
    "type": "month",
    "month_key": "2026-01",
    "confidence": 0.9
  }
}

CONVERSATION:
${recentHistory || "(none)"}

MEMORY:
${formatConversationMemory(memory)}

LATEST_USER_QUESTION:
${question}`;
}

function normalizeQueryUnderstanding(
  text: string,
  originalQuestion: string,
): QueryUnderstanding | null {
  const parsed = parseJsonObject(text);

  if (!parsed) {
    return null;
  }

  const intent =
    typeof parsed.intent === "string" && parsed.intent.trim()
      ? parsed.intent.trim()
      : "unknown";
  const rawSearchMode =
    typeof parsed.search_mode === "string" ? parsed.search_mode : parsed.searchMode;
  const searchMode =
    rawSearchMode === "metadata_date" ||
    rawSearchMode === "metadata_month" ||
    rawSearchMode === "semantic"
      ? rawSearchMode
      : "semantic";
  const rawStandaloneQuestion =
    typeof parsed.standalone_question === "string"
      ? parsed.standalone_question
      : parsed.standaloneQuestion;
  const standaloneQuestion =
    typeof rawStandaloneQuestion === "string" && rawStandaloneQuestion.trim()
      ? rawStandaloneQuestion.trim()
      : originalQuestion;
  const rawSchoolScope =
    typeof parsed.school_scope === "string" ? parsed.school_scope : parsed.schoolScope;
  const schoolScope =
    rawSchoolScope === "school" ||
    rawSchoolScope === "off_topic" ||
    rawSchoolScope === "unclear"
      ? rawSchoolScope
      : "unclear";
  const shouldUseWebSearch =
    typeof parsed.should_use_web_search === "boolean"
      ? parsed.should_use_web_search
      : typeof parsed.shouldUseWebSearch === "boolean"
        ? parsed.shouldUseWebSearch
        : schoolScope === "off_topic";
  const retrievalQueries = readStringArray(
    parsed.retrieval_queries ?? parsed.retrievalQueries,
  );
  const keywords = readStringArray(parsed.keywords);
  const sourceTypes = readStringArray(parsed.source_types ?? parsed.sourceTypes);
  const confidence = clampConfidence(parsed.confidence);
  const resolvedTime = normalizeResolvedTime(parsed.resolved_time ?? parsed.resolvedTime);

  return {
    intent,
    searchMode,
    schoolScope,
    shouldUseWebSearch,
    standaloneQuestion,
    retrievalQueries,
    keywords,
    sourceTypes,
    confidence,
    resolvedTime,
  };
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return uniqueStrings(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function uniqueStrings(values: string[]): string[] {
  const normalizedValues = new Set<string>();
  const results: string[] = [];

  for (const value of values) {
    const normalizedValue = value.replace(/\s+/g, " ").trim().toLowerCase();

    if (!normalizedValue || normalizedValues.has(normalizedValue)) {
      continue;
    }

    normalizedValues.add(normalizedValue);
    results.push(value.replace(/\s+/g, " ").trim());
  }

  return results;
}

function formatConversationMemory(memory: ConversationMemory): string {
  const lines = [];

  if (memory.calendarYear) {
    lines.push(
      `- User's current calendar-year correction/preference: ${memory.calendarYear}`,
    );
  }

  if (memory.calendarMonthKey) {
    lines.push(
      `- User's latest corrected calendar month: ${memory.calendarMonthKey}`,
    );
  }

  for (const correction of memory.corrections?.slice(-6) ?? []) {
    lines.push(`- ${correction}`);
  }

  return lines.length > 0 ? lines.join("\n") : "(none)";
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const jsonText =
    text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]?.trim() ??
    text.match(/\{[\s\S]*\}/)?.[0]?.trim();

  if (!jsonText) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonText);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizeResolvedTime(value: unknown): QueryUnderstanding["resolvedTime"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const resolved = value as Record<string, unknown>;
  const type =
    resolved.type === "date" || resolved.type === "month" || resolved.type === "none"
      ? resolved.type
      : "none";
  const dateKey =
    typeof resolved.date_key === "string" && isValidDateKey(resolved.date_key)
      ? resolved.date_key
      : typeof resolved.dateKey === "string" && isValidDateKey(resolved.dateKey)
        ? resolved.dateKey
        : undefined;
  const monthKey =
    typeof resolved.month_key === "string" && isValidMonthKey(resolved.month_key)
      ? resolved.month_key
      : typeof resolved.monthKey === "string" && isValidMonthKey(resolved.monthKey)
        ? resolved.monthKey
        : undefined;

  return {
    type,
    dateKey,
    monthKey,
    confidence: clampConfidence(resolved.confidence),
  };
}

function clampConfidence(value: unknown): number {
  const confidence = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(confidence)) {
    return 0;
  }

  return Math.min(1, Math.max(0, confidence));
}

async function generateGroundedAnswer(
  question: string,
  groundedQuestion: string,
  dateContext: DateContext,
  documents: RetrievedDocument[],
  config: RagConfig,
  answerMode: AnswerMode = "general",
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
                text: buildPrompt(
                  question,
                  groundedQuestion,
                  dateContext,
                  documents,
                  answerMode,
                ),
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

type CalendarMonthItem = {
  summary: string;
  startDateKey: string;
  endDateKey: string;
  eventType: string;
  isSchoolActivity: boolean;
};

function buildPrompt(
  question: string,
  groundedQuestion: string,
  dateContext: DateContext,
  documents: RetrievedDocument[],
  answerMode: AnswerMode = "general",
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
  const modeRules =
    answerMode === "program"
      ? `
กติกาเฉพาะคำถามหลักสูตร/สาขา:
- ถ้าผู้ใช้ถามสั้น ๆ เช่น "สนใจ..." หรือ "อยากเรียน..." ให้ตีความว่าอยากรู้หลักสูตรหรือสาขาที่เกี่ยวข้องจาก CONTEXT
- ถ้า CONTEXT มีประเภทวิชา กลุ่มอาชีพ หรือสาขาที่สัมพันธ์กันโดยตรง ให้สรุปความสัมพันธ์นั้นได้ แต่ต้องไม่เพิ่มชื่อสาขาที่ไม่มีใน CONTEXT
- ถ้ามีทั้ง ปวช. และ ปวส. ให้ตอบแยกสั้น ๆ เมื่อข้อมูลใน CONTEXT ระบุไว้
- อย่าตอบว่าไม่พบ ถ้า CONTEXT มีคำเดียวกับคำถามหรือมีตารางหลักสูตรที่ระบุสาขาที่เกี่ยวข้องโดยตรง
- ถ้าคำถามเป็นแค่เชิงสนใจหรือถามคร่าว ๆ ให้ตอบ 2-5 บรรทัดก่อน อย่าลงรายละเอียดรายวิชาหรืออาชีพยาว ๆ เว้นแต่ผู้ใช้ถามต่อ
- โทนคำตอบให้เหมือนคุยกับนักเรียน/ผู้ปกครอง กระชับ ไม่เป็นราชการเกินไป`
      : "";

  return `คุณคือ chatbot สำหรับตอบคำถามเกี่ยวกับโรงเรียนหรือวิทยาลัย

กติกา:
- ตอบเป็นภาษาไทย กระชับ และเป็นทางการพอสำหรับสถานศึกษา
- ใช้คำลงท้าย "ครับ" ให้สม่ำเสมอ
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
${modeRules}

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

function answerRepeatedQuestion(
  question: string,
  history: ConversationMessage[],
): string | null {
  const lastUserIndex = findLastMessageIndex(history, "user");

  if (lastUserIndex === -1) {
    return null;
  }

  const lastUserMessage = history[lastUserIndex];

  if (normalizeQuestion(lastUserMessage.content) !== normalizeQuestion(question)) {
    return null;
  }

  const previousAnswer = history
    .slice(lastUserIndex + 1)
    .find((message) => message.role === "assistant")?.content;

  if (!previousAnswer || isFallbackAnswer(previousAnswer)) {
    return null;
  }

  return `คำตอบเดียวกับเมื่อกี้ครับ: ${trimRepeatedAnswer(previousAnswer)}`;
}

function findLastMessageIndex(
  history: ConversationMessage[],
  role: ConversationMessage["role"],
): number {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].role === role) {
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
  return /ยังตอบจากฐานข้อมูลไม่ได้|RAG backend|ไม่พบคำตอบ|ไม่พบข้อมูล|ไม่พบข้อมูลในเอกสาร|ไม่พบข้อมูลที่เกี่ยวข้อง|ไม่พบข้อมูลที่เพียงพอ/.test(
    answer,
  );
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

function buildCalendarMonthAnswer(
  documents: RetrievedDocument[],
  monthKey: string,
  groundedQuestion: string,
): string {
  const monthText = formatThaiMonthKey(monthKey);
  const wantsHoliday = /(?:วันหยุด|หยุด|นักขัตฤกษ์|ราชการ)/.test(groundedQuestion);
  const schoolEvents = uniqueCalendarMonthItems(
    documents.filter(
      (document) =>
        document.metadata?.is_school_activity === true ||
        document.metadata?.event_type === "school_event",
    ),
  );
  const holidays = uniqueCalendarMonthItems(
    documents.filter(
      (document) =>
        document.metadata?.is_school_activity === false &&
        document.metadata?.event_type !== "school_event",
    ),
  );
  const items = wantsHoliday ? holidays : schoolEvents;

  if (items.length === 0) {
    if (wantsHoliday) {
      return `เดือน${monthText} ผมยังไม่เจอรายการวันหยุดในปฏิทินครับ`;
    }

    if (holidays.length > 0) {
      return `เดือน${monthText} ผมยังไม่เจอกิจกรรมของวิทยาลัยในปฏิทินครับ แต่มีวันหยุด/หมายเหตุที่เจอคือ ${holidays
        .map((item) => item.summary)
        .join(", ")}`;
    }

    return `เดือน${monthText} ผมยังไม่เจอรายการกิจกรรมในปฏิทินครับ`;
  }

  const visibleItems = items.slice(0, MAX_MONTH_EVENTS_IN_ANSWER);
  const remainingCount = items.length - visibleItems.length;
  const title = wantsHoliday
    ? `เดือน${monthText} มีวันหยุดที่เจอประมาณนี้ครับ:`
    : `เดือน${monthText} มีรายการหลัก ๆ ที่เจอประมาณนี้ครับ:`;
  const itemLines = visibleItems.map(
    (item) => `- ${formatCalendarMonthItemDate(item)}: ${item.summary}`,
  );
  const remainingText =
    remainingCount > 0
      ? `\n\nยังมีอีก ${remainingCount} รายการในปฏิทิน ถ้าต้องการผมไล่ทั้งหมดให้ได้ครับ`
      : "";

  return `${title}\n${itemLines.join("\n")}${remainingText}`;
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

function uniqueCalendarMonthItems(documents: RetrievedDocument[]): CalendarMonthItem[] {
  const itemsByKey = new Map<string, CalendarMonthItem>();

  for (const document of documents) {
    const summary = readMetadataString(document.metadata, "summary")?.trim();
    const dateKey = readMetadataString(document.metadata, "date_key");

    if (!summary || !dateKey) {
      continue;
    }

    const startDateKey =
      readMetadataString(document.metadata, "start_date_key") ?? dateKey;
    const endDateKey = readMetadataString(document.metadata, "end_date_key") ?? dateKey;
    const eventType = readMetadataString(document.metadata, "event_type") ?? "";
    const isSchoolActivity =
      document.metadata?.is_school_activity === true || eventType === "school_event";
    const key = `${summary}|${startDateKey}|${endDateKey}|${eventType}`;

    if (!itemsByKey.has(key)) {
      itemsByKey.set(key, {
        summary,
        startDateKey,
        endDateKey,
        eventType,
        isSchoolActivity,
      });
    }
  }

  return [...itemsByKey.values()].sort((first, second) =>
    first.startDateKey.localeCompare(second.startDateKey),
  );
}

function readMetadataString(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" ? value : null;
}

function shouldUseProgramDocumentLookup(
  searchText: string,
  understanding: QueryUnderstanding | null,
): boolean {
  const normalizedText = searchText.replace(/\s+/g, " ");
  const hasSpecificProgramTerm =
    /(?:บริหารธุรกิจ|การบัญชี|บัญชี|การตลาด|เทคโนโลยีสารสนเทศ|เทคโนโลยีธุรกิจดิจิทัล|ธุรกิจดิจิทัล|คอมพิวเตอร์ธุรกิจ|ดิจิทัลกราฟิก|กราฟิก|ท่องเที่ยว|อาหาร|โภชนาการ|ไมซ์|อีเวนต์|แสง|เสียง)/i.test(
      normalizedText,
    );
  const looksLikeNonCourseQuestion =
    /(?:เอกสาร|หลักฐาน|ค่าเทอม|ชำระ|จ่าย|ช่องทางติดต่อ|เบอร์|โทร|แต่งกาย|กยศ|ทุน)/.test(
      normalizedText,
    ) && !hasSpecificProgramTerm;

  if (looksLikeNonCourseQuestion) {
    return false;
  }

  if (understanding?.intent === "courses") {
    return true;
  }

  const hasProgramTerm =
    hasSpecificProgramTerm || /(?:หลักสูตร|สาขา|คณะ|ปวช\.?|ปวส\.?)/i.test(normalizedText);
  const hasInterestIntent =
    /(?:สนใจ|อยากเรียน|อยากสมัคร|เรียนต่อ|ต่อสาย|เลือกเรียน|เปิดสอน|เรียนอะไร|เกี่ยวกับอะไร|แนะนำ|มี.*(?:ไหม|มั้ย|หรือเปล่า)|อยากรู้.*(?:หลักสูตร|สาขา))/i.test(
      normalizedText,
    );

  return hasProgramTerm && hasInterestIntent;
}

function isCalendarIntent(understanding: QueryUnderstanding | null): boolean {
  return (
    understanding?.intent === "calendar_date_events" ||
    understanding?.intent === "calendar_month_events" ||
    understanding?.searchMode === "metadata_date" ||
    understanding?.searchMode === "metadata_month" ||
    understanding?.sourceTypes.includes("calendar") === true
  );
}

function buildProgramLookupTerms(searchText: string): string[] {
  const terms = new Set<string>([
    "หลักสูตร",
    "จัดการเรียนการสอน",
    "ระดับประกาศนียบัตรวิชาชีพ",
    "ระดับประกาศนียบัตรวิชาชีพชั้นสูง",
  ]);

  if (/(?:บริหารธุรกิจ|ธุรกิจ|business)/i.test(searchText)) {
    [
      "บริหารธุรกิจ",
      "การบัญชี",
      "การตลาด",
      "เทคโนโลยีธุรกิจดิจิทัล",
      "เทคโนโลยีสารสนเทศทางธุรกิจ",
      "คอมพิวเตอร์ธุรกิจ",
      "ธุรกิจ",
    ].forEach((term) => terms.add(term));
  }

  if (/(?:บัญชี|account)/i.test(searchText)) {
    ["การบัญชี", "บัญชี", "นักบัญชี"].forEach((term) => terms.add(term));
  }

  if (/(?:การตลาด|ตลาด|marketing)/i.test(searchText)) {
    ["การตลาด", "การตลาดดิจิทัล", "นักการตลาด"].forEach((term) =>
      terms.add(term),
    );
  }

  if (/(?:เทคโนโลยีสารสนเทศ|ไอที|it|bit)/i.test(searchText)) {
    ["เทคโนโลยีสารสนเทศ", "เทคโนโลยีสารสนเทศทางธุรกิจ"].forEach((term) =>
      terms.add(term),
    );
  }

  if (/(?:ธุรกิจดิจิทัล|คอมพิวเตอร์ธุรกิจ|digital business)/i.test(searchText)) {
    ["เทคโนโลยีธุรกิจดิจิทัล", "ธุรกิจดิจิทัล", "คอมพิวเตอร์ธุรกิจ"].forEach(
      (term) => terms.add(term),
    );
  }

  if (/(?:กราฟิก|graphic|มัลติเดีย|มัลติมีเดีย)/i.test(searchText)) {
    ["คอมพิวเตอร์กราฟิก", "ดิจิทัลกราฟิก", "มัลติเดีย"].forEach((term) =>
      terms.add(term),
    );
  }

  if (/(?:ท่องเที่ยว|tourism)/i.test(searchText)) {
    ["การท่องเที่ยว"].forEach((term) => terms.add(term));
  }

  if (/(?:อาหาร|โภชนาการ|cookery|food)/i.test(searchText)) {
    ["อาหารและโภชนาการ"].forEach((term) => terms.add(term));
  }

  if (/(?:ไมซ์|อีเวนต์|event|mice)/i.test(searchText)) {
    ["ไมซ์และอีเวนต์", "การจัดประชุมและนิทรรศการ"].forEach((term) =>
      terms.add(term),
    );
  }

  if (/(?:แสง|เสียง|sound|light)/i.test(searchText)) {
    ["เทคโนโลยีระบบแสง", "เทคโนโลยีระบบเสียง", "อุตสาหกรรมบันเทิง"].forEach(
      (term) => terms.add(term),
    );
  }

  return [...terms]
    .map((term) => sanitizePostgrestPattern(term))
    .filter(Boolean)
    .slice(0, 16);
}

function sanitizePostgrestPattern(term: string): string {
  return term.replace(/[*,()]/g, " ").replace(/\s+/g, " ").trim();
}

function rankProgramDocuments(
  documents: RetrievedDocument[],
  terms: string[],
): RetrievedDocument[] {
  return documents
    .map((document) => ({
      document,
      score: scoreProgramDocument(document, terms),
    }))
    .filter(({ score }) => score > 0)
    .sort((first, second) => {
      if (second.score !== first.score) {
        return second.score - first.score;
      }

      return first.document.id - second.document.id;
    })
    .map(({ document }) => document);
}

function scoreProgramDocument(document: RetrievedDocument, terms: string[]): number {
  const title =
    typeof document.metadata?.title === "string" ? document.metadata.title : "";
  const sourceName = document.source_name.toLowerCase();
  const content = document.content;
  let score = 0;

  if (sourceName.includes("/academic/")) {
    score += 80;
  }

  if (/หลักสูตร|จัดการเรียนการสอน/.test(content) || title.includes("หลักสูตร")) {
    score += 30;
  }

  if (title.includes("สาขา")) {
    score += 20;
  }

  if (
    /accounting-program|digital-marketing-program|bit-program|food-cookery-program|mice-program|tourism-program/.test(
      sourceName,
    )
  ) {
    score += 20;
  }

  if (title.includes("สมัครเรียน")) {
    score -= 20;
  }

  for (const term of terms) {
    if (term && (content.includes(term) || title.includes(term))) {
      score += 18;
    }
  }

  return score;
}

function buildDirectProgramAnswer(
  question: string,
  groundedQuestion: string,
  documents: RetrievedDocument[],
): string | null {
  const searchText = `${question}\n${groundedQuestion}`;
  const contextText = documents.map((document) => document.content).join("\n");

  if (!/บริหารธุรกิจ/.test(searchText) || !contextText.includes("บริหารธุรกิจ")) {
    return null;
  }

  const branches = [
    {
      name: "การบัญชี",
      pattern: /บริหารธุรกิจ[\s\S]{0,180}การบัญชี|การบัญชี[\s\S]{0,180}บริหารธุรกิจ/,
    },
    {
      name: "การตลาด",
      pattern: /บริหารธุรกิจ[\s\S]{0,180}การตลาด|การตลาด[\s\S]{0,180}บริหารธุรกิจ/,
    },
  ]
    .filter((branch) => branch.pattern.test(contextText))
    .map((branch) => branch.name);

  if (branches.length === 0) {
    return null;
  }

  const hasVocationalLevel =
    /ระดับประกาศนียบัตรวิชาชีพ\s*\(ปวช\.?\)[\s\S]{0,700}บริหารธุรกิจ/.test(
      contextText,
    );
  const hasHighVocationalLevel =
    /ระดับประกาศนียบัตรวิชาชีพชั้นสูง\s*\(ปวส\.?\)[\s\S]{0,700}บริหารธุรกิจ/.test(
      contextText,
    );
  const levels = [
    hasVocationalLevel ? "ปวช." : null,
    hasHighVocationalLevel ? "ปวส." : null,
  ].filter(Boolean);
  const levelText =
    levels.length > 0 ? ` โดยระบุในระดับ ${levels.join(" และ ")} ครับ` : "ครับ";

  return `ถ้าสนใจสายบริหารธุรกิจ จากข้อมูลหลักสูตรที่เจอมีสาขาที่เกี่ยวข้องคือ ${formatThaiList(
    branches,
  )}${levelText}`;
}

function buildProgramGroundedQuestion(
  question: string,
  groundedQuestion: string,
): string {
  if (/(?:สนใจ|อยากเรียน|อยากสมัคร)/.test(question)) {
    return `${groundedQuestion}\nตีความคำถามนี้ว่า: ผู้ใช้สนใจหลักสูตรหรือสาขานี้ และอยากรู้ว่ามีข้อมูลหลักสูตร/สาขาที่เกี่ยวข้องอะไรบ้าง`;
  }

  return groundedQuestion;
}

function formatThaiList(items: string[]): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }

  return `${items.slice(0, -1).join(", ")} และ${items.at(-1)}`;
}

function buildSingleCalendarEventSentence(dateText: string, event: string): string {
  if (event.startsWith("เปิดภาคเรียน")) {
    return `วันที่ ${dateText} เป็นวัน${event} ครับ`;
  }

  if (event.startsWith("วัน")) {
    return `วันที่ ${dateText} เป็น${event} ครับ`;
  }

  return `วันที่ ${dateText} มีกิจกรรม/กำหนดการ: ${event} ครับ`;
}

function buildClarificationAnswer(
  question: string,
  history: ConversationMessage[],
  memory: ConversationMemory,
  dateContext: DateContext,
): string | null {
  const shortDay = extractShortDayReference(question);

  if (
    shortDay !== null &&
    isShortCalendarDateQuestion(question, history) &&
    !hasExplicitCalendarDateContext(question) &&
    !hasCurrentMonthDateCue(question) &&
    shouldAskForShortDateMonthConfirmation(question, history)
  ) {
    return `หมายถึงวันที่ ${shortDay} ของเดือนไหนครับ พิมพ์เดือน/ปีเพิ่มอีกนิดได้เลย เช่น "${shortDay} มิถุนายน 2569" หรือถ้าหมายถึงเดือนนี้ให้ตอบว่า "เดือนนี้"`;
  }

  if (
    shortDay !== null &&
    isShortCalendarDateQuestion(question, history) &&
    !hasExplicitCalendarDateContext(question) &&
    !hasCurrentMonthDateCue(question) &&
    !getCalendarBaseMonthKey(history, memory)
  ) {
    const currentMonthText = formatThaiMonthKey(dateContext.todayKey.slice(0, 7));

    return `หมายถึงวันที่ ${shortDay} ของเดือนไหนครับ ถ้าหมายถึงเดือนนี้คือ ${shortDay} ${currentMonthText} หรือพิมพ์เดือน/ปีมาได้เลย เช่น "${shortDay} มิถุนายน 2569"`;
  }

  if (
    hasAmbiguousCalendarReference(question) &&
    !findLatestDateKey(history) &&
    !findLatestMonthKey(history) &&
    !getCalendarBaseMonthKey(history, memory)
  ) {
    return "หมายถึงวันหรือเดือนช่วงไหนครับ พิมพ์วันที่/เดือนให้ชัดอีกนิดได้เลย เช่น \"5 มิถุนายน 2569\" หรือ \"เดือนมิถุนายน 2569\"";
  }

  if (isBareAmbiguousFollowUp(question) && history.length === 0) {
    return "ขอรายละเอียดเพิ่มอีกนิดครับ หมายถึงเรื่องสมัครเรียน ค่าเทอม หลักสูตร ปฏิทินกิจกรรม หรือเรื่องอื่นของวิทยาลัยครับ";
  }

  return null;
}

async function buildStandaloneQuestion(
  question: string,
  history: ConversationMessage[],
  memory: ConversationMemory,
  dateContext: DateContext,
  config: RagConfig,
): Promise<string> {
  const deterministicQuestion = buildDeterministicStandaloneQuestion(
    question,
    history,
    memory,
    dateContext,
  );

  if (deterministicQuestion) {
    return deterministicQuestion;
  }

  if (history.length === 0 || !isLikelyFollowUpQuestion(question)) {
    return question;
  }

  try {
    const rewrittenQuestion = await rewriteFollowUpQuestion(
      question,
      history,
      memory,
      dateContext,
      config,
    );

    return rewrittenQuestion || question;
  } catch {
    return question;
  }
}

function buildDeterministicStandaloneQuestion(
  question: string,
  history: ConversationMessage[],
  memory: ConversationMemory,
  dateContext: DateContext,
): string | null {
  return (
    contextualizeClarifiedDateQuestion(question, history, memory, dateContext) ??
    contextualizeRelativeDateQuestion(question, dateContext) ??
    contextualizeMonthQuestion(question, history, memory, dateContext) ??
    contextualizeDateQuestion(question, history, memory, dateContext)
  );
}

function contextualizeClarifiedDateQuestion(
  question: string,
  history: ConversationMessage[],
  memory: ConversationMemory,
  dateContext: DateContext,
): string | null {
  const pendingDay = findPendingDateClarificationDay(history);

  if (!pendingDay) {
    return null;
  }

  const normalizedQuestion = question
    .replace(/[?？!！.。]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const monthKey = /^(?:ใช่|ใช่ครับ|ใช่ค่ะ|ครับ|ค่ะ|นี้|นี่|เอาเดือนนี้|เดือนนี้|เดือนปัจจุบัน)$/.test(
    normalizedQuestion,
  )
    ? dateContext.todayKey.slice(0, 7)
    : extractTargetMonthKey(question, dateContext, history, memory);

  if (!monthKey) {
    return null;
  }

  const [year, month] = monthKey.split("-");
  const dateKey = `${year}-${month}-${String(pendingDay).padStart(2, "0")}`;

  return `วันที่ ${formatThaiDateKey(dateKey)} (${dateKey}) มีกิจกรรมอะไร`;
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

function contextualizeMonthQuestion(
  question: string,
  history: ConversationMessage[],
  memory: ConversationMemory,
  dateContext: DateContext,
): string | null {
  if (!isCalendarMonthQuestion(question) || hasDayMonthReference(question)) {
    return null;
  }

  const monthKey = extractTargetMonthKey(question, dateContext, history, memory);

  if (!monthKey) {
    return null;
  }

  return `เดือน${formatThaiMonthKey(monthKey)} (${monthKey}) มีกิจกรรมอะไรบ้าง`;
}

function contextualizeDateQuestion(
  question: string,
  history: ConversationMessage[],
  memory: ConversationMemory,
  dateContext: DateContext,
): string | null {
  if (
    extractTargetDateKeys(question).length > 0 ||
    containsThaiMonth(question) ||
    hasDayMonthReference(question)
  ) {
    const partialThaiDateKey = extractPartialThaiDateKey(question, history, dateContext);

    if (
      partialThaiDateKey &&
      (isCalendarFollowUp(question, history) ||
        isStandaloneCalendarDateQuestion(question))
    ) {
      return `วันที่ ${formatThaiDateKey(
        partialThaiDateKey,
      )} (${partialThaiDateKey}) มีกิจกรรมอะไร`;
    }

    return null;
  }

  const day = extractShortDayReference(question);

  if (
    !day ||
    !isShortCalendarDateQuestion(question, history)
  ) {
    return null;
  }

  const baseMonthKey =
    getShortDateBaseMonthKey(question, history, memory, dateContext) ??
    dateContext.todayKey.slice(0, 7);
  const [year, month] = baseMonthKey.split("-");
  const dateKey = `${year}-${month}-${String(day).padStart(2, "0")}`;

  return `วันที่ ${formatThaiDateKey(dateKey)} (${dateKey}) มีกิจกรรมอะไร`;
}

function isStandaloneCalendarDateQuestion(question: string): boolean {
  return (
    /(?:วันที่|วัน|มีอะไร|อะไร|กิจกรรม|งาน|ปฏิทิน|กำหนดการ|วันหยุด)/.test(
      question,
    ) && extractShortDayReference(question) !== null
  );
}

function isShortCalendarDateQuestion(
  question: string,
  history: ConversationMessage[],
): boolean {
  return (
    isStandaloneCalendarDateQuestion(question) ||
    isCalendarFollowUp(question, history) ||
    (extractShortDayReference(question) !== null &&
      /(?:นั้น|นั่น|หละ|ล่ะ|ละ|แล้ว)/.test(question))
  );
}

function hasExplicitCalendarDateContext(question: string): boolean {
  return (
    extractTargetDateKeys(question).length > 0 ||
    containsThaiMonth(question) ||
    hasDayMonthReference(question) ||
    /\b20\d{2}-\d{2}-\d{2}\b/.test(question)
  );
}

function hasAmbiguousCalendarReference(question: string): boolean {
  return /(?:วันนั้น|วันดังกล่าว|เดือนนั้น|เดือนดังกล่าว|ช่วงนั้น|ตอนนั้น)/.test(
    question,
  );
}

function hasCurrentMonthDateCue(question: string): boolean {
  return /(?:เดือนนี้|เดือนปัจจุบัน|เดือนล่าสุด|(?:^|\s)(?:นี้|นี่)(?:\s*(?:หละ|ล่ะ|ละ|แหละ))?(?=\s|$))/i.test(
    question,
  );
}

function isBareAmbiguousFollowUp(question: string): boolean {
  const normalizedQuestion = question
    .replace(/[?？!！.。]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (normalizedQuestion.length === 0 || normalizedQuestion.length > 24) {
    return false;
  }

  return /^(?:อะไร|ยังไง|แบบไหน|ที่ไหน|เท่าไหร่|เมื่อไหร่|ใคร|อันไหน|ไหน|แล้ว|ต่อ|หละ|ล่ะ|ละ)$/.test(
    normalizedQuestion,
  );
}

function getCalendarBaseMonthKey(
  history: ConversationMessage[],
  memory: ConversationMemory,
): string | null {
  const latestDateKey = findLatestDateKey(history);

  if (latestDateKey) {
    return latestDateKey.slice(0, 7);
  }

  const latestMonthKey = findLatestMonthKey(history);

  if (latestMonthKey) {
    return latestMonthKey;
  }

  if (memory.calendarMonthKey && isValidMonthKey(memory.calendarMonthKey)) {
    return memory.calendarMonthKey;
  }

  return null;
}

function getShortDateBaseMonthKey(
  question: string,
  history: ConversationMessage[],
  memory: ConversationMemory,
  dateContext: DateContext,
): string | null {
  if (hasCurrentMonthDateCue(question)) {
    return dateContext.todayKey.slice(0, 7);
  }

  return getCalendarBaseMonthKey(history, memory);
}

function shouldAskForShortDateMonthConfirmation(
  question: string,
  history: ConversationMessage[],
): boolean {
  if (!/(?:นั้น|นั่น|นั้นละ|นั่นละ|นั้นแหละ|นั่นแหละ|อันนั้น|ที่ว่า)/.test(question)) {
    return false;
  }

  const latestDateKey = findLatestDateKey(history);

  if (!latestDateKey) {
    return false;
  }

  const day = extractShortDayReference(question);
  const latestDay = Number(latestDateKey.slice(-2));

  return day !== null && day === latestDay;
}

function findPendingDateClarificationDay(
  history: ConversationMessage[],
): number | null {
  for (const message of history.slice(-4).reverse()) {
    if (message.role !== "assistant") {
      continue;
    }

    const match = message.content.match(/หมายถึงวันที่\s*(\d{1,2})\s*ของเดือนไหน/);

    if (!match) {
      continue;
    }

    const day = Number(match[1]);
    return day >= 1 && day <= 31 ? day : null;
  }

  return null;
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
  const hasCalendarContext = history
    .slice(-6)
    .some((message) =>
      /(?:กิจกรรม|งาน|ปฏิทิน|กำหนดการ|วันหยุด|วันที่|วันนี้|พรุ่งนี้)/.test(
        message.content,
      ),
    );

  return (
    (/(?:กิจกรรม|งาน|ปฏิทิน|กำหนดการ|วันหยุด|อะไร|หละ|ล่ะ|ละ)/.test(
      question,
    ) &&
    (isCalendarDateQuestion(question) ||
      hasCalendarContext)) ||
    (hasDateLikeReference(question) && hasCalendarContext)
  );
}

function hasDateLikeReference(question: string): boolean {
  return (
    extractTargetDateKeys(question).length > 0 ||
    containsThaiMonth(question) ||
    extractShortDayReference(question) !== null
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

function findLatestMonthKey(history: ConversationMessage[]): string | null {
  for (const message of [...history].reverse()) {
    const isoMonthMatch = message.content.match(/\b(20\d{2})-(\d{2})\b/);

    if (isoMonthMatch) {
      return `${isoMonthMatch[1]}-${isoMonthMatch[2]}`;
    }

    const explicitMonthKey = extractExplicitMonthYearKey(message.content);

    if (explicitMonthKey) {
      return explicitMonthKey;
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
  memory: ConversationMemory,
  dateContext: DateContext,
  config: RagConfig,
): Promise<string> {
  const recentHistory = history
    .slice(-MAX_HISTORY_MESSAGES)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
  const prompt = `Rewrite the latest user question into one standalone Thai question for document retrieval.
Use only the conversation history to resolve references. Do not answer the question.
If the latest question is already standalone, return it unchanged.
Today in Thailand is ${dateContext.todayText} (${dateContext.todayKey}).
Memory/corrections to respect:
${formatConversationMemory(memory)}
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

function getUnderstoodDateKey(understanding: QueryUnderstanding | null): string | null {
  const dateKey = understanding?.resolvedTime?.dateKey;
  const confidence = understanding?.resolvedTime?.confidence ?? understanding?.confidence ?? 0;

  return dateKey && confidence >= 0.5 ? dateKey : null;
}

function getUnderstoodMonthKey(understanding: QueryUnderstanding | null): string | null {
  const monthKey = understanding?.resolvedTime?.monthKey;
  const confidence = understanding?.resolvedTime?.confidence ?? understanding?.confidence ?? 0;

  return monthKey && confidence >= 0.5 ? monthKey : null;
}

function shouldUseExactCalendarDate(
  understanding: QueryUnderstanding | null,
  groundedQuestion: string,
): boolean {
  if (
    understanding?.searchMode === "metadata_date" ||
    understanding?.intent === "calendar_date_events"
  ) {
    return true;
  }

  return isCalendarDateQuestion(groundedQuestion);
}

function shouldUseExactCalendarMonth(
  understanding: QueryUnderstanding | null,
  groundedQuestion: string,
  originalQuestion: string,
  history: ConversationMessage[],
): boolean {
  if (
    understanding?.searchMode === "metadata_month" ||
    understanding?.intent === "calendar_month_events"
  ) {
    return true;
  }

  const hasCalendarContext = history
    .slice(-MAX_HISTORY_MESSAGES)
    .some((message) =>
      /(?:กิจกรรม|งาน|ปฏิทิน|กำหนดการ|วันหยุด|เดือน|วันที่)/.test(
        message.content,
      ),
    );

  return (
    isCalendarMonthQuestion(groundedQuestion) ||
    isCalendarMonthQuestion(originalQuestion) ||
    (containsThaiMonth(originalQuestion) &&
      (hasCalendarContext || /(?:หมายถึง|คือ|ไม่ใช่|ปี|20\d{2}|25\d{2})/.test(originalQuestion)))
  );
}

function isCalendarDateQuestion(question: string): boolean {
  return (
    /(?:กิจกรรม|งาน|ปฏิทิน|กำหนดการ|วันหยุด|วันนี้|พรุ่งนี้|เมื่อวาน)/.test(
      question,
    ) || isStandaloneCalendarDateQuestion(question)
  );
}

function isCalendarMonthQuestion(question: string): boolean {
  return (
    (containsThaiMonth(question) || hasRelativeMonthReference(question)) &&
    /(?:กิจกรรม|งาน|ปฏิทิน|กำหนดการ|วันหยุด|มีอะไร|อะไรบ้าง|เมื่อ|เดือน)/.test(
      question,
    )
  );
}

function extractExplicitMonthYearKey(text: string): string | null {
  const monthThenYearMatch = text.match(
    new RegExp(`(${THAI_MONTH_PATTERN})\\s*(20\\d{2}|25\\d{2})`, "i"),
  );
  const yearThenMonthMatch = text.match(
    new RegExp(`(20\\d{2}|25\\d{2})\\s*(${THAI_MONTH_PATTERN})`, "i"),
  );

  const monthText = monthThenYearMatch?.[1] ?? yearThenMonthMatch?.[2];
  const rawYearText = monthThenYearMatch?.[2] ?? yearThenMonthMatch?.[1];

  if (!monthText || !rawYearText) {
    return null;
  }

  const month = parseThaiMonth(monthText);
  const rawYear = Number(rawYearText);

  if (!month || !Number.isFinite(rawYear)) {
    return null;
  }

  const year = rawYear > 2400 ? rawYear - 543 : rawYear;
  return isValidCalendarYear(year) ? `${year}-${month}` : null;
}

function extractTargetMonthKey(
  question: string,
  dateContext: DateContext,
  history: ConversationMessage[] = [],
  memory: ConversationMemory = {},
): string | null {
  const isoMonthMatch = question.match(/\b(20\d{2})-(\d{2})\b/);

  if (isoMonthMatch) {
    return `${isoMonthMatch[1]}-${isoMonthMatch[2]}`;
  }

  const explicitMonthKey = extractExplicitMonthYearKey(question);

  if (explicitMonthKey) {
    return explicitMonthKey;
  }

  if (/(?:เดือนนั้น|เดือนดังกล่าว|ช่วงนั้น|ตอนนั้น)/.test(question)) {
    const latestDateKey = findLatestDateKey(history);
    const latestMonthKey = findLatestMonthKey(history);

    if (latestDateKey) {
      return latestDateKey.slice(0, 7);
    }

    if (latestMonthKey) {
      return latestMonthKey;
    }

    if (memory.calendarMonthKey && isValidMonthKey(memory.calendarMonthKey)) {
      return memory.calendarMonthKey;
    }
  }

  if (/(?:เดือนนี้|เดือนปัจจุบัน|เดือนล่าสุด)/.test(question)) {
    return dateContext.todayKey.slice(0, 7);
  }

  if (/(?:เดือนหน้า|เดือนถัดไป|เดือนที่จะถึง)/.test(question)) {
    return addMonths(dateContext.todayKey.slice(0, 7), 1);
  }

  if (/(?:เดือนที่แล้ว|เดือนก่อน|เดือนที่ผ่านมา)/.test(question)) {
    return addMonths(dateContext.todayKey.slice(0, 7), -1);
  }

  const monthMatch = question.match(new RegExp(`(${THAI_MONTH_PATTERN})`, "i"));

  if (!monthMatch) {
    return null;
  }

  const month = parseThaiMonth(monthMatch[1]);

  if (!month) {
    return null;
  }

  const [todayYear, todayMonth] = dateContext.todayKey.split("-").map(Number);
  const targetMonth = Number(month);
  let year = todayYear;

  if (/(?:ปีหน้า|เดือนหน้า|ถัดไป|หน้า)/.test(question)) {
    year = targetMonth >= todayMonth ? todayYear : todayYear + 1;
  } else if (/(?:ปีที่แล้ว|ปีก่อน)/.test(question)) {
    year = todayYear - 1;
  } else if (/(?:เมื่อ|ที่ผ่านมา|ที่แล้ว|ก่อน)/.test(question)) {
    year = targetMonth <= todayMonth ? todayYear : todayYear - 1;
  } else if (memory.calendarYear && isValidCalendarYear(memory.calendarYear)) {
    year = memory.calendarYear;
  }

  return `${year}-${month}`;
}

function hasRelativeMonthReference(question: string): boolean {
  return /(?:เดือนนี้|เดือนหน้า|เดือนถัดไป|เดือนที่จะถึง|เดือนที่แล้ว|เดือนก่อน|เดือนที่ผ่านมา|เดือนนั้น|เดือนดังกล่าว|เดือนล่าสุด|เดือนปัจจุบัน|ช่วงนั้น|ตอนนั้น)/.test(
    question,
  );
}

function hasDayMonthReference(question: string): boolean {
  return new RegExp(`\\d{1,2}\\s*(${THAI_DATE_MONTH_PATTERN})`, "i").test(question);
}

function extractTargetDateKeys(question: string): string[] {
  const dateKeys = new Set<string>();

  for (const match of question.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) {
    dateKeys.add(`${match[1]}-${match[2]}-${match[3]}`);
  }

  for (const match of question.matchAll(
    new RegExp(`(\\d{1,2})\\s*(${THAI_DATE_MONTH_PATTERN})\\s*(\\d{4})`, "gi"),
  )) {
    const day = match[1].padStart(2, "0");
    const month = parseThaiMonth(match[2]);
    const rawYear = Number(match[3]);
    const year = rawYear > 2400 ? rawYear - 543 : rawYear;

    if (month) {
      dateKeys.add(`${year}-${month}-${day}`);
    }
  }

  return [...dateKeys];
}

function isValidDateKey(dateKey: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return false;
  }

  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isValidMonthKey(monthKey: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    return false;
  }

  const [year, month] = monthKey.split("-").map(Number);
  return isValidCalendarYear(year) && month >= 1 && month <= 12;
}

function isValidCalendarYear(year: number): boolean {
  return Number.isInteger(year) && year >= 2000 && year <= 2600;
}

function containsThaiMonth(question: string): boolean {
  return THAI_MONTH_REGEX.test(question);
}

function extractPartialThaiDateKey(
  question: string,
  history: ConversationMessage[],
  dateContext: DateContext,
): string | null {
  const match = question.match(
    new RegExp(`(\\d{1,2})\\s*(${THAI_DATE_MONTH_PATTERN})(?!\\s*\\d{4})`, "i"),
  );

  if (!match) {
    return null;
  }

  const baseDateKey = findLatestDateKey(history) ?? dateContext.todayKey;
  const [year] = baseDateKey.split("-");
  const day = match[1].padStart(2, "0");
  const month = parseThaiMonth(match[2]);

  return month ? `${year}-${month}-${day}` : null;
}

function parseThaiMonth(monthText: string): string | null {
  const normalizedMonth = monthText.replace(/\./g, "").trim().toLowerCase();

  if (normalizedMonth in THAI_MONTHS) {
    return THAI_MONTHS[normalizedMonth];
  }

  const shortMonths: Record<string, string> = {
    มค: "01",
    มกรา: "01",
    กพ: "02",
    กุมภา: "02",
    มีค: "03",
    มีนา: "03",
    เมย: "04",
    เมษา: "04",
    พค: "05",
    พฤษภา: "05",
    พฤ: "05",
    มิย: "06",
    มิถุนา: "06",
    กค: "07",
    กรกฎา: "07",
    สค: "08",
    สิงหา: "08",
    กย: "09",
    กันยา: "09",
    ตค: "10",
    ตุลา: "10",
    พย: "11",
    พฤศจิกา: "11",
    ธค: "12",
    ธันวา: "12",
  };

  return shortMonths[normalizedMonth] ?? null;
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

function formatThaiMonthKey(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, 1, 12));

  return date.toLocaleDateString("th-TH", {
    year: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

function formatCalendarMonthItemDate(item: CalendarMonthItem): string {
  if (item.startDateKey === item.endDateKey) {
    return formatThaiDateKey(item.startDateKey);
  }

  const [startYear, startMonth, startDay] = item.startDateKey.split("-").map(Number);
  const [endYear, endMonth, endDay] = item.endDateKey.split("-").map(Number);

  if (startYear === endYear && startMonth === endMonth) {
    const monthText = new Date(Date.UTC(startYear, startMonth - 1, 1, 12)).toLocaleDateString(
      "th-TH",
      {
        year: "numeric",
        month: "long",
        timeZone: "UTC",
      },
    );

    return `${startDay}-${endDay} ${monthText}`;
  }

  return `${formatThaiDateKey(item.startDateKey)} - ${formatThaiDateKey(
    item.endDateKey,
  )}`;
}

function addDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12));

  return date.toISOString().slice(0, 10);
}

function addMonths(monthKey: string, months: number): string {
  const [year, month] = monthKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + months, 1, 12));

  return date.toISOString().slice(0, 7);
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
