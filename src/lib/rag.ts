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

export class RagConfigurationError extends Error {
  constructor(public readonly missingEnv: string[]) {
    super(`Missing required environment variables: ${missingEnv.join(", ")}`);
    this.name = "RagConfigurationError";
  }
}

export async function answerQuestion(question: string): Promise<RagAnswer> {
  const config = getRagConfig();
  const queryEmbedding = await createQueryEmbedding(question, config);
  const documents = await matchDocuments(queryEmbedding, config);

  if (documents.length === 0) {
    return {
      answer: "ไม่พบข้อมูลที่เกี่ยวข้องในเอกสารของโรงเรียน/วิทยาลัย",
      sources: [],
    };
  }

  const answer = await generateGroundedAnswer(question, documents, config);

  return {
    answer,
    sources: documents.map((document) => ({
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
                text: buildPrompt(question, documents),
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

function buildPrompt(question: string, documents: RetrievedDocument[]): string {
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
- ถ้า CONTEXT ไม่มีคำตอบ ให้ตอบว่า "ไม่พบข้อมูลในเอกสารที่มี"
- ห้ามเดาข้อมูล เช่น ค่าเทอม วันที่ ช่องทางติดต่อ หรือระเบียบ
- ถ้าใช้ข้อมูลจากหลายแหล่ง ให้ใส่อ้างอิงท้ายประโยคด้วยเลข [1], [2]

QUESTION:
${question}

CONTEXT:
${context}`;
}

function readNumberEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const numberValue = Number(rawValue);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}
