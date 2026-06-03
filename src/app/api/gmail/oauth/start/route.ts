import { randomUUID } from "crypto";
import { NextResponse, type NextRequest } from "next/server";

import {
  GmailConfigurationError,
  GMAIL_OAUTH_STATE_COOKIE,
  GMAIL_SESSION_COOKIE,
  buildGoogleAuthorizeUrl,
  getGmailConfig,
  isUuid,
} from "@/lib/gmail";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const config = getGmailConfig();
    const origin = request.nextUrl.origin;
    const sessionId = isUuid(request.cookies.get(GMAIL_SESSION_COOKIE)?.value)
      ? request.cookies.get(GMAIL_SESSION_COOKIE)?.value
      : randomUUID();

    if (!sessionId) {
      return NextResponse.json({ error: "Unable to create Gmail session" }, { status: 500 });
    }

    const { authorizeUrl, state } = buildGoogleAuthorizeUrl({
      origin,
      sessionId,
      config,
    });
    const response = NextResponse.redirect(authorizeUrl);

    response.cookies.set(GMAIL_SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    response.cookies.set(GMAIL_OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 10 * 60,
    });

    return response;
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

    console.error(error);

    return NextResponse.json(
      { error: "Unable to start Gmail OAuth flow" },
      { status: 500 },
    );
  }
}
