import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { hasPermission as hasAccountPermission } from "@/lib/auth";
import type { Permission as AccountPermission } from "@/types/auth";
import { CollaborationError, assertCollaboration } from "./errors";
import { getCollaborationEventHub, type CollaborationEventHub } from "./event-hub";
import { applyJsonPatch } from "./json-patch";
import {
  canManageMember,
  hasPermission,
  isProjectRole,
  requirePermission,
} from "./permissions";
import {
  getCollaborationProjectStore,
  type CollaborationProjectStore,
} from "./store";
import {
  COLLABORATION_SCHEMA,
  type ActorSnapshot,
  type CollaborationActor,
  type CollaborationPermission,
  type CommentAnchor,
  type JsonPatchOperation,
  type MutationOptions,
  type ProjectAction,
  type ProjectActionType,
  type ProjectComment,
  type ProjectMember,
  type ProjectRole,
  type ProjectSummary,
  type StoredCollaborationProject,
} from "./types";

const HISTORY_LIMIT = 2_000;
const MAX_DOCUMENT_BYTES = Number(process.env.AH2D_MAX_PROJECT_BYTES) || 16 * 1024 * 1024;
const projectContract = createRequire(path.join(process.cwd(), "package.json"))(
  "./engine/cli/AH2DProject.js",
) as {
  createProject: (options?: { name?: string }) => Record<string, unknown>;
  syncActiveMirror: (
    document: Record<string, unknown>,
    options?: { touch?: boolean },
  ) => unknown;
  validateDocument: (document: unknown, options?: { strict?: boolean }) => Array<{
    severity: "error" | "warning";
    code: string;
    message: string;
    pointer?: string;
  }>;
};

const ACCOUNT_PERMISSION_FOR_COLLABORATION: Record<CollaborationPermission, AccountPermission> = {
  "project:read": "project:read",
  "project:update": "project:edit",
  "document:read": "project:read",
  "document:write": "project:edit",
  "comment:read": "project:read",
  "comment:create": "project:comment",
  "comment:moderate": "project:comment",
  "history:read": "history:read",
  "member:read": "members:read",
  "member:manage": "members:manage",
  "presence:read": "collaboration:read",
  "presence:write": "collaboration:write",
};

function requireAccountPermission(actor: CollaborationActor, permission: AccountPermission): void {
  // Direct Engine/CLI adapters may omit an account role. Every HTTP actor has
  // one, and it is a hard upper bound over its project membership role.
  if (actor.accountRole && !hasAccountPermission(actor.accountRole, permission)) {
    throw new CollaborationError(
      "ACCOUNT_PERMISSION_DENIED",
      `Account role '${actor.accountRole}' does not grant '${permission}'.`,
      403,
      { accountRole: actor.accountRole, permission },
    );
  }
}

function requireEffectivePermission(
  project: StoredCollaborationProject,
  actor: CollaborationActor,
  permission: CollaborationPermission,
): ProjectMember {
  requireAccountPermission(actor, ACCOUNT_PERMISSION_FOR_COLLABORATION[permission]);
  return requirePermission(project, actor.id, permission);
}

function actorSnapshot(actor: CollaborationActor): ActorSnapshot {
  return { id: actor.id, name: actor.name, email: actor.email ?? null };
}

function requiredText(value: unknown, label: string, maximum: number): string {
  assertCollaboration(typeof value === "string", "INVALID_INPUT", `${label} must be a string.`);
  const text = value.trim();
  assertCollaboration(text.length > 0, "INVALID_INPUT", `${label} cannot be empty.`);
  assertCollaboration(text.length <= maximum, "INVALID_INPUT", `${label} is too long.`, 400, { maximum });
  return text;
}

function optionalMutationId(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  return requiredText(value, "clientMutationId", 160);
}

