import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "crypto";

export type GmailConnection = {
  session_id: string;
  google_email: string | null;
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  access_token_expires_at: string | null;
  scope: string | null;
};

export type GmailStatus = {
  connected: boolean;
  email?: string;
  scope?: string;
};

export type GmailMessageSummary = {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  labelIds: string[];
};

export type GmailThreadMessage = GmailMessageSummary & {
  body: string;
};

export type GmailThreadDetails = {
  id: string;
  historyId?: string;
  messages: GmailThreadMessage[];
};

type GmailConfig = {
  googleClientId: string;
  googleClientSecret: string;
  redirectUri?: string;
  tokenEncryptionKey: Buffer;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
};

type GoogleTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
};

export class GmailConfigurationError extends Error {
  constructor(public readonly missingEnv: string[]) {
    super(`Missing required Gmail environment variables: ${missingEnv.join(", ")}`);
    this.name = "GmailConfigurationError";
  }
}

export class GmailConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailConnectionError";
  }
}

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const GMAIL_DRAFTS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/drafts";
const GMAIL_MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const GMAIL_THREADS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/threads";
const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GMAIL_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
];
const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;

export const GMAIL_SESSION_COOKIE = "psc_gmail_session";
export const GMAIL_OAUTH_STATE_COOKIE = "psc_gmail_oauth_state";

export function getGmailConfig(): GmailConfig {
  const googleClientId = process.env.GOOGLE_OAUTH_CLIENT_ID ?? "";
  const googleClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "";
  const tokenEncryptionSecret = process.env.GMAIL_TOKEN_ENCRYPTION_KEY ?? "";
  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  const missingEnv = [
    ["GOOGLE_OAUTH_CLIENT_ID", googleClientId],
    ["GOOGLE_OAUTH_CLIENT_SECRET", googleClientSecret],
    ["GMAIL_TOKEN_ENCRYPTION_KEY", tokenEncryptionSecret],
    ["SUPABASE_URL", supabaseUrl],
    ["SUPABASE_SERVICE_ROLE_KEY", supabaseServiceRoleKey],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missingEnv.length > 0) {
    throw new GmailConfigurationError(missingEnv);
  }

  return {
    googleClientId,
    googleClientSecret,
    redirectUri: process.env.GMAIL_OAUTH_REDIRECT_URI || undefined,
    tokenEncryptionKey: normalizeEncryptionKey(tokenEncryptionSecret),
    supabaseUrl: supabaseUrl.replace(/\/$/, ""),
    supabaseServiceRoleKey,
  };
}

export function buildGoogleAuthorizeUrl({
  origin,
  sessionId,
  config,
}: {
  origin: string;
  sessionId: string;
  config: GmailConfig;
}): { authorizeUrl: string; state: string; redirectUri: string } {
  const redirectUri =
    config.redirectUri ?? `${origin.replace(/\/$/, "")}/api/gmail/oauth/callback`;
  const state = createOAuthState(sessionId, config);
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    state,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });

  return {
    authorizeUrl: `${GOOGLE_AUTH_URL}?${params.toString()}`,
    state,
    redirectUri,
  };
}

export function createOAuthState(sessionId: string, config: GmailConfig): string {
  const payload = base64UrlEncode(
    Buffer.from(
      JSON.stringify({
        sessionId,
        nonce: randomBytes(16).toString("hex"),
        createdAt: Date.now(),
      }),
      "utf8",
    ),
  );
  const signature = signStatePayload(payload, config);

  return `${payload}.${signature}`;
}

export function verifyOAuthState(state: string, config: GmailConfig): string | null {
  const [payload, signature] = state.split(".");

  if (!payload || !signature) {
    return null;
  }

  const expectedSignature = signStatePayload(payload, config);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(payload).toString("utf8")) as {
      sessionId?: unknown;
      createdAt?: unknown;
    };

    if (
      typeof parsed.sessionId !== "string" ||
      !isUuid(parsed.sessionId) ||
      typeof parsed.createdAt !== "number" ||
      Date.now() - parsed.createdAt > OAUTH_STATE_MAX_AGE_MS
    ) {
      return null;
    }

    return parsed.sessionId;
  } catch {
    return null;
  }
}

