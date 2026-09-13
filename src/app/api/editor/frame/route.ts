import { readFile } from "node:fs/promises";
import path from "node:path";
import { authErrorResponse, requireRequestAuth } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WORKSPACE_BRIDGE = String.raw`
<script data-ah2d-workspace-bridge>
(() => {
  const SOURCE_EDITOR = "ah2d-editor";
  const SOURCE_STUDIO = "ah2d-studio";
  let lastSnapshot = "";
  let ignoreChangesUntil = 0;
  let readySent = false;
  let baseProject = null;

  function clone(value) {
    if (value == null) return value;
    return typeof structuredClone === "function"
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  }

  function mergeRecord(base, authored) {
    return {
      ...(base && typeof base === "object" && !Array.isArray(base) ? clone(base) : {}),
      ...(authored && typeof authored === "object" && !Array.isArray(authored) ? clone(authored) : {}),
    };
  }

  function mergeScenes(baseScenes, authoredScenes) {
    if (!Array.isArray(authoredScenes)) return clone(baseScenes);
    const originals = new Map(
      (Array.isArray(baseScenes) ? baseScenes : [])
        .filter((scene) => scene && typeof scene === "object" && scene.id != null)
        .map((scene) => [String(scene.id), scene]),
    );
    return authoredScenes.map((scene) => {
      const original = scene && typeof scene === "object" ? originals.get(String(scene.id)) : null;
      const merged = mergeRecord(original, scene);
      if (scene && typeof scene === "object" && scene.view !== undefined) {
        merged.view = mergeRecord(original && original.view, scene.view);
      }
      return merged;
    });
  }

  // Merge the fields authored by the current editor into the original
  // universal document. Runtime extensions and future schema fields must
  // survive an editor autosave even when this UI cannot render them yet.
  function mergeProject(editorDocument) {
    if (!baseProject || typeof baseProject !== "object") return clone(editorDocument);
    const merged = clone(baseProject);
    const authoredKeys = ["format", "version", "currentSceneId", "scene", "folders", "prefab"];
    for (const key of authoredKeys) {
      if (editorDocument[key] !== undefined) merged[key] = clone(editorDocument[key]);
    }

    merged.engine = mergeRecord(baseProject.engine, editorDocument.engine);
    merged.postProcess = mergeRecord(baseProject.postProcess, editorDocument.postProcess);
    if (Array.isArray(editorDocument.scenes)) {
      merged.scenes = mergeScenes(baseProject.scenes, editorDocument.scenes);
    }

    merged.meta = {
      ...(baseProject.meta && typeof baseProject.meta === "object" ? clone(baseProject.meta) : {}),
      ...(editorDocument.meta && typeof editorDocument.meta === "object" ? clone(editorDocument.meta) : {}),
    };
    if (baseProject.project && typeof baseProject.project === "object" && baseProject.project.name) {
      merged.meta.name = baseProject.project.name;
    } else if (baseProject.meta && typeof baseProject.meta === "object" && baseProject.meta.name) {
      merged.meta.name = baseProject.meta.name;
    }

    // The current Animator does not load arbitrary external clip extensions.
    if (!Array.isArray(baseProject.animations) && Array.isArray(editorDocument.animations)) {
      merged.animations = clone(editorDocument.animations);
    }

    // Particle UI authors the first system; additional systems remain opaque.
    if (Array.isArray(editorDocument.particles)) {
      merged.particles = Array.isArray(baseProject.particles) && baseProject.particles.length > 1
        ? [clone(editorDocument.particles[0]), ...clone(baseProject.particles.slice(1))]
        : clone(editorDocument.particles);
    }

    // Keep non-image/runtime asset descriptors the editor cannot display.
    if (Array.isArray(editorDocument.assets)) {
      const authoredIds = new Set(editorDocument.assets.map((asset) => asset && asset.id).filter(Boolean));
      const opaqueAssets = Array.isArray(baseProject.assets)
        ? baseProject.assets.filter((asset) => !asset || !asset.id || (!authoredIds.has(asset.id) && !asset.imageSrc))
        : [];
      merged.assets = [...clone(editorDocument.assets), ...clone(opaqueAssets)];
    }
    return merged;
  }

  function send(type, detail) {
    if (window.parent === window) return;
    window.parent.postMessage({ source: SOURCE_EDITOR, type, ...(detail || {}) }, "*");
  }

  function readProject() {
    try {
      return typeof window.projectData === "function" ? window.projectData() : null;
    } catch (error) {
      send("AH2D_BRIDGE_ERROR", { message: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  function announceReady(force) {
    if ((!force && readySent) || typeof window.projectData !== "function" || typeof window.loadProject !== "function") return;
    readySent = true;
    const document = readProject();
    lastSnapshot = document ? JSON.stringify(document) : "";
    send("AH2D_EDITOR_READY", { capabilities: ["project-load", "project-snapshot", "autosave"] });
  }

  function publishIfChanged(force) {
    announceReady();
    if (!readySent || Date.now() < ignoreChangesUntil) return;
    const editorDocument = readProject();
    if (!editorDocument) return;
    const document = mergeProject(editorDocument);
    const serialized = JSON.stringify(document);
    if (!force && serialized === lastSnapshot) return;
    lastSnapshot = serialized;
    baseProject = clone(document);
    send("AH2D_PROJECT_CHANGED", { document });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.source !== SOURCE_STUDIO) return;

    if (message.type === "AH2D_STUDIO_READY") {
      announceReady(true);
      return;
    }

    if (message.type === "AH2D_LOAD_PROJECT" && message.document && typeof window.loadProject === "function") {
      try {
        ignoreChangesUntil = Date.now() + 1000;
        baseProject = clone(message.document);
        window.loadProject(message.document);
        const current = mergeProject(readProject());
        lastSnapshot = current ? JSON.stringify(current) : "";
        send("AH2D_PROJECT_LOADED", { requestId: message.requestId || null });
      } catch (error) {
        send("AH2D_BRIDGE_ERROR", {
          requestId: message.requestId || null,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (message.type === "AH2D_REQUEST_PROJECT") publishIfChanged(true);
  });

  let lastPresence = "";
  let lastPointerSentAt = 0;
  function publishPresence(cursor) {
    try {
      const presence = {
        sceneId: state.currentSceneId || undefined,
        entityIds: Array.isArray(state.sceneSelectedIds) ? [...state.sceneSelectedIds] : [],
        ...(cursor ? { cursor } : {}),
      };
      const signature = JSON.stringify(presence);
      if (!cursor && signature === lastPresence) return;
      lastPresence = signature;
      send("AH2D_EDITOR_PRESENCE", { presence });
    } catch {}
  }

  document.addEventListener("pointermove", (event) => {
    const canvas = document.getElementById("sceneCanvas");
    if (event.target !== canvas || typeof sceneS2W !== "function") return;
    const now = performance.now();
    if (now - lastPointerSentAt < 120) return;
    lastPointerSentAt = now;
    const bounds = canvas.getBoundingClientRect();
    publishPresence(sceneS2W(event.clientX - bounds.left, event.clientY - bounds.top));
  }, { passive: true });
  document.addEventListener("pointerup", () => publishPresence(), { passive: true });
  window.setInterval(() => publishPresence(), 700);

  window.addEventListener("load", announceReady, { once: true });
  window.setInterval(() => publishIfChanged(false), 650);
  window.setTimeout(announceReady, 0);
})();
</script>`;

export async function GET(request: Request) {
  try {
    await requireRequestAuth(request);
    const [editorSource, engineSource] = await Promise.all([
      readFile(path.join(process.cwd(), "AH2DEdtior.html"), "utf8"),
      readFile(path.join(process.cwd(), "engine", "AH2DEngine.js"), "utf8"),
    ]);
    let html = editorSource.replace(
      '<script src="./engine/AH2DEngine.js"></script>',
      `<script>${engineSource.replace(/<\/script/gi, "<\\/script")}</script>`,
    );
    html = html.replace("</body>", `${WORKSPACE_BRIDGE}\n</body>`);

    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
