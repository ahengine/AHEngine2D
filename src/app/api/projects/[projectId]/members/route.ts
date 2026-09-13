import {
  apiSuccess,
  authenticatedApi,
  jsonBody,
  type ProjectRouteContext,
} from "@/lib/collaboration/api";
import { getCollaborationService } from "@/lib/collaboration/service";
import { CollaborationError } from "@/lib/collaboration/errors";
import { findApiUserById } from "@/lib/auth";
import { accountAllowsProjectRole } from "@/lib/collaboration/account-role";

export const runtime = "nodejs";

export function GET(request: Request, context: ProjectRouteContext): Promise<Response> {
  return authenticatedApi(request, async (actor) => {
    const { projectId } = await context.params;
    const result = await getCollaborationService().listMembers(actor, projectId);
    return apiSuccess(result, { revision: result.revision });
  });
}

export function POST(request: Request, context: ProjectRouteContext): Promise<Response> {
  return authenticatedApi(request, async (actor) => {
    const { projectId } = await context.params;
    const body = await jsonBody(request);
    const target = typeof body.userId === "string"
      ? await findApiUserById(body.userId)
      : null;
    if (!target) {
      throw new CollaborationError(
        "ACCOUNT_NOT_FOUND",
        "Choose an active AH2D account before adding a project member.",
        404,
      );
    }
    if (!accountAllowsProjectRole(target.role, body.role)) {
      throw new CollaborationError(
        "ROLE_EXCEEDS_ACCOUNT",
        `Project role '${String(body.role)}' exceeds the '${target.role}' account role.`,
        409,
      );
    }
    const result = await getCollaborationService().upsertMember(actor, projectId, {
      userId: target.id,
      name: target.name,
      email: target.email,
      role: body.role,
    });
    return apiSuccess(result, { revision: result.action.documentRevision });
  });
}