export async function exchangeOAuthCode({
  code,
  redirectUri,
  config,
}: {
  code: string;
  redirectUri: string;
  config: GmailConfig;
}): Promise<GoogleTokenResponse> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
    cache: "no-store",
  });
  const data = (await response.json()) as GoogleTokenResponse;

  if (!response.ok || !data.access_token) {
    throw new GmailConnectionError(
      data.error_description ?? data.error ?? "Google OAuth token exchange failed",
    );
  }

  return data;
}

export async function refreshAccessToken(
  connection: GmailConnection,
  config: GmailConfig,
): Promise<string> {
  if (!connection.refresh_token_encrypted) {
    throw new GmailConnectionError("Gmail refresh token is missing");
  }

  const refreshToken = decryptSecret(
    connection.refresh_token_encrypted,
    config.tokenEncryptionKey,
  );
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    cache: "no-store",
  });
  const data = (await response.json()) as GoogleTokenResponse;

  if (!response.ok || !data.access_token) {
    throw new GmailConnectionError(
      data.error_description ?? data.error ?? "Google OAuth token refresh failed",
    );
  }

  const expiresAt = new Date(
    Date.now() + Math.max(60, data.expires_in ?? 3600) * 1000,
  ).toISOString();

  await updateGmailConnectionTokens(connection.session_id, config, {
    accessToken: data.access_token,
    expiresAt,
    scope: data.scope ?? connection.scope,
  });

  return data.access_token;
}

export async function getUsableAccessToken(
  sessionId: string,
  config: GmailConfig,
): Promise<{ accessToken: string; connection: GmailConnection }> {
  const connection = await getGmailConnection(sessionId, config);

  if (!connection) {
    throw new GmailConnectionError("Gmail is not connected");
  }

  const expiresAt = connection.access_token_expires_at
    ? new Date(connection.access_token_expires_at).getTime()
    : 0;
  const shouldRefresh = !expiresAt || expiresAt < Date.now() + 60 * 1000;

  if (shouldRefresh) {
    const accessToken = await refreshAccessToken(connection, config);
    return {
      accessToken,
      connection,
    };
  }

  return {
    accessToken: decryptSecret(connection.access_token_encrypted, config.tokenEncryptionKey),
    connection,
  };
}

export async function upsertGmailConnection({
  sessionId,
  tokenResponse,
  config,
}: {
  sessionId: string;
  tokenResponse: GoogleTokenResponse;
  config: GmailConfig;
}): Promise<void> {
  if (!tokenResponse.access_token) {
    throw new GmailConnectionError("Google OAuth did not return an access token");
  }

  const existingConnection = await getGmailConnection(sessionId, config);
  const refreshToken =
    tokenResponse.refresh_token ??
    (existingConnection?.refresh_token_encrypted
      ? decryptSecret(existingConnection.refresh_token_encrypted, config.tokenEncryptionKey)
      : null);

  if (!refreshToken) {
    throw new GmailConnectionError(
      "Google OAuth did not return a refresh token. Try disconnecting and connecting again.",
    );
  }

  const expiresAt = new Date(
    Date.now() + Math.max(60, tokenResponse.expires_in ?? 3600) * 1000,
  ).toISOString();
  const googleEmail = readEmailFromIdToken(tokenResponse.id_token, config);

  await supabaseFetch("/rest/v1/gmail_connections?on_conflict=session_id", config, {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({
      session_id: sessionId,
      google_email: googleEmail ?? existingConnection?.google_email ?? null,
      access_token_encrypted: encryptSecret(
        tokenResponse.access_token,
        config.tokenEncryptionKey,
      ),
      refresh_token_encrypted: encryptSecret(refreshToken, config.tokenEncryptionKey),
      access_token_expires_at: expiresAt,
      scope: tokenResponse.scope ?? existingConnection?.scope ?? GMAIL_SCOPES.join(" "),
      updated_at: new Date().toISOString(),
    }),
  });
}

export async function getGmailStatus(
  sessionId: string | null,
  config: GmailConfig,
): Promise<GmailStatus> {
  if (!sessionId || !isUuid(sessionId)) {
    return {
      connected: false,
    };
  }

  const connection = await getGmailConnection(sessionId, config);

  if (!connection) {
    return {
      connected: false,
    };
  }

  return {
    connected: true,
    email: connection.google_email ?? undefined,
    scope: connection.scope ?? undefined,
  };
}

