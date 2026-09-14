export const AH2D_PROJECT_VERSION = 4;
export const AH2D_PROJECT_MANIFEST = "project.ah2d.json";

export type UniversalProjectDocument = Record<string, unknown>;

export class LocalProjectDocumentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LocalProjectDocumentError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeProjectName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!name) {
    throw new LocalProjectDocumentError("PROJECT_NAME_REQUIRED", "Enter a project name.");
  }
  return name;
}

export function safeProjectDirectoryName(value: string): string {
  const normalized = normalizeProjectName(value)
    .normalize("NFKC")
    .replace(/[<>:\"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[ .-]+|[ .-]+$/g, "")
    .slice(0, 64)
    .replace(/[ .-]+$/g, "");
  const fallback = normalized || "ah2d-project";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(fallback)
    ? `ah2d-${fallback}`
    : fallback;
}

export function resolveProjectManifestName(
  fileNames: readonly string[],
  directoryName = "",
): string | null {
  const files = [...new Set(fileNames.filter((name) => typeof name === "string"))];
  const byLower = new Map(files.map((name) => [name.toLocaleLowerCase(), name]));
  const exactNames = [
    AH2D_PROJECT_MANIFEST,
    "AH2D_Project.json",
    "AH2DProject.json",
    directoryName ? `${directoryName}.ah2d.json` : "",
  ].filter(Boolean);
  for (const name of exactNames) {
    const match = byLower.get(name.toLocaleLowerCase());
    if (match) return match;
  }

  const manifests = files.filter((name) => name.toLocaleLowerCase().endsWith(".ah2d.json"));
  if (manifests.length === 1) return manifests[0];
  if (manifests.length > 1) {
    throw new LocalProjectDocumentError(
      "AMBIGUOUS_PROJECT_MANIFEST",
      `This folder contains ${manifests.length} AH2D project files. Rename the project you want to open to ${AH2D_PROJECT_MANIFEST}.`,
    );
  }
  return null;
}

export function parseUniversalProject(text: string): UniversalProjectDocument {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new LocalProjectDocumentError("INVALID_JSON", "The selected project file is not valid JSON.");
  }
  if (!isRecord(value)) {
    throw new LocalProjectDocumentError("INVALID_PROJECT", "The selected JSON must contain an AH2D project object.");
  }
  if (value.format !== "AH2D") {
    throw new LocalProjectDocumentError("INVALID_FORMAT", "The selected file is not an AH2D Universal Project.");
  }
  const version = Number(value.version);
  if (!Number.isInteger(version) || version < 1 || version > AH2D_PROJECT_VERSION) {
    throw new LocalProjectDocumentError(
      "UNSUPPORTED_VERSION",
      `AH2D project version ${String(value.version)} is not supported by this editor.`,
    );
  }
  const hasScenes = Array.isArray(value.scenes) && value.scenes.length > 0;
  const hasLegacyScene = Array.isArray(value.scene);
  if (!hasScenes && !hasLegacyScene) {
    throw new LocalProjectDocumentError("SCENES_REQUIRED", "The AH2D project does not contain a Scene.");
  }
  if (hasScenes) {
    const sceneIds = new Set<string>();
    for (const scene of value.scenes as unknown[]) {
      if (!isRecord(scene) || typeof scene.id !== "string" || !scene.id || !Array.isArray(scene.objects)) {
        throw new LocalProjectDocumentError("INVALID_SCENE", "The AH2D project contains an invalid Scene record.");
      }
      if (sceneIds.has(scene.id)) {
        throw new LocalProjectDocumentError("DUPLICATE_SCENE", `Scene ID ${scene.id} is duplicated.`);
      }
      sceneIds.add(scene.id);
    }
    if (typeof value.currentSceneId === "string" && !sceneIds.has(value.currentSceneId)) {
      throw new LocalProjectDocumentError("ACTIVE_SCENE_MISSING", "The active Scene does not exist in this project.");
    }
  }
  return value;
}

export function serializeUniversalProject(document: UniversalProjectDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function projectDisplayName(document: UniversalProjectDocument, fallback: string): string {
  const project = isRecord(document.project) ? document.project : null;
  const meta = isRecord(document.meta) ? document.meta : null;
  const value = project?.name ?? meta?.name;
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : fallback;
}
