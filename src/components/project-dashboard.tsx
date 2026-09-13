"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import type { ProjectSummary } from "@/lib/collaboration/types";
import type { CurrentUser } from "@/lib/auth/server";

type ApiEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: { message?: string };
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => null) as ApiEnvelope<T> | null;
  if (!response.ok || !payload?.ok || payload.data === undefined) {
    throw new Error(payload?.error?.message || `Request failed (${response.status}).`);
  }
  return payload.data;
}

function relativeDate(value: string): string {
  const time = new Date(value).getTime();
  const seconds = Math.round((time - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function ProjectGlyph() {
  return (
    <span className="project-glyph" aria-hidden="true">
      <i /><i /><i />
    </span>
  );
}

export function ProjectDashboard({ user }: Readonly<{ user: CurrentUser }>) {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [error, setError] = useState("");
  const canCreateProject = user.role === "OWNER" || user.role === "ADMIN" || user.role === "EDITOR";

  useEffect(() => {
    let active = true;
    api<{ projects: ProjectSummary[] }>("/api/projects")
      .then(({ projects: next }) => { if (active) setProjects(next); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Unable to load projects."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") || "").trim();
    if (!name) return;
    setCreating(true);
    setError("");
    try {
      const result = await api<{ project: ProjectSummary }>("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      router.push(`/projects/${encodeURIComponent(result.project.id)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create the project.");
      setCreating(false);
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
    router.replace("/login");
    router.refresh();
  }

  return (
    <main className="projects-page">
      <div className="dashboard-glow dashboard-glow-a" />
      <div className="dashboard-glow dashboard-glow-b" />
      <header className="dashboard-header glass-panel">
        <Link className="dashboard-brand" href="/projects" aria-label="AH2D projects">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <strong>AH2D</strong>
          <span>Studio</span>
        </Link>
        <div className="account-cluster">
          <span className="global-role">{user.role}</span>
          <span className="avatar" aria-hidden="true">{user.displayName.slice(0, 1).toUpperCase()}</span>
          <span className="account-copy"><strong>{user.displayName}</strong><small>{user.email}</small></span>
          <button className="ghost-button compact-button" type="button" onClick={logout}>Sign out</button>
        </div>
      </header>

      <section className="dashboard-content">
        <div className="dashboard-heading">
          <div>
            <p className="eyebrow">Your workspace</p>
            <h1>Projects</h1>
            <p>Build, review and collaborate on every AH2D world from one place.</p>
          </div>
          <button className="primary-button create-project-button" type="button" disabled={!canCreateProject} onClick={() => setCreateOpen(true)} title={canCreateProject ? "Create project" : "Your account role cannot create projects"}>
            <span aria-hidden="true">＋</span> New project
          </button>
        </div>

        {error ? <div className="dashboard-alert" role="alert"><span>!</span>{error}</div> : null}

        {loading ? (
          <div className="project-grid" aria-label="Loading projects">
            {[0, 1, 2].map((key) => <div className="project-card project-card-skeleton" key={key} />)}
          </div>
        ) : projects.length ? (
          <div className="project-grid">
            {projects.map((project) => (
              <Link className="project-card" href={`/projects/${encodeURIComponent(project.id)}`} key={project.id}>
                <div className="project-card-top">
                  <ProjectGlyph />
                  <span className={`role-badge role-${project.role}`}>{project.role}</span>
                </div>
                <div className="project-card-copy">
                  <h2>{project.name}</h2>
                  <p>Updated {relativeDate(project.updatedAt)}</p>
                </div>
                <div className="project-card-meta">
                  <span title="Project members">◉ {project.memberCount}</span>
                  <span title="Open comments">◌ {project.openCommentCount}</span>
                  <span>r{project.revision}</span>
                  <span className="open-project-arrow" aria-hidden="true">↗</span>
                </div>
              </Link>
            ))}
          </div>
        ) : canCreateProject ? (
          <button className="empty-projects glass-panel" type="button" onClick={() => setCreateOpen(true)}>
            <ProjectGlyph />
            <strong>Create your first world</strong>
            <span>Start with an empty Scene and the default editable post-process stack.</span>
          </button>
        ) : (
          <div className="empty-projects glass-panel">
            <ProjectGlyph />
            <strong>No shared projects yet</strong>
            <span>Ask an Owner or Admin to add this account to a project.</span>
          </div>
        )}
      </section>

      {createOpen ? (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target && !creating) setCreateOpen(false);
        }}>
          <form className="project-dialog glass-panel" onSubmit={createProject}>
            <div className="dialog-icon"><ProjectGlyph /></div>
            <p className="eyebrow">New AH2D project</p>
            <h2>Name your world</h2>
            <p>A versioned Universal AH2D project will be created and ready for live collaboration.</p>
            <label>
              <span>Project name</span>
              <input className="surface-input" name="name" maxLength={120} required autoFocus placeholder="Untitled Adventure" />
            </label>
            <div className="dialog-actions">
              <button className="ghost-button" type="button" disabled={creating} onClick={() => setCreateOpen(false)}>Cancel</button>
              <button className="primary-button" type="submit" disabled={creating}>{creating ? "Creating…" : "Create project"}</button>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  );
}
