import { promises as fs } from "node:fs";
import path from "node:path";

export function projectPath(...segments) {
  return path.join(process.cwd(), ...segments);
}

export async function loadLocalEnv() {
  for (const fileName of [".env.local", ".env"]) {
    const filePath = projectPath(fileName);

    try {
      const content = await fs.readFile(filePath, "utf8");
      parseEnvFile(content);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

export function getIngestConfig() {
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
    throw new Error(`Missing env: ${missingEnv.join(", ")}`);
  }

  return {
    geminiApiKey,
    embeddingModel: process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001",
    embeddingDimensions: readNumberEnv("GEMINI_EMBEDDING_DIMENSIONS", 768),
    supabaseUrl: supabaseUrl.replace(/\/$/, ""),
    supabaseServiceRoleKey,
    chunkSize: readNumberEnv("INGEST_CHUNK_SIZE", 1800),
    chunkOverlap: readNumberEnv("INGEST_CHUNK_OVERLAP", 250),
  };
}

export function chunkText(text, options = {}) {
  const chunkSize = options.chunkSize ?? 1800;
  const overlap = options.chunkOverlap ?? 250;
  const normalized = normalizeText(text);
  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const chunks = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (paragraph.length > chunkSize) {
      if (current) {
        chunks.push(current.trim());
        current = "";
      }

      chunks.push(...splitLongText(paragraph, chunkSize, overlap));
      continue;
    }

    const next = current ? `${current}\n\n${paragraph}` : paragraph;

    if (next.length > chunkSize && current) {
      chunks.push(current.trim());
      const prefix = tailText(current, overlap);
      current = prefix ? `${prefix}\n\n${paragraph}` : paragraph;
    } else {
      current = next;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks.filter((chunk) => chunk.length >= 80);
}

export async function ingestChunks({
  config,
  sourceName,
  sourceType,
  chunks,
  metadata = {},
  append = false,
  dryRun = false,
}) {
  if (chunks.length === 0) {
    return { inserted: 0, skipped: true };
  }

  if (dryRun) {
    return { inserted: 0, skipped: false, dryRun: true };
  }

  if (!append) {
    await deleteSource(config, sourceName);
  }

  const rows = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = normalizeChunk(chunks[index]);
    const content = chunk.content;
    const embedding = await createEmbedding(content, config);

    rows.push({
      source_name: sourceName,
      source_type: sourceType,
      content,
      metadata: {
        ...metadata,
        ...chunk.metadata,
        chunk_index: index,
        chunk_count: chunks.length,
        ingested_at: new Date().toISOString(),
      },
      embedding,
    });

    await sleep(120);
  }

  await insertRows(config, rows);
  return { inserted: rows.length, skipped: false };
}

function normalizeChunk(chunk) {
  if (typeof chunk === "string") {
    return {
      content: chunk,
      metadata: {},
    };
  }

  if (chunk && typeof chunk.content === "string") {
    return {
      content: chunk.content,
      metadata: chunk.metadata ?? {},
    };
  }

  throw new Error("Invalid ingest chunk: expected string or { content, metadata }");
}

export async function collectTextFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectTextFiles(fullPath)));
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();

    if (
      [".md", ".txt"].includes(extension) &&
      !entry.name.endsWith(".example.md") &&
      entry.name !== ".gitkeep"
    ) {
      files.push(fullPath);
    }
  }

  return files;
}

export function getArgValue(name, fallback = undefined) {
  const prefix = `${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

export function hasArg(name) {
  return process.argv.includes(name);
}

export function normalizeText(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ \u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseEnvFile(content) {
  for (const line of content.split(/\r?\n/)) {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    let value = trimmedLine.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function readNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function splitLongText(text, chunkSize, overlap) {
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end).trim());

    if (end >= text.length) {
      break;
    }

    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}

function tailText(text, maxLength) {
  const normalized = text.trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return normalized.slice(-maxLength).replace(/^[^\s]+/, "").trim();
}

async function createEmbedding(text, config) {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${config.embeddingModel}:embedContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": config.geminiApiKey,
        },
        body: JSON.stringify({
          content: {
            parts: [{ text }],
          },
          taskType: "RETRIEVAL_DOCUMENT",
          output_dimensionality: config.embeddingDimensions,
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text();

      if (attempt < maxAttempts && isRetryableGeminiStatus(response.status)) {
        await sleep(1000 * attempt ** 2);
        continue;
      }

      throw new Error(`Gemini embedding failed ${response.status}: ${body}`);
    }

    const data = await response.json();
    const values = data.embedding?.values;

    if (!Array.isArray(values) || values.length !== config.embeddingDimensions) {
      throw new Error("Gemini embedding dimension did not match the Supabase schema");
    }

    return values;
  }

  throw new Error("Gemini embedding failed after retries");
}

function isRetryableGeminiStatus(status) {
  return [429, 500, 502, 503, 504].includes(status);
}

export async function deleteSource(config, sourceName) {
  const response = await fetch(
    `${config.supabaseUrl}/rest/v1/document_chunks?source_name=eq.${encodeURIComponent(
      sourceName,
    )}`,
    {
      method: "DELETE",
      headers: supabaseHeaders(config),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase delete failed ${response.status}: ${body}`);
  }
}

async function insertRows(config, rows) {
  const response = await fetch(`${config.supabaseUrl}/rest/v1/document_chunks`, {
    method: "POST",
    headers: {
      ...supabaseHeaders(config),
      Prefer: "return=minimal",
    },
    body: JSON.stringify(rows),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase insert failed ${response.status}: ${body}`);
  }
}

function supabaseHeaders(config) {
  return {
    "Content-Type": "application/json",
    apikey: config.supabaseServiceRoleKey,
    Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
