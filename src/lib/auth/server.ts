import { cookies } from "next/headers";
import type { AuthContext, PublicAuthUser, Role } from "../../types/auth";
import { SESSION_COOKIE_NAME } from "./config";
import { AuthenticationRequiredError } from "./errors";
import { authenticateSessionToken, requireSessionToken } from "./service";
import { authErrorResponse, sessionTokenFromRequest } from "./http";
import { findUserById } from "./store";

/** Minimal identity contract consumed by collaboration and other API modules. */
export interface ApiUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

/** Canonical account lookup for trusted server modules (never exposes password data). */
export async function findApiUserById(userId: string): Promise<ApiUser | null> {
  const user = await findUserById(userId);
  if (!user || user.status !== "ACTIVE") return null;
  return { id: user.id, name: user.displayName, email: user.email, role: user.role };
}

export type CurrentUser = PublicAuthUser & { name: string };

async function tokenFromServerCookies(): Promise<string | undefined> {
  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE_NAME)?.value;
}

export async function getCurrentAuthContext(): Promise<AuthContext | null> {
  return (await authenticateSessionToken(await tokenFromServerCookies())) ?? null;
}

/** Returns the signed-in user in Server Components, or null for a guest. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const user = (await getCurrentAuthContext())?.user;
  return user ? { ...user, name: user.displayName } : null;
}

/**
 * Resolves an API-safe actor without coupling consumers to sessions or RBAC.
 * A Request is preferred in Route Handlers; omission reads App Router cookies.
 */
export async function requireApiUser(request?: Request): Promise<ApiUser> {
  try {
    const context = request
      ? await requireSessionToken(sessionTokenFromRequest(request))
      : await getCurrentAuthContext();
    if (!context) throw new AuthenticationRequiredError();
    return {
      id: context.user.id,
      name: context.user.displayName,
      email: context.user.email,
      role: context.user.role,
    };
  } catch (error) {
    throw authErrorResponse(error);
  }
}
