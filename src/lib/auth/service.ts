import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  AuthContext,
  IssuedSession,
  Permission,
  PublicAuthUser,
  Role,
  StoredAuthSession,
  StoredAuthUser,
} from "../../types/auth";
import { sessionTtlSeconds, signingSecret } from "./config";
import {
  AuthenticationRequiredError,
  AuthConfigurationError,
  AuthError,
} from "./errors";
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "./password";
import { permissionsForRole, requirePermission } from "./rbac";
import {
  findSessionByTokenHash,
  findUserByEmail,
  findUserById,
  insertSession,
  insertUser,
  readAuthStore,
  revokeSessionByTokenHash,
  touchSession,
} from "./store";

const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1_000;
const LOGIN_WINDOW_MS = 15 * 60 * 1_000;
const LOGIN_MAX_FAILURES = 5;
const loginFailures = new Map<string, { count: number; resetAt: number }>();

export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toLocaleLowerCase("en-US");
}

export function validateEmail(email: string): void {
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AuthError("INVALID_EMAIL", "Enter a valid email address.", 422);
  }
}

export function publicUser(user: StoredAuthUser): PublicAuthUser {
  const { passwordHash: _passwordHash, ...safeUser } = user;
  return safeUser;
}

function sessionTokenHash(sessionId: string): string {
  return createHash("sha256").update(sessionId, "utf8").digest("hex");
}

async function signSessionId(sessionId: string): Promise<string> {
  const base = `v1.${sessionId}`;
  const signature = createHmac("sha256", await signingSecret()).update(base, "utf8").digest("base64url");
  return `${base}.${signature}`;
}

async function verifySessionToken(token: string): Promise<string | undefined> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !/^[A-Za-z0-9_-]{32,128}$/.test(parts[1])) {
    return undefined;
  }

  const base = `${parts[0]}.${parts[1]}`;
  const expected = createHmac("sha256", await signingSecret()).update(base, "utf8").digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(parts[2], "base64url");
  } catch {
    return undefined;
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined;
  return parts[1];
}

function contextFor(user: StoredAuthUser, session: StoredAuthSession): AuthContext {
  return {
    user: publicUser(user),
    session: {
      id: session.id,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
    },
    permissions: permissionsForRole(user.role),
  };
}

function rateLimitKey(email: string, ip: string): string {
  return `${ip || "unknown"}\u0000${email}`;
}

function assertLoginAllowed(key: string): void {
  const now = Date.now();
  for (const [candidate, state] of loginFailures) {
    if (state.resetAt <= now) loginFailures.delete(candidate);
  }
  const state = loginFailures.get(key);
  if (state && state.count >= LOGIN_MAX_FAILURES && state.resetAt > now) {
    throw new AuthError("LOGIN_RATE_LIMITED", "Too many login attempts. Try again later.", 429, {
      retryAfterSeconds: Math.ceil((state.resetAt - now) / 1_000),
    });
  }
}

function recordLoginFailure(key: string): void {
  const now = Date.now();
  const state = loginFailures.get(key);
  if (!state || state.resetAt <= now) {
    loginFailures.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    state.count += 1;
  }
}

export async function bootstrapOwnerFromEnvironment(): Promise<boolean> {
  const store = await readAuthStore();
  if (store.users.length > 0) return false;

  const email = normalizeEmail(process.env.AH2D_BOOTSTRAP_OWNER_EMAIL);
  const password = process.env.AH2D_BOOTSTRAP_OWNER_PASSWORD;
  if (!email && !password) return false;
  if (!email || !password) {
    throw new AuthConfigurationError(
      "Both AH2D_BOOTSTRAP_OWNER_EMAIL and AH2D_BOOTSTRAP_OWNER_PASSWORD are required.",
    );
  }

  validateEmail(email);
  const now = new Date().toISOString();
  await insertUser({
    id: randomUUID(),
    email,
    displayName: process.env.AH2D_BOOTSTRAP_OWNER_NAME?.trim() || "Project Owner",
    passwordHash: await hashPassword(password),
    role: "OWNER",
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  });
  return true;
}

export async function createLocalUser(input: {
  email: string;
  displayName: string;
  password: string;
  role?: Role;
}): Promise<PublicAuthUser> {
  const email = normalizeEmail(input.email);
  validateEmail(email);
  const displayName = input.displayName.trim();
  if (!displayName || displayName.length > 100) {
    throw new AuthError("INVALID_DISPLAY_NAME", "Display name is required and must be at most 100 characters.", 422);
  }

  const now = new Date().toISOString();
  const user: StoredAuthUser = {
    id: randomUUID(),
    email,
    displayName,
    passwordHash: await hashPassword(input.password),
    role: input.role ?? "VIEWER",
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  };
  await insertUser(user);
  return publicUser(user);
}

export async function loginWithCredentials(input: {
  email: unknown;
  password: unknown;
  ip?: string;
}): Promise<IssuedSession> {
  await bootstrapOwnerFromEnvironment();
  const email = normalizeEmail(input.email);
  const key = rateLimitKey(email, input.ip ?? "");
  assertLoginAllowed(key);

  const user = email ? await findUserByEmail(email) : undefined;
  const passwordMatches = await verifyPassword(
    input.password,
    user?.passwordHash ?? DUMMY_PASSWORD_HASH,
  );
  if (!user || !passwordMatches || user.status !== "ACTIVE") {
    recordLoginFailure(key);
    throw new AuthError("INVALID_CREDENTIALS", "Email or password is incorrect.", 401);
  }

  loginFailures.delete(key);
  const sessionId = randomBytes(32).toString("base64url");
  const now = new Date();
  const expires = new Date(now.getTime() + sessionTtlSeconds() * 1_000);
  const session: StoredAuthSession = {
    id: randomUUID(),
    tokenHash: sessionTokenHash(sessionId),
    userId: user.id,
    createdAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    expiresAt: expires.toISOString(),
  };
  await insertSession(session);

  return { token: await signSessionId(sessionId), context: contextFor(user, session) };
}

export async function authenticateSessionToken(token: string | undefined): Promise<AuthContext | undefined> {
  if (!token) return undefined;
  const sessionId = await verifySessionToken(token);
  if (!sessionId) return undefined;

  const tokenHash = sessionTokenHash(sessionId);
  const session = await findSessionByTokenHash(tokenHash);
  if (!session) return undefined;
  if (Date.parse(session.expiresAt) <= Date.now()) {
    await revokeSessionByTokenHash(tokenHash);
    return undefined;
  }

  const user = await findUserById(session.userId);
  if (!user || user.status !== "ACTIVE") {
    await revokeSessionByTokenHash(tokenHash);
    return undefined;
  }

  if (Date.now() - Date.parse(session.lastSeenAt) >= SESSION_TOUCH_INTERVAL_MS) {
    session.lastSeenAt = new Date().toISOString();
    await touchSession(session.id, session.lastSeenAt);
  }
  return contextFor(user, session);
}

export async function logoutSessionToken(token: string | undefined): Promise<void> {
  if (!token) return;
  const sessionId = await verifySessionToken(token);
  if (sessionId) await revokeSessionByTokenHash(sessionTokenHash(sessionId));
}

export async function requireSessionToken(token: string | undefined): Promise<AuthContext> {
  const context = await authenticateSessionToken(token);
  if (!context) throw new AuthenticationRequiredError();
  return context;
}

export async function authorizeSessionToken(
  token: string | undefined,
  permission: Permission,
): Promise<AuthContext> {
  const context = await requireSessionToken(token);
  requirePermission(context, permission);
  return context;
}
