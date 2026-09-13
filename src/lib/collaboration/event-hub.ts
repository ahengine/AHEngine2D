import { randomUUID } from "node:crypto";
import type {
  ActorSnapshot,
  CollaborationEvent,
  CollaborationEventType,
  PresenceState,
} from "./types";

type EventListener = (event: CollaborationEvent) => void;

interface BufferedEvent {
  event: CollaborationEvent;
  bytes: number;
}

interface PresenceEntry {
  connectionToken: string;
  state: PresenceState;
}

export class CollaborationEventHub {
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly eventBuffers = new Map<string, BufferedEvent[]>();
  private readonly eventBufferBytes = new Map<string, number>();
  private readonly presence = new Map<string, Map<string, PresenceEntry>>();
  private sequence = 0;

  private presenceKey(userId: string, clientId: string): string {
    return `${userId}\u0000${clientId}`;
  }

  publish<T>(
    projectId: string,
    type: CollaborationEventType,
    data: T,
    options: { actor?: ActorSnapshot; revision?: number } = {},
  ): CollaborationEvent<T> {
    const event: CollaborationEvent<T> = {
      id: `${Date.now().toString(36)}-${(++this.sequence).toString(36)}`,
      projectId,
      type,
      createdAt: new Date().toISOString(),
      actor: options.actor,
      revision: options.revision,
      data,
    };
    const buffer = this.eventBuffers.get(projectId) ?? [];
    const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    let totalBytes = this.eventBufferBytes.get(projectId) ?? 0;
    // Oversized events still reach connected clients, but are not retained for replay.
    if (bytes <= 512 * 1024) {
      buffer.push({ event, bytes });
      totalBytes += bytes;
    }
    while (buffer.length > 256 || totalBytes > 2 * 1024 * 1024) {
      totalBytes -= buffer.shift()!.bytes;
    }
    this.eventBuffers.set(projectId, buffer);
    this.eventBufferBytes.set(projectId, totalBytes);
    for (const listener of this.listeners.get(projectId) ?? []) {
      try {
        listener(event);
      } catch {
        // A disconnected stream cannot make an already-persisted mutation fail.
      }
    }
    return event;
  }

  subscribe(projectId: string, listener: EventListener, afterEventId?: string | null): () => void {
    const projectListeners = this.listeners.get(projectId) ?? new Set<EventListener>();
    projectListeners.add(listener);
    this.listeners.set(projectId, projectListeners);

    if (afterEventId) {
      const buffer = this.eventBuffers.get(projectId) ?? [];
      const index = buffer.findIndex(({ event }) => event.id === afterEventId);
      if (index >= 0) {
        for (const { event } of buffer.slice(index + 1)) listener(event);
      }
    }

    return () => {
      projectListeners.delete(listener);
      if (projectListeners.size === 0) this.listeners.delete(projectId);
    };
  }

  connect(projectId: string, clientId: string, actor: ActorSnapshot): { token: string; state: PresenceState } {
    const now = new Date().toISOString();
    const token = randomUUID();
    const state: PresenceState = {
      clientId,
      projectId,
      user: actor,
      status: "active",
      connectedAt: now,
      updatedAt: now,
    };
    const projectPresence = this.presence.get(projectId) ?? new Map<string, PresenceEntry>();
    const key = this.presenceKey(actor.id, clientId);
    const existed = projectPresence.has(key);
    projectPresence.set(key, { connectionToken: token, state });
    this.presence.set(projectId, projectPresence);
    this.publish(projectId, existed ? "presence.updated" : "presence.joined", state, { actor });
    return { token, state };
  }

  updatePresence(
    projectId: string,
    clientId: string,
    actor: ActorSnapshot,
    update: Pick<PresenceState, "sceneId" | "entityIds" | "cursor" | "status">,
  ): PresenceState {
    const projectPresence = this.presence.get(projectId);
    const key = this.presenceKey(actor.id, clientId);
    const entry = projectPresence?.get(key);
    if (!entry) {
      throw new Error("Presence connection was not found for this user and client ID.");
    }
    entry.state = {
      ...entry.state,
      ...update,
      user: actor,
      updatedAt: new Date().toISOString(),
    };
    this.publish(projectId, "presence.updated", entry.state, { actor });
    return entry.state;
  }

  disconnect(projectId: string, clientId: string, connectionToken: string): void {
    const projectPresence = this.presence.get(projectId);
    const key = [...(projectPresence?.entries() ?? [])].find(([, candidate]) =>
      candidate.state.clientId === clientId && candidate.connectionToken === connectionToken,
    );
    // A reconnect may have replaced this connection; stale cleanup must not remove it.
    if (!key) return;
    const [presenceKey, entry] = key;
    projectPresence!.delete(presenceKey);
    if (projectPresence!.size === 0) this.presence.delete(projectId);
    this.publish(projectId, "presence.left", entry.state, { actor: entry.state.user });
  }

  listPresence(projectId: string): PresenceState[] {
    return [...(this.presence.get(projectId)?.values() ?? [])].map(({ state }) => structuredClone(state));
  }
}

const globalHub = globalThis as typeof globalThis & {
  __ah2dCollaborationEventHub?: CollaborationEventHub;
};

export function getCollaborationEventHub(): CollaborationEventHub {
  return globalHub.__ah2dCollaborationEventHub ??=
    new CollaborationEventHub();
}
