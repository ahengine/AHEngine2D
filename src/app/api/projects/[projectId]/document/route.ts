import {
  apiSuccess,
  collaborationApi,
  jsonBody,
  type ProjectRouteContext,
} from "@/lib/collaboration/api";
import { getCollaborationService } from "@/lib/collaboration/service";
import type { JsonPatchOperation } from "@/lib/collaboration/types";

export const runtime = "nodejs";

export function GET(request: Request, context: ProjectRouteContext): Promise<Response> {
  return collaborationApi(request, async (actor) => {
    const { projectId } = await context.params;
    const result = await getCollaborationService().getDocument(actor, projectId);
    return apiSuccess(result, {
      revision: result.revision,
      headers: { ETag: `\"${result.revision}\"` },
    });
  });
}

export function PUT(request: Request, context: ProjectRouteContext): Promise<Response> {
  return collaborationApi(request, async (actor) => {
    const { projectId } = await context.params;
    const body = await jsonBody(request);
    const result = await getCollaborationService().replaceDocument(actor, projectId, {
      document: body.document,
      expectedRevision: body.expectedRevision,
      clientMutationId: body.clientMutationId,
    });
    return apiSuccess(result, { revision: result.revision });
  });
}

export function PATCH(request: Request, context: ProjectRouteContext): Promise<Response> {
  return collaborationApi(request, async (actor) => {
    const { projectId } = await context.params;
    const body = await jsonBody(request);
    const result = await getCollaborationService().patchDocument(actor, projectId, {
      operations: body.operations as JsonPatchOperation[],
      expectedRevision: body.expectedRevision,
      clientMutationId: body.clientMutationId,
    });
    return apiSuccess(result, { revision: result.revision });
  });
}
