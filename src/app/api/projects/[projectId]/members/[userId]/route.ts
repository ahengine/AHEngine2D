import {
  apiSuccess,
  authenticatedApi,
  jsonBody,
  type MemberRouteContext,
} from "@/lib/collaboration/api";
import { getCollaborationService } from "@/lib/collaboration/service";
import { CollaborationError } from "@/lib/collaboration/errors";
import { accountAllowsProjectRole } from "@/lib/collaboration/account-role";
import { findApiUserById } from "@/lib/auth";

export const runtime = "nodejs";

export function PATCH(request: Request, context: MemberRouteContext): Promise<Response> {
  return authenticatedApi(request, async (actor) => {
    const { projectId, userId } = await context.params;
    const body = await jsonBody(request);
    const target = await findApiUserById(userId);
    if (!target) {
      throw new CollaborationError("ACCOUNT_NOT_FOUND", "The project member has no active AH2D account.", 404);
    }
    if (!accountAllowsProjectRole(target.role, body.role)) {
      throw new CollaborationError(
        "ROLE_EXCEEDS_ACCOUNT",
        `Project role '${String(body.role)}' exceeds the '${target.role}' account role.`,
        409,
      );
    }
    const result = await getCollaborationService().updateMemberRole(actor, projectId, userId, body.role);
    return apiSuccess(result, { revision: result.action.documentRevision });
  });
}

export function DELETE(request: Request, context: MemberRouteContext): Promise<Response> {
  return authenticatedApi(request, async (actor) => {
    const { projectId, userId } = await context.params;
    const result = await getCollaborationService().removeMember(actor, projectId, userId);
    return apiSuccess(result, { revision: result.action.documentRevision });
  });
}
