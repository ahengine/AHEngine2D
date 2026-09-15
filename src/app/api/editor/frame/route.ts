import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WORKSPACE_BRIDGE = String.raw`
<script data-ah2d-workspace-bridge>
(() => {
  const SOURCE_EDITOR = "ah2d-editor";
  const SOURCE_STUDIO = "ah2d-studio";
  const REQUEST_ORIGIN = __AH2D_PARENT_ORIGIN__;
  const EXPECTED_PARENT_ORIGIN = (() => {
    try { return document.referrer ? new URL(document.referrer).origin : REQUEST_ORIGIN; }
    catch { return REQUEST_ORIGIN; }
  })();
  window.__AH2D_HOSTED__ = window.parent !== window;
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

  function animationKey(clip) {
    if (!clip || typeof clip !== "object" || Array.isArray(clip)) return null;
    if (clip.id != null && String(clip.id).trim()) return "id:" + String(clip.id);
    if (clip.name != null && String(clip.name).trim()) return "name:" + String(clip.name);
    return null;
  }

  function mergeAnimations(baseAnimations, authoredAnimations) {
    if (!Array.isArray(authoredAnimations)) return clone(baseAnimations);
    const originals = new Map();
    for (const clip of Array.isArray(baseAnimations) ? baseAnimations : []) {
      const key = animationKey(clip);
      if (key && !originals.has(key)) originals.set(key, clip);
    }
    return authoredAnimations.map((clip) => {
      const key = animationKey(clip);
      const original = key ? originals.get(key) : null;
      return clip && typeof clip === "object" && !Array.isArray(clip)
        ? mergeRecord(original, clip)
        : clone(clip);
    });
  }

  function mergeParticles(baseParticles, authoredParticles) {
    if (!Array.isArray(authoredParticles)) return clone(baseParticles);
    const originalsById = new Map();
    const originalsByName = new Map();
    const legacyOriginalsByName = new Map();
    for (const asset of Array.isArray(baseParticles) ? baseParticles : []) {
      if (!asset || typeof asset !== "object" || Array.isArray(asset)) continue;
      const id = asset.id != null ? String(asset.id).trim() : "";
      const name = asset.name != null ? String(asset.name).trim() : "";
      if (id && !originalsById.has(id)) originalsById.set(id, asset);
      if (name && !originalsByName.has(name)) originalsByName.set(name, asset);
      if (!id && name && !legacyOriginalsByName.has(name)) legacyOriginalsByName.set(name, asset);
    }
    return authoredParticles.map((asset) => {
      const id = asset && typeof asset === "object" && asset.id != null ? String(asset.id).trim() : "";
      const name = asset && typeof asset === "object" && asset.name != null ? String(asset.name).trim() : "";
      // Canonical IDs always win. Name matching is only a migration bridge
      // when one side has no ID, never a way to merge two different IDs.
      const original = id
        ? (originalsById.get(id) || (name ? legacyOriginalsByName.get(name) : null))
        : (name ? originalsByName.get(name) : null);
      if (!asset || typeof asset !== "object" || Array.isArray(asset)) return clone(asset);
      const merged = mergeRecord(original, asset);
      for (const field of ["emission", "lifetime", "velocity", "shape", "appearance"]) {
        if (asset[field] !== undefined) merged[field] = mergeRecord(original && original[field], asset[field]);
      }
      if (Array.isArray(asset.curves)) {
        const originalCurves = Array.isArray(original && original.curves) ? original.curves : [];
        const curvesById = new Map();
        const curvesByProperty = new Map();
        const legacyCurvesByProperty = new Map();
        for (const curve of originalCurves) {
          if (!curve || typeof curve !== "object" || Array.isArray(curve)) continue;
          const curveId = curve.id != null ? String(curve.id).trim() : "";
          const property = curve.property != null ? String(curve.property).trim() : "";
          if (curveId && !curvesById.has(curveId)) curvesById.set(curveId, curve);
          if (property && !curvesByProperty.has(property)) curvesByProperty.set(property, curve);
          if (!curveId && property && !legacyCurvesByProperty.has(property)) legacyCurvesByProperty.set(property, curve);
        }
        merged.curves = asset.curves.map((curve) => {
          if (!curve || typeof curve !== "object" || Array.isArray(curve)) return clone(curve);
          const curveId = curve.id != null ? String(curve.id).trim() : "";
          const property = curve.property != null ? String(curve.property).trim() : "";
          const originalCurve = curveId
            ? (curvesById.get(curveId) || (property ? legacyCurvesByProperty.get(property) : null))
            : (property ? curvesByProperty.get(property) : null);
          const mergedCurve = mergeRecord(originalCurve, curve);
          if (!Array.isArray(curve.keys)) return mergedCurve;
          const originalKeys = Array.isArray(originalCurve && originalCurve.keys) ? originalCurve.keys : [];
          const keysById = new Map();
          const keysByTime = new Map();
          const legacyKeysByTime = new Map();
          for (const key of originalKeys) {
            if (!key || typeof key !== "object" || Array.isArray(key)) continue;
            const keyId = key.id != null ? String(key.id).trim() : "";
            const time = Number(key.time);
            if (keyId && !keysById.has(keyId)) keysById.set(keyId, key);
            if (Number.isFinite(time) && !keysByTime.has(time)) keysByTime.set(time, key);
            if (!keyId && Number.isFinite(time) && !legacyKeysByTime.has(time)) legacyKeysByTime.set(time, key);
          }
          mergedCurve.keys = curve.keys.map((key) => {
            if (!key || typeof key !== "object" || Array.isArray(key)) return clone(key);
            const keyId = key.id != null ? String(key.id).trim() : "";
            const time = Number(key.time);
            const originalKey = keyId
              ? (keysById.get(keyId) || (Number.isFinite(time) ? legacyKeysByTime.get(time) : null))
              : (Number.isFinite(time) ? keysByTime.get(time) : null);
            const mergedKey = mergeRecord(originalKey, key);
            // Tangents are optional authored values. Omitting one is the
            // Editor's explicit "use automatic segment slope" operation, so
            // a hosted merge must not resurrect the previous tangent.
            for (const tangent of ["inTangent", "outTangent"]) {
              if (!Object.prototype.hasOwnProperty.call(key, tangent)) delete mergedKey[tangent];
            }
            return mergedKey;
          });
          return mergedCurve;
        });
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
    const authoredKeys = ["format", "version", "currentSceneId", "scene", "folders", "prefab", "prefabs"];
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

    // Animation clips are authored by the Editor. Merge matching records by
    // stable ID (or legacy name) so future clip-level extension fields survive
    // an Editor round-trip while additions, deletions and ordering remain owned
    // by the authored array.
    if (Array.isArray(editorDocument.animations)) {
      merged.animations = mergeAnimations(baseProject.animations, editorDocument.animations);
    }

    // Particle Assets are authored as a stable-ID library. Matching records
    // retain extension fields the current Editor does not understand, while
    // additions, deletions, ordering, and known values come from the Editor.
    if (Array.isArray(editorDocument.particles)) {
      merged.particles = mergeParticles(baseProject.particles, editorDocument.particles);
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
    window.parent.postMessage({ source: SOURCE_EDITOR, type, ...(detail || {}) }, EXPECTED_PARENT_ORIGIN);
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
    if (event.source !== window.parent || event.origin !== EXPECTED_PARENT_ORIGIN) return;
    const message = event.data;
    if (!message || message.source !== SOURCE_STUDIO) return;

    if (message.type === "AH2D_STUDIO_READY") {
      announceReady(true);
      return;
    }

    if (message.type === "AH2D_LOAD_PROJECT" && message.document && typeof window.loadProject === "function") {
      const previousBaseProject = baseProject;
      const previousSnapshot = lastSnapshot;
      const previousIgnoreChangesUntil = ignoreChangesUntil;
      try {
        ignoreChangesUntil = Date.now() + 1000;
        baseProject = clone(message.document);
        const loaded = window.loadProject(message.document);
        if (loaded !== true) throw new Error("Stop Preview before opening another Project.");
        const current = mergeProject(readProject());
        if (!current) throw new Error("The Editor did not produce a project snapshot after loading.");
        lastSnapshot = current ? JSON.stringify(current) : "";
        send("AH2D_PROJECT_LOADED", { requestId: message.requestId || null });
      } catch (error) {
        baseProject = previousBaseProject;
        lastSnapshot = previousSnapshot;
        ignoreChangesUntil = previousIgnoreChangesUntil;
        send("AH2D_BRIDGE_ERROR", {
          requestId: message.requestId || null,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (message.type === "AH2D_REQUEST_PROJECT") publishIfChanged(true);
    if (message.type === "AH2D_SAVE_RESULT" && typeof window.toast === "function") {
      window.toast(message.ok ? "Project saved to disk" : (message.message || "Project save failed"));
    }
  });

  window.addEventListener("ah2d:host-command", (event) => {
    const detail = event && event.detail && typeof event.detail === "object" ? event.detail : {};
    const command = String(detail.command || "");
    if (command === "save") {
      const editorDocument = detail.document || readProject();
      if (!editorDocument) return;
      const document = mergeProject(editorDocument);
      lastSnapshot = JSON.stringify(document);
      baseProject = clone(document);
      send("AH2D_SAVE_REQUEST", { document });
      return;
    }
    if (["new", "open", "recent"].includes(command)) {
      send("AH2D_EDITOR_COMMAND", { command });
    }
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
  const [editorSource, pixiSource, pixiCspSource, planckSource, dataModelSource, engineSource] = await Promise.all([
    readFile(path.join(process.cwd(), "AH2DEdtior.html"), "utf8"),
    readFile(path.join(process.cwd(), "node_modules", "pixi.js", "dist", "pixi.min.js"), "utf8"),
    readFile(path.join(process.cwd(), "node_modules", "pixi.js", "dist", "packages", "unsafe-eval.min.js"), "utf8"),
    readFile(path.join(process.cwd(), "node_modules", "planck", "dist", "planck.min.js"), "utf8"),
    readFile(path.join(process.cwd(), "engine", "AH2DDataModel.js"), "utf8"),
    readFile(path.join(process.cwd(), "engine", "AH2DEngine.js"), "utf8"),
  ]);
  let html = editorSource
    .replace(
      '<script src="./node_modules/pixi.js/dist/pixi.min.js"></script>',
      () => `<script>${pixiSource.replace(/<\/script/gi, "<\\/script")}</script>`,
    )
    .replace(
      '<script src="./node_modules/pixi.js/dist/packages/unsafe-eval.min.js"></script>',
      () => `<script>${pixiCspSource.replace(/<\/script/gi, "<\\/script")}</script>`,
    )
    .replace(
      '<script src="./node_modules/planck/dist/planck.min.js"></script>',
      () => `<script>${planckSource.replace(/<\/script/gi, "<\\/script")}</script>`,
    )
    .replace('<script src="./engine/AH2DDataModel.js"></script>', "")
    .replace(
      '<script src="./engine/AH2DEngine.js"></script>',
      () => `<script>${dataModelSource.replace(/<\/script/gi, "<\\/script")}</script>\n` +
        `<script>${engineSource.replace(/<\/script/gi, "<\\/script")}</script>`,
    );
  const bridge = WORKSPACE_BRIDGE.replace("__AH2D_PARENT_ORIGIN__", JSON.stringify(new URL(request.url).origin));
  html = html.replace("</body>", `${bridge}\n</body>`);

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
