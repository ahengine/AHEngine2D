import { NextResponse } from "next/server";
import {
  SESSION_COOKIE_NAME,
  assertSameOrigin,
  authErrorResponse,
  clearedSessionCookieOptions,
  logoutSessionToken,
  sessionTokenFromRequest,
} from "../../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    await logoutSessionToken(sessionTokenFromRequest(request));
    const response = new NextResponse(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
    response.cookies.set(SESSION_COOKIE_NAME, "", clearedSessionCookieOptions());
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}
