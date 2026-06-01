import { promises as fs } from "node:fs";
import path from "node:path";

import {
  chunkText,
  collectTextFiles,
  getArgValue,
  getIngestConfig,
  hasArg,
  ingestChunks,
  loadLocalEnv,
  projectPath,
} from "./lib/demo-ingest.mjs";

await loadLocalEnv();

const config = getIngestConfig();
const sourceDirectory = path.resolve(
  getArgValue("--dir", projectPath("data", "sources")),
);
const append = hasArg("--append");
const dryRun = hasArg("--dry-run");

await fs.mkdir(sourceDirectory, { recursive: true });

const files = await collectTextFiles(sourceDirectory);

if (files.length === 0) {
  console.log(`No .md or .txt files found in ${sourceDirectory}`);
  console.log("Copy data/sources/facebook-latest.example.md to a real file first.");
  process.exit(0);
}

for (const filePath of files) {
  const content = await fs.readFile(filePath, "utf8");
  const relativePath = path.relative(sourceDirectory, filePath).replaceAll("\\", "/");
  const chunks = chunkText(content, {
    chunkSize: config.chunkSize,
    chunkOverlap: config.chunkOverlap,
  });

  console.log(`${dryRun ? "Checking" : "Ingesting"} ${relativePath}: ${chunks.length} chunks`);

  const result = await ingestChunks({
    config,
    sourceName: relativePath,
    sourceType: path.extname(filePath).slice(1) || "text",
    chunks,
    metadata: {
      file_path: relativePath,
    },
    append,
    dryRun,
  });

  if (!result.dryRun) {
    console.log(`Inserted ${result.inserted} chunks from ${relativePath}`);
  }
}