function validateDocument(document: unknown): unknown {
  assertCollaboration(
    document !== null && typeof document === "object" && !Array.isArray(document),
    "INVALID_PROJECT_DOCUMENT",
    "The project document must be a JSON object.",
  );
  let serialized: string;
  try {
    serialized = JSON.stringify(document);
  } catch {
    throw new CollaborationError("INVALID_PROJECT_DOCUMENT", "The project document must be JSON serializable.");
  }
  assertCollaboration(serialized !== undefined, "INVALID_PROJECT_DOCUMENT", "The project document is not serializable.");
  let copy: Record<string, unknown>;
  try {
    copy = structuredClone(document) as Record<string, unknown>;
  } catch {
    throw new CollaborationError(
      "INVALID_PROJECT_DOCUMENT",
      "The project document must contain only cloneable JSON data.",
    );
  }
  let mirrorFailure: {
    severity: "error";
    code: string;
    message: string;
    pointer?: string;
  } | undefined;
  try {
    projectContract.syncActiveMirror(copy, { touch: false });
  } catch (error) {
    const contractError = error as { code?: unknown; pointer?: unknown };
    mirrorFailure = {
      severity: "error",
      code: typeof contractError.code === "string" ? contractError.code : "E_ACTIVE_MIRROR",
      message: error instanceof Error
        ? error.message
        : "The active Scene mirror could not be synchronized.",
      ...(typeof contractError.pointer === "string" ? { pointer: contractError.pointer } : {}),
    };
  }
  serialized = JSON.stringify(copy);
  assertCollaboration(
    Buffer.byteLength(serialized, "utf8") <= MAX_DOCUMENT_BYTES,
    "PROJECT_DOCUMENT_TOO_LARGE",
    "The project document exceeds the configured size limit.",
    413,
    { maximumBytes: MAX_DOCUMENT_BYTES },
  );
  const diagnostics = projectContract.validateDocument(copy, { strict: true });
  const failures = diagnostics.filter((item) => item.severity === "error");
  if (mirrorFailure && failures.length === 0) {
    failures.push(mirrorFailure);
  }
  if (failures.length) {
    throw new CollaborationError(
      "INVALID_AH2D_PROJECT",
      `The AH2D project document has ${failures.length} validation error${failures.length === 1 ? "" : "s"}.`,
      422,
      { diagnostics: failures.slice(0, 100) },
    );
  }
  return copy;
}

function documentSha256(document: unknown): string {
  return createHash("sha256").update(JSON.stringify(document), "utf8").digest("hex");
}

function defaultDocument(name: string): Record<string, unknown> {
  return projectContract.createProject({ name });
}

function assertRevision(expected: unknown, actual: number): asserts expected is number {
  if (!Number.isSafeInteger(expected) || (expected as number) < 1) {
    throw new CollaborationError(
      "REVISION_REQUIRED",
      "A positive integer expectedRevision is required for document mutations.",
      428,
      { actualRevision: actual },
      actual,
    );
  }
  if (expected !== actual) {
    throw new CollaborationError(
      "REVISION_CONFLICT",
      "The project document changed since it was read.",
      409,
      { expectedRevision: expected, actualRevision: actual },
      actual,
    );
  }
}

function appendAction(
  project: StoredCollaborationProject,
  type: ProjectActionType,
  actor: CollaborationActor,
  metadata?: Record<string, unknown>,
  clientMutationId?: string,
): ProjectAction {
  const now = new Date().toISOString();
  project.activitySequence += 1;
  project.updatedAt = now;
  const action: ProjectAction = {
    id: randomUUID(),
    sequence: project.activitySequence,
    projectId: project.id,
    type,
    actor: actorSnapshot(actor),
    createdAt: now,
    documentRevision: project.revision,
    clientMutationId,
    metadata,
  };
  project.history.push(action);
  if (project.history.length > HISTORY_LIMIT) {
    project.history.splice(0, project.history.length - HISTORY_LIMIT);
  }
  return action;
}

function findMutationReplay(
  project: StoredCollaborationProject,
  actor: CollaborationActor,
  clientMutationId: string | undefined,
  expectedType: ProjectActionType,
): ProjectAction | undefined {
  if (!clientMutationId) return undefined;
  const prior = project.history.find((action) =>
    action.actor.id === actor.id && action.clientMutationId === clientMutationId,
  );
  if (prior && prior.type !== expectedType) {
    throw new CollaborationError(
      "IDEMPOTENCY_KEY_REUSED",
      "clientMutationId was already used for a different mutation.",
      409,
      { priorActionId: prior.id, priorType: prior.type, expectedType },
      project.revision,
    );
  }
  return prior;
}

function summary(project: StoredCollaborationProject, userId: string): ProjectSummary {
  const member = project.members[userId];
  return {
    id: project.id,
    name: project.name,
    ownerId: project.ownerId,
    role: member.role,
    revision: project.revision,
    activitySequence: project.activitySequence,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    memberCount: Object.keys(project.members).length,
    openCommentCount: project.comments.filter((comment) => comment.status === "open").length,
  };
}

