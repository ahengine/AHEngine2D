import {
  apiSuccess,
  collaborationApi,
  jsonBody,
  type CommentRouteContext,
} from "@/lib/collaboration/api";
import { getCollaborationService } from "@/lib/collaboration/service";

export const runtime = "nodejs";

export function PATCH(request: Request, context: CommentRouteContext): Promise<Response> {
  return collaborationApi(request, async (actor) => {
    const { projectId, commentId } = await context.params;
    const body = await jsonBody(request);
    const result = await getCollaborationService().updateComment(actor, projectId, commentId, {
      body: body.body,
      status: body.status,
      clientMutationId: body.clientMutationId,
    });
    return apiSuccess(result, { revision: result.action.documentRevision });
  });
}

export function DELETE(request: Request, context: CommentRouteContext): Promise<Response> {
  return collaborationApi(request, async (actor) => {
    const { projectId, commentId } = await context.params;
    const result = await getCollaborationService().deleteComment(actor, projectId, commentId);
    return apiSuccess(result, { revision: result.action.documentRevision });
  });
}
