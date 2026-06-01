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
const generationModel = process.env.GEMINI_GENERATION_MODEL || "gemini-3.5-flash";
const baseUrl = getArgValue(
  "--base-url",
  "https://www3.pongsawadi.ac.th/psc2023",
).replace(/\/$/, "");
const cacheDirectory = path.resolve(
  getArgValue("--cache-dir", projectPath("data", "sources", "wordpress")),
);
const selectedTypes = getArgValue("--types", "pages,posts")
  .split(",")
  .map((type) => type.trim())
  .filter(Boolean);
const append = hasArg("--append");
const dryRun = hasArg("--dry-run");
const ocrImages = !hasArg("--no-ocr");
const limit = Number(getArgValue("--limit", "0"));
const offset = Number(getArgValue("--offset", "0"));
const maxOcrImagesPerItem = Number(getArgValue("--ocr-per-item", "2"));
const ocrIfTextUnder = Number(getArgValue("--ocr-if-text-under", "160"));

await fs.mkdir(cacheDirectory, { recursive: true });

const items = [];

for (const type of selectedTypes) {
  if (type !== "pages" && type !== "posts") {
    throw new Error(`Unsupported WordPress type "${type}". Use pages, posts, or both.`);
  }

  items.push(...(await fetchWordPressItems(type)));
}

const selectedItems =
  limit > 0 ? items.slice(offset, offset + limit) : items.slice(offset);

console.log(
  `${dryRun ? "Checking" : "Ingesting"} ${selectedItems.length} WordPress items from ${baseUrl} (offset ${offset})`,
);

for (const item of selectedItems) {
  const title = decodeHtml(item.title?.rendered || item.slug || item.link);
  const sourceUrl = normalizeUrl(item.link);
  const renderedContent = item.content?.rendered || "";
  const renderedExcerpt = item.excerpt?.rendered || "";
  const html = `${renderedContent}\n${renderedExcerpt}`;
  const text = extractReadableText(html);
  const links = extractLinks(html, sourceUrl);
  const images = extractImages(html, sourceUrl);
  const htmlImages =
    ocrImages && text.length < ocrIfTextUnder
      ? await fetchPageImages(sourceUrl)
      : [];
  const imageCandidates = rankImageCandidates([...images, ...htmlImages]);
  const ocrResults =
    ocrImages && text.length < ocrIfTextUnder
      ? await ocrImageCandidates(imageCandidates, maxOcrImagesPerItem)
      : [];
  const markdown = buildMarkdown({
    item,
    title,
    sourceUrl,
    text,
    links,
    images: imageCandidates,
    ocrResults,
  });
  const chunks = chunkText(markdown, {
    chunkSize: config.chunkSize,
    chunkOverlap: config.chunkOverlap,
  });
  const cachePath = path.join(cacheDirectory, `${slugify(sourceUrl)}.md`);

  await fs.writeFile(cachePath, markdown, "utf8");
  console.log(
    `${dryRun ? "Checked" : "Cached"} ${title} (${chunks.length} chunks, ${ocrResults.length} OCR images)`,
  );

  const result = await ingestChunks({
    config,
    sourceName: sourceUrl,
    sourceType: "website",
    chunks,
    metadata: {
      source_url: sourceUrl,
      title,
      wp_id: item.id,
      wp_type: item.type,
      wp_slug: item.slug,
      wp_date: item.date,
      wp_modified: item.modified,
      cache_path: path.relative(process.cwd(), cachePath).replaceAll("\\", "/"),
      ocr_image_count: ocrResults.length,
    },
    append,
    dryRun,
  });

  if (!result.dryRun) {
    console.log(`Inserted ${result.inserted} chunks from ${sourceUrl}`);
  }
}

async function fetchWordPressItems(type) {
  const endpointType = type === "pages" ? "pages" : "posts";
  const results = [];
  let page = 1;

  while (true) {
    const query = new URLSearchParams({
      per_page: "100",
      page: String(page),
      _fields:
        "id,link,slug,title,content,excerpt,modified,date,status,type,categories,tags",
    });
    const url = `${baseUrl}/wp-json/wp/v2/${endpointType}?${query}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "SchoolRagDemoBot/1.0",
      },
    });

    if (response.status === 400 && page > 1) {
      break;
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch WordPress ${type} page ${page}: ${response.status}`);
    }

    const items = await response.json();
    results.push(...items.filter((item) => item.status === "publish"));

    const totalPages = Number(response.headers.get("x-wp-totalpages") || "1");

    if (page >= totalPages) {
      break;
    }

    page += 1;
  }

  return results;
}

function extractReadableText(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, canvas, iframe, form").remove();
  return normalizeText($.root().text());
}

function extractLinks(html, sourceUrl) {
  const $ = cheerio.load(html);
  const links = [];

  $("a[href]").each((_, element) => {
    const href = normalizeUrl($(element).attr("href") || "", sourceUrl);
    const label = normalizeText($(element).text());

    if (!href || href.startsWith("mailto:") || href.startsWith("tel:")) {
      return;
    }

    links.push({
      href,
      label,
    });
  });

  return uniqueBy(links, (link) => link.href).slice(0, 40);
}