function publicProject(project: StoredCollaborationProject, userId: string) {
  return {
    ...summary(project, userId),
    members: Object.values(project.members),
  };
}

function validateAnchor(value: unknown): CommentAnchor | undefined {
  if (value == null) return undefined;
  assertCollaboration(value && typeof value === "object" && !Array.isArray(value), "INVALID_COMMENT_ANCHOR", "Comment anchor must be an object.");
  const input = value as Record<string, unknown>;
  const anchor: CommentAnchor = {};
  for (const key of ["sceneId", "entityId", "path"] as const) {
    if (input[key] != null) anchor[key] = requiredText(input[key], `anchor.${key}`, 256);
  }
  for (const key of ["x", "y", "frame"] as const) {
    if (input[key] != null) {
      assertCollaboration(typeof input[key] === "number" && Number.isFinite(input[key]), "INVALID_COMMENT_ANCHOR", `anchor.${key} must be finite.`);
      anchor[key] = input[key] as number;
    }
  }
  return anchor;
}

export class CollaborationService {
  constructor(
    private readonly store: CollaborationProjectStore = getCollaborationProjectStore(),
    readonly events: CollaborationEventHub = getCollaborationEventHub(),
  ) {}

  async createProject(
    actor: CollaborationActor,
    input: { name: unknown; document?: unknown },
  ): Promise<{ project: ReturnType<typeof publicProject>; action: ProjectAction }> {
    requireAccountPermission(actor, "project:edit");
    const name = requiredText(input.name, "name", 120);
    const now = new Date().toISOString();
    const id = this.store.createId();
    const owner: ProjectMember = {
      userId: actor.id,
      role: "owner",
      name: actor.name,
      email: actor.email ?? null,
      joinedAt: now,
      updatedAt: now,
    };
    const project: StoredCollaborationProject = {
      schema: COLLABORATION_SCHEMA,
      id,
      name,
      ownerId: actor.id,
      createdAt: now,
      updatedAt: now,
      revision: 1,
      activitySequence: 0,
      document: validateDocument(input.document ?? defaultDocument(name)),
      members: { [actor.id]: owner },
      comments: [],
      history: [],
    };
    const action = appendAction(project, "project.created", actor, { name });
    await this.store.create(project);
    this.events.publish(project.id, "project.changed", { action }, { actor: action.actor, revision: project.revision });
    return { project: publicProject(project, actor.id), action };
  }

