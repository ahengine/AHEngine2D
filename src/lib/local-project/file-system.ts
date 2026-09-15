import {
  parseUniversalProject,
  resolveProjectManifestName,
  type UniversalProjectDocument,
} from "./project-document";

export type WritableProjectFileHandle = FileSystemFileHandle & {
  createWritable: () => Promise<{
    write: (data: string | Blob) => Promise<void>;
    close: () => Promise<void>;
    abort?: () => Promise<void>;
  }>;
};

export type ProjectDirectoryHandle = FileSystemDirectoryHandle & {
  entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<ProjectDirectoryHandle>;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<WritableProjectFileHandle>;
};

export interface ReadProjectFile {
  document: UniversalProjectDocument;
  fileHandle: WritableProjectFileHandle;
  fileName: string;
  diskText: string;
}

export interface ResolvedProjectAssetFile {
  source: string;
  aliases: string[];
  file: File;
}

export interface ResolvedProjectAssets {
  files: ResolvedProjectAssetFile[];
  missing: string[];
}

const IMAGE_SOURCE_FIELDS = ["imageSrc", "src", "url", "dataUrl", "dataURI"] as const;
const LOCAL_IMAGE_MIME: Record<string, string> = {
  bmp: "image/bmp",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};

export function localImageMimeType(fileName: string): string | null {
  const extension = fileName.split(/[?#]/, 1)[0].split(".").pop()?.toLowerCase() || "";
  return LOCAL_IMAGE_MIME[extension] || null;
}

export function normalizeLocalAssetPath(value: unknown): string | null {
  const source = typeof value === "string" ? value.trim() : "";
  if (!source || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(source)) return null;
  const pathname = source.split(/[?#]/, 1)[0];
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  decoded = decoded.replace(/\\/g, "/");
  if (/^(?:\/+|[a-z]:)/i.test(decoded)) return null;
  while (decoded.startsWith("./")) decoded = decoded.slice(2);
  const segments = decoded.split("/");
  if (!segments.length || segments.some((segment) => !segment || segment === "." || segment === ".." || /[\0:]/.test(segment))) return null;
  return segments.join("/");
}

function collectProjectAssetReferences(document: UniversalProjectDocument): Map<string, Set<string>> {
  const references = new Map<string, Set<string>>();
  const seen = new Set<object>();
  const visit = (value: unknown, insideAssets = false): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, insideAssets));
      return;
    }
    const record = value as Record<string, unknown>;
    for (const field of IMAGE_SOURCE_FIELDS) {
      const original = typeof record[field] === "string" ? record[field].trim() : "";
      const localPath = normalizeLocalAssetPath(original);
      if (!localPath || !localImageMimeType(localPath)) continue;
      const aliases = references.get(localPath) || new Set<string>();
      aliases.add(original);
      aliases.add(localPath);
      if (insideAssets && record.id != null) aliases.add(String(record.id));
      references.set(localPath, aliases);
      break;
    }
    for (const [key, child] of Object.entries(record)) visit(child, insideAssets || key === "assets");
  };
  visit(document, false);
  return references;
}

export function listLocalProjectAssetPaths(document: UniversalProjectDocument): string[] {
  return [...collectProjectAssetReferences(document).keys()].sort((left, right) => left.localeCompare(right));
}

export async function resolveProjectAssetFiles(directory: ProjectDirectoryHandle, document: UniversalProjectDocument): Promise<ResolvedProjectAssets> {
  const files: ResolvedProjectAssetFile[] = [];
  const missing: string[] = [];
  for (const [source, aliases] of [...collectProjectAssetReferences(document)].sort(([left], [right]) => left.localeCompare(right))) {
    try {
      const segments = source.split("/");
      let current = directory;
      for (const segment of segments.slice(0, -1)) current = await current.getDirectoryHandle(segment);
      const handle = await current.getFileHandle(segments.at(-1)!);
      files.push({ source, aliases: [...aliases], file: await handle.getFile() });
    } catch {
      missing.push(source);
    }
  }
  return { files, missing };
}

export async function readProjectFile(fileHandle: WritableProjectFileHandle): Promise<ReadProjectFile> {
  const file = await fileHandle.getFile();
  const diskText = await file.text();
  return {
    document: parseUniversalProject(diskText),
    fileHandle,
    fileName: file.name,
    diskText,
  };
}

export async function writeProjectText(fileHandle: WritableProjectFileHandle, text: string): Promise<void> {
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(text);
    await writable.close();
  } catch (error) {
    try {
      await writable.abort?.();
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

export async function findProjectInDirectory(directory: ProjectDirectoryHandle): Promise<ReadProjectFile> {
  const handles = new Map<string, WritableProjectFileHandle>();
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind === "file" && name.toLocaleLowerCase().endsWith(".json")) {
      handles.set(name, handle as WritableProjectFileHandle);
    }
  }

  const manifestName = resolveProjectManifestName([...handles.keys()], directory.name);
  if (manifestName) return readProjectFile(handles.get(manifestName)!);

  const validProjects: ReadProjectFile[] = [];
  for (const [name, handle] of handles) {
    if (/^(package(?:-lock)?|tsconfig|jsconfig)\.json$/i.test(name)) continue;
    try {
      validProjects.push(await readProjectFile(handle));
    } catch {
      // A normal project folder may contain unrelated JSON files.
    }
  }
  if (validProjects.length === 1) return validProjects[0];
  if (validProjects.length > 1) {
    throw new Error(`This folder contains multiple AH2D projects. Rename one to project.ah2d.json.`);
  }
  throw new Error("No AH2D project was found in this folder. Expected project.ah2d.json.");
}
