import { NextResponse, type NextRequest } from "next/server";

import {
  GmailConfigurationError,
  GmailConnectionError,
  GMAIL_OAUTH_STATE_COOKIE,
  GMAIL_SESSION_COOKIE,
  exchangeOAuthCode,
  getGmailConfig,
  upsertGmailConnection,
  verifyOAuthState,
} from "@/lib/gmail";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const homeUrl = new URL("/", request.nextUrl.origin);

  try {
    const config = getGmailConfig();
    const code = request.nextUrl.searchParams.get("code");
    const state = request.nextUrl.searchParams.get("state");
    const stateCookie = request.cookies.get(GMAIL_OAUTH_STATE_COOKIE)?.value;

    if (!code || !state || !stateCookie || state !== stateCookie) {
      homeUrl.searchParams.set("gmail_error", "invalid_oauth_state");
      return NextResponse.redirect(homeUrl);
    }

    const sessionId = verifyOAuthState(state, config);

    if (!sessionId) {
      homeUrl.searchParams.set("gmail_error", "expired_oauth_state");
      return NextResponse.redirect(homeUrl);
    }

    const redirectUri =
      config.redirectUri ??
      `${request.nextUrl.origin.replace(/\/$/, "")}/api/gmail/oauth/callback`;
    const tokenResponse = await exchangeOAuthCode({
      code,
      redirectUri,
      config,
    });

    await upsertGmailConnection({
      sessionId,
      tokenResponse,
      config,
    });

    homeUrl.searchParams.set("gmail", "connected");
    const response = NextResponse.redirect(homeUrl);

    response.cookies.set(GMAIL_SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    response.cookies.set(GMAIL_OAUTH_STATE_COOKIE, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 0,
    });

    return response;
  } catch (error) {
    if (error instanceof GmailConfigurationError) {
      homeUrl.searchParams.set("gmail_error", `missing_env_${error.missingEnv.join("_")}`);
    } else if (error instanceof GmailConnectionError) {
      homeUrl.searchParams.set("gmail_error", error.message);
    } else {
      console.error(error);
      homeUrl.searchParams.set("gmail_error", "gmail_oauth_failed");
    }

    return NextResponse.redirect(homeUrl);
  }
}
