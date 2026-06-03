import { NextResponse, type NextRequest } from "next/server";

import {
  GmailConfigurationError,
  GmailConnectionError,
  GMAIL_SESSION_COOKIE,
  deleteGmailConnection,
  getGmailConfig,
  isUuid,
} from "@/lib/gmail";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const config = getGmailConfig();
    const sessionId = request.cookies.get(GMAIL_SESSION_COOKIE)?.value;

    if (!isUuid(sessionId)) {
      return NextResponse.json({ connected: false });
    }

    await deleteGmailConnection(sessionId, config);

    return NextResponse.json({ connected: false });
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
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    console.error(error);

    return NextResponse.json(
      { error: "Unable to disconnect Gmail" },
      { status: 500 },
    );
  }
}
