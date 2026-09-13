export const COLLABORATION_SCHEMA = "ah2d.collaboration/project-v2" as const;
export const LEGACY_COLLABORATION_SCHEMA = "ah2d.collaboration/project-v1" as const;

export interface CollaborationActor {
  id: string;
  name: string;
}

export interface ActorSnapshot {
  id: string;
  name: string;
}

export interface CommentAnchor {
  sceneId?: string;
  entityId?: string;
  path?: string;
  x?: number;
  y?: number;
  frame?: number;
}

export interface ProjectComment {
  id: string;
  projectId: string;
  author: ActorSnapshot;
  body: string;
  anchor?: CommentAnchor;
  parentId?: string;
  status: "open" | "resolved";
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resolvedBy?: ActorSnapshot;
}

export type ProjectActionType =
  | "project.created"
  | "project.updated"
  | "document.replaced"
  | "document.patched"
  | "comment.created"
  | "comment.updated"
  | "comment.deleted"
  // Retained so v1 action history can be read without losing prior activity.
  | "member.added"
  | "member.role_changed"
  | "member.removed";

export interface ProjectAction {
  id: string;
  sequence: number;
  projectId: string;
  type: ProjectActionType;
  actor: ActorSnapshot;
  createdAt: string;
  documentRevision: number;
  clientMutationId?: string;
  metadata?: Record<string, unknown>;
}

export interface StoredCollaborationProject {
  schema: typeof COLLABORATION_SCHEMA;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Optimistic concurrency token for the authored AH2D document. */
  revision: number;
  /** Monotonic sequence covering every persisted project action. */
  activitySequence: number;
  document: unknown;
  comments: ProjectComment[];
  history: ProjectAction[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  revision: number;
  activitySequence: number;
  createdAt: string;
  updatedAt: string;
  openCommentCount: number;
}

export interface PresenceState {
  clientId: string;
  projectId: string;
  user: ActorSnapshot;
  sceneId?: string;
  entityIds?: string[];
  cursor?: { x: number; y: number };
  status?: "active" | "idle";
  connectedAt: string;
  updatedAt: string;
}

export type CollaborationEventType =
  | "connected"
  | "document.changed"
  | "project.changed"
  | "comment.changed"
  | "presence.joined"
  | "presence.updated"
  | "presence.left";

export interface CollaborationEvent<T = unknown> {
  id: string;
  projectId: string;
  type: CollaborationEventType;
  createdAt: string;
  actor?: ActorSnapshot;
  revision?: number;
  data: T;
}

export interface JsonPatchOperation {
  op: "add" | "remove" | "replace" | "test";
  path: string;
  value?: unknown;
}

export interface MutationOptions {
  clientMutationId?: string;
}
