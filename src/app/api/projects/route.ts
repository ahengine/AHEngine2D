import { apiSuccess, authenticatedApi, jsonBody } from "@/lib/collaboration/api";
import { getCollaborationService } from "@/lib/collaboration/service";

export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return authenticatedApi(request, async (actor) => {
    const projects = await getCollaborationService().listProjects(actor);
    return apiSuccess({ projects });
  });
}

export function POST(request: Request): Promise<Response> {
  return authenticatedApi(request, async (actor) => {
    const body = await jsonBody(request);
    const result = await getCollaborationService().createProject(actor, {
      name: body.name,
      document: body.document,
    });
    return apiSuccess(result, { status: 201, revision: result.project.revision });
  });
}
