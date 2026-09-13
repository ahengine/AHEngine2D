import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { AuthError } from "./errors";

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const MAX_PASSWORD_LENGTH = 1_024;

// A syntactically valid hash used for unknown users, keeping password checks
// computationally similar without embedding a working credential.
export const DUMMY_PASSWORD_HASH = `$scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${"00".repeat(16)}$${"00".repeat(KEY_LENGTH)}`;

function deriveKey(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      { N: n, r, p, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

export function validateNewPassword(password: unknown): asserts password is string {
  if (typeof password !== "string" || password.length < 12) {
    throw new AuthError(
      "WEAK_PASSWORD",
      "Password must contain at least 12 characters.",
      422,
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new AuthError("PASSWORD_TOO_LONG", "Password is too long.", 422);
  }
}

export async function hashPassword(password: string): Promise<string> {
  validateNewPassword(password);
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `$scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: unknown, encoded: string): Promise<boolean> {
  if (typeof password !== "string" || password.length > MAX_PASSWORD_LENGTH) return false;

  const parts = encoded.split("$");
  if (parts.length !== 7 || parts[1] !== "scrypt") return false;

  const n = Number(parts[2]);
  const r = Number(parts[3]);
  const p = Number(parts[4]);
  if (
    !Number.isSafeInteger(n) ||
    n < 2 ||
    n > 131_072 ||
    (n & (n - 1)) !== 0 ||
    !Number.isSafeInteger(r) ||
    r < 1 ||
    r > 32 ||
    !Number.isSafeInteger(p) ||
    p < 1 ||
    p > 16
  ) {
    return false;
  }

  const salt = Buffer.from(parts[5], "hex");
  const expected = Buffer.from(parts[6], "hex");
  if (salt.length < 16 || expected.length !== KEY_LENGTH) return false;

  try {
    const actual = await deriveKey(password, salt, n, r, p);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
