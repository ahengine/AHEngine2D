import { AuthError, assertSameOrigin, authErrorResponse, requireApiUser } from "@/lib/auth";
import { CollaborationError } from "./errors";
import type { CollaborationActor } from "./types";

const MAX_API_BODY_BYTES = Number(process.env.AH2D_MAX_API_BODY_BYTES) || 18 * 1024 * 1024;

interface ApiSuccessOptions {
  status?: number;
  revision?: number;
  headers?: HeadersInit;
}

export function apiSuccess(data: unknown, options: ApiSuccessOptions = {}): Response {
  const headers = new Headers(options.headers);
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return Response.json(
    {
      ok: true,
      data,
      ...(options.revision !== undefined ? { revision: options.revision } : {}),
    },
    { status: options.status ?? 200, headers },
  );
}

export function apiError(error: unknown): Response {
  if (error instanceof AuthError) return authErrorResponse(error);
  if (error instanceof Response) {
    if (error.headers.get("content-type")?.includes("application/json")) return error;
    return Response.json(
      { ok: false, error: { code: "AUTHENTICATION_REQUIRED", message: error.statusText || "Authentication failed." } },
      { status: error.status || 401, headers: error.headers },
    );
  }
  if (error instanceof CollaborationError) {
    return Response.json(
      {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
        ...(error.revision !== undefined ? { revision: error.revision } : {}),
      },
      { status: error.status },
    );
  }
  if (error instanceof SyntaxError) {
    return Response.json(
      { ok: false, error: { code: "INVALID_JSON", message: "Request body contains invalid JSON." } },
      { status: 400 },
    );
  }
  console.error("Unhandled collaboration API error", error);
  return Response.json(
    { ok: false, error: { code: "INTERNAL_ERROR", message: "An internal server error occurred." } },
    { status: 500 },
  );
}

export async function authenticatedApi(
  request: Request,
  handler: (actor: CollaborationActor) => Promise<Response>,
): Promise<Response> {
  try {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) {
      assertSameOrigin(request);
    }
    const user = await requireApiUser(request);
    const actor: CollaborationActor = {
      id: user.id,
      name: user.name || user.email || "User",
      email: user.email ?? null,
      accountRole: user.role,
    };
    return await handler(actor);
  } catch (error) {
    return apiError(error);
  }
}

export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_API_BODY_BYTES) {
    throw new CollaborationError(
      "REQUEST_BODY_TOO_LARGE",
      "Request body exceeds the configured size limit.",
      413,
      { maximumBytes: MAX_API_BODY_BYTES },
    );
  }
  if (!request.body) throw new CollaborationError("INVALID_BODY", "Request body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_API_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new CollaborationError(
        "REQUEST_BODY_TOO_LARGE",
        "Request body exceeds the configured size limit.",
        413,
        { maximumBytes: MAX_API_BODY_BYTES },
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
  const body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CollaborationError("INVALID_BODY", "Request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

export type ProjectRouteContext = {
  params: Promise<{ projectId: string }>;
};

export type CommentRouteContext = {
  params: Promise<{ projectId: string; commentId: string }>;
};

export type MemberRouteContext = {
  params: Promise<{ projectId: string; userId: string }>;
};
