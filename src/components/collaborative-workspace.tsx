"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CurrentUser } from "@/lib/auth/server";
import { hasPermission as hasAccountPermission } from "@/lib/auth/rbac";
import { ACCOUNT_PROJECT_ROLE_CAP } from "@/lib/collaboration/account-role";
import type { PublicAuthUser, Role } from "@/types/auth";
import type {
  CollaborationEvent,
  PresenceState,
  ProjectAction,
  ProjectComment,
  ProjectMember,
  ProjectRole,
  ProjectSummary,
} from "@/lib/collaboration/types";

type ProjectDetails = ProjectSummary & { members: ProjectMember[] };
type RailTab = "comments" | "history" | "people";
type SaveState = "loading" | "saved" | "dirty" | "saving" | "conflict" | "offline" | "readonly";

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
  const response = await fetch(url, { cache: "no-store", ...init });
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

const ACTION_LABELS: Record<ProjectAction["type"], string> = {
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
  for (const state of states) users.set(state.user.id, state);
  return [...users.values()];
}

function manageableProjectRoles(
  actorProjectRole: ProjectRole | undefined,
  targetAccountRole?: Role,
): ProjectRole[] {
  const roles: ProjectRole[] = actorProjectRole === "owner"
    ? ["admin", "editor", "commenter", "viewer"]
    : actorProjectRole === "admin"
      ? ["editor", "commenter", "viewer"]
      : [];
  if (!targetAccountRole) return roles;
  return roles.filter((role) => ACCOUNT_PROJECT_ROLE_CAP[targetAccountRole].includes(role));
}

