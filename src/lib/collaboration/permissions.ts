import { CollaborationError } from "./errors";
import type {
  CollaborationPermission,
  ProjectMember,
  ProjectRole,
  StoredCollaborationProject,
} from "./types";

const ROLE_PERMISSIONS: Record<ProjectRole, ReadonlySet<CollaborationPermission>> = {
  owner: new Set([
    "project:read", "project:update", "document:read", "document:write",
    "comment:read", "comment:create", "comment:moderate", "history:read",
    "member:read", "member:manage", "presence:read", "presence:write",
  ]),
  admin: new Set([
    "project:read", "project:update", "document:read", "document:write",
    "comment:read", "comment:create", "comment:moderate", "history:read",
    "member:read", "member:manage", "presence:read", "presence:write",
  ]),
  editor: new Set([
    "project:read", "document:read", "document:write", "comment:read",
    "comment:create", "history:read", "member:read", "presence:read", "presence:write",
  ]),
  commenter: new Set([
    "project:read", "document:read", "comment:read", "comment:create",
    "history:read", "member:read", "presence:read", "presence:write",
  ]),
  viewer: new Set([
    "project:read", "document:read", "comment:read", "history:read",
    "member:read", "presence:read", "presence:write",
  ]),
};

export function hasPermission(role: ProjectRole, permission: CollaborationPermission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function memberFor(project: StoredCollaborationProject, userId: string): ProjectMember {
  const member = project.members[userId];
  if (!member) {
    throw new CollaborationError(
      "PROJECT_ACCESS_DENIED",
      "You are not a member of this project.",
      403,
    );
  }
  return member;
}

export function requirePermission(
  project: StoredCollaborationProject,
  userId: string,
  permission: CollaborationPermission,
): ProjectMember {
  const member = memberFor(project, userId);
  if (!hasPermission(member.role, permission)) {
    throw new CollaborationError(
      "PROJECT_PERMISSION_DENIED",
      `Role '${member.role}' does not grant '${permission}'.`,
      403,
      { role: member.role, permission },
    );
  }
  return member;
}

export function canManageMember(
  actor: ProjectMember,
  target: ProjectMember | undefined,
  nextRole?: ProjectRole,
): boolean {
  if (actor.role === "owner") return true;
  if (actor.role !== "admin") return false;
  if (target && (target.role === "owner" || target.role === "admin")) return false;
  return nextRole !== "owner" && nextRole !== "admin";
}

export const PROJECT_ROLES: readonly ProjectRole[] = [
  "owner", "admin", "editor", "commenter", "viewer",
] as const;

export function isProjectRole(value: unknown): value is ProjectRole {
  return typeof value === "string" && PROJECT_ROLES.includes(value as ProjectRole);
}
