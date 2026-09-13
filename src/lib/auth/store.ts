import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import type {
  AuthStoreDocument,
  StoredAuthSession,
  StoredAuthUser,
} from "../../types/auth";
import { authStorePath } from "./config";
import { AuthConfigurationError } from "./errors";

let mutationTail: Promise<unknown> = Promise.resolve();

function emptyStore(): AuthStoreDocument {
  return { format: "AH2D_AUTH", version: 1, users: [], sessions: [] };
}

function assertStore(value: unknown): asserts value is AuthStoreDocument {
  const candidate = value as Partial<AuthStoreDocument> | null;
  if (
    !candidate ||
    candidate.format !== "AH2D_AUTH" ||
    candidate.version !== 1 ||
    !Array.isArray(candidate.users) ||
    !Array.isArray(candidate.sessions)
  ) {
    throw new AuthConfigurationError("The AH2D auth store is malformed or unsupported.");
  }
}

export async function readAuthStore(): Promise<AuthStoreDocument> {
  try {
    const document = JSON.parse(await readFile(authStorePath(), "utf8")) as unknown;
    assertStore(document);
    return document;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    if (error instanceof SyntaxError) {
      throw new AuthConfigurationError("The AH2D auth store contains invalid JSON.");
    }
    throw error;
  }
}

async function writeAuthStore(document: AuthStoreDocument): Promise<void> {
  const target = authStorePath();
  const directory = path.dirname(target);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true });

  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
}

export function mutateAuthStore<T>(
  mutation: (document: AuthStoreDocument) => T | Promise<T>,
): Promise<T> {
  const operation = mutationTail.then(async () => {
    const document = await readAuthStore();
    const result = await mutation(document);
    await writeAuthStore(document);
    return result;
  });
  mutationTail = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

export async function findUserByEmail(email: string): Promise<StoredAuthUser | undefined> {
  return (await readAuthStore()).users.find((user) => user.email === email);
}

export async function findUserById(id: string): Promise<StoredAuthUser | undefined> {
  return (await readAuthStore()).users.find((user) => user.id === id);
}

export async function insertUser(user: StoredAuthUser): Promise<void> {
  await mutateAuthStore((document) => {
    if (document.users.some((candidate) => candidate.id === user.id || candidate.email === user.email)) {
      throw new AuthConfigurationError("A user with the same ID or email already exists.");
    }
    document.users.push(user);
  });
}

export async function insertSession(session: StoredAuthSession): Promise<void> {
  await mutateAuthStore((document) => {
    const now = Date.now();
    document.sessions = document.sessions.filter(
      (candidate) => Date.parse(candidate.expiresAt) > now && candidate.id !== session.id,
    );
    document.sessions.push(session);
  });
}

export async function findSessionByTokenHash(
  tokenHash: string,
): Promise<StoredAuthSession | undefined> {
  return (await readAuthStore()).sessions.find((session) => session.tokenHash === tokenHash);
}

export async function touchSession(id: string, lastSeenAt: string): Promise<void> {
  await mutateAuthStore((document) => {
    const session = document.sessions.find((candidate) => candidate.id === id);
    if (session) session.lastSeenAt = lastSeenAt;
  });
}

export async function revokeSessionByTokenHash(tokenHash: string): Promise<void> {
  await mutateAuthStore((document) => {
    document.sessions = document.sessions.filter((session) => session.tokenHash !== tokenHash);
  });
}
