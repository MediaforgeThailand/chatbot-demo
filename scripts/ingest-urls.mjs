import { promises as fs } from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";

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
const urlFilePath = path.resolve(getArgValue("--file", projectPath("data", "urls.txt")));
const cacheDirectory = path.resolve(
  getArgValue("--cache-dir", projectPath("data", "sources", "scraped")),
);
const append = hasArg("--append");
const dryRun = hasArg("--dry-run");
const limit = Number(getArgValue("--limit", "0"));

const urls = await readUrls(urlFilePath);
const selectedUrls = limit > 0 ? urls.slice(0, limit) : urls;

if (selectedUrls.length === 0) {
  console.log(`No URLs found in ${urlFilePath}`);
  console.log("Copy data/urls.example.txt to data/urls.txt and add school pages first.");
  process.exit(0);
}

await fs.mkdir(cacheDirectory, { recursive: true });

for (const url of selectedUrls) {
  console.log(`${dryRun ? "Checking" : "Scraping"} ${url}`);

  const scraped = await scrapeUrl(url);
  const chunks = chunkText(scraped.markdown, {
    chunkSize: config.chunkSize,
    chunkOverlap: config.chunkOverlap,
  });
  const cachePath = path.join(cacheDirectory, `${slugify(url)}.md`);

  await fs.writeFile(cachePath, scraped.markdown, "utf8");
  console.log(`Cached ${path.relative(process.cwd(), cachePath)} (${chunks.length} chunks)`);

  const result = await ingestChunks({
    config,
    sourceName: url,
    sourceType: "website",
    chunks,
    metadata: {
      source_url: url,
      title: scraped.title,
      scraped_at: scraped.scrapedAt,
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
      .filter((line) => /^https?:\/\//i.test(line));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function scrapeUrl(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; SchoolRagDemoBot/1.0; +https://github.com/infoMedia11/chatbot-demo)",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  $(
    "script, style, noscript, svg, canvas, iframe, form, nav, header, footer, aside",
  ).remove();

  const title = normalizeText(
    $("title").first().text() || $("h1").first().text() || url,
  );
  const mainText = normalizeText(
    $("main").text() || $("article").text() || $("body").text(),
  );
  const scrapedAt = new Date().toISOString();
  const markdown = `# ${title}

Source: ${url}
Scraped at: ${scrapedAt}

${mainText}
`;

  return {
    title,
    scrapedAt,
    markdown,
  };
}

function slugify(value) {
  return value
    .replace(/^https?:\/\//i, "")
    .replace(/[^a-zA-Z0-9ก-๙]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .toLowerCase();
}
