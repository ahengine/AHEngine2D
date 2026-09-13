import type { AuthContext, Permission, Role } from "../../types/auth";
import { AuthorizationError } from "./errors";

const ROLE_RANK: Record<Role, number> = {
  OWNER: 5,
  ADMIN: 4,
  EDITOR: 3,
  COMMENTER: 2,
  VIEWER: 1,
};

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  OWNER: [
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
  ],
  ADMIN: [
    "project:read",
    "project:edit",
    "project:comment",
    "collaboration:read",
    "collaboration:write",
    "members:read",
    "members:manage",
    "roles:manage",
    "history:read",
  ],
  EDITOR: [
    "project:read",
    "project:edit",
    "project:comment",
    "collaboration:read",
    "collaboration:write",
    "members:read",
    "members:manage",
    "history:read",
  ],
  COMMENTER: [
    "project:read",
    "project:comment",
    "collaboration:read",
    "collaboration:write",
    "members:read",
    "history:read",
  ],
  VIEWER: ["project:read", "collaboration:read", "members:read", "history:read"],
};

export function permissionsForRole(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export function hasPermission(
  subject: Pick<AuthContext, "permissions"> | Role,
  permission: Permission,
): boolean {
  const permissions = typeof subject === "string" ? ROLE_PERMISSIONS[subject] : subject.permissions;
  return permissions.includes(permission);
}

export function requirePermission(
  subject: Pick<AuthContext, "permissions"> | Role,
  permission: Permission,
): void {
  if (!hasPermission(subject, permission)) {
    throw new AuthorizationError(`Missing required permission: ${permission}.`);
  }
}

export function canManageRole(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === "OWNER") return true;
  if (actorRole !== "ADMIN") return false;
  return ROLE_RANK[targetRole] < ROLE_RANK.ADMIN;
}

export function requireRoleManagement(actorRole: Role, targetRole: Role): void {
  if (!canManageRole(actorRole, targetRole)) {
    throw new AuthorizationError("This role cannot be assigned or managed by the current user.");
  }
}