function extractImages(html, sourceUrl) {
  const $ = cheerio.load(html);
  const images = [];

  $("img[src]").each((_, element) => {
    const src = normalizeUrl($(element).attr("src") || "", sourceUrl);
    const alt = normalizeText($(element).attr("alt") || "");
    const width = Number($(element).attr("width") || "0");
    const height = Number($(element).attr("height") || "0");

    if (!src) {
      return;
    }

    images.push({
      src,
      alt,
      width,
      height,
    });
  });

  return images;
}

async function fetchPageImages(sourceUrl) {
  try {
    const response = await fetch(sourceUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SchoolRagDemoBot/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    if (!response.ok) {
      return [];
    }

    const html = await response.text();
    return extractImages(html, sourceUrl);
  } catch {
    return [];
  }
}

function rankImageCandidates(images) {
  return uniqueBy(images, (image) => image.src)
    .filter((image) => {
      const area = image.width * image.height;
      const looksLikeLogo = /logo|psc150|ตรา-?logo/i.test(image.src);

      if (looksLikeLogo && area < 400000) {
        return false;
      }

      return area === 0 || area >= 250000 || image.alt.length > 20;
    })
    .sort((first, second) => {
      const secondArea = second.width * second.height;
      const firstArea = first.width * first.height;
      return secondArea - firstArea;
    });
}

async function ocrImageCandidates(images, maxImages) {
  const results = [];

  for (const image of images.slice(0, maxImages)) {
    try {
      const text = await ocrImage(image);

      if (text.length >= 40) {
        results.push({
          ...image,
          text,
        });
      }
    } catch (error) {
      console.warn(`OCR skipped ${image.src}: ${error.message}`);
    }

    await sleep(400);
  }

  return results;
}

async function ocrImage(image) {
  const response = await fetch(image.src, {
    headers: {
      "User-Agent": "SchoolRagDemoBot/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`image download failed ${response.status}`);
  }

  const mimeType = readImageMimeType(response.headers.get("content-type"), image.src);
  const imageData = Buffer.from(await response.arrayBuffer()).toString("base64");
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              "ถอดข้อความภาษาไทยและอังกฤษทั้งหมดจากรูปนี้อย่างละเอียด สำหรับนำไปทำ RAG ของวิทยาลัย ตอบเป็นข้อความล้วน รักษาชื่อบุคคล วันที่ ปี และหัวข้อให้ครบ ถ้าไม่มีข้อความให้ออกคำว่า NO_TEXT",
          },
          {
            inline_data: {
              mime_type: mimeType,
              data: imageData,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 4096,
    },
  };

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const ocrResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${generationModel}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": config.geminiApiKey,
        },
        body: JSON.stringify(body),
      },
    );

    if (!ocrResponse.ok) {
      if (attempt < 4 && [429, 500, 502, 503, 504].includes(ocrResponse.status)) {
        await sleep(1000 * attempt ** 2);
        continue;
      }

      throw new Error(`Gemini OCR failed ${ocrResponse.status}: ${await ocrResponse.text()}`);
    }

    const data = await ocrResponse.json();
    const text = normalizeText(
      data.candidates?.[0]?.content?.parts
        ?.map((part) => part.text)
        .filter(Boolean)
        .join("\n") || "",
    );

    return text === "NO_TEXT" ? "" : text;
  }

  return "";
}

function buildMarkdown({ item, title, sourceUrl, text, links, images, ocrResults }) {
  const linkText =
    links.length > 0
      ? `\n\n## Links found on source\n${links
          .map((link) => `- ${link.label ? `${link.label}: ` : ""}${link.href}`)
          .join("\n")}`
      : "";
  const imageAltText =
    images.filter((image) => image.alt).length > 0
      ? `\n\n## Image alt text\n${images
          .filter((image) => image.alt)
          .map((image) => `- ${image.alt}: ${image.src}`)
          .join("\n")}`
      : "";
  const ocrText =
    ocrResults.length > 0
      ? `\n\n## OCR text from source images\n${ocrResults
          .map((image, index) => `### Image ${index + 1}: ${image.src}\n${image.text}`)
          .join("\n\n")}`
      : "";

  return `# ${title}

Source: ${sourceUrl}
WordPress type: ${item.type}
WordPress id: ${item.id}
Published: ${item.date || ""}
Modified: ${item.modified || ""}
Scraped at: ${new Date().toISOString()}

${text}
${linkText}
${imageAltText}
${ocrText}
`;
}

function decodeHtml(value) {
  return normalizeText(cheerio.load(value).root().text() || value);
}

function normalizeUrl(value, base = baseUrl) {
  if (!value) {
    return "";
  }

  try {
    return new URL(value, base).toString();
  } catch {
    return "";
  }
}

function readImageMimeType(contentType, url) {
  if (contentType?.startsWith("image/")) {
    return contentType.split(";")[0];
  }

  if (/\.png(?:\?|$)/i.test(url)) {
    return "image/png";
  }

  if (/\.webp(?:\?|$)/i.test(url)) {
    return "image/webp";
  }

  return "image/jpeg";
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const results = [];

  for (const item of items) {
    const key = keyFn(item);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push(item);
  }

  return results;
}

function slugify(value) {
  return value
    .replace(/^https?:\/\//i, "")
    .replace(/[^a-zA-Z0-9ก-๙]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
