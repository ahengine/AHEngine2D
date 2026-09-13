import { CollaborationError } from "./errors";
import type { CollaborationActor } from "./types";

const MAX_API_BODY_BYTES = Number(process.env.AH2D_MAX_API_BODY_BYTES) || 18 * 1024 * 1024;
const ACTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MAX_ACTOR_NAME_LENGTH = 160;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export const LOCAL_ACTOR: Readonly<CollaborationActor> = {
  id: "local",
  name: "Local User",
};

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
    throw new CollaborationError(
      "INVALID_ORIGIN",
      "Cross-origin collaboration request rejected.",
      403,
    );
  }
}

function optionalActorValue(value: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function actorFromRequest(request: Request): CollaborationActor {
  const url = new URL(request.url);
  const id = optionalActorValue(request.headers.get("x-ah2d-actor-id"))
    ?? optionalActorValue(url.searchParams.get("actorId"));
  const name = optionalActorValue(request.headers.get("x-ah2d-actor-name"))
    ?? optionalActorValue(url.searchParams.get("actorName"));

  if (id && !ACTOR_ID_PATTERN.test(id)) {
    throw new CollaborationError(
      "INVALID_ACTOR",
      "Actor ID must contain 1 to 160 safe identifier characters.",
      400,
    );
  }
  if (name && (name.length > MAX_ACTOR_NAME_LENGTH || CONTROL_CHARACTER_PATTERN.test(name))) {
    throw new CollaborationError(
      "INVALID_ACTOR",
      "Actor name must contain at most 160 characters and no control characters.",
      400,
    );
  }

  return {
    id: id ?? LOCAL_ACTOR.id,
    name: name ?? LOCAL_ACTOR.name,
  };
}

export async function collaborationApi(
  request: Request,
  handler: (actor: CollaborationActor) => Promise<Response>,
): Promise<Response> {
  try {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) {
      assertSameOrigin(request);
    }
    return await handler(actorFromRequest(request));
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
