import { NextResponse, type NextRequest } from "next/server";

import {
  GmailConfigurationError,
  GMAIL_SESSION_COOKIE,
  getGmailConfig,
  getGmailStatus,
} from "@/lib/gmail";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const config = getGmailConfig();
    const sessionId = request.cookies.get(GMAIL_SESSION_COOKIE)?.value ?? null;
    const status = await getGmailStatus(sessionId, config);

    return NextResponse.json(status);
  } catch (error) {
    if (error instanceof GmailConfigurationError) {
      return NextResponse.json(
        {
          connected: false,
          configured: false,
          missingEnv: error.missingEnv,
        },
        { status: 503 },
      );
    }

    console.error(error);

    return NextResponse.json(
      { connected: false, error: "Unable to read Gmail connector status" },
      { status: 500 },
    );
  }
}
