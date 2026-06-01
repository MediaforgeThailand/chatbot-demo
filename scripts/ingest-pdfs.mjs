import { promises as fs } from "node:fs";
import path from "node:path";
import { PDFParse } from "pdf-parse";

import {
  chunkText,
  getArgValue,
  getIngestConfig,
  hasArg,
  ingestChunks,
  loadLocalEnv,
  normalizeText,
  projectPath,
} from "./lib/demo-ingest.mjs";

await loadLocalEnv();

const config = getIngestConfig();
const pdfUrlFilePath = path.resolve(
  getArgValue("--file", projectPath("data", "pdf-urls.txt")),
);
const cacheDirectory = path.resolve(
  getArgValue("--cache-dir", projectPath("data", "sources", "pdfs")),
);
const append = hasArg("--append");
const dryRun = hasArg("--dry-run");
const urls = await readUrls(pdfUrlFilePath);

if (urls.length === 0) {
  console.log(`No PDF URLs found in ${pdfUrlFilePath}`);
  console.log("Copy data/pdf-urls.example.txt to data/pdf-urls.txt first.");
  process.exit(0);
}

await fs.mkdir(cacheDirectory, { recursive: true });

for (const url of urls) {
  console.log(`${dryRun ? "Checking" : "Downloading"} ${url}`);

  const pdfText = await readPdfText(url);
  const markdown = `# PDF source

Source: ${url}
Scraped at: ${new Date().toISOString()}

${pdfText}
`;
  const chunks = chunkText(markdown, {
    chunkSize: config.chunkSize,
    chunkOverlap: config.chunkOverlap,
  });
  const cachePath = path.join(cacheDirectory, `${slugify(url)}.md`);

  await fs.writeFile(cachePath, markdown, "utf8");
  console.log(`Cached ${path.relative(process.cwd(), cachePath)} (${chunks.length} chunks)`);

  const result = await ingestChunks({
    config,
    sourceName: url,
    sourceType: "pdf",
    chunks,
    metadata: {
      source_url: url,
      cache_path: path.relative(process.cwd(), cachePath).replaceAll("\\", "/"),
    },
    append,
    dryRun,
  });

  if (!result.dryRun) {
    console.log(`Inserted ${result.inserted} chunks from ${url}`);
  }
}

async function readUrls(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");

    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split(/\s+/)[0])
      .filter((line) => /^https?:\/\/.+\.pdf(\?.*)?$/i.test(line));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function readPdfText(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }

  const parser = new PDFParse({
    data: Buffer.from(await response.arrayBuffer()),
  });

  try {
    const result = await parser.getText();
    return normalizeText(result.text);
  } finally {
    await parser.destroy();
  }
}

function slugify(value) {
  return value
    .replace(/^https?:\/\//i, "")
    .replace(/[^a-zA-Z0-9ก-๙]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .toLowerCase();
}
