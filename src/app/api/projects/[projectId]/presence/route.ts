import {
  apiSuccess,
  authenticatedApi,
  jsonBody,
  type ProjectRouteContext,
} from "@/lib/collaboration/api";
import { CollaborationError } from "@/lib/collaboration/errors";
import { getCollaborationService } from "@/lib/collaboration/service";
import type { PresenceState } from "@/lib/collaboration/types";

export const runtime = "nodejs";

function finiteCoordinate(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CollaborationError("INVALID_PRESENCE", `${label} must be a finite number.`);
  }
  return value;
}

export function POST(request: Request, context: ProjectRouteContext): Promise<Response> {
  return authenticatedApi(request, async (actor) => {
    const { projectId } = await context.params;
    const body = await jsonBody(request);
    const service = getCollaborationService();
    const project = await service.authorize(actor, projectId, "presence:write");
    if (typeof body.clientId !== "string" || !body.clientId.trim() || body.clientId.length > 160) {
      throw new CollaborationError("INVALID_PRESENCE", "A valid clientId is required.");
    }
    const update: Pick<PresenceState, "sceneId" | "entityIds" | "cursor" | "status"> = {};
    if (body.sceneId !== undefined) {
      if (body.sceneId === null) {
        update.sceneId = undefined;
      } else if (typeof body.sceneId !== "string" || body.sceneId.length > 256) {
        throw new CollaborationError("INVALID_PRESENCE", "sceneId must be a string of at most 256 characters.");
      } else {
        update.sceneId = body.sceneId;
      }
    }
    if (body.entityIds !== undefined) {
      if (body.entityIds === null) {
        update.entityIds = undefined;
      } else if (!Array.isArray(body.entityIds) || body.entityIds.length > 100 || body.entityIds.some((id) => typeof id !== "string" || id.length > 256)) {
        throw new CollaborationError("INVALID_PRESENCE", "entityIds must contain at most 100 string IDs.");
      } else {
        update.entityIds = [...body.entityIds] as string[];
      }
    }
    if (body.cursor !== undefined) {
      if (body.cursor === null) {
        update.cursor = undefined;
      } else if (!body.cursor || typeof body.cursor !== "object" || Array.isArray(body.cursor)) {
        throw new CollaborationError("INVALID_PRESENCE", "cursor must be an object.");
      } else {
        const cursor = body.cursor as Record<string, unknown>;
        update.cursor = { x: finiteCoordinate(cursor.x, "cursor.x"), y: finiteCoordinate(cursor.y, "cursor.y") };
      }
    }
    if (body.status !== undefined) {
      if (body.status !== "active" && body.status !== "idle") {
        throw new CollaborationError("INVALID_PRESENCE", "status must be 'active' or 'idle'.");
      }
      update.status = body.status;
    }
    let presence;
    try {
      presence = service.events.updatePresence(projectId, body.clientId.trim(), actor, update);
    } catch {
      throw new CollaborationError(
        "PRESENCE_CONNECTION_NOT_FOUND",
        "Open the project event stream before updating presence.",
        409,
      );
    }
    return apiSuccess({ presence }, { revision: project.revision });
  });
}
