import {
  apiSuccess,
  authenticatedApi,
  jsonBody,
  type ProjectRouteContext,
} from "@/lib/collaboration/api";
import { getCollaborationService } from "@/lib/collaboration/service";

export const runtime = "nodejs";

export function GET(request: Request, context: ProjectRouteContext): Promise<Response> {
  return authenticatedApi(request, async (actor) => {
    const { projectId } = await context.params;
    const project = await getCollaborationService().getProject(actor, projectId);
    return apiSuccess({ project }, { revision: project.revision });
  });
}

export function PATCH(request: Request, context: ProjectRouteContext): Promise<Response> {
  return authenticatedApi(request, async (actor) => {
    const { projectId } = await context.params;
    const body = await jsonBody(request);
    const result = await getCollaborationService().updateProject(actor, projectId, {
      name: body.name,
      clientMutationId: body.clientMutationId,
    });
    return apiSuccess(result, { revision: result.project.revision });
  });
}
