"use client";

import Link from "next/link";
import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  appendLocalActor,
  getLocalActor,
  withLocalActorHeaders,
  type LocalActor,
} from "@/lib/collaboration/local-actor";
import type {
  CollaborationEvent,
  PresenceState,
  ProjectAction,
  ProjectComment,
  ProjectSummary,
} from "@/lib/collaboration/types";

type RailTab = "comments" | "history";
type SaveState = "loading" | "saved" | "dirty" | "saving" | "conflict" | "offline";

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  revision?: number;
  error?: { code?: string; message?: string; details?: unknown };
}

class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly revision?: number,
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<ApiEnvelope<T>> {
  const response = await fetch(url, {
    cache: "no-store",
    ...init,
    headers: withLocalActorHeaders(init?.headers),
  });
  const payload = await response.json().catch(() => null) as ApiEnvelope<T> | null;
  if (!response.ok || !payload?.ok || payload.data === undefined) {
    throw new ApiRequestError(
      payload?.error?.message || `Request failed (${response.status}).`,
      response.status,
      payload?.error?.code,
      payload?.revision,
    );
  }
  return payload;
}

function mutationId(clientId: string): string {
  return `${clientId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat(undefined, sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

const ACTION_LABELS: Record<string, string> = {
  "project.created": "created the project",
  "project.updated": "updated project settings",
  "document.replaced": "saved the project",
  "document.patched": "edited the project",
  "comment.created": "added a comment",
  "comment.updated": "updated a comment",
  "comment.deleted": "removed a comment",
  "member.added": "added a collaborator",
  "member.role_changed": "changed a collaborator role",
  "member.removed": "removed a collaborator",
};

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((word) => word[0]).join("").toUpperCase() || "?";
}

function uniquePresence(states: PresenceState[]): PresenceState[] {
  const users = new Map<string, PresenceState>();
  for (const state of states) users.set(state.clientId, state);
  return [...users.values()];
}

export function CollaborativeWorkspace({
  projectId,
}: Readonly<{ projectId: string }>) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const clientIdRef = useRef(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `client-${Math.random().toString(36).slice(2)}`,
  );
  const revisionRef = useRef(1);
  const serverDocumentRef = useRef<unknown>(null);
  const pendingDocumentRef = useRef<unknown>(null);
  const editorReadyRef = useRef(false);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushAutosaveRef = useRef<() => Promise<void>>(async () => {});
  const ownMutationsRef = useRef(new Set<string>());

  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [revision, setRevision] = useState(1);
  const [comments, setComments] = useState<ProjectComment[]>([]);
  const [history, setHistory] = useState<ProjectAction[]>([]);
  const [presence, setPresence] = useState<PresenceState[]>([]);
  const [localActor, setLocalActor] = useState<LocalActor | null>(null);
  const [loading, setLoading] = useState(true);
  const [editorLoaded, setEditorLoaded] = useState(false);
  const [fatalError, setFatalError] = useState("");
  const [notice, setNotice] = useState("");
  const [recoveryDocument, setRecoveryDocument] = useState<unknown>(null);
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [connected, setConnected] = useState(false);
  const [railOpen, setRailOpen] = useState(true);
  const [tab, setTab] = useState<RailTab>("comments");
  const [commentBody, setCommentBody] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);

  useEffect(() => setLocalActor(getLocalActor()), []);

  const postToEditor = useCallback((message: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage({ source: "ah2d-studio", ...message }, "*");
  }, []);

  const loadIntoEditor = useCallback((document: unknown) => {
    serverDocumentRef.current = document;
    if (!editorReadyRef.current) return;
    postToEditor({
      type: "AH2D_LOAD_PROJECT",
      document,
      requestId: mutationId(clientIdRef.current),
    });
  }, [postToEditor]);

  const pushPresence = useCallback(async (update: {
    status?: "active" | "idle";
    sceneId?: string;
    entityIds?: string[];
    cursor?: { x: number; y: number };
  }) => {
    try {
      await request(`/api/projects/${encodeURIComponent(projectId)}/presence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: clientIdRef.current, ...update }),
      });
    } catch {
      // Presence is ephemeral; EventSource reconnect establishes it again.
    }
  }, [projectId]);

  const refreshComments = useCallback(async () => {
    const payload = await request<{ comments: ProjectComment[] }>(`/api/projects/${encodeURIComponent(projectId)}/comments`);
    setComments(payload.data!.comments);
  }, [projectId]);

  const refreshHistory = useCallback(async () => {
    const payload = await request<{ actions: ProjectAction[] }>(`/api/projects/${encodeURIComponent(projectId)}/history?limit=120`);
    setHistory(payload.data!.actions.slice().reverse());
  }, [projectId]);

  const refreshProject = useCallback(async () => {
    const payload = await request<{ project: ProjectSummary }>(`/api/projects/${encodeURIComponent(projectId)}`);
    setProject(payload.data!.project);
    return payload.data!.project;
  }, [projectId]);

  const fetchRemoteDocument = useCallback(async (showNotice = false) => {
    const payload = await request<{ document: unknown; revision: number; updatedAt: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/document`,
    );
    const remoteRevision = payload.data!.revision ?? payload.revision ?? revisionRef.current;
    revisionRef.current = remoteRevision;
    setRevision(remoteRevision);
    pendingDocumentRef.current = null;
    dirtyRef.current = false;
    loadIntoEditor(payload.data!.document);
    setSaveState("saved");
    if (showNotice) setNotice("A newer version from the team was loaded.");
  }, [loadIntoEditor, projectId]);

  function scheduleAutosave(delay = 800) {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => void flushAutosaveRef.current(), delay);
  }

  async function flushAutosave() {
    if (savingRef.current || pendingDocumentRef.current == null) return;
    const document = pendingDocumentRef.current;
    pendingDocumentRef.current = null;
    const id = mutationId(clientIdRef.current);
    ownMutationsRef.current.add(id);
    savingRef.current = true;
    setSaveState("saving");
    setNotice("");

    try {
      const payload = await request<{ revision: number }>(
        `/api/projects/${encodeURIComponent(projectId)}/document`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            document,
            expectedRevision: revisionRef.current,
            clientMutationId: id,
          }),
        },
      );
      const nextRevision = payload.data!.revision ?? payload.revision ?? revisionRef.current + 1;
      revisionRef.current = nextRevision;
      setRevision(nextRevision);
      serverDocumentRef.current = document;
      if (pendingDocumentRef.current == null) {
        dirtyRef.current = false;
        setSaveState("saved");
      }
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.status === 409) {
        const newestLocalDraft = pendingDocumentRef.current ?? document;
        setSaveState("conflict");
        setRecoveryDocument(newestLocalDraft);
        setNotice("Another collaborator saved first. Loading their latest version…");
        try {
          await fetchRemoteDocument(false);
          setNotice("The team version was loaded. Your unsaved draft is retained and can be reapplied.");
        } catch (reloadError) {
          setNotice(reloadError instanceof Error ? reloadError.message : "Unable to load the latest project.");
          setSaveState("offline");
        }
      } else {
        if (pendingDocumentRef.current == null) pendingDocumentRef.current = document;
        setSaveState("offline");
        setNotice(cause instanceof Error ? cause.message : "Autosave failed. Retrying…");
        scheduleAutosave(3000);
      }
    } finally {
      savingRef.current = false;
      window.setTimeout(() => ownMutationsRef.current.delete(id), 20_000);
      if (pendingDocumentRef.current != null) scheduleAutosave(180);
    }
  }
  flushAutosaveRef.current = flushAutosave;

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([
      request<{ project: ProjectSummary }>(`/api/projects/${encodeURIComponent(projectId)}`),
      request<{ document: unknown; revision: number; updatedAt: string }>(`/api/projects/${encodeURIComponent(projectId)}/document`),
      request<{ comments: ProjectComment[] }>(`/api/projects/${encodeURIComponent(projectId)}/comments`),
      request<{ actions: ProjectAction[] }>(`/api/projects/${encodeURIComponent(projectId)}/history?limit=120`),
    ]).then(([projectResult, documentResult, commentResult, historyResult]) => {
      if (!active) return;
      const nextProject = projectResult.data!.project;
      const nextRevision = documentResult.data!.revision ?? documentResult.revision ?? nextProject.revision;
      setProject(nextProject);
      setComments(commentResult.data!.comments);
      setHistory(historyResult.data!.actions.slice().reverse());
      revisionRef.current = nextRevision;
      setRevision(nextRevision);
      loadIntoEditor(documentResult.data!.document);
      setSaveState("saved");

    }).catch((cause) => {
      if (active) setFatalError(cause instanceof Error ? cause.message : "Unable to open this project.");
    }).finally(() => {
      if (active) setLoading(false);
    });

    return () => { active = false; };
  }, [loadIntoEditor, projectId]);

  const liveProjectId = project?.id;

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if ((event.origin !== window.location.origin && event.origin !== "null") || event.source !== iframeRef.current?.contentWindow) return;
      const message = event.data as { source?: string; type?: string; document?: unknown; message?: string; presence?: { sceneId?: string; entityIds?: string[]; cursor?: { x: number; y: number } } };
      if (!message || message.source !== "ah2d-editor") return;
      if (message.type === "AH2D_EDITOR_READY") {
        editorReadyRef.current = true;
        if (serverDocumentRef.current) loadIntoEditor(serverDocumentRef.current);
      } else if (message.type === "AH2D_PROJECT_LOADED") {
        setEditorLoaded(true);
      } else if (message.type === "AH2D_PROJECT_CHANGED" && message.document) {
        setRecoveryDocument(null);
        pendingDocumentRef.current = message.document;
        dirtyRef.current = true;
        setSaveState("dirty");
        scheduleAutosave();
      } else if (message.type === "AH2D_BRIDGE_ERROR") {
        setNotice(message.message || "The editor bridge reported an error.");
      } else if (message.type === "AH2D_EDITOR_PRESENCE" && message.presence) {
        void pushPresence({ ...message.presence, status: "active" });
      }
    }
    window.addEventListener("message", onMessage);
    postToEditor({ type: "AH2D_STUDIO_READY" });
    return () => window.removeEventListener("message", onMessage);
  }, [loadIntoEditor, postToEditor, pushPresence]);

  useEffect(() => {
    if (!liveProjectId) return;
    const eventQuery = appendLocalActor(new URLSearchParams({ clientId: clientIdRef.current }));
    const source = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/events?${eventQuery.toString()}`);

    const handleRefreshFailure = (cause: unknown) => {
      if (cause instanceof ApiRequestError && cause.status === 404) {
        source.close();
        setConnected(false);
        setFatalError(cause.message);
        return;
      }
      setNotice(cause instanceof Error ? `Live refresh failed: ${cause.message}` : "Live refresh failed.");
    };

    const refreshLiveData = async (tasks: Promise<unknown>[]) => {
      try {
        await Promise.all(tasks);
      } catch (cause) {
        handleRefreshFailure(cause);
      }
    };

    const refreshLiveDocument = async () => {
      try {
        await fetchRemoteDocument(true);
      } catch (cause) {
        handleRefreshFailure(cause);
      }
    };

    const handle = (nativeEvent: Event) => {
      const event = JSON.parse((nativeEvent as MessageEvent<string>).data) as CollaborationEvent;
      if (event.type === "connected") {
        const data = event.data as { presence?: PresenceState[]; revision?: number };
        setPresence(data.presence ?? []);
        setConnected(true);
        if ((data.revision ?? 0) > revisionRef.current && !dirtyRef.current) void refreshLiveDocument();
        void refreshLiveData([
          refreshProject(),
          refreshComments(),
          refreshHistory(),
        ]);
        void pushPresence({ status: document.visibilityState === "hidden" ? "idle" : "active" });
        return;
      }
      if (event.type === "presence.joined" || event.type === "presence.updated") {
        const state = event.data as PresenceState;
        setPresence((current) => [...current.filter((item) => item.clientId !== state.clientId), state]);
        return;
      }
      if (event.type === "presence.left") {
        const state = event.data as PresenceState;
        setPresence((current) => current.filter((item) => item.clientId !== state.clientId));
        return;
      }
      if (event.type === "document.changed") {
        const data = event.data as { action?: ProjectAction };
        const ownMutation = data.action?.clientMutationId && ownMutationsRef.current.has(data.action.clientMutationId);
        if (event.revision && event.revision > revisionRef.current && ownMutation) {
          revisionRef.current = event.revision;
          setRevision(event.revision);
        } else if (event.revision && event.revision > revisionRef.current && !dirtyRef.current && !savingRef.current) {
          void refreshLiveDocument();
        }
        void refreshLiveData([refreshHistory()]);
        return;
      }
      if (event.type === "comment.changed") {
        void refreshLiveData([refreshComments(), refreshHistory()]);
      } else if (event.type === "project.changed") {
        void refreshLiveData([refreshProject(), refreshHistory()]);
      }
    };

    const eventTypes = [
      "connected", "document.changed", "project.changed", "comment.changed",
      "presence.joined", "presence.updated", "presence.left",
    ] as const;
    for (const type of eventTypes) source.addEventListener(type, handle);
    source.onerror = () => {
      setConnected(false);
      void refreshLiveData([refreshProject()]);
    };

    const heartbeat = window.setInterval(() => {
      if (source.readyState === EventSource.OPEN) void pushPresence({ status: document.visibilityState === "hidden" ? "idle" : "active" });
    }, 12_000);
    const visibility = () => void pushPresence({ status: document.visibilityState === "hidden" ? "idle" : "active" });
    document.addEventListener("visibilitychange", visibility);

    return () => {
      source.close();
      window.clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", visibility);
      setConnected(false);
    };
  }, [fetchRemoteDocument, liveProjectId, projectId, pushPresence, refreshComments, refreshHistory, refreshProject]);

  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
  }, []);

  const onlineUsers = useMemo(() => uniquePresence(presence), [presence]);

  async function createComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = commentBody.trim();
    if (!body) return;
    setCommentBusy(true);
    setNotice("");
    try {
      await request(`/api/projects/${encodeURIComponent(projectId)}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, clientMutationId: mutationId(clientIdRef.current) }),
      });
      setCommentBody("");
      await refreshComments();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Unable to add the comment.");
    } finally {
      setCommentBusy(false);
    }
  }

  function reapplyRecoveredDraft() {
    if (recoveryDocument == null) return;
    const draft = recoveryDocument;
    setRecoveryDocument(null);
    pendingDocumentRef.current = draft;
    dirtyRef.current = true;
    loadIntoEditor(draft);
    setSaveState("dirty");
    setNotice("Your retained draft is ready to save against the latest revision.");
    scheduleAutosave(1200);
  }

  async function toggleComment(comment: ProjectComment) {
    setCommentBusy(true);
    try {
      await request(`/api/projects/${encodeURIComponent(projectId)}/comments/${encodeURIComponent(comment.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: comment.status === "open" ? "resolved" : "open" }),
      });
      await refreshComments();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Unable to update the comment.");
    } finally {
      setCommentBusy(false);
    }
  }

  if (fatalError) {
    return (
      <main className="workspace-failure">
        <div className="glass-panel">
          <span className="failure-icon">!</span>
          <h1>Project unavailable</h1>
          <p>{fatalError}</p>
          <Link className="primary-button" href="/projects">Back to projects</Link>
        </div>
      </main>
    );
  }

  return (
    <main className={`workspace-shell ${railOpen ? "rail-is-open" : ""}`}>
      <iframe
        ref={iframeRef}
        className="editor-frame"
        src="/api/editor/frame"
        title="AH2D Editor"
        sandbox="allow-scripts allow-downloads allow-modals"
        referrerPolicy="no-referrer"
        onLoad={() => postToEditor({ type: "AH2D_STUDIO_READY" })}
      />

      <nav className="workspace-commandbar glass-panel" aria-label="Project controls">
        <Link className="workspace-back" href="/projects" title="All projects" aria-label="Back to projects">←</Link>
        <span className="command-divider" />
        <span className="workspace-title" title={project?.name}><strong>{project?.name || "Loading project…"}</strong><small>r{revision}</small></span>
        <span className={`save-state save-${saveState}`}><i />{saveState === "dirty" ? "Unsaved" : saveState}</span>
        <span className="command-divider" />
        <div className="presence-stack" aria-label={`${onlineUsers.length} collaborators online`}>
          {onlineUsers.slice(0, 4).map((state) => (
            <span className={`mini-avatar ${state.status === "idle" ? "is-idle" : ""}`} key={state.clientId} title={`${state.user.name}${state.status === "idle" ? " (idle)" : ""}`}>
              {initials(state.user.name)}
            </span>
          ))}
          {onlineUsers.length > 4 ? <span className="mini-avatar">+{onlineUsers.length - 4}</span> : null}
        </div>
        <button className={`collaboration-toggle ${railOpen ? "is-active" : ""}`} type="button" onClick={() => setRailOpen((open) => !open)}>
          <span className={`connection-dot ${connected ? "is-online" : ""}`} />
          Local collaboration
          {comments.filter((comment) => comment.status === "open").length ? <b>{comments.filter((comment) => comment.status === "open").length}</b> : null}
        </button>
      </nav>

      {notice || recoveryDocument != null ? <div className="workspace-notice" role="status"><span>{notice || "An unsaved local draft is retained."}</span>{recoveryDocument != null ? <><button className="notice-reapply" type="button" onClick={reapplyRecoveredDraft}>Reapply draft</button><button className="notice-reapply notice-discard" type="button" onClick={() => { setRecoveryDocument(null); setNotice(""); }}>Discard draft</button></> : <button type="button" onClick={() => setNotice("")} aria-label="Dismiss">×</button>}</div> : null}

      {loading || !editorLoaded ? (
        <div className="workspace-loader" aria-label="Loading editor">
          <span className="workspace-loader-mark"><i /><i /><i /></span>
          <strong>{loading ? "Opening project" : "Preparing editor"}</strong>
          <small>Connecting the live workspace…</small>
        </div>
      ) : null}

      <aside className={`collaboration-rail glass-panel ${railOpen ? "is-open" : ""}`} aria-hidden={!railOpen}>
        <header className="rail-header">
          <div>
            <span className="rail-kicker"><i className={connected ? "is-online" : ""} />{connected ? "Local workspace" : "Reconnecting"}</span>
            <h2>Collaboration</h2>
          </div>
          <button className="rail-close" type="button" onClick={() => setRailOpen(false)} aria-label="Close collaboration panel">×</button>
        </header>

        <div className="rail-tabs" role="tablist">
          <button className={tab === "comments" ? "is-active" : ""} type="button" role="tab" onClick={() => setTab("comments")}>Comments <span>{comments.filter((comment) => comment.status === "open").length}</span></button>
          <button className={tab === "history" ? "is-active" : ""} type="button" role="tab" onClick={() => setTab("history")}>History</button>
        </div>

        <div className="rail-content">
          {tab === "comments" ? (
            <section className="comments-panel" aria-label="Project comments">
              <form className="comment-composer" onSubmit={createComment}>
                <span className="avatar composer-avatar">{initials(localActor?.name || "Local User")}</span>
                <div>
                  <textarea className="surface-textarea" value={commentBody} onChange={(event) => setCommentBody(event.target.value)} maxLength={10_000} rows={3} placeholder="Leave a comment…" />
                  <div><small>{localActor?.name || "Local User"}</small><button className="primary-button comment-submit" disabled={commentBusy || !commentBody.trim()} type="submit">Comment</button></div>
                </div>
              </form>

              <div className="comment-list">
                {comments.length ? comments.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((comment) => (
                    <article className={`comment-card ${comment.status === "resolved" ? "is-resolved" : ""}`} key={comment.id}>
                      <span className="avatar">{initials(comment.author.name)}</span>
                      <div className="comment-main">
                        <header><strong>{comment.author.name}</strong><time>{formatTime(comment.createdAt)}</time></header>
                        <p>{comment.body}</p>
                        <footer>
                          <span>{comment.status === "resolved" ? "✓ Resolved" : "Open"}</span>
                          <button disabled={commentBusy} type="button" onClick={() => void toggleComment(comment)}>{comment.status === "open" ? "Resolve" : "Reopen"}</button>
                        </footer>
                      </div>
                    </article>
                )) : <div className="rail-empty"><span>◌</span><strong>No comments yet</strong><p>Start a focused conversation about this project.</p></div>}
              </div>
            </section>
          ) : null}

          {tab === "history" ? (
            <section className="history-panel" aria-label="Project action history">
              <div className="history-summary"><span>Project activity</span><small>Actions use browser-local anonymous attribution.</small></div>
              {history.length ? <ol className="history-list">
                {history.map((action) => (
                  <li key={action.id}>
                    <span className="history-node" />
                    <div><p><strong>{action.actor.name}</strong> {ACTION_LABELS[action.type] || "updated the project"}</p><small>{formatTime(action.createdAt)} · r{action.documentRevision}</small></div>
                  </li>
                ))}
              </ol> : <div className="rail-empty"><span>↶</span><strong>No activity yet</strong><p>Saved edits and collaboration actions appear here.</p></div>}
            </section>
          ) : null}

        </div>
      </aside>
    </main>
  );
}
