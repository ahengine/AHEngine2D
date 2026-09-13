import {
  apiSuccess,
  collaborationApi,
  jsonBody,
  type ProjectRouteContext,
} from "@/lib/collaboration/api";
import { getCollaborationService } from "@/lib/collaboration/service";

export const runtime = "nodejs";

export function GET(request: Request, context: ProjectRouteContext): Promise<Response> {
  return collaborationApi(request, async (actor) => {
    const { projectId } = await context.params;
    const url = new URL(request.url);
    const result = await getCollaborationService().listComments(actor, projectId, {
      status: url.searchParams.get("status"),
      sceneId: url.searchParams.get("sceneId"),
      entityId: url.searchParams.get("entityId"),
    });
    return apiSuccess(result, { revision: result.revision });
  });
}

export function POST(request: Request, context: ProjectRouteContext): Promise<Response> {
  return collaborationApi(request, async (actor) => {
    const { projectId } = await context.params;
    const body = await jsonBody(request);
    const result = await getCollaborationService().createComment(actor, projectId, {
      body: body.body,
      anchor: body.anchor,
      parentId: body.parentId,
      clientMutationId: body.clientMutationId,
    });
    return apiSuccess(result, { status: 201, revision: result.action.documentRevision });
  });
}
