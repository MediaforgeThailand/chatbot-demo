import { NextResponse, type NextRequest } from "next/server";

import {
  GmailConfigurationError,
  GmailConnectionError,
  GMAIL_SESSION_COOKIE,
  getGmailConfig,
  getGmailThreadDetails,
  getUsableAccessToken,
  isUuid,
  summarizeGmailThread,
} from "@/lib/gmail";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ threadId: string }> },
) {
  try {
    const config = getGmailConfig();
    const sessionId = request.cookies.get(GMAIL_SESSION_COOKIE)?.value;

    if (!isUuid(sessionId)) {
      return NextResponse.json({ error: "Gmail is not connected" }, { status: 401 });
    }

    const { threadId } = await context.params;
    const userInstruction =
      request.nextUrl.searchParams.get("instruction")?.trim() || undefined;
    const { accessToken } = await getUsableAccessToken(sessionId, config);
    const thread = await getGmailThreadDetails({
      accessToken,
      threadId,
    });
    const summary = await summarizeGmailThread({
      thread,
      userInstruction,
    });

    return NextResponse.json({
      thread,
      summary,
    });
  } catch (error) {
    if (error instanceof GmailConfigurationError) {
      return NextResponse.json(
        {
          error: "Gmail connector is not configured",
          missingEnv: error.missingEnv,
        },
        { status: 503 },
      );
    }

    if (error instanceof GmailConnectionError) {
      const status = /insufficient|permission|scope|forbidden|403/i.test(error.message)
        ? 403
        : 400;
      return NextResponse.json(
        {
          error:
            status === 403
              ? "Gmail needs read permission. Disconnect and connect Gmail again."
              : error.message,
        },
        { status },
      );
    }

    console.error(error);

    return NextResponse.json(
      { error: "Unable to summarize Gmail thread" },
      { status: 500 },
    );
  }
}