  async listProjects(actor: CollaborationActor): Promise<ProjectSummary[]> {
    const projects = await this.store.list();
    return projects
      .filter((project) => Boolean(project.members[actor.id]))
      .map((project) => summary(project, actor.id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getProject(actor: CollaborationActor, projectId: string) {
    const project = await this.authorize(actor, projectId, "project:read");
    return publicProject(project, actor.id);
  }

  async updateProject(
    actor: CollaborationActor,
    projectId: string,
    input: { name: unknown; clientMutationId?: unknown },
  ) {
    const name = requiredText(input.name, "name", 120);
    const clientMutationId = optionalMutationId(input.clientMutationId);
    const { project, result } = await this.store.mutate(projectId, (value) => {
      requireEffectivePermission(value, actor, "project:update");
      const replay = findMutationReplay(value, actor, clientMutationId, "project.updated");
      if (replay) return { action: replay, replayed: true };
      const previousName = value.name;
      value.name = name;
      return {
        action: appendAction(value, "project.updated", actor, { previousName, name }, clientMutationId),
        replayed: false,
      };
    });
    if (!result.replayed) {
      this.events.publish(projectId, "project.changed", { action: result.action }, {
        actor: result.action.actor,
        revision: project.revision,
      });
    }
    return { project: publicProject(project, actor.id), ...result };
  }

  async getDocument(actor: CollaborationActor, projectId: string) {
    const project = await this.authorize(actor, projectId, "document:read");
    return { document: structuredClone(project.document), revision: project.revision, updatedAt: project.updatedAt };
  }

  async replaceDocument(
    actor: CollaborationActor,
    projectId: string,
    input: { document: unknown; expectedRevision: unknown; clientMutationId?: unknown },
  ) {
    const document = validateDocument(input.document);
    const clientMutationId = optionalMutationId(input.clientMutationId);
    const { project, result } = await this.store.mutate(projectId, (value) => {
      requireEffectivePermission(value, actor, "document:write");
      const replay = findMutationReplay(value, actor, clientMutationId, "document.replaced");
      if (replay) return { action: replay, replayed: true };
      assertRevision(input.expectedRevision, value.revision);
      value.document = document;
      value.revision += 1;
      return {
        action: appendAction(value, "document.replaced", actor, {
          documentSha256: documentSha256(value.document),
        }, clientMutationId),
        replayed: false,
      };
    });
    if (!result.replayed) {
      this.events.publish(projectId, "document.changed", { mode: "replace", action: result.action }, {
        actor: result.action.actor,
        revision: project.revision,
      });
    }
    return { revision: project.revision, action: result.action, replayed: result.replayed };
  }

  async patchDocument(
    actor: CollaborationActor,
    projectId: string,
    input: { operations: JsonPatchOperation[]; expectedRevision: unknown; clientMutationId?: unknown },
  ) {
    const clientMutationId = optionalMutationId(input.clientMutationId);
    const { project, result } = await this.store.mutate(projectId, (value) => {
      requireEffectivePermission(value, actor, "document:write");
      const replay = findMutationReplay(value, actor, clientMutationId, "document.patched");
      if (replay) return { action: replay, replayed: true };
      assertRevision(input.expectedRevision, value.revision);
      value.document = validateDocument(applyJsonPatch(value.document, input.operations));
      value.revision += 1;
      return {
        action: appendAction(
          value,
          "document.patched",
          actor,
          {
            operationCount: input.operations.length,
            paths: input.operations.map((operation) => operation.path),
            documentSha256: documentSha256(value.document),
          },
          clientMutationId,
        ),
        replayed: false,
      };
    });
    if (!result.replayed) {
      this.events.publish(projectId, "document.changed", {
        mode: "patch",
        operations: input.operations,
        action: result.action,
      }, { actor: result.action.actor, revision: project.revision });
    }
    return { revision: project.revision, action: result.action, replayed: result.replayed };
  }

  async listComments(
    actor: CollaborationActor,
    projectId: string,
    filters: { status?: string | null; sceneId?: string | null; entityId?: string | null } = {},
  ) {
    const project = await this.authorize(actor, projectId, "comment:read");
    return {
      comments: project.comments.filter((comment) =>
        (!filters.status || comment.status === filters.status) &&
        (!filters.sceneId || comment.anchor?.sceneId === filters.sceneId) &&
        (!filters.entityId || comment.anchor?.entityId === filters.entityId),
      ),
      revision: project.revision,
    };
  }

  async createComment(
    actor: CollaborationActor,
    projectId: string,
    input: { body: unknown; anchor?: unknown; parentId?: unknown; clientMutationId?: unknown },
  ) {
    const body = requiredText(input.body, "body", 10_000);
    const anchor = validateAnchor(input.anchor);
    const parentId = input.parentId == null ? undefined : requiredText(input.parentId, "parentId", 160);
    const clientMutationId = optionalMutationId(input.clientMutationId);
    const { project, result } = await this.store.mutate(projectId, (value) => {
      requireEffectivePermission(value, actor, "comment:create");
      const replay = findMutationReplay(value, actor, clientMutationId, "comment.created");
      if (replay) {
        const comment = value.comments.find((candidate) => candidate.id === replay.metadata?.commentId);
        if (!comment) throw new CollaborationError("IDEMPOTENCY_RECORD_EXPIRED", "The prior comment mutation can no longer be replayed.", 409);
        return { comment, action: replay, replayed: true };
      }
      if (parentId && !value.comments.some((comment) => comment.id === parentId)) {
        throw new CollaborationError("PARENT_COMMENT_NOT_FOUND", "Parent comment was not found.", 404);
      }
      const now = new Date().toISOString();
      const comment: ProjectComment = {
        id: randomUUID(),
        projectId,
        author: actorSnapshot(actor),
        body,
        anchor,
        parentId,
        status: "open",
        createdAt: now,
        updatedAt: now,
      };
      value.comments.push(comment);
      const action = appendAction(value, "comment.created", actor, {
        commentId: comment.id,
        parentId,
        anchor,
        bodyPreview: body.slice(0, 240),
      }, clientMutationId);
      return { comment, action, replayed: false };
    });
    if (!result.replayed) {
      this.events.publish(projectId, "comment.changed", { mode: "create", ...result }, {
        actor: result.action.actor,
        revision: project.revision,
      });
    }
    return result;
  }

  async updateComment(
    actor: CollaborationActor,
    projectId: string,
    commentId: string,
    input: { body?: unknown; status?: unknown; clientMutationId?: unknown },
  ) {
    const clientMutationId = optionalMutationId(input.clientMutationId);
    const { project, result } = await this.store.mutate(projectId, (value) => {
      const member = requireEffectivePermission(value, actor, "comment:create");
      const replay = findMutationReplay(value, actor, clientMutationId, "comment.updated");
      if (replay) {
        if (replay.metadata?.commentId !== commentId) {
          throw new CollaborationError(
            "IDEMPOTENCY_KEY_REUSED",
            "clientMutationId was already used for a different comment.",
            409,
            { priorCommentId: replay.metadata?.commentId, commentId },
            value.revision,
          );
        }
        const comment = value.comments.find((candidate) => candidate.id === replay.metadata?.commentId);
        if (!comment) throw new CollaborationError("IDEMPOTENCY_RECORD_EXPIRED", "The prior comment mutation can no longer be replayed.", 409);
        return { comment, action: replay, replayed: true };
      }
      const comment = value.comments.find((candidate) => candidate.id === commentId);
      if (!comment) throw new CollaborationError("COMMENT_NOT_FOUND", "Comment was not found.", 404);
      const mayEdit = comment.author.id === actor.id || hasPermission(member.role, "comment:moderate");
      if (!mayEdit) throw new CollaborationError("COMMENT_PERMISSION_DENIED", "You cannot edit this comment.", 403);
      if (input.body !== undefined) comment.body = requiredText(input.body, "body", 10_000);
      if (input.status !== undefined) {
        assertCollaboration(input.status === "open" || input.status === "resolved", "INVALID_COMMENT_STATUS", "Comment status must be 'open' or 'resolved'.");
        comment.status = input.status;
        if (input.status === "resolved") {
          comment.resolvedAt = new Date().toISOString();
          comment.resolvedBy = actorSnapshot(actor);
        } else {
          delete comment.resolvedAt;
          delete comment.resolvedBy;
        }
      }
      assertCollaboration(input.body !== undefined || input.status !== undefined, "EMPTY_UPDATE", "No comment changes were provided.");
      comment.updatedAt = new Date().toISOString();
      const action = appendAction(value, "comment.updated", actor, {
        commentId,
        status: comment.status,
        changedBody: input.body !== undefined,
        ...(input.body !== undefined ? { bodyPreview: comment.body.slice(0, 240) } : {}),
      }, clientMutationId);
      return { comment: structuredClone(comment), action, replayed: false };
    });
    if (!result.replayed) {
      this.events.publish(projectId, "comment.changed", { mode: "update", ...result }, {
        actor: result.action.actor,
        revision: project.revision,
      });
    }
    return result;
  }

  async deleteComment(actor: CollaborationActor, projectId: string, commentId: string) {
    const { project, result: action } = await this.store.mutate(projectId, (value) => {
      const member = requireEffectivePermission(value, actor, "comment:create");
      const index = value.comments.findIndex((candidate) => candidate.id === commentId);
      if (index < 0) throw new CollaborationError("COMMENT_NOT_FOUND", "Comment was not found.", 404);
      const comment = value.comments[index];
      const mayDelete = comment.author.id === actor.id || hasPermission(member.role, "comment:moderate");
      if (!mayDelete) throw new CollaborationError("COMMENT_PERMISSION_DENIED", "You cannot delete this comment.", 403);
      value.comments.splice(index, 1);
      // Replies remain as historical discussion, but are detached from the removed parent.
      for (const reply of value.comments) if (reply.parentId === commentId) delete reply.parentId;
      return appendAction(value, "comment.deleted", actor, {
        commentId,
        bodyPreview: comment.body.slice(0, 240),
      });
    });
    this.events.publish(projectId, "comment.changed", { mode: "delete", commentId, action }, {
      actor: action.actor,
      revision: project.revision,
    });
    return { commentId, action };
  }

  async listHistory(actor: CollaborationActor, projectId: string, after = 0, limit = 100) {
    const project = await this.authorize(actor, projectId, "history:read");
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 100, 1), 500);
    const actions = after > 0
      ? project.history.filter((action) => action.sequence > after).slice(0, safeLimit)
      : project.history.slice(-safeLimit);
    return { actions, activitySequence: project.activitySequence, revision: project.revision };
  }

  async listMembers(actor: CollaborationActor, projectId: string) {
    const project = await this.authorize(actor, projectId, "member:read");
    return { members: Object.values(project.members), revision: project.revision };
  }

  async upsertMember(
    actor: CollaborationActor,
    projectId: string,
    input: { userId: unknown; name: unknown; email?: unknown; role: unknown },
  ) {
    const userId = requiredText(input.userId, "userId", 160);
    const name = requiredText(input.name, "name", 160);
    const email = input.email == null ? null : requiredText(input.email, "email", 320);
    assertCollaboration(isProjectRole(input.role), "INVALID_PROJECT_ROLE", "Invalid project role.");
    assertCollaboration(input.role !== "owner", "OWNER_TRANSFER_REQUIRED", "Ownership cannot be assigned through member upsert.", 409);
    const role = input.role;
    const { project, result } = await this.store.mutate(projectId, (value) => {
      const managingMember = requireEffectivePermission(value, actor, "member:manage");
      const existing = value.members[userId];
      if (existing?.role === "owner" || userId === value.ownerId) {
        throw new CollaborationError(
          "OWNER_ROLE_IMMUTABLE",
          "The project owner cannot be demoted through member management.",
          409,
        );
      }
      if (!canManageMember(managingMember, existing, role)) {
        throw new CollaborationError("MEMBER_MANAGEMENT_DENIED", "You cannot manage this member or role.", 403);
      }
      const now = new Date().toISOString();
      const member: ProjectMember = existing
        ? { ...existing, name, email, role, updatedAt: now }
        : { userId, name, email, role, joinedAt: now, updatedAt: now, invitedBy: actor.id };
      value.members[userId] = member;
      const action = appendAction(value, existing ? "member.role_changed" : "member.added", actor, {
        userId,
        previousRole: existing?.role,
        role,
      });
      return { member, action };
    });
    this.events.publish(projectId, "member.changed", { mode: "upsert", ...result }, {
      actor: result.action.actor,
      revision: project.revision,
    });
    return result;
  }

  async updateMemberRole(
    actor: CollaborationActor,
    projectId: string,
    userId: string,
    role: unknown,
  ) {
    const existingProject = await this.authorize(actor, projectId, "member:read");
    const target = existingProject.members[userId];
    if (!target) throw new CollaborationError("MEMBER_NOT_FOUND", "Project member was not found.", 404);
    return this.upsertMember(actor, projectId, { ...target, role });
  }

  async removeMember(actor: CollaborationActor, projectId: string, userId: string) {
    const { project, result: action } = await this.store.mutate(projectId, (value) => {
      const managingMember = requireEffectivePermission(value, actor, "member:manage");
      const target = value.members[userId];
      if (!target) throw new CollaborationError("MEMBER_NOT_FOUND", "Project member was not found.", 404);
      if (target.role === "owner") throw new CollaborationError("OWNER_REMOVAL_DENIED", "The project owner cannot be removed.", 409);
      if (!canManageMember(managingMember, target)) {
        throw new CollaborationError("MEMBER_MANAGEMENT_DENIED", "You cannot remove this member.", 403);
      }
      delete value.members[userId];
      return appendAction(value, "member.removed", actor, { userId, role: target.role });
    });
    this.events.publish(projectId, "member.changed", { mode: "remove", userId, action }, {
      actor: action.actor,
      revision: project.revision,
    });
    return { userId, action };
  }

  async authorize(
    actor: CollaborationActor,
    projectId: string,
    permission: CollaborationPermission,
  ): Promise<StoredCollaborationProject> {
    const project = await this.store.read(projectId);
    requireEffectivePermission(project, actor, permission);
    return project;
  }
}

const globalService = globalThis as typeof globalThis & {
  __ah2dCollaborationService?: CollaborationService;
};

export function getCollaborationService(): CollaborationService {
  return globalService.__ah2dCollaborationService ??=
    new CollaborationService();
}
