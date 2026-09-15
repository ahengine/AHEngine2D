"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  findProjectInDirectory,
  listLocalProjectAssetPaths,
  localImageMimeType,
  readProjectFile,
  resolveProjectAssetFiles,
  writeProjectText,
  type ProjectDirectoryHandle,
  type WritableProjectFileHandle,
} from "@/lib/local-project/file-system";
import {
  AH2D_PROJECT_MANIFEST,
  normalizeProjectName,
  parseUniversalProject,
  projectDisplayName,
  safeProjectDirectoryName,
  serializeUniversalProject,
  type UniversalProjectDocument,
} from "@/lib/local-project/project-document";

type SaveState = "idle" | "saved" | "dirty" | "saving" | "conflict" | "error" | "downloaded";

interface PickerWindow extends Window {
  showDirectoryPicker?: (options?: { id?: string; mode?: "read" | "readwrite" }) => Promise<ProjectDirectoryHandle>;
  showOpenFilePicker?: (options?: {
    id?: string;
    multiple?: boolean;
    types?: Array<{ description?: string; accept: Record<string, string[]> }>;
  }) => Promise<WritableProjectFileHandle[]>;
  showSaveFilePicker?: (options?: {
    id?: string;
    suggestedName?: string;
    types?: Array<{ description?: string; accept: Record<string, string[]> }>;
  }) => Promise<WritableProjectFileHandle>;
}

interface LocalSession {
  id: string;
  projectName: string;
  fileName: string;
  locationLabel: string;
  fileHandle: WritableProjectFileHandle | null;
  expectedDiskText: string | null;
  document: UniversalProjectDocument;
  directoryHandle: ProjectDirectoryHandle | null;
  runtimeAssetSources: Record<string, string>;
  missingAssets: string[];
}

interface CandidateProject {
  requestId: string;
  session: LocalSession;
  preservePending?: boolean;
}

interface PendingWrite {
  sessionId: string;
  generation: number;
  document: UniversalProjectDocument;
}

interface EditorMessage {
  source?: string;
  type?: string;
  requestId?: string | null;
  document?: unknown;
  message?: string;
  command?: string;
}

const FILE_PICKER_TYPES = [{
  description: "AH2D Universal Project",
  accept: { "application/json": [".ah2d.json", ".json"] },
}];

function nextId(prefix: string): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `${prefix}-${crypto.randomUUID()}`
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "NotFoundError"
    : Boolean(error && typeof error === "object" && (error as { name?: unknown }).name === "NotFoundError");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The local project operation failed.";
}

const EMPTY_RUNTIME_ASSETS = Object.freeze({
  sources: {} as Record<string, string>,
  missing: [] as string[],
});

async function readFileAsDataUrl(file: File): Promise<string> {
  const mime = localImageMimeType(file.name);
  if (!mime) throw new Error(`Unsupported local image asset ${file.name}.`);
  const source = file.type.toLowerCase() === mime
    ? file
    : new Blob([await file.arrayBuffer()], { type: mime });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error(`Unable to read local image asset ${file.name}.`));
    }, { once: true });
    reader.addEventListener("error", () => reject(reader.error || new Error(`Unable to read local image asset ${file.name}.`)), { once: true });
    reader.readAsDataURL(source);
  });
}

async function createRuntimeAssets(directory: ProjectDirectoryHandle | null, document: UniversalProjectDocument) {
  if (!directory) return { ...EMPTY_RUNTIME_ASSETS, sources: {}, missing: listLocalProjectAssetPaths(document) };
  const resolved = await resolveProjectAssetFiles(directory, document);
  const sources: Record<string, string> = {};
  for (const entry of resolved.files) {
    const dataUrl = await readFileAsDataUrl(entry.file);
    for (const alias of entry.aliases) sources[alias] = dataUrl;
  }
  return { sources, missing: resolved.missing };
}

