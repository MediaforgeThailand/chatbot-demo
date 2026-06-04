import { NextResponse, type NextRequest } from "next/server";

import {
  GmailConfigurationError,
  GmailConnectionError,
  GMAIL_SESSION_COOKIE,
  createGmailDraft,
  getGmailConfig,
  getUsableAccessToken,
  isUuid,
  refreshAccessToken,
  validateEmailInput,
} from "@/lib/gmail";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const config = getGmailConfig();
    const sessionId = request.cookies.get(GMAIL_SESSION_COOKIE)?.value;

    if (!isUuid(sessionId)) {
      return NextResponse.json({ error: "Gmail is not connected" }, { status: 401 });
    }

    const payload = await request.json();
    const email = validateEmailInput({
      to: typeof payload === "object" && payload !== null ? payload.to : undefined,
      subject:
        typeof payload === "object" && payload !== null ? payload.subject : undefined,
      body: typeof payload === "object" && payload !== null ? payload.body : undefined,
    });
    const { accessToken, connection } = await getUsableAccessToken(sessionId, config);

    try {
      const result = await createGmailDraft({
        accessToken,
        ...email,
      });

      return NextResponse.json({ drafted: true, ...result });
    } catch (error) {
      if (
        error instanceof GmailConnectionError &&
        /invalid credential|auth|token|401/i.test(error.message)
      ) {
        const refreshedAccessToken = await refreshAccessToken(connection, config);
        const result = await createGmailDraft({
          accessToken: refreshedAccessToken,
          ...email,
        });

        return NextResponse.json({ drafted: true, ...result });
      }

      throw error;
    }
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

    return NextResponse.json({ error: "Unable to create Gmail draft" }, { status: 500 });
  }
}
