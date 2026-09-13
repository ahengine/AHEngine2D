import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AuthConfigurationError } from "./errors";

export const SESSION_COOKIE_NAME = "ah2d_session";

const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
let signingSecretPromise: Promise<Buffer> | undefined;

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

export function authStorePath(): string {
  return path.resolve(/* turbopackIgnore: true */ process.env.AH2D_AUTH_STORE_PATH || path.join(process.cwd(), ".ah2d-data", "auth-store.json"));
}

export function sessionTtlSeconds(): number {
  return boundedInteger(process.env.AH2D_AUTH_SESSION_TTL_SECONDS, DEFAULT_SESSION_TTL_SECONDS, 300, 60 * 60 * 24 * 30);
}

export function sessionCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" || process.env.AH2D_AUTH_SECURE_COOKIE === "true",
    sameSite: "strict" as const,
    path: "/",
    expires,
    maxAge: Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1_000)),
  };
}

export function clearedSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" || process.env.AH2D_AUTH_SECURE_COOKIE === "true",
    sameSite: "strict" as const,
    path: "/",
    expires: new Date(0),
    maxAge: 0,
  };
}

async function loadOrCreateDevelopmentSecret(): Promise<Buffer> {
  const secretPath = path.resolve(/* turbopackIgnore: true */
    process.env.AH2D_AUTH_SECRET_PATH || path.join(path.dirname(authStorePath()), "auth-secret"),
  );
  await mkdir(path.dirname(secretPath), { recursive: true });

  let value: string;
  try {
    value = (await readFile(/* turbopackIgnore: true */ secretPath, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    value = randomBytes(48).toString("base64url");
    try {
      await writeFile(secretPath, `${value}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
      value = (await readFile(/* turbopackIgnore: true */ secretPath, "utf8")).trim();
    }
  }

  if (Buffer.byteLength(value, "utf8") < 32) {
    throw new AuthConfigurationError("The development auth secret file is invalid.");
  }
  return createHash("sha256").update(value, "utf8").digest();
}

export function signingSecret(): Promise<Buffer> {
  if (!signingSecretPromise) {
    signingSecretPromise = (async () => {
      const configured = process.env.AH2D_AUTH_SECRET?.trim();
      if (configured) {
        if (Buffer.byteLength(configured, "utf8") < 32) {
          throw new AuthConfigurationError("AH2D_AUTH_SECRET must contain at least 32 bytes.");
        }
        return createHash("sha256").update(configured, "utf8").digest();
      }

      if (process.env.NODE_ENV === "production") {
        throw new AuthConfigurationError("AH2D_AUTH_SECRET is required in production.");
      }
      return loadOrCreateDevelopmentSecret();
    })();
  }
  return signingSecretPromise;
}
