import type { AuthContext, Permission } from "../../types/auth";
import { SESSION_COOKIE_NAME } from "./config";
import { AuthError } from "./errors";
import { authorizeSessionToken, requireSessionToken } from "./service";

export const MAX_AUTH_BODY_BYTES = 64 * 1024;

function cookieValue(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function sessionTokenFromRequest(request: Request): string | undefined {
  return cookieValue(request.headers.get("cookie"), SESSION_COOKIE_NAME);
}

export function requestIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;

  const requestUrl = new URL(request.url);

  const allowed = new Set(
    (process.env.AH2D_ALLOWED_ORIGINS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  allowed.add(requestUrl.origin);
  const host = request.headers.get("host")?.trim();
  if (host) allowed.add(`${requestUrl.protocol}//${host}`);
  if (!allowed.has(origin)) {
    throw new AuthError("INVALID_ORIGIN", "Cross-origin authentication request rejected.", 403);
  }
}

/**
 * Reads small authentication payloads without allowing request.json() to buffer
 * an unbounded body first. Authentication routes only accept JSON objects.
 */
export async function readAuthJsonObject(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_AUTH_BODY_BYTES) {
    throw new AuthError(
      "REQUEST_BODY_TOO_LARGE",
      "Authentication request body exceeds the size limit.",
      413,
      { maximumBytes: MAX_AUTH_BODY_BYTES },
    );
  }
  if (!request.body) throw new AuthError("INVALID_BODY", "Request body is required.", 400);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_AUTH_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new AuthError(
        "REQUEST_BODY_TOO_LARGE",
        "Authentication request body exceeds the size limit.",
        413,
        { maximumBytes: MAX_AUTH_BODY_BYTES },
      );
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AuthError("INVALID_JSON", "Request body must be valid JSON.", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AuthError("INVALID_BODY", "Request body must be a JSON object.", 400);
  }
  return parsed as Record<string, unknown>;
}

export function requireRequestAuth(request: Request): Promise<AuthContext> {
  return requireSessionToken(sessionTokenFromRequest(request));
}

export function requireRequestPermission(
  request: Request,
  permission: Permission,
): Promise<AuthContext> {
  return authorizeSessionToken(sessionTokenFromRequest(request), permission);
}

export function authErrorResponse(error: unknown): Response {
  const known = error instanceof AuthError;
  const status = known ? error.status : 500;
  const body = {
    ok: false,
    error: {
      code: known ? error.code : "INTERNAL_ERROR",
      message: known ? error.message : "Authentication service failed.",
      ...(known && error.details ? { details: error.details } : {}),
    },
  };
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  };
  if (status === 401) headers["WWW-Authenticate"] = "Session";
  if (status === 429 && known && typeof error.details?.retryAfterSeconds === "number") {
    headers["Retry-After"] = String(error.details.retryAfterSeconds);
  }
  return new Response(JSON.stringify(body), { status, headers });
}
