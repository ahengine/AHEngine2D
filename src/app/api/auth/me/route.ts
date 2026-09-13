import { NextResponse } from "next/server";
import { authErrorResponse, requireRequestAuth } from "../../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const context = await requireRequestAuth(request);
    return NextResponse.json(
      { ok: true, data: context },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}
