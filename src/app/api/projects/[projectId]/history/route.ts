import { apiSuccess, collaborationApi, type ProjectRouteContext } from "@/lib/collaboration/api";
import { getCollaborationService } from "@/lib/collaboration/service";

export const runtime = "nodejs";

export function GET(request: Request, context: ProjectRouteContext): Promise<Response> {
  return collaborationApi(request, async (actor) => {
    const { projectId } = await context.params;
    const url = new URL(request.url);
    const after = Number(url.searchParams.get("after") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const result = await getCollaborationService().listHistory(actor, projectId, after, limit);
    return apiSuccess(result, { revision: result.revision });
  });
}