export async function getGmailConnection(
  sessionId: string,
  config: GmailConfig,
): Promise<GmailConnection | null> {
  if (!isUuid(sessionId)) {
    return null;
  }

  const rows = await supabaseFetch<GmailConnection[]>(
    `/rest/v1/gmail_connections?select=session_id,google_email,access_token_encrypted,refresh_token_encrypted,access_token_expires_at,scope&session_id=eq.${sessionId}&limit=1`,
    config,
  );

  return rows[0] ?? null;
}

export async function deleteGmailConnection(
  sessionId: string,
  config: GmailConfig,
): Promise<void> {
  const connection = await getGmailConnection(sessionId, config);

  if (connection) {
    const revokeToken = connection.refresh_token_encrypted
      ? decryptSecret(connection.refresh_token_encrypted, config.tokenEncryptionKey)
      : decryptSecret(connection.access_token_encrypted, config.tokenEncryptionKey);

    await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(revokeToken)}`, {
      method: "POST",
      cache: "no-store",
    }).catch(() => undefined);
  }

  await supabaseFetch(`/rest/v1/gmail_connections?session_id=eq.${sessionId}`, config, {
    method: "DELETE",
  });
}

export async function sendGmailMessage({
  accessToken,
  to,
  subject,
  body,
}: {
  accessToken: string;
  to: string;
  subject: string;
  body: string;
}): Promise<{ id?: string; threadId?: string }> {
  const raw = buildRawMimeMessage({ to, subject, body });
  const response = await fetch(GMAIL_SEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
    cache: "no-store",
  });
  const data = (await response.json().catch(() => ({}))) as {
    id?: string;
    threadId?: string;
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new GmailConnectionError(
      data.error?.message ?? `Gmail send request failed: ${response.status}`,
    );
  }

  return {
    id: data.id,
    threadId: data.threadId,
  };
}

export async function createGmailDraft({
  accessToken,
  to,
  subject,
  body,
}: {
  accessToken: string;
  to: string;
  subject: string;
  body: string;
}): Promise<{ id?: string; messageId?: string; threadId?: string }> {
  const raw = buildRawMimeMessage({ to, subject, body });
  const response = await fetch(GMAIL_DRAFTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        raw,
      },
    }),
    cache: "no-store",
  });
  const data = (await response.json().catch(() => ({}))) as {
    id?: string;
    message?: {
      id?: string;
      threadId?: string;
    };
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new GmailConnectionError(
      data.error?.message ?? `Gmail draft request failed: ${response.status}`,
    );
  }

  return {
    id: data.id,
    messageId: data.message?.id,
    threadId: data.message?.threadId,
  };
}

export async function searchGmailMessages({
  accessToken,
  query,
  maxResults = 10,
}: {
  accessToken: string;
  query: string;
  maxResults?: number;
}): Promise<GmailMessageSummary[]> {
  const params = new URLSearchParams({
    maxResults: String(Math.min(Math.max(maxResults, 1), 20)),
    q: query.trim() || "in:inbox newer_than:30d",
  });
  const response = await fetch(`${GMAIL_MESSAGES_URL}?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    cache: "no-store",
  });
  const data = (await response.json().catch(() => ({}))) as {
    messages?: Array<{ id?: string; threadId?: string }>;
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new GmailConnectionError(
      data.error?.message ?? `Gmail message search failed: ${response.status}`,
    );
  }

  const messages = data.messages ?? [];
  const details = await Promise.all(
    messages
      .filter((message): message is { id: string; threadId: string } =>
        Boolean(message.id && message.threadId),
      )
      .map((message) => getGmailMessageMetadata(accessToken, message.id)),
  );

  return details;
}

export async function getGmailThreadDetails({
  accessToken,
  threadId,
}: {
  accessToken: string;
  threadId: string;
}): Promise<GmailThreadDetails> {
  if (!/^[A-Za-z0-9_-]+$/.test(threadId)) {
    throw new GmailConnectionError("Gmail thread id is invalid");
  }

  const response = await fetch(
    `${GMAIL_THREADS_URL}/${encodeURIComponent(threadId)}?format=full`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      cache: "no-store",
    },
  );
  const data = (await response.json().catch(() => ({}))) as GmailThreadApiResponse & {
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new GmailConnectionError(
      data.error?.message ?? `Gmail thread request failed: ${response.status}`,
    );
  }

  return {
    id: data.id ?? threadId,
    historyId: data.historyId,
    messages: (data.messages ?? [])
      .map(readThreadMessage)
      .filter((message): message is GmailThreadMessage => message !== null),
  };
}

