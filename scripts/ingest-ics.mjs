import { promises as fs } from "node:fs";
import path from "node:path";

import {
  deleteSource,
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
const icsUrlFilePath = path.resolve(
  getArgValue("--file", projectPath("data", "ics-urls.txt")),
);
const cacheDirectory = path.resolve(
  getArgValue("--cache-dir", projectPath("data", "sources", "calendars")),
);
const append = hasArg("--append");
const dryRun = hasArg("--dry-run");
const fromDateKey = parseDateArg(getArgValue("--from", `${new Date().getFullYear()}-01-01`));
const urls = await readUrls(icsUrlFilePath);

if (urls.length === 0) {
  console.log(`No ICS URLs found in ${icsUrlFilePath}`);
  console.log("Copy data/ics-urls.example.txt to data/ics-urls.txt first.");
  process.exit(0);
}

await fs.mkdir(cacheDirectory, { recursive: true });

for (const url of urls) {
  console.log(`${dryRun ? "Checking" : "Downloading"} ${url}`);

  const calendarText = await fetchIcs(url);
  const calendarInfo = parseCalendarInfo(calendarText, url);
  const events = parseIcsEvents(calendarText)
    .map((event) => classifyCalendarEvent(event, calendarInfo))
    .filter((event) => event.startDateKey >= fromDateKey)
    .sort((first, second) => first.startDateKey.localeCompare(second.startDateKey));

  if (events.length === 0) {
    if (!append && !dryRun) {
      await deleteSource(config, url);
    }

    console.log(`Skipped ${url}: no events from ${formatDateKey(fromDateKey)}`);
    continue;
  }

  const markdown = buildMarkdown(url, events, fromDateKey, calendarInfo);
  const chunks = buildCalendarChunks(url, events, fromDateKey, calendarInfo);
  const cachePath = path.join(cacheDirectory, `${slugify(url)}.md`);

  await fs.writeFile(cachePath, markdown, "utf8");
  console.log(
    `Cached ${path.relative(process.cwd(), cachePath)} (${events.length} events, ${chunks.length} chunks)`,
  );

  const result = await ingestChunks({
    config,
    sourceName: url,
    sourceType: "calendar",
    chunks,
    metadata: {
      source_url: url,
      cache_path: path.relative(process.cwd(), cachePath).replaceAll("\\", "/"),
      from_date: formatDateKey(fromDateKey),
      event_count: events.length,
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
      .filter((line) => /^https?:\/\/.+\.ics(\?.*)?$/i.test(line));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function fetchIcs(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }

  return response.text();
}

function parseCalendarInfo(icsText, url) {
  const unfoldedLines = unfoldIcsLines(icsText);
  const info = {
    url,
    name: "",
    description: "",
  };

  for (const line of unfoldedLines) {
    const property = parseIcsProperty(line);

    if (!property) {
      continue;
    }

    if (property.key === "X-WR-CALNAME") {
      info.name = decodeIcsText(property.value);
    } else if (property.key === "X-WR-CALDESC") {
      info.description = decodeIcsText(property.value);
    }
  }

  return info;
}

function classifyCalendarEvent(event, calendarInfo) {
  const calendarName = calendarInfo.name || "PSC calendar";
  const text = `${calendarName} ${calendarInfo.description} ${event.summary}`;
  const schoolHolidayOverride = /(?:วันทำงาน|งดเฉพาะการเรียนการสอน)/.test(
    event.summary,
  );
  const isPublicHoliday =
    !schoolHolidayOverride &&
    (/วันหยุด(?:นักขัตฤกษ์|ราชการ)/.test(calendarName) ||
      [
        "วันขึ้นปีใหม่",
        "วันมาฆบูชา",
        "วันจักรี",
        "วันสงกรานต์",
        "วันฉัตรมงคล",
        "วันวิสาขบูชา",
        "วันเฉลิมพระชนมพรรษา",
        "วันอาสาฬหบูชา",
        "วันเข้าพรรษา",
        "วันปิยมหาราช",
        "วันรัฐธรรมนูญ",
        "วันแรงงาน",
        "วันชาติ",
        "วันแม่แห่งชาติ",
        "วันพ่อแห่งชาติ",
        "วันสิ้นปี",
      ].some((keyword) => text.includes(keyword)));
  const isSchoolHoliday =
    !isPublicHoliday &&
    (schoolHolidayOverride || /(?:^|\s)(หยุด|งดเรียน|งดการเรียน)/.test(text));
  const eventType = isPublicHoliday
    ? "public_holiday"
    : isSchoolHoliday
      ? "school_holiday"
      : "school_event";
  const eventTypeLabel =
    eventType === "public_holiday"
      ? "วันหยุดนักขัตฤกษ์/วันหยุดราชการ"
      : eventType === "school_holiday"
        ? "วันหยุดหรือวันงดกิจกรรมตามปฏิทินวิทยาลัย"
        : "กิจกรรมหรือกำหนดการของวิทยาลัย";

  return {
    ...event,
    calendarName,
    calendarDescription: calendarInfo.description,
    eventType,
    eventTypeLabel,
    isSchoolActivity: eventType === "school_event",
    answerGuidance: buildAnswerGuidance(event.summary, eventType),
  };
}

function buildAnswerGuidance(summary, eventType) {
  if (eventType === "public_holiday") {
    return `ถ้าผู้ใช้ถามว่าวันนี้มีกิจกรรมอะไร ให้ตอบว่าไม่พบกิจกรรมของวิทยาลัยในข้อมูลที่ค้นเจอสำหรับวันนั้น แต่วันนั้นเป็นวันหยุดนักขัตฤกษ์/วันหยุดราชการ: ${summary}`;
  }

  if (eventType === "school_holiday") {
    return `ถ้าผู้ใช้ถามว่าวันนี้มีกิจกรรมอะไร ให้ตอบว่าไม่พบกิจกรรมของวิทยาลัยในข้อมูลที่ค้นเจอสำหรับวันนั้น แต่มีข้อมูลว่าเป็นวันหยุดหรือวันงดกิจกรรมตามปฏิทินวิทยาลัย: ${summary}`;
  }

  return `ถ้าผู้ใช้ถามว่าวันนี้มีกิจกรรมอะไร ให้ตอบเป็นกิจกรรมหรือกำหนดการของวิทยาลัย: ${summary}`;
}

function parseIcsEvents(icsText) {
  const unfoldedLines = unfoldIcsLines(icsText);
  const events = [];
  let currentEvent = null;

  for (const line of unfoldedLines) {
    if (line === "BEGIN:VEVENT") {
      currentEvent = {};
      continue;
    }

    if (line === "END:VEVENT") {
      if (currentEvent?.summary && currentEvent.startDateKey) {
        events.push(currentEvent);
      }

      currentEvent = null;
      continue;
    }

    if (!currentEvent) {
      continue;
    }

    const property = parseIcsProperty(line);

    if (!property) {
      continue;
    }

    const value = decodeIcsText(property.value);

    if (property.key === "SUMMARY") {
      currentEvent.summary = value;
    } else if (property.key === "DESCRIPTION") {
      currentEvent.description = value;
    } else if (property.key === "LOCATION") {
      currentEvent.location = value;
    } else if (property.key === "DTSTART") {
      const start = parseIcsDate(property.value, property.params);
      currentEvent.allDay = start.allDay;
      currentEvent.startDateKey = start.dateKey;
      currentEvent.startText = formatDateKey(start.dateKey);
    } else if (property.key === "DTEND") {
      const end = parseIcsDate(property.value, property.params);
      const endDateKey =
        currentEvent.allDay && end.allDay ? addDays(end.dateKey, -1) : end.dateKey;

      if (!currentEvent.startDateKey || endDateKey >= currentEvent.startDateKey) {
        currentEvent.endDateKey = endDateKey;
        currentEvent.endText = formatDateKey(endDateKey);
      }
    }
  }

  return events;
}

function parseIcsProperty(line) {
  const separatorIndex = line.indexOf(":");

  if (separatorIndex === -1) {
    return null;
  }

  const head = line.slice(0, separatorIndex);
  const value = line.slice(separatorIndex + 1);
  const [rawKey, ...rawParams] = head.split(";");
  const params = {};

  for (const rawParam of rawParams) {
    const paramSeparatorIndex = rawParam.indexOf("=");

    if (paramSeparatorIndex === -1) {
      continue;
    }

    params[rawParam.slice(0, paramSeparatorIndex).toUpperCase()] = rawParam.slice(
      paramSeparatorIndex + 1,
    );
  }

  return {
    key: rawKey.toUpperCase(),
    params,
    value,
  };
}

function unfoldIcsLines(icsText) {
  return icsText.split(/\r?\n/).reduce((lines, line) => {
    if (/^[ \t]/.test(line) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line.trimEnd());
    }

    return lines;
  }, []);
}

function parseIcsDate(value, params = {}) {
  const dateMatch = value.match(/^(\d{4})(\d{2})(\d{2})$/);

  if (dateMatch) {
    return {
      allDay: true,
      dateKey: toDateKey(dateMatch[1], dateMatch[2], dateMatch[3]),
    };
  }

  const dateTimeMatch = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);

  if (dateTimeMatch) {
    if (value.endsWith("Z")) {
      return {
        allDay: false,
        dateKey: formatDateKeyInBangkok(
          new Date(
            Date.UTC(
              Number(dateTimeMatch[1]),
              Number(dateTimeMatch[2]) - 1,
              Number(dateTimeMatch[3]),
              Number(dateTimeMatch[4]),
              Number(dateTimeMatch[5]),
              Number(dateTimeMatch[6]),
            ),
          ),
        ),
      };
    }

    return {
      allDay: params.VALUE === "DATE",
      dateKey: toDateKey(dateTimeMatch[1], dateTimeMatch[2], dateTimeMatch[3]),
    };
  }

  throw new Error(`Unsupported ICS date: ${value}`);
}

function buildMarkdown(url, events, fromDateKey, calendarInfo) {
  const lines = [
    "# PSC activity calendar",
    "",
    `Calendar: ${calendarInfo.name || "PSC calendar"}`,
    `Source: ${url}`,
    `Imported at: ${new Date().toISOString()}`,
    `Included events from: ${formatDateKey(fromDateKey)}`,
    "",
  ];

  for (const event of events) {
    lines.push(`## ${event.startText} - ${event.summary}`);
    lines.push(`Event type: ${event.eventType}`);
    lines.push(`Event type label: ${event.eventTypeLabel}`);
    lines.push(`Is school activity: ${event.isSchoolActivity ? "yes" : "no"}`);
    lines.push(`Answer guidance: ${event.answerGuidance}`);

    if (event.endText && event.endDateKey !== event.startDateKey) {
      lines.push(`End: ${event.endText}`);
    }

    if (event.location && event.location !== "-------") {
      lines.push(`Location: ${event.location}`);
    }

    if (event.description) {
      lines.push(`Description: ${normalizeText(event.description)}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

function buildCalendarChunks(url, events, fromDateKey, calendarInfo) {
  const monthGroups = groupEventsByMonth(events);
  const chunks = [];

  for (const [monthKey, monthEvents] of monthGroups) {
    chunks.push(buildMonthChunk(url, monthKey, monthEvents, fromDateKey, calendarInfo));
  }

  for (const event of events) {
    chunks.push(buildEventChunk(url, event, calendarInfo));
  }

  return chunks;
}

function buildMonthChunk(url, monthKey, events, fromDateKey, calendarInfo) {
  const eventTypes = [...new Set(events.map((event) => event.eventType))];
  const schoolEvents = events.filter((event) => event.isSchoolActivity);
  const holidayEvents = events.filter((event) => !event.isSchoolActivity);
  const lines = [
    "# PSC activity calendar month",
    "",
    `Calendar: ${calendarInfo.name || "PSC calendar"}`,
    `Source: ${url}`,
    `Month: ${formatMonthKey(monthKey)} (${monthKey})`,
    `Included events from: ${formatDateKey(fromDateKey)}`,
    `Contains school activities: ${schoolEvents.length > 0 ? "yes" : "no"}`,
    `Contains holidays/non-activity days: ${holidayEvents.length > 0 ? "yes" : "no"}`,
    "",
  ];

  appendEventList(lines, "School activities and school schedules", schoolEvents);
  appendEventList(lines, "Holidays or non-activity days", holidayEvents);

  return {
    content: lines.join("\n").trim(),
    metadata: {
      chunk_kind: "calendar_month",
      calendar_name: calendarInfo.name,
      calendar_description: calendarInfo.description,
      month_key: monthKey,
      event_types: eventTypes,
      school_event_count: schoolEvents.length,
      holiday_event_count: holidayEvents.length,
    },
  };
}

function appendEventList(lines, title, events) {
  if (events.length === 0) {
    return;
  }

  lines.push(`## ${title}`);

  for (const event of events) {
    appendEventLines(lines, event);
  }
}

function appendEventLines(lines, event) {
  lines.push(`### ${event.startText} - ${event.summary}`);
  lines.push(`Event type: ${event.eventType}`);
  lines.push(`Event type label: ${event.eventTypeLabel}`);
  lines.push(`Is school activity: ${event.isSchoolActivity ? "yes" : "no"}`);
  lines.push(`Answer guidance: ${event.answerGuidance}`);

  if (event.endText && event.endDateKey !== event.startDateKey) {
    lines.push(`End: ${event.endText}`);
  }

  if (event.location && event.location !== "-------") {
    lines.push(`Location: ${event.location}`);
  }

  if (event.description) {
    lines.push(`Description: ${normalizeText(event.description)}`);
  }

  lines.push("");
}

function buildEventChunk(url, event, calendarInfo) {
  const lines = [
    "# PSC activity calendar event",
    "",
    `Calendar: ${calendarInfo.name || "PSC calendar"}`,
    `Source: ${url}`,
    `Date: ${event.startText}`,
    `Date key: ${event.startDateKey}`,
    `Month: ${formatMonthKey(event.startDateKey.slice(0, 7))}`,
    `Activity: ${event.summary}`,
    `Event type: ${event.eventType}`,
    `Event type label: ${event.eventTypeLabel}`,
    `Is school activity: ${event.isSchoolActivity ? "yes" : "no"}`,
    `Answer guidance: ${event.answerGuidance}`,
    `Search terms: กิจกรรมวันที่ ${event.startText}, ปฏิทินกิจกรรม ${event.startDateKey}`,
  ];

  if (event.endText && event.endDateKey !== event.startDateKey) {
    lines.push(`End: ${event.endText}`);
  }

  if (event.location && event.location !== "-------") {
    lines.push(`Location: ${event.location}`);
  }

  if (event.description) {
    lines.push(`Description: ${normalizeText(event.description)}`);
  }

  return {
    content: lines.join("\n").trim(),
    metadata: {
      chunk_kind: "calendar_event",
      calendar_name: calendarInfo.name,
      calendar_description: calendarInfo.description,
      date_key: event.startDateKey,
      month_key: event.startDateKey.slice(0, 7),
      event_type: event.eventType,
      event_type_label: event.eventTypeLabel,
      is_school_activity: event.isSchoolActivity,
      summary: event.summary,
    },
  };
}

function groupEventsByMonth(events) {
  const groups = new Map();

  for (const event of events) {
    const monthKey = event.startDateKey.slice(0, 7);
    const monthEvents = groups.get(monthKey) ?? [];
    monthEvents.push(event);
    groups.set(monthKey, monthEvents);
  }

  return groups;
}

function decodeIcsText(value) {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function parseDateArg(value) {
  const dateMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!dateMatch) {
    throw new Error(`Invalid date argument: ${value}`);
  }

  return toDateKey(dateMatch[1], dateMatch[2], dateMatch[3]);
}

function formatDateKey(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));

  return date.toLocaleDateString("th-TH", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatMonthKey(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, 1, 12));

  return date.toLocaleDateString("th-TH", {
    year: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

function formatDateKeyInBangkok(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function toDateKey(year, month, day) {
  return `${year}-${month}-${day}`;
}

function addDays(dateKey, days) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12));
  return date.toISOString().slice(0, 10);
}

function slugify(value) {
  return value
    .replace(/^https?:\/\//i, "")
    .replace(/[^a-zA-Z0-9ก-๙]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .toLowerCase();
}
