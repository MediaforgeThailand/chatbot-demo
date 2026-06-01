import { NextResponse } from "next/server";

import {
  answerQuestion,
  RagConfigurationError,
  type ConversationMemory,
  type ConversationMessage,
} from "@/lib/rag";

const MAX_HISTORY_MESSAGES = 24;

export async function POST(request: Request) {
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