export async function summarizeGmailThread({
  thread,
  userInstruction,
}: {
  thread: GmailThreadDetails;
  userInstruction?: string;
}): Promise<string> {
  const geminiApiKey =
    process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "";
  const generationModel = process.env.GEMINI_GENERATION_MODEL || "gemini-3.5-flash";

  if (!geminiApiKey) {
    throw new GmailConfigurationError(["GEMINI_API_KEY"]);
  }

  const threadText = thread.messages
    .map(
      (message, index) => `MESSAGE ${index + 1}
From: ${message.from || "-"}
To: ${message.to || "-"}
Date: ${message.date || "-"}
Subject: ${message.subject || "-"}
Snippet: ${message.snippet || "-"}
Body:
${message.body || "(empty)"}`,
    )
    .join("\n\n---\n\n")
    .slice(0, 18000);
  const prompt = `คุณคือผู้ช่วยอ่าน Gmail ให้ผู้ใช้
สรุป thread อีเมลนี้เป็นภาษาไทย กระชับ อ่านง่าย และไม่เดาข้อมูลนอกอีเมล

กติกา:
- สรุปใจความสำคัญ 3-6 bullet
- ระบุ action items ถ้ามี
- ระบุคนที่เกี่ยวข้องและวันที่สำคัญถ้าพบ
- ถ้าข้อมูลไม่พอ ให้บอกว่าไม่พบใน thread

คำสั่งเพิ่มเติมจากผู้ใช้:
${userInstruction?.trim() || "(ไม่มี)"}

GMAIL THREAD:
${threadText}`;
  const response = await fetch(
    `${GEMINI_API_BASE_URL}/models/${generationModel}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": geminiApiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 0.2,
        },
      }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new GmailConnectionError(`Gemini Gmail summary request failed: ${response.status}`);
  }

  const data = (await response.json()) as GeminiGenerateResponse;
  const text =
    data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text)
      .filter(Boolean)
      .join("\n")
      .trim() ?? "";

  return text || "ผมยังสรุป thread นี้ไม่ได้ครับ";
}

async function getGmailMessageMetadata(
  accessToken: string,
  messageId: string,
): Promise<GmailMessageSummary> {
  const params = new URLSearchParams({
    format: "metadata",
  });

  for (const header of ["From", "To", "Subject", "Date"]) {
    params.append("metadataHeaders", header);
  }

  const response = await fetch(
    `${GMAIL_MESSAGES_URL}/${encodeURIComponent(messageId)}?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      cache: "no-store",
    },
  );
  const data = (await response.json().catch(() => ({}))) as GmailMessageApiResponse & {
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new GmailConnectionError(
      data.error?.message ?? `Gmail message request failed: ${response.status}`,
    );
  }

  return readMessageSummary(data);
}

function readThreadMessage(message: GmailMessageApiResponse): GmailThreadMessage | null {
  if (!message.id || !message.threadId) {
    return null;
  }

  return {
    ...readMessageSummary(message),
    body: extractMessageBody(message.payload).slice(0, 6000),
  };
}

function readMessageSummary(message: GmailMessageApiResponse): GmailMessageSummary {
  const headers = readHeaders(message.payload?.headers);

  return {
    id: message.id ?? "",
    threadId: message.threadId ?? "",
    subject: headers.Subject ?? "(ไม่มีหัวข้อ)",
    from: headers.From ?? "",
    to: headers.To ?? "",
    date: headers.Date ?? "",
    snippet: message.snippet ?? "",
    labelIds: message.labelIds ?? [],
  };
}

function readHeaders(
  headers: Array<{ name?: string; value?: string }> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const header of headers ?? []) {
    if (header.name && header.value) {
      result[header.name] = header.value;
    }
  }

  return result;
}

