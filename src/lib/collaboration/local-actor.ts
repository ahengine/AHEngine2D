export interface LocalActor {
  id: string;
  name: string;
}

const ACTOR_ID_KEY = "ah2d.localActor.id";
const ACTOR_NAME_KEY = "ah2d.localActor.name";
let memoryActor: LocalActor | null = null;

function createActor(): LocalActor {
  const token = globalThis.crypto?.randomUUID?.()
    ?? `anonymous-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return {
    id: `local-${token}`,
    name: `Local User ${token.slice(0, 4).toUpperCase()}`,
  };
}

function validStoredId(value: string | null): value is string {
  return Boolean(value && /^[a-zA-Z0-9_-]{4,160}$/.test(value));
}

function validStoredName(value: string | null): value is string {
  return Boolean(value && /^[\x20-\x7e]{1,80}$/.test(value));
}

/**
 * Returns a browser-local display identity. It is deliberately not an
 * access credential and never grants permissions.
 */
export function getLocalActor(): LocalActor {
  if (memoryActor) return memoryActor;

  const generated = createActor();
  if (typeof window === "undefined") return generated;

  try {
    const storedId = window.localStorage.getItem(ACTOR_ID_KEY);
    const storedName = window.localStorage.getItem(ACTOR_NAME_KEY);
    memoryActor = {
      id: validStoredId(storedId) ? storedId : generated.id,
      name: validStoredName(storedName) ? storedName : generated.name,
    };
    window.localStorage.setItem(ACTOR_ID_KEY, memoryActor.id);
    window.localStorage.setItem(ACTOR_NAME_KEY, memoryActor.name);
  } catch {
    memoryActor = generated;
  }

  return memoryActor;
}

export function withLocalActorHeaders(headers?: HeadersInit): Headers {
  const next = new Headers(headers);
  const actor = getLocalActor();
  next.set("x-ah2d-actor-id", actor.id);
  next.set("x-ah2d-actor-name", actor.name);
  return next;
}

export function appendLocalActor(search: URLSearchParams): URLSearchParams {
  const actor = getLocalActor();
  search.set("actorId", actor.id);
  search.set("actorName", actor.name);
  return search;
}
