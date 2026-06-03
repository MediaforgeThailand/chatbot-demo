import { NextResponse, type NextRequest } from "next/server";

import {
  GmailConfigurationError,
  GmailConnectionError,
  GMAIL_SESSION_COOKIE,
  getGmailConfig,
  getUsableAccessToken,
  isUuid,
  searchGmailMessages,
} from "@/lib/gmail";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const config = getGmailConfig();
    const sessionId = request.cookies.get(GMAIL_SESSION_COOKIE)?.value;

    if (!isUuid(sessionId)) {
      return NextResponse.json({ error: "Gmail is not connected" }, { status: 401 });
    }

    const query =
      request.nextUrl.searchParams.get("q")?.trim() || "in:inbox newer_than:30d";
    const maxResults = Number(request.nextUrl.searchParams.get("maxResults") ?? 10);
    const { accessToken } = await getUsableAccessToken(sessionId, config);
    const messages = await searchGmailMessages({
      accessToken,
      query,
      maxResults: Number.isFinite(maxResults) ? maxResults : 10,
    });

    return NextResponse.json({
      query,
      messages,
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
      { error: "Unable to read Gmail messages" },
      { status: 500 },
    );
  }
}
