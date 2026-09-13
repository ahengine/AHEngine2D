import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  authenticateSessionToken,
  authorizeSessionToken,
  loginWithCredentials,
  logoutSessionToken,
} from "./service";
import { canManageRole, hasPermission } from "./rbac";
import { POST as loginRoute } from "../../app/api/auth/login/route";
import { POST as logoutRoute } from "../../app/api/auth/logout/route";
import { GET as meRoute } from "../../app/api/auth/me/route";
import { requireApiUser } from "./server";
import { MAX_AUTH_BODY_BYTES } from "./http";

test("credential login creates a signed, revocable session with OWNER permissions", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ah2d-auth-test-"));
  const storePath = path.join(directory, "auth.json");
  process.env.AH2D_AUTH_STORE_PATH = storePath;
  process.env.AH2D_AUTH_SECRET = "test-only-auth-secret-that-is-at-least-thirty-two-bytes";
  process.env.AH2D_BOOTSTRAP_OWNER_EMAIL = "owner@example.com";
  process.env.AH2D_BOOTSTRAP_OWNER_PASSWORD = "a-secure-test-password";
  process.env.AH2D_BOOTSTRAP_OWNER_NAME = "Test Owner";

  try {
    await assert.rejects(
      loginWithCredentials({ email: "owner@example.com", password: "incorrect", ip: "test-1" }),
      (error: unknown) => (error as { code?: string }).code === "INVALID_CREDENTIALS",
    );

    const issued = await loginWithCredentials({
      email: "OWNER@example.com",
      password: "a-secure-test-password",
      ip: "test-2",
    });
    assert.equal(issued.context.user.displayName, "Test Owner");
    assert.equal(issued.context.user.role, "OWNER");
    assert.equal(issued.context.permissions.includes("roles:manage"), true);
    assert.equal("passwordHash" in issued.context.user, false);

    const restored = await authenticateSessionToken(issued.token);
    assert.equal(restored?.user.id, issued.context.user.id);
    await authorizeSessionToken(issued.token, "project:delete");
    assert.equal(await authenticateSessionToken(`${issued.token}x`), undefined);

    const persisted = await readFile(storePath, "utf8");
    assert.equal(persisted.includes("a-secure-test-password"), false);

    await logoutSessionToken(issued.token);
    assert.equal(await authenticateSessionToken(issued.token), undefined);
  } finally {
    delete process.env.AH2D_AUTH_STORE_PATH;
    delete process.env.AH2D_AUTH_SECRET;
    delete process.env.AH2D_BOOTSTRAP_OWNER_EMAIL;
    delete process.env.AH2D_BOOTSTRAP_OWNER_PASSWORD;
    delete process.env.AH2D_BOOTSTRAP_OWNER_NAME;
    await rm(directory, { recursive: true, force: true });
  }
});

test("RBAC keeps destructive and role-management privileges constrained", () => {
  assert.equal(hasPermission("VIEWER", "project:read"), true);
  assert.equal(hasPermission("VIEWER", "project:edit"), false);
  assert.equal(hasPermission("ADMIN", "project:delete"), false);
  assert.equal(canManageRole("ADMIN", "EDITOR"), true);
  assert.equal(canManageRole("ADMIN", "ADMIN"), false);
  assert.equal(canManageRole("OWNER", "OWNER"), true);
});

test("authentication routes reject oversized bodies before parsing credentials", async () => {
  const response = await loginRoute(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(MAX_AUTH_BODY_BYTES + 1),
        Origin: "http://localhost",
      },
      body: "{}",
    }),
  );
  assert.equal(response.status, 413);
  const payload = (await response.json()) as {
    error?: { code?: string; details?: { maximumBytes?: number } };
  };
  assert.equal(payload.error?.code, "REQUEST_BODY_TOO_LARGE");
  assert.equal(payload.error?.details?.maximumBytes, MAX_AUTH_BODY_BYTES);
});

test("App Router login, me, API actor and logout share the HttpOnly session", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ah2d-auth-route-test-"));
  process.env.AH2D_AUTH_STORE_PATH = path.join(directory, "auth.json");
  process.env.AH2D_AUTH_SECRET = "test-only-auth-secret-that-is-at-least-thirty-two-bytes";
  process.env.AH2D_BOOTSTRAP_OWNER_EMAIL = "route-owner@example.com";
  process.env.AH2D_BOOTSTRAP_OWNER_PASSWORD = "a-secure-route-password";
  process.env.AH2D_BOOTSTRAP_OWNER_NAME = "Route Owner";

  try {
    const loginResponse = await loginRoute(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost" },
        body: JSON.stringify({
          email: "route-owner@example.com",
          password: "a-secure-route-password",
        }),
      }),
    );
    assert.equal(loginResponse.status, 200);
    const setCookie = loginResponse.headers.get("set-cookie");
    assert.match(setCookie ?? "", /ah2d_session=/);
    assert.match(setCookie ?? "", /HttpOnly/i);
    assert.match(setCookie ?? "", /SameSite=strict/i);

    const cookie = setCookie?.split(";", 1)[0] ?? "";
    const authenticatedRequest = new Request("http://localhost/api/auth/me", {
      headers: { Cookie: cookie },
    });
    const meResponse = await meRoute(authenticatedRequest);
    assert.equal(meResponse.status, 200);
    const me = (await meResponse.json()) as { data: { user: { email: string } } };
    assert.equal(me.data.user.email, "route-owner@example.com");

    const actor = await requireApiUser(authenticatedRequest);
    assert.deepEqual(
      { name: actor.name, email: actor.email },
      { name: "Route Owner", email: "route-owner@example.com" },
    );

    const logoutResponse = await logoutRoute(
      new Request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: { Cookie: cookie, Origin: "http://localhost" },
      }),
    );
    assert.equal(logoutResponse.status, 204);
    assert.equal((await meRoute(authenticatedRequest)).status, 401);

    await assert.rejects(
      requireApiUser(authenticatedRequest),
      (error: unknown) => error instanceof Response && error.status === 401,
    );
  } finally {
    delete process.env.AH2D_AUTH_STORE_PATH;
    delete process.env.AH2D_AUTH_SECRET;
    delete process.env.AH2D_BOOTSTRAP_OWNER_EMAIL;
    delete process.env.AH2D_BOOTSTRAP_OWNER_PASSWORD;
    delete process.env.AH2D_BOOTSTRAP_OWNER_NAME;
    await rm(directory, { recursive: true, force: true });
  }
});
