import { randomUUID } from "node:crypto";
import { authenticatedApi, type ProjectRouteContext } from "@/lib/collaboration/api";
import { getCollaborationService } from "@/lib/collaboration/service";
import type { CollaborationEvent } from "@/lib/collaboration/types";
import { requireApiUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function encodeEvent(event: CollaborationEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function GET(request: Request, context: ProjectRouteContext): Promise<Response> {
  return authenticatedApi(request, async (actor) => {
    const { projectId } = await context.params;
    const service = getCollaborationService();
    const project = await service.authorize(actor, projectId, "presence:read");
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
          const change = event.type === "member.changed" && event.data && typeof event.data === "object"
            ? event.data as { mode?: string; userId?: string }
            : null;
          if (change?.mode === "remove" && change.userId === actor.id) {
            cleanup();
            return;
          }
          enqueue(encodeEvent(event));
        }, lastEventId);
        let checkingAccess = false;
        const heartbeat = setInterval(async () => {
          if (checkingAccess || !active) return;
          checkingAccess = true;
          try {
            const current = await requireApiUser(request);
            if (current.id !== actor.id) throw new Error("Session identity changed.");
            await service.authorize(
              { id: current.id, name: current.name, email: current.email, accountRole: current.role },
              projectId,
              "presence:read",
            );
            enqueue(`: heartbeat ${Date.now()}\n\n`);
          } catch {
            cleanup();
          } finally {
            checkingAccess = false;
          }
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