export function CollaborativeWorkspace({
  projectId,
  user,
}: Readonly<{ projectId: string; user: CurrentUser }>) {
  const router = useRouter();
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
  const canEditRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushAutosaveRef = useRef<() => Promise<void>>(async () => {});
  const ownMutationsRef = useRef(new Set<string>());

  const [project, setProject] = useState<ProjectDetails | null>(null);
  const [revision, setRevision] = useState(1);
  const [comments, setComments] = useState<ProjectComment[]>([]);
  const [history, setHistory] = useState<ProjectAction[]>([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [directory, setDirectory] = useState<PublicAuthUser[] | null>(null);
  const [presence, setPresence] = useState<PresenceState[]>([]);
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
  const [memberBusy, setMemberBusy] = useState("");
  const [selectedUser, setSelectedUser] = useState("");
  const [selectedRole, setSelectedRole] = useState<ProjectRole>("editor");

  const accountCanEdit = hasAccountPermission(user.role, "project:edit");
  const accountCanComment = hasAccountPermission(user.role, "project:comment");
  const accountCanManageMembers = hasAccountPermission(user.role, "members:manage");
  const accountCanWritePresence = hasAccountPermission(user.role, "collaboration:write");
  const canEdit = accountCanEdit && (project?.role === "owner" || project?.role === "admin" || project?.role === "editor");
  const canComment = accountCanComment && Boolean(project && project.role !== "viewer");
  const canManageMembers = accountCanManageMembers && Boolean(project && (project.role === "owner" || project.role === "admin"));
  canEditRef.current = Boolean(canEdit);

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
    if (!accountCanWritePresence) return;
    try {
      await request(`/api/projects/${encodeURIComponent(projectId)}/presence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: clientIdRef.current, ...update }),
      });
    } catch {
      // Presence is ephemeral; EventSource reconnect establishes it again.
    }
  }, [accountCanWritePresence, projectId]);

  const refreshComments = useCallback(async () => {
    const payload = await request<{ comments: ProjectComment[] }>(`/api/projects/${encodeURIComponent(projectId)}/comments`);
    setComments(payload.data!.comments);
  }, [projectId]);

  const refreshHistory = useCallback(async () => {
    const payload = await request<{ actions: ProjectAction[] }>(`/api/projects/${encodeURIComponent(projectId)}/history?limit=120`);
    setHistory(payload.data!.actions.slice().reverse());
  }, [projectId]);

  const refreshMembers = useCallback(async () => {
    const payload = await request<{ members: ProjectMember[] }>(`/api/projects/${encodeURIComponent(projectId)}/members`);
    setMembers(payload.data!.members);
  }, [projectId]);

  const refreshProject = useCallback(async () => {
    const payload = await request<{ project: ProjectDetails }>(`/api/projects/${encodeURIComponent(projectId)}`);
    setProject(payload.data!.project);
    setMembers(payload.data!.project.members);
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
    setSaveState(canEditRef.current ? "saved" : "readonly");
    if (showNotice) setNotice("A newer version from the team was loaded.");
  }, [loadIntoEditor, projectId]);

  function scheduleAutosave(delay = 800) {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => void flushAutosaveRef.current(), delay);
  }

  async function flushAutosave() {
    if (!canEditRef.current || savingRef.current || pendingDocumentRef.current == null) return;
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
      } else if (cause instanceof ApiRequestError && cause.status === 403) {
        setRecoveryDocument(pendingDocumentRef.current ?? document);
        pendingDocumentRef.current = null;
        dirtyRef.current = false;
        setSaveState("readonly");
        setNotice("Your editing permission changed. The unsaved draft is retained locally.");
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
      request<{ project: ProjectDetails }>(`/api/projects/${encodeURIComponent(projectId)}`),
      request<{ document: unknown; revision: number; updatedAt: string }>(`/api/projects/${encodeURIComponent(projectId)}/document`),
      request<{ comments: ProjectComment[] }>(`/api/projects/${encodeURIComponent(projectId)}/comments`),
      request<{ actions: ProjectAction[] }>(`/api/projects/${encodeURIComponent(projectId)}/history?limit=120`),
      request<{ members: ProjectMember[] }>(`/api/projects/${encodeURIComponent(projectId)}/members`),
    ]).then(async ([projectResult, documentResult, commentResult, historyResult, memberResult]) => {
      if (!active) return;
      const nextProject = projectResult.data!.project;
      const nextRevision = documentResult.data!.revision ?? documentResult.revision ?? nextProject.revision;
      setProject(nextProject);
      setMembers(memberResult.data!.members);
      setComments(commentResult.data!.comments);
      setHistory(historyResult.data!.actions.slice().reverse());
      revisionRef.current = nextRevision;
      setRevision(nextRevision);
      loadIntoEditor(documentResult.data!.document);
      setSaveState(accountCanEdit && ["owner", "admin", "editor"].includes(nextProject.role) ? "saved" : "readonly");

    }).catch((cause) => {
      if (active) setFatalError(cause instanceof Error ? cause.message : "Unable to open this project.");
    }).finally(() => {
      if (active) setLoading(false);
    });

    return () => { active = false; };
  }, [accountCanEdit, loadIntoEditor, projectId]);

  useEffect(() => {
    if (!canManageMembers) {
      setDirectory(null);
      return;
    }
    let active = true;
    request<{ users: PublicAuthUser[] }>("/api/auth/users")
      .then((users) => { if (active) setDirectory(users.data!.users); })
      .catch(() => { if (active) setDirectory(null); });
    return () => { active = false; };
  }, [canManageMembers]);

  const liveProjectId = project?.id;

  useEffect(() => {
    if (!liveProjectId) return;
    if (!canEdit) {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (pendingDocumentRef.current != null) {
        setRecoveryDocument(pendingDocumentRef.current);
        pendingDocumentRef.current = null;
        dirtyRef.current = false;
        setNotice("Your editing permission changed. The unsaved draft is retained locally.");
      }
      setSaveState("readonly");
      return;
    }
    if (pendingDocumentRef.current != null) {
      setSaveState("dirty");
      scheduleAutosave(500);
    } else if (!savingRef.current) {
      setSaveState("saved");
    }
  }, [canEdit, liveProjectId]);

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
      } else if (message.type === "AH2D_PROJECT_CHANGED" && message.document && canEditRef.current) {
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
    const source = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/events?clientId=${encodeURIComponent(clientIdRef.current)}`);

    const handleRefreshFailure = (cause: unknown) => {
      if (cause instanceof ApiRequestError && [401, 403, 404].includes(cause.status)) {
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
          refreshMembers(),
        ]);
        void pushPresence({ status: document.visibilityState === "hidden" ? "idle" : "active" });
        return;
      }
      if (event.type === "presence.joined" || event.type === "presence.updated") {
        const state = event.data as PresenceState;
        setPresence((current) => [...current.filter((item) => !(item.clientId === state.clientId && item.user.id === state.user.id)), state]);
        return;
      }
      if (event.type === "presence.left") {
        const state = event.data as PresenceState;
        setPresence((current) => current.filter((item) => !(item.clientId === state.clientId && item.user.id === state.user.id)));
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
      } else if (event.type === "member.changed") {
        void refreshLiveData([refreshProject(), refreshMembers(), refreshHistory()]);
      } else if (event.type === "project.changed") {
        void refreshLiveData([refreshProject(), refreshHistory()]);
      }
    };

    const eventTypes = [
      "connected", "document.changed", "project.changed", "comment.changed", "member.changed",
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
  }, [fetchRemoteDocument, liveProjectId, projectId, pushPresence, refreshComments, refreshHistory, refreshMembers, refreshProject]);

  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
  }, []);

  const onlineUsers = useMemo(() => uniquePresence(presence), [presence]);
  const availableUsers = useMemo(
    () => (directory ?? []).filter((candidate) => candidate.status === "ACTIVE" && !members.some((member) => member.userId === candidate.id)),
    [directory, members],
  );
  const selectedDirectoryUser = useMemo(
    () => availableUsers.find((candidate) => candidate.id === selectedUser),
    [availableUsers, selectedUser],
  );
  const inviteRoleOptions = useMemo(
    () => manageableProjectRoles(project?.role, selectedDirectoryUser?.role),
    [project?.role, selectedDirectoryUser?.role],
  );

  useEffect(() => {
    if (inviteRoleOptions.length && !inviteRoleOptions.includes(selectedRole)) {
      setSelectedRole(inviteRoleOptions[0]);
    }
  }, [inviteRoleOptions, selectedRole]);

  async function createComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = commentBody.trim();
    if (!body || !canComment) return;
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
    if (recoveryDocument == null || !canEditRef.current) return;
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

  async function inviteMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const candidate = selectedDirectoryUser;
    if (!candidate || !inviteRoleOptions.includes(selectedRole)) return;
    setMemberBusy(candidate.id);
    try {
      await request(`/api/projects/${encodeURIComponent(projectId)}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: candidate.id,
          name: candidate.displayName,
          email: candidate.email,
          role: selectedRole,
        }),
      });
      setSelectedUser("");
      await Promise.all([refreshMembers(), refreshProject()]);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Unable to add this collaborator.");
    } finally {
      setMemberBusy("");
    }
  }

  function mayManage(member: ProjectMember): boolean {
    if (!accountCanManageMembers) return false;
    if (member.role === "owner") return false;
    if (project?.role === "owner") return true;
    return project?.role === "admin" && member.role !== "admin";
  }

  function rolesForMember(member: ProjectMember): ProjectRole[] {
    const targetAccount = directory?.find((candidate) => candidate.id === member.userId);
    const roles = manageableProjectRoles(project?.role, targetAccount?.role);
    return roles.includes(member.role) ? roles : [member.role, ...roles];
  }

  async function changeMemberRole(member: ProjectMember, role: ProjectRole) {
    setMemberBusy(member.userId);
    try {
      await request(`/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(member.userId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      await Promise.all([refreshMembers(), refreshProject()]);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Unable to change the role.");
    } finally {
      setMemberBusy("");
    }
  }

  async function removeMember(member: ProjectMember) {
    setMemberBusy(member.userId);
    try {
      await request(`/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(member.userId)}`, { method: "DELETE" });
      await Promise.all([refreshMembers(), refreshProject()]);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Unable to remove the collaborator.");
    } finally {
      setMemberBusy("");
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
    router.replace("/login");
    router.refresh();
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

      {!canEdit && project ? (
        <div className="readonly-shield" aria-label={`Editor is read only for the ${project.role} role`}>
          <span>Read-only · {project.role}</span>
        </div>
      ) : null}

      <nav className="workspace-commandbar glass-panel" aria-label="Project controls">
        <Link className="workspace-back" href="/projects" title="All projects" aria-label="Back to projects">←</Link>
        <span className="command-divider" />
        <span className="workspace-title" title={project?.name}><strong>{project?.name || "Loading project…"}</strong><small>r{revision}</small></span>
        <span className={`save-state save-${saveState}`}><i />{saveState === "dirty" ? "Unsaved" : saveState === "readonly" ? "Read only" : saveState}</span>
        <span className="command-divider" />
        <div className="presence-stack" aria-label={`${onlineUsers.length} collaborators online`}>
          {onlineUsers.slice(0, 4).map((state) => (
            <span className={`mini-avatar ${state.status === "idle" ? "is-idle" : ""}`} key={state.user.id} title={`${state.user.name}${state.status === "idle" ? " (idle)" : ""}`}>
              {initials(state.user.name)}
            </span>
          ))}
          {onlineUsers.length > 4 ? <span className="mini-avatar">+{onlineUsers.length - 4}</span> : null}
        </div>
        <button className={`collaboration-toggle ${railOpen ? "is-active" : ""}`} type="button" onClick={() => setRailOpen((open) => !open)}>
          <span className={`connection-dot ${connected ? "is-online" : ""}`} />
          Collaborate
          {comments.filter((comment) => comment.status === "open").length ? <b>{comments.filter((comment) => comment.status === "open").length}</b> : null}
        </button>
      </nav>

      {notice || recoveryDocument != null ? <div className="workspace-notice" role="status"><span>{notice || "An unsaved local draft is retained."}</span>{recoveryDocument != null ? <><button className="notice-reapply" type="button" onClick={reapplyRecoveredDraft} disabled={!canEdit}>Reapply draft</button><button className="notice-reapply notice-discard" type="button" onClick={() => { setRecoveryDocument(null); setNotice(""); }}>Discard draft</button></> : <button type="button" onClick={() => setNotice("")} aria-label="Dismiss">×</button>}</div> : null}

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
            <span className="rail-kicker"><i className={connected ? "is-online" : ""} />{connected ? "Live workspace" : "Reconnecting"}</span>
            <h2>Collaboration</h2>
          </div>
          <button className="rail-close" type="button" onClick={() => setRailOpen(false)} aria-label="Close collaboration panel">×</button>
        </header>

        <div className="rail-tabs" role="tablist">
          <button className={tab === "comments" ? "is-active" : ""} type="button" role="tab" onClick={() => setTab("comments")}>Comments <span>{comments.filter((comment) => comment.status === "open").length}</span></button>
          <button className={tab === "history" ? "is-active" : ""} type="button" role="tab" onClick={() => setTab("history")}>History</button>
          <button className={tab === "people" ? "is-active" : ""} type="button" role="tab" onClick={() => setTab("people")}>People <span>{members.length}</span></button>
        </div>

        <div className="rail-content">
          {tab === "comments" ? (
            <section className="comments-panel" aria-label="Project comments">
              {canComment ? (
                <form className="comment-composer" onSubmit={createComment}>
                  <span className="avatar composer-avatar">{initials(user.displayName)}</span>
                  <div>
                    <textarea className="surface-textarea" value={commentBody} onChange={(event) => setCommentBody(event.target.value)} maxLength={10_000} rows={3} placeholder="Leave a comment for the team…" />
                    <div><small>Project-wide comment</small><button className="primary-button comment-submit" disabled={commentBusy || !commentBody.trim()} type="submit">Comment</button></div>
                  </div>
                </form>
              ) : <div className="permission-note">Your effective account and project roles allow reading comments, but not creating them.</div>}

              <div className="comment-list">
                {comments.length ? comments.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((comment) => {
                  const mayToggle = accountCanComment && (comment.author.id === user.id || project?.role === "owner" || project?.role === "admin");
                  return (
                    <article className={`comment-card ${comment.status === "resolved" ? "is-resolved" : ""}`} key={comment.id}>
                      <span className="avatar">{initials(comment.author.name)}</span>
                      <div className="comment-main">
                        <header><strong>{comment.author.name}</strong><time>{formatTime(comment.createdAt)}</time></header>
                        <p>{comment.body}</p>
                        <footer>
                          <span>{comment.status === "resolved" ? "✓ Resolved" : "Open"}</span>
                          {mayToggle ? <button disabled={commentBusy} type="button" onClick={() => void toggleComment(comment)}>{comment.status === "open" ? "Resolve" : "Reopen"}</button> : null}
                        </footer>
                      </div>
                    </article>
                  );
                }) : <div className="rail-empty"><span>◌</span><strong>No comments yet</strong><p>Start a focused conversation about this project.</p></div>}
              </div>
            </section>
          ) : null}

          {tab === "history" ? (
            <section className="history-panel" aria-label="Project action history">
              <div className="history-summary"><span>Project activity</span><small>Every persisted team action includes its actor.</small></div>
              {history.length ? <ol className="history-list">
                {history.map((action) => (
                  <li key={action.id}>
                    <span className="history-node" />
                    <div><p><strong>{action.actor.name}</strong> {ACTION_LABELS[action.type]}</p><small>{formatTime(action.createdAt)} · r{action.documentRevision}</small></div>
                  </li>
                ))}
              </ol> : <div className="rail-empty"><span>↶</span><strong>No activity yet</strong><p>Saved edits and collaboration actions appear here.</p></div>}
            </section>
          ) : null}

          {tab === "people" ? (
            <section className="people-panel" aria-label="Project members">
              <div className="people-heading"><div><strong>{onlineUsers.length} online</strong><small>{members.length} project members</small></div><span className={`role-badge role-${project?.role}`}>{project?.role}</span></div>

              {canManageMembers && directory ? (
                <form className="invite-form" onSubmit={inviteMember}>
                  <label><span>Add an existing account</span>
                    <select className="surface-input" value={selectedUser} onChange={(event) => setSelectedUser(event.target.value)} required>
                      <option value="">Choose a user…</option>
                      {availableUsers.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.displayName} · {candidate.email}</option>)}
                    </select>
                  </label>
                  <select className="surface-input role-select" value={selectedRole} onChange={(event) => setSelectedRole(event.target.value as ProjectRole)} aria-label="Project role">
                    {inviteRoleOptions.map((role) => <option key={role} value={role}>{role}</option>)}
                  </select>
                  <button className="primary-button invite-button" disabled={!selectedUser || !inviteRoleOptions.length || Boolean(memberBusy)} type="submit">Add</button>
                </form>
              ) : null}

              <div className="member-list">
                {members.map((member) => {
                  const online = presence.some((entry) => entry.user.id === member.userId);
                  const manageable = mayManage(member);
                  const roles = rolesForMember(member);
                  return (
                    <article className="member-row" key={member.userId}>
                      <span className="avatar member-avatar">{initials(member.name)}<i className={online ? "is-online" : ""} /></span>
                      <div className="member-copy"><strong>{member.name}{member.userId === user.id ? " (you)" : ""}</strong><small>{member.email || "AH2D account"}</small></div>
                      {manageable ? (
                        <div className="member-actions">
                          <select value={member.role} disabled={memberBusy === member.userId} onChange={(event) => void changeMemberRole(member, event.target.value as ProjectRole)} aria-label={`${member.name} role`}>
                            {roles.map((role) => <option value={role} key={role}>{role}</option>)}
                          </select>
                          <button disabled={memberBusy === member.userId} type="button" onClick={() => void removeMember(member)} aria-label={`Remove ${member.name}`}>×</button>
                        </div>
                      ) : <span className={`role-badge role-${member.role}`}>{member.role}</span>}
                    </article>
                  );
                })}
              </div>
            </section>
          ) : null}
        </div>

        <footer className="rail-footer">
          <div><span className="avatar">{initials(user.displayName)}</span><span><strong>{user.displayName}</strong><small>{user.email}</small></span></div>
          <button type="button" onClick={logout}>Sign out</button>
        </footer>
      </aside>
    </main>
  );
}
