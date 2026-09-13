import { randomUUID } from "node:crypto";
import { collaborationApi, type ProjectRouteContext } from "@/lib/collaboration/api";
import { getCollaborationService } from "@/lib/collaboration/service";
import type { CollaborationEvent } from "@/lib/collaboration/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function encodeEvent(event: CollaborationEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function GET(request: Request, context: ProjectRouteContext): Promise<Response> {
  return collaborationApi(request, async (actor) => {
    const { projectId } = await context.params;
    const service = getCollaborationService();
    const project = await service.readProject(projectId);
    const requestedClientId = new URL(request.url).searchParams.get("clientId")?.trim();
    const clientId = requestedClientId && requestedClientId.length <= 160
      ? requestedClientId
      : randomUUID();
    const lastEventId = request.headers.get("last-event-id");
    const encoder = new TextEncoder();
    let cleanup = () => {};

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let active = true;
        const enqueue = (text: string) => {
          if (!active) return;
          try { controller.enqueue(encoder.encode(text)); } catch { cleanup(); }
        };
        const connection = service.events.connect(projectId, clientId, actor);
        const connected: CollaborationEvent = {
          id: `connected-${randomUUID()}`,
          projectId,
          type: "connected",
          createdAt: new Date().toISOString(),
          actor,
          revision: project.revision,
          data: {
            clientId,
            revision: project.revision,
            activitySequence: project.activitySequence,
            presence: service.events.listPresence(projectId),
          },
        };
        enqueue(`retry: 3000\n${encodeEvent(connected)}`);
        const unsubscribe = service.events.subscribe(projectId, (event) => {
          enqueue(encodeEvent(event));
        }, lastEventId);
        const heartbeat = setInterval(() => {
          if (!active) return;
          enqueue(`: heartbeat ${Date.now()}\n\n`);
        }, 15_000);
        cleanup = () => {
          if (!active) return;
          active = false;
          clearInterval(heartbeat);
          unsubscribe();
          service.events.disconnect(projectId, clientId, connection.token);
          try { controller.close(); } catch {}
        };
        request.signal.addEventListener("abort", cleanup, { once: true });
        if (request.signal.aborted) cleanup();
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });
}