function extractMessageBody(payload: GmailMessagePayload | undefined): string {
  if (!payload) {
    return "";
  }

  if (payload.body?.data) {
    return decodeGmailBody(payload.body.data);
  }

  const preferredParts = [...(payload.parts ?? [])].sort((first, second) => {
    const firstScore = first.mimeType === "text/plain" ? 0 : 1;
    const secondScore = second.mimeType === "text/plain" ? 0 : 1;
    return firstScore - secondScore;
  });

  return preferredParts
    .map((part) => extractMessageBody(part))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function decodeGmailBody(data: string): string {
  try {
    return Buffer.from(data, "base64url").toString("utf8").trim();
  } catch {
    return "";
  }
}

type GmailThreadApiResponse = {
  id?: string;
  historyId?: string;
  messages?: GmailMessageApiResponse[];
};

type GmailMessageApiResponse = {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailMessagePayload;
};

type GmailMessagePayload = {
  mimeType?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: {
    data?: string;
  };
  parts?: GmailMessagePayload[];
};

type GeminiGenerateResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
};

export function validateEmailInput({
  to,
  subject,
  body,
}: {
  to: unknown;
  subject: unknown;
  body: unknown;
}): { to: string; subject: string; body: string } {
  const cleanTo = typeof to === "string" ? to.trim() : "";
  const cleanSubject = typeof subject === "string" ? subject.trim() : "";
  const cleanBody = typeof body === "string" ? body.trim() : "";

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanTo)) {
    throw new GmailConnectionError("Recipient email is invalid");
  }

  if (!cleanSubject || cleanSubject.length > 200) {
    throw new GmailConnectionError("Subject is required and must be under 200 characters");
  }

  if (!cleanBody || cleanBody.length > 5000) {
    throw new GmailConnectionError("Body is required and must be under 5000 characters");
  }

  return {
    to: cleanTo,
    subject: cleanSubject,
    body: cleanBody,
  };
}

export function isUuid(value: string | undefined | null): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

async function updateGmailConnectionTokens(
  sessionId: string,
  config: GmailConfig,
  values: {
    accessToken: string;
    expiresAt: string;
    scope?: string | null;
  },
): Promise<void> {
  await supabaseFetch(`/rest/v1/gmail_connections?session_id=eq.${sessionId}`, config, {
    method: "PATCH",
    body: JSON.stringify({
      access_token_encrypted: encryptSecret(values.accessToken, config.tokenEncryptionKey),
      access_token_expires_at: values.expiresAt,
      scope: values.scope ?? null,
      updated_at: new Date().toISOString(),
    }),
  });
}

async function supabaseFetch<T = unknown>(
  path: string,
  config: GmailConfig,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${config.supabaseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      apikey: config.supabaseServiceRoleKey,
      Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new GmailConnectionError(
      `Supabase Gmail connection request failed: ${response.status} ${text}`,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function buildRawMimeMessage({
  to,
  subject,
  body,
}: {
  to: string;
  subject: string;
  body: string;
}): string {
  const message = [
    `To: ${to}`,
    `Subject: ${encodeMimeHeader(subject)}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
  ].join("\r\n");

  return base64UrlEncode(Buffer.from(message, "utf8"));
}

function encodeMimeHeader(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) {
    return value;
  }

  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function encryptSecret(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return ["v1", base64UrlEncode(iv), base64UrlEncode(tag), base64UrlEncode(encrypted)].join(
    ".",
  );
}

function decryptSecret(value: string, key: Buffer): string {
  const [version, ivText, tagText, encryptedText] = value.split(".");

  if (version !== "v1" || !ivText || !tagText || !encryptedText) {
    throw new GmailConnectionError("Encrypted Gmail token has an invalid format");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, base64UrlDecode(ivText));
  decipher.setAuthTag(base64UrlDecode(tagText));

  return Buffer.concat([
    decipher.update(base64UrlDecode(encryptedText)),
    decipher.final(),
  ]).toString("utf8");
}

function normalizeEncryptionKey(secret: string): Buffer {
  const decoded = Buffer.from(secret, "base64");

  if (decoded.length === 32) {
    return decoded;
  }

  return createHmac("sha256", "psc-gmail-token-key").update(secret).digest();
}

function signStatePayload(payload: string, config: GmailConfig): string {
  return createHmac("sha256", config.tokenEncryptionKey).update(payload).digest("base64url");
}

function readEmailFromIdToken(
  idToken: string | undefined,
  config: GmailConfig,
): string | null {
  if (!idToken) {
    return null;
  }

  const [, payload] = idToken.split(".");

  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(payload).toString("utf8")) as {
      aud?: unknown;
      email?: unknown;
    };

    if (parsed.aud !== config.googleClientId || typeof parsed.email !== "string") {
      return null;
    }

    return parsed.email;
  } catch {
    return null;
  }
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}
