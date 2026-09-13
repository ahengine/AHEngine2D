import { NextResponse } from "next/server";
import {
  SESSION_COOKIE_NAME,
  assertSameOrigin,
  authErrorResponse,
  loginWithCredentials,
  readAuthJsonObject,
  requestIp,
  sessionCookieOptions,
} from "../../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const input = await readAuthJsonObject(request);
    const issued = await loginWithCredentials({
      email: input.email,
      password: input.password,
      ip: requestIp(request),
    });
    const response = NextResponse.json(
      { ok: true, data: issued.context },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
    response.cookies.set(
      SESSION_COOKIE_NAME,
      issued.token,
      sessionCookieOptions(new Date(issued.context.session.expiresAt)),
    );
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}
