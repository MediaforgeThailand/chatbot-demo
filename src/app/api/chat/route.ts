import { NextResponse } from "next/server";

import { answerQuestion, RagConfigurationError } from "@/lib/rag";

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

  try {
    const result = await answerQuestion(question);
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