function downloadProject(project: UniversalProjectDocument, fileName: string): void {
  const blob = new Blob([serializeUniversalProject(project)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = documentGlobal().createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function documentGlobal(): Document {
  return window.document;
}

async function requestProjectTemplate(name: string): Promise<UniversalProjectDocument> {
  const response = await fetch("/api/editor/project-template", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const payload = await response.json().catch(() => null) as {
    ok?: boolean;
    document?: unknown;
    error?: { message?: string };
  } | null;
  if (!response.ok || !payload?.ok || !payload.document) {
    throw new Error(payload?.error?.message || "Unable to create the AH2D project template.");
  }
  return parseUniversalProject(JSON.stringify(payload.document));
}

export function LocalProjectWorkspace() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const fallbackInputRef = useRef<HTMLInputElement>(null);
  const editorReadyRef = useRef(false);
  const acceptsChangesRef = useRef(false);
  const sessionRef = useRef<LocalSession | null>(null);
  const candidateRef = useRef<CandidateProject | null>(null);
  const pendingWriteRef = useRef<PendingWrite | null>(null);
  const generationRef = useRef(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());
  const saveStateRef = useRef<SaveState>("idle");

  const [gateOpen, setGateOpen] = useState(true);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("Untitled Game");
  const [opening, setOpening] = useState(false);
  const [editorLoaded, setEditorLoaded] = useState(false);
  const [saveState, setSaveStateValue] = useState<SaveState>("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [session, setSession] = useState<LocalSession | null>(null);

  const setSaveState = useCallback((value: SaveState) => {
    saveStateRef.current = value;
    setSaveStateValue(value);
  }, []);

  const postToEditor = useCallback((message: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage({ source: "ah2d-studio", ...message }, "*");
  }, []);

  const sendCandidate = useCallback((candidate: CandidateProject) => {
    if (!editorReadyRef.current) return;
    postToEditor({
      type: "AH2D_LOAD_PROJECT",
      requestId: candidate.requestId,
      document: candidate.session.document,
      assetSources: candidate.session.runtimeAssetSources,
    });
  }, [postToEditor]);

  const beginLoadingProject = useCallback((nextSession: LocalSession) => {
    const candidate = { requestId: nextId("load"), session: nextSession };
    candidateRef.current = candidate;
    acceptsChangesRef.current = false;
    setOpening(true);
    setError("");
    setNotice("");
    sendCandidate(candidate);
  }, [sendCandidate]);

  const drainWrites = useCallback((options: { overwrite?: boolean; download?: boolean } = {}) => {
    const run = async () => {
      let overwrite = options.overwrite === true;
      while (pendingWriteRef.current) {
        const pending = pendingWriteRef.current;
        const active = sessionRef.current;
        if (!active || pending.sessionId !== active.id) {
          pendingWriteRef.current = null;
          continue;
        }
        if (!active.fileHandle) {
          if (options.download) {
            downloadProject(pending.document, active.fileName);
            active.document = pending.document;
            pendingWriteRef.current = null;
            setSaveState("downloaded");
            setNotice("A fresh project file was downloaded. This browser cannot overwrite the original file directly.");
            postToEditor({ type: "AH2D_SAVE_RESULT", ok: true, fileName: active.fileName });
          }
          return;
        }

        pendingWriteRef.current = null;
        setSaveState("saving");
        try {
          if (!overwrite && active.expectedDiskText !== null) {
            const diskText = await (await active.fileHandle.getFile()).text();
            if (diskText !== active.expectedDiskText) {
              if (generationRef.current <= pending.generation) pendingWriteRef.current = pending;
              setSaveState("conflict");
              setNotice("The project changed outside AH2D. Reload it or explicitly overwrite the external changes.");
              return;
            }
          }
          const text = serializeUniversalProject(pending.document);
          await writeProjectText(active.fileHandle, text);
          active.expectedDiskText = text;
          active.document = pending.document;
          overwrite = false;
          if (!pendingWriteRef.current) {
            setSaveState("saved");
            postToEditor({ type: "AH2D_SAVE_RESULT", ok: true, fileName: active.fileName });
          }
        } catch (writeError) {
          if (!pendingWriteRef.current) pendingWriteRef.current = pending;
          setSaveState("error");
          setNotice(`Could not save ${active.fileName}: ${errorMessage(writeError)}`);
          postToEditor({ type: "AH2D_SAVE_RESULT", ok: false, message: errorMessage(writeError) });
          return;
        }
      }
    };
    const chained = writeChainRef.current.then(run, run);
    writeChainRef.current = chained.catch(() => {});
    return chained;
  }, [postToEditor, setSaveState]);

  const queueDocument = useCallback((document: UniversalProjectDocument, immediate = false) => {
    const active = sessionRef.current;
    if (!active) return;
    const generation = ++generationRef.current;
    pendingWriteRef.current = { sessionId: active.id, generation, document };
    setSaveState("dirty");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (immediate) {
      void drainWrites({ download: !active.fileHandle });
    } else if (active.fileHandle) {
      saveTimerRef.current = setTimeout(() => void drainWrites(), 700);
    }
  }, [drainWrites, setSaveState]);

  const prepareProjectSwitch = useCallback(async (): Promise<boolean> => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    await writeChainRef.current;
    if (pendingWriteRef.current && sessionRef.current?.fileHandle) {
      await drainWrites();
      await writeChainRef.current;
    }
    if (pendingWriteRef.current) {
      return window.confirm("The current project still has unsaved changes. Open another project anyway?");
    }
    return true;
  }, [drainWrites]);

  const openPickedProject = useCallback(async () => {
    setError("");
    try {
      const pickerWindow = window as PickerWindow;
      if (pickerWindow.showDirectoryPicker) {
        const directory = await pickerWindow.showDirectoryPicker({ id: "ah2d-open-project", mode: "readwrite" });
        const selected = await findProjectInDirectory(directory);
        if (!await prepareProjectSwitch()) return;
        const runtimeAssets = await createRuntimeAssets(directory, selected.document);
        beginLoadingProject({
          id: nextId("session"),
          projectName: projectDisplayName(selected.document, directory.name),
          fileName: selected.fileName,
          locationLabel: directory.name,
          fileHandle: selected.fileHandle,
          expectedDiskText: selected.diskText,
          document: selected.document,
          directoryHandle: directory,
          runtimeAssetSources: runtimeAssets.sources,
          missingAssets: runtimeAssets.missing,
        });
        return;
      }
      if (pickerWindow.showOpenFilePicker) {
        const [handle] = await pickerWindow.showOpenFilePicker({ id: "ah2d-open-project", multiple: false, types: FILE_PICKER_TYPES });
        if (!handle) return;
        const selected = await readProjectFile(handle);
        if (!await prepareProjectSwitch()) return;
        const runtimeAssets = await createRuntimeAssets(null, selected.document);
        beginLoadingProject({
          id: nextId("session"),
          projectName: projectDisplayName(selected.document, selected.fileName.replace(/\.(?:ah2d\.)?json$/i, "")),
          fileName: selected.fileName,
          locationLabel: "Local file",
          fileHandle: selected.fileHandle,
          expectedDiskText: selected.diskText,
          document: selected.document,
          directoryHandle: null,
          runtimeAssetSources: runtimeAssets.sources,
          missingAssets: runtimeAssets.missing,
        });
        return;
      }
      fallbackInputRef.current?.click();
    } catch (openError) {
      if (!isAbortError(openError)) setError(errorMessage(openError));
    }
  }, [beginLoadingProject, prepareProjectSwitch]);

  const createProject = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    let name: string;
    try {
      name = normalizeProjectName(newProjectName);
    } catch (nameError) {
      setError(errorMessage(nameError));
      return;
    }

    const pickerWindow = window as PickerWindow;
    try {
      // Picker calls intentionally happen before any other await so browser user activation is retained.
      const directory = pickerWindow.showDirectoryPicker
        ? await pickerWindow.showDirectoryPicker({ id: "ah2d-new-project", mode: "readwrite" })
        : null;
      const standaloneFile = !directory && pickerWindow.showSaveFilePicker
        ? await pickerWindow.showSaveFilePicker({
          id: "ah2d-new-project-file",
          suggestedName: `${safeProjectDirectoryName(name)}.ah2d.json`,
          types: FILE_PICKER_TYPES,
        })
        : null;
      const document = await requestProjectTemplate(name);
      if (!await prepareProjectSwitch()) return;
      const text = serializeUniversalProject(document);

      if (directory) {
        const folderName = safeProjectDirectoryName(name);
        try {
          await directory.getDirectoryHandle(folderName);
          throw new Error(`The folder ${folderName} already exists. Choose another name or use Open Project.`);
        } catch (probeError) {
          if (!isNotFoundError(probeError)) throw probeError;
        }
        const projectDirectory = await directory.getDirectoryHandle(folderName, { create: true });
        const fileHandle = await projectDirectory.getFileHandle(AH2D_PROJECT_MANIFEST, { create: true });
        await writeProjectText(fileHandle, text);
        beginLoadingProject({
          id: nextId("session"),
          projectName: name,
          fileName: AH2D_PROJECT_MANIFEST,
          locationLabel: `${directory.name}/${folderName}`,
          fileHandle,
          expectedDiskText: text,
          document,
          directoryHandle: projectDirectory,
          runtimeAssetSources: {},
          missingAssets: [],
        });
      } else if (standaloneFile) {
        await writeProjectText(standaloneFile, text);
        beginLoadingProject({
          id: nextId("session"),
          projectName: name,
          fileName: standaloneFile.name,
          locationLabel: "Local file",
          fileHandle: standaloneFile,
          expectedDiskText: text,
          document,
          directoryHandle: null,
          runtimeAssetSources: {},
          missingAssets: [],
        });
      } else {
        const fileName = `${safeProjectDirectoryName(name)}.ah2d.json`;
        downloadProject(document, fileName);
        beginLoadingProject({
          id: nextId("session"),
          projectName: name,
          fileName,
          locationLabel: "Download mode",
          fileHandle: null,
          expectedDiskText: null,
          document,
          directoryHandle: null,
          runtimeAssetSources: {},
          missingAssets: [],
        });
      }
      setNewProjectOpen(false);
    } catch (createError) {
      if (!isAbortError(createError)) setError(errorMessage(createError));
    }
  }, [beginLoadingProject, newProjectName, prepareProjectSwitch]);

  const openFallbackFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    try {
      const diskText = await file.text();
      const document = parseUniversalProject(diskText);
      if (!await prepareProjectSwitch()) return;
      const runtimeAssets = await createRuntimeAssets(null, document);
      beginLoadingProject({
        id: nextId("session"),
        projectName: projectDisplayName(document, file.name.replace(/\.(?:ah2d\.)?json$/i, "")),
        fileName: file.name,
        locationLabel: "Download mode",
        fileHandle: null,
        expectedDiskText: diskText,
        document,
        directoryHandle: null,
        runtimeAssetSources: runtimeAssets.sources,
        missingAssets: runtimeAssets.missing,
      });
    } catch (fallbackError) {
      setError(errorMessage(fallbackError));
    } finally {
      if (fallbackInputRef.current) fallbackInputRef.current.value = "";
    }
  }, [beginLoadingProject, prepareProjectSwitch]);

  const showProjectGate = useCallback((openNewProject = false) => {
    setGateOpen(true);
    setNewProjectOpen(openNewProject);
    setError("");
    if (pendingWriteRef.current && sessionRef.current?.fileHandle) void drainWrites();
  }, [drainWrites]);

  const reloadExternalProject = useCallback(async () => {
    const active = sessionRef.current;
    if (!active?.fileHandle) return;
    try {
      const selected = await readProjectFile(active.fileHandle);
      const runtimeAssets = await createRuntimeAssets(active.directoryHandle, selected.document);
      setNotice("");
      beginLoadingProject({
        ...active,
        projectName: projectDisplayName(selected.document, active.projectName),
        expectedDiskText: selected.diskText,
        document: selected.document,
        runtimeAssetSources: runtimeAssets.sources,
        missingAssets: runtimeAssets.missing,
      });
    } catch (reloadError) {
      setSaveState("error");
      setNotice(`Could not reload the project: ${errorMessage(reloadError)}`);
    }
  }, [beginLoadingProject, setSaveState]);

  const overwriteExternalProject = useCallback(() => {
    setNotice("");
    setSaveState("dirty");
    void drainWrites({ overwrite: true });
  }, [drainWrites, setSaveState]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.origin !== "null") return;
      const message = event.data as EditorMessage;
      if (!message || message.source !== "ah2d-editor") return;

      if (message.type === "AH2D_EDITOR_READY") {
        editorReadyRef.current = true;
        const candidate = candidateRef.current;
        if (candidate) sendCandidate(candidate);
        return;
      }
      if (message.type === "AH2D_PROJECT_LOADED") {
        const candidate = candidateRef.current;
        if (!candidate || message.requestId !== candidate.requestId) return;
        const preservePending = candidate.preservePending === true
          && pendingWriteRef.current?.sessionId === candidate.session.id;
        sessionRef.current = candidate.session;
        candidateRef.current = null;
        if (!preservePending) pendingWriteRef.current = null;
        acceptsChangesRef.current = true;
        setSession({ ...candidate.session });
        if (!preservePending) setSaveState("saved");
        setOpening(false);
        setEditorLoaded(true);
        setGateOpen(false);
        window.document.title = `${candidate.session.projectName} — AH2D Editor`;
        const notices: string[] = [];
        if (candidate.session.missingAssets.length) notices.push(`Opened with ${candidate.session.missingAssets.length} unresolved local image asset${candidate.session.missingAssets.length === 1 ? "" : "s"}; open the project folder to resolve relative paths.`);
        if (!candidate.session.fileHandle) notices.push("Save downloads a new copy because direct filesystem access is unavailable.");
        if (notices.length) setNotice(notices.join(" "));
        return;
      }
      if (message.type === "AH2D_PROJECT_CHANGED" && message.document && acceptsChangesRef.current) {
        try {
          const document = parseUniversalProject(JSON.stringify(message.document));
          queueDocument(document);
        } catch (changeError) {
          setSaveState("error");
          setNotice(`The Editor produced an invalid project snapshot: ${errorMessage(changeError)}`);
        }
        return;
      }
      if (message.type === "AH2D_SAVE_REQUEST" && message.document && acceptsChangesRef.current) {
        try {
          queueDocument(parseUniversalProject(JSON.stringify(message.document)), true);
        } catch (saveError) {
          setSaveState("error");
          setNotice(errorMessage(saveError));
        }
        return;
      }
      if (message.type === "AH2D_EDITOR_COMMAND") {
        if (message.command === "new") showProjectGate(true);
        if (message.command === "open" || message.command === "recent") showProjectGate(false);
        return;
      }
      if (message.type === "AH2D_BRIDGE_ERROR") {
        const bridgeError = message.message || "The Editor could not load this project.";
        candidateRef.current = null;
        acceptsChangesRef.current = Boolean(sessionRef.current);
        setOpening(false);
        setError(bridgeError);
        setNotice(sessionRef.current ? bridgeError : "");
      }
    }
    window.addEventListener("message", onMessage);
    postToEditor({ type: "AH2D_STUDIO_READY" });
    return () => window.removeEventListener("message", onMessage);
  }, [postToEditor, queueDocument, sendCandidate, setSaveState, showProjectGate]);

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (!pendingWriteRef.current && !["dirty", "saving", "conflict", "error"].includes(saveStateRef.current)) return;
      event.preventDefault();
      event.returnValue = true;
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const handleEditorFrameLoad = useCallback(() => {
    editorReadyRef.current = false;
    acceptsChangesRef.current = false;
    setEditorLoaded(false);
    const active = sessionRef.current;
    if (!candidateRef.current && active) {
      setOpening(true);
      void writeChainRef.current.then(() => {
        if (candidateRef.current) return;
        const refreshed = sessionRef.current;
        if (!refreshed) return;
        const pending = pendingWriteRef.current;
        const latestDocument = pending?.sessionId === refreshed.id ? pending.document : refreshed.document;
        const candidate: CandidateProject = {
          requestId: nextId("reload"),
          session: { ...refreshed, document: latestDocument },
          preservePending: Boolean(pending?.sessionId === refreshed.id),
        };
        candidateRef.current = candidate;
        sendCandidate(candidate);
      });
    }
    postToEditor({ type: "AH2D_STUDIO_READY" });
  }, [postToEditor, sendCandidate]);

  return (
    <main className="local-workspace">
      <iframe
        ref={iframeRef}
        className="editor-frame"
        src="/api/editor/frame"
        title="AH2D Editor"
        sandbox="allow-scripts allow-downloads allow-modals"
        referrerPolicy="origin"
        aria-hidden={gateOpen || opening}
        inert={gateOpen || opening}
        onLoad={handleEditorFrameLoad}
      />

      {gateOpen ? (
        <section className="local-project-gate" aria-label="Choose a local project">
          <div className="local-gate-grid" />
          <div className="local-gate-orb local-gate-orb-a" />
          <div className="local-gate-orb local-gate-orb-b" />
          <header className="local-gate-brand">
            <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
            <span><strong>AH2D</strong><small>Editor</small></span>
          </header>
          {session ? (
            <button className="local-return-button" type="button" onClick={() => setGateOpen(false)}>
              Return to {session.projectName}
            </button>
          ) : null}
          <div className="local-gate-content">
            <p className="eyebrow">Local-first workspace</p>
            <h1>Your game lives<br />on your machine.</h1>
            <p className="local-gate-lead">Open an AH2D project folder or create a new one. The browser writes the Universal Project directly to your selected location.</p>
            <div className="local-project-actions">
              <button className="local-project-action local-project-action-primary" type="button" onClick={() => void openPickedProject()}>
                <span className="local-action-icon" aria-hidden="true">↗</span>
                <span><strong>Open Project</strong><small>Choose an existing local folder</small></span>
                <b aria-hidden="true">→</b>
              </button>
              <button className="local-project-action" type="button" onClick={() => { setError(""); setNewProjectOpen(true); }}>
                <span className="local-action-icon" aria-hidden="true">＋</span>
                <span><strong>New Project</strong><small>Create a project on this system</small></span>
                <b aria-hidden="true">→</b>
              </button>
            </div>
            {error ? <p className="local-gate-error" role="alert"><span>!</span>{error}</p> : null}
            <p className="local-browser-note">Direct folder access works in current Chromium-based browsers on HTTPS or localhost.</p>
          </div>
          <footer className="local-gate-footer"><span>Universal Project v4</span><span>PixiJS · Box2D · Local files</span></footer>
        </section>
      ) : null}

      {newProjectOpen ? (
        <div className="local-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setNewProjectOpen(false); }}>
          <form className="local-project-dialog glass-panel" role="dialog" aria-modal="true" aria-labelledby="new-project-title" onSubmit={createProject}>
            <button className="local-dialog-close" type="button" onClick={() => setNewProjectOpen(false)} aria-label="Close">×</button>
            <span className="local-dialog-glyph" aria-hidden="true">＋</span>
            <p className="eyebrow">New local project</p>
            <h2 id="new-project-title">Create Project</h2>
            <p>Choose a name, then select the parent folder. AH2D creates a project folder containing <code>{AH2D_PROJECT_MANIFEST}</code>.</p>
            <label>
              <span>Project name</span>
              <input className="surface-input" autoFocus maxLength={80} value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="My 2D Game" />
            </label>
            {error ? <p className="local-dialog-error" role="alert">{error}</p> : null}
            <div className="dialog-actions">
              <button className="ghost-button" type="button" onClick={() => setNewProjectOpen(false)}>Cancel</button>
              <button className="primary-button" type="submit">Choose Location</button>
            </div>
          </form>
        </div>
      ) : null}

      {opening || (!gateOpen && !editorLoaded) ? (
        <div className="local-editor-loader" aria-live="polite">
          <span className="workspace-loader-mark"><i /><i /><i /></span>
          <strong>Opening local project</strong>
          <small>Validating the Universal document…</small>
        </div>
      ) : null}

      {!gateOpen && session && saveState !== "idle" ? (
        <button className={`local-save-chip local-save-${saveState}`} type="button" onClick={() => showProjectGate(false)} title={`${session.locationLabel}/${session.fileName} — Open project switcher`}>
          <i /><span>{saveState === "dirty" ? "Unsaved" : saveState === "downloaded" ? "Downloaded" : saveState}</span><b>{session.fileName}</b>
        </button>
      ) : null}

      {notice && !gateOpen ? (
        <div className="local-host-notice" role="status">
          <span>{notice}</span>
          {saveState === "conflict" ? (
            <>
              <button type="button" onClick={() => void reloadExternalProject()}>Reload disk</button>
              <button className="is-danger" type="button" onClick={overwriteExternalProject}>Overwrite</button>
            </>
          ) : saveState === "error" && pendingWriteRef.current ? (
            <button type="button" onClick={() => void drainWrites()}>Retry</button>
          ) : null}
          <button className="local-notice-close" type="button" onClick={() => setNotice("")} aria-label="Dismiss">×</button>
        </div>
      ) : null}

      <input
        ref={fallbackInputRef}
        className="local-file-input"
        type="file"
        accept=".ah2d.json,.json,application/json"
        onChange={(event) => void openFallbackFile(event.currentTarget.files?.[0])}
      />
    </main>
  );
}
