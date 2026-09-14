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
