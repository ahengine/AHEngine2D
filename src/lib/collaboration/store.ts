import { randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { CollaborationError } from "./errors";
import { COLLABORATION_SCHEMA, type StoredCollaborationProject } from "./types";

const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function dataDirectory(): string {
  const configured = process.env.AH2D_COLLAB_DATA_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(process.cwd(), ".ah2d-data", "collaboration");
}

function projectPath(projectId: string): string {
  if (!PROJECT_ID_PATTERN.test(projectId) || projectId === "." || projectId === "..") {
    throw new CollaborationError("INVALID_PROJECT_ID", "Invalid project ID.", 400);
  }
  return path.join(dataDirectory(), `${projectId}.json`);
}

function validateStoredProject(value: unknown, expectedId?: string): StoredCollaborationProject {
  if (!value || typeof value !== "object") {
    throw new CollaborationError("CORRUPT_PROJECT", "Stored project is not a JSON object.", 500);
  }
  const project = value as StoredCollaborationProject;
  if (
    project.schema !== COLLABORATION_SCHEMA ||
    typeof project.id !== "string" ||
    (expectedId && project.id !== expectedId) ||
    !Number.isSafeInteger(project.revision) ||
    !Number.isSafeInteger(project.activitySequence) ||
    !project.members || typeof project.members !== "object" ||
    !Array.isArray(project.comments) ||
    !Array.isArray(project.history)
  ) {
    throw new CollaborationError("CORRUPT_PROJECT", "Stored collaboration project has an invalid shape.", 500);
  }
  return project;
}

class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(key, current);
    await prior;
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }
}

export class CollaborationProjectStore {
  private readonly lock = new KeyedLock();

  createId(): string {
    return `project-${randomUUID()}`;
  }

  async list(): Promise<StoredCollaborationProject[]> {
    await mkdir(dataDirectory(), { recursive: true });
    const entries = await readdir(dataDirectory(), { withFileTypes: true });
    const projects: StoredCollaborationProject[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const text = await readFile(path.join(dataDirectory(), entry.name), "utf8");
        projects.push(validateStoredProject(JSON.parse(text)));
      } catch {
        // A corrupt project must not make every other project undiscoverable.
      }
    }
    return projects;
  }

  async read(projectId: string): Promise<StoredCollaborationProject> {
    try {
      const text = await readFile(projectPath(projectId), "utf8");
      return validateStoredProject(JSON.parse(text), projectId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CollaborationError("PROJECT_NOT_FOUND", "Project was not found.", 404);
      }
      if (error instanceof CollaborationError) throw error;
      if (error instanceof SyntaxError) {
        throw new CollaborationError("CORRUPT_PROJECT", "Stored project contains invalid JSON.", 500);
      }
      throw error;
    }
  }

  async create(project: StoredCollaborationProject): Promise<void> {
    return this.lock.run(project.id, async () => {
      validateStoredProject(project, project.id);
      await mkdir(dataDirectory(), { recursive: true });
      const target = projectPath(project.id);
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(project, null, 2)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new CollaborationError("PROJECT_ALREADY_EXISTS", "A project with this ID already exists.", 409);
        }
        throw error;
      } finally {
        await handle.close().catch(() => undefined);
        await unlink(temporary).catch(() => undefined);
      }
    });
  }

  async mutate<T>(
    projectId: string,
    mutation: (project: StoredCollaborationProject) => T | Promise<T>,
  ): Promise<{ project: StoredCollaborationProject; result: T }> {
    return this.lock.run(projectId, async () => {
      const project = await this.read(projectId);
      const result = await mutation(project);
      await this.writeAtomic(project);
      return { project: structuredClone(project), result };
    });
  }

  private async writeAtomic(project: StoredCollaborationProject): Promise<void> {
    validateStoredProject(project, project.id);
    await mkdir(dataDirectory(), { recursive: true });
    const target = projectPath(project.id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(project, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  }
}

const globalStore = globalThis as typeof globalThis & {
  __ah2dCollaborationStore?: CollaborationProjectStore;
};

export function getCollaborationProjectStore(): CollaborationProjectStore {
  return globalStore.__ah2dCollaborationStore ??=
    new CollaborationProjectStore();
}
