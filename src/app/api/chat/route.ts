import { NextResponse } from "next/server";

import { answerQuestion, RagConfigurationError, type ConversationMessage } from "@/lib/rag";

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

  try {
    const result = await answerQuestion(question, history);
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
    .slice(-8);
}
