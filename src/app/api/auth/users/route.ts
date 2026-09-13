import { NextResponse } from "next/server";
import {
  AH2D_ROLES,
  assertSameOrigin,
  authErrorResponse,
  createLocalUser,
  publicUser,
  readAuthJsonObject,
  requireRequestPermission,
  requireRoleManagement,
  type Role,
} from "@/lib/auth";
import { AuthError } from "@/lib/auth/errors";
import { readAuthStore } from "@/lib/auth/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    await requireRequestPermission(request, "members:manage");
    const users = (await readAuthStore()).users
      .map(publicUser)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    return NextResponse.json(
      { ok: true, data: { users } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const context = await requireRequestPermission(request, "roles:manage");
    const body = await readAuthJsonObject(request);
    const role = body.role ?? "VIEWER";
    if (typeof role !== "string" || !AH2D_ROLES.includes(role as Role)) {
      throw new AuthError("INVALID_ROLE", "Choose a valid account role.", 422);
    }
    requireRoleManagement(context.user.role, role as Role);
    const normalizedEmail = typeof body.email === "string"
      ? body.email.trim().toLocaleLowerCase("en-US")
      : "";
    if ((await readAuthStore()).users.some((user) => user.email === normalizedEmail)) {
      throw new AuthError("EMAIL_ALREADY_EXISTS", "An account with this email already exists.", 409);
    }
    const user = await createLocalUser({
      email: normalizedEmail,
      displayName: typeof body.displayName === "string" ? body.displayName : "",
      password: typeof body.password === "string" ? body.password : "",
      role: role as Role,
    });
    return NextResponse.json(
      { ok: true, data: { user } },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}
