export const AH2D_ROLES = [
  "OWNER",
  "ADMIN",
  "EDITOR",
  "COMMENTER",
  "VIEWER",
] as const;

export type Role = (typeof AH2D_ROLES)[number];

export const AH2D_PERMISSIONS = [
  "project:read",
  "project:edit",
  "project:comment",
  "project:delete",
  "collaboration:read",
  "collaboration:write",
  "members:read",
  "members:manage",
  "roles:manage",
  "history:read",
] as const;

export type Permission = (typeof AH2D_PERMISSIONS)[number];

export type UserStatus = "ACTIVE" | "DISABLED";

export interface StoredAuthUser {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  role: Role;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PublicAuthUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}

export interface StoredAuthSession {
  id: string;
  tokenHash: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface AuthStoreDocument {
  format: "AH2D_AUTH";
  version: 1;
  users: StoredAuthUser[];
  sessions: StoredAuthSession[];
}

export interface AuthContext {
  user: PublicAuthUser;
  session: Pick<StoredAuthSession, "id" | "createdAt" | "lastSeenAt" | "expiresAt">;
  permissions: Permission[];
}

export interface IssuedSession {
  token: string;
  context: AuthContext;
}
