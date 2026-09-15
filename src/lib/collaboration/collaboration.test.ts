import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { CollaborationError } from "./errors";
import { CollaborationEventHub } from "./event-hub";
import { CollaborationService } from "./service";
import { CollaborationProjectStore } from "./store";
import type { CollaborationActor } from "./types";
import { collaborationApi, jsonBody } from "./api";
import { GET as listProjectsRoute, POST as createProjectRoute } from "../../app/api/projects/route";
import { GET as getEditorEngineRoute } from "../../app/api/editor/engine/route";
import { GET as getEditorFrameRoute } from "../../app/api/editor/frame/route";

const owner: CollaborationActor = { id: "owner-1", name: "Owner" };
const editor: CollaborationActor = { id: "editor-1", name: "Editor" };
const viewer: CollaborationActor = { id: "viewer-1", name: "Viewer" };

async function rejectsCode(task: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(task, (error: unknown) =>
    error instanceof CollaborationError && error.code === code,
  );
}

async function main(): Promise<void> {
  const attributed = await collaborationApi(
    new Request("http://localhost/api/projects?actorId=query-user&actorName=Query%20User"),
    async (actor) => Response.json({ ok: true, actor }),
  );
  assert.equal(attributed.status, 200, "project APIs must be usable without a session");
  assert.deepEqual((await attributed.json() as { actor: CollaborationActor }).actor, {
    id: "query-user",
    name: "Query User",
  });

  const fallbackActor = await collaborationApi(
    new Request("http://localhost/api/projects"),
    async (actor) => Response.json({ ok: true, actor }),
  );
  assert.deepEqual((await fallbackActor.json() as { actor: CollaborationActor }).actor, {
    id: "local",
    name: "Local User",
  });

  const invalidActor = await collaborationApi(
    new Request("http://localhost/api/projects", {
      headers: { "x-ah2d-actor-id": "invalid actor id" },
    }),
    async () => Response.json({ ok: true }),
  );
  assert.equal(invalidActor.status, 400);
  assert.equal((await invalidActor.json() as { error: { code: string } }).error.code, "INVALID_ACTOR");

  const crossOrigin = await collaborationApi(
    new Request("http://localhost/api/projects", {
      method: "POST",
      headers: { Origin: "https://example.invalid" },
    }),
    async () => Response.json({ ok: true }),
  );
  assert.equal(crossOrigin.status, 403);
  assert.equal((await crossOrigin.json() as { error: { code: string } }).error.code, "INVALID_ORIGIN");

  await assert.rejects(
    () => jsonBody(new Request("http://localhost/api/projects", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(Number.MAX_SAFE_INTEGER),
      },
      body: "{}",
    })),
    (error: unknown) =>
      error instanceof CollaborationError &&
      error.code === "REQUEST_BODY_TOO_LARGE" &&
      error.status === 413,
  );

  const directory = await mkdtemp(path.join(os.tmpdir(), "ah2d-collaboration-test-"));
  process.env.AH2D_COLLAB_DATA_DIR = directory;
  const store = new CollaborationProjectStore();
  const hub = new CollaborationEventHub();
  const service = new CollaborationService(store, hub);

  try {
    const created = await service.createProject(owner, {
      name: "Collaboration Test",
      document: {
        format: "AH2D",
        version: 4,
        currentSceneId: "main",
        scenes: [{
          id: "main",
          name: "Main",
          objects: [{ id: "platform-1", name: "Platform" }],
        }],
        scene: [{ id: "stale-mirror", name: "Stale" }],
        futureExtension: { preserved: true },
      },
    });
    const projectId = created.project.id;
    assert.equal(created.project.revision, 1);
    const normalizedSnapshot = await service.getDocument(owner, projectId);
    const normalizedDocument = normalizedSnapshot.document as {
      scenes: Array<{ objects: unknown[] }>;
      scene: unknown[];
      meta: { currentSceneId: string };
    };
    assert.deepEqual(normalizedDocument.scene, normalizedDocument.scenes[0].objects);
    assert.equal(normalizedDocument.meta.currentSceneId, "main");

    const legacyId = "legacy-project";
    const legacyFixture = JSON.parse(
      await readFile(path.join(directory, `${projectId}.json`), "utf8"),
    ) as Record<string, unknown>;
    legacyFixture.schema = "ah2d.collaboration/project-v1";
    legacyFixture.id = legacyId;
    legacyFixture.ownerId = "legacy-owner";
    legacyFixture.members = {
      "legacy-owner": {
        userId: "legacy-owner",
        role: "owner",
        name: "Legacy Owner",
        email: "legacy@example.test",
        joinedAt: created.project.createdAt,
        updatedAt: created.project.updatedAt,
      },
    };
    legacyFixture.comments = [{
      id: "legacy-comment",
      projectId: legacyId,
      author: { id: "legacy-owner", name: "Legacy Owner", email: "legacy@example.test" },
      body: "Legacy comment",
      status: "resolved",
      createdAt: created.project.createdAt,
      updatedAt: created.project.updatedAt,
      resolvedAt: created.project.updatedAt,
      resolvedBy: { id: "legacy-reviewer", name: "Legacy Reviewer", email: "reviewer@example.test" },
    }];
    legacyFixture.history = (legacyFixture.history as Array<Record<string, unknown>>).map((action) => ({
      ...action,
      projectId: legacyId,
      actor: { id: "legacy-owner", name: "Legacy Owner", email: "legacy@example.test" },
    }));
    await writeFile(path.join(directory, `${legacyId}.json`), `${JSON.stringify(legacyFixture, null, 2)}\n`, "utf8");

    const migratedLegacy = await store.read(legacyId);
    assert.equal(migratedLegacy.schema, "ah2d.collaboration/project-v2");
    assert.equal("ownerId" in migratedLegacy, false);
    assert.equal("members" in migratedLegacy, false);
    assert.equal("email" in migratedLegacy.comments[0].author, false);
    assert.equal("email" in migratedLegacy.comments[0].resolvedBy!, false);
    assert.equal("email" in migratedLegacy.history[0].actor, false);
    assert.equal(
      (JSON.parse(await readFile(path.join(directory, `${legacyId}.json`), "utf8")) as { schema: string }).schema,
      "ah2d.collaboration/project-v1",
      "read-only access must not persist a migration",
    );
    await store.mutate(legacyId, (project) => { project.name = "Migrated Legacy Project"; });
    const persistedMigration = JSON.parse(
      await readFile(path.join(directory, `${legacyId}.json`), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(persistedMigration.schema, "ah2d.collaboration/project-v2");
    assert.equal("ownerId" in persistedMigration, false);
    assert.equal("members" in persistedMigration, false);
    assert.equal(
      "email" in ((persistedMigration.comments as Array<{ author: Record<string, unknown> }>)[0].author),
      false,
    );


    const defaults = await service.createProject(owner, { name: "Default Contract" });
    const defaultSnapshot = await service.getDocument(owner, defaults.project.id);
    const defaultDocument = defaultSnapshot.document as Record<string, unknown>;
    assert.deepEqual(defaultDocument.prefabs, []);
    assert.deepEqual(defaultDocument.animations, []);
    assert.deepEqual(defaultDocument.particles, []);
    assert.equal((defaultDocument.meta as { name?: string }).name, "Default Contract");
    assert.equal((defaultDocument.engine as { runtime?: string }).runtime, "custom");
    assert.equal(defaultDocument.currentSceneId, "main");
    assert.equal((defaultDocument.scenes as Array<{ id: string }>)[0].id, "main");
    assert.deepEqual(defaultDocument.dataModel, { id: "ah2d.ecs", version: 1, componentSchemaVersion: 1 });
    const defaultEffects = (defaultDocument.postProcess as {
      enabled: boolean;
      effects: Array<{ id: string }>;
    });
    assert.equal(defaultEffects.enabled, true);
    assert.deepEqual(
      defaultEffects.effects.map((effect) => effect.id),
      ["bloom", "vignette", "color-adjust", "chromatic-aberration", "pixelate", "crt"],
    );

    await rejectsCode(
      () => service.createProject(owner, {
        name: "Invalid Contract",
        document: { format: "AH2D", version: 4, scenes: [] },
      }),
      "INVALID_AH2D_PROJECT",
    );

    const legacyDescriptorProject = await service.createProject(owner, {
      name: "Legacy Data Model",
      document: {
        format: "AH2D",
        version: 4,
        dataModel: { id: "ah2d.ecs", version: 0, componentSchemaVersion: 0 },
        currentSceneId: "main",
        scenes: [{ id: "main", name: "Main", objects: [] }],
      },
    });
    const legacyDescriptorSnapshot = await service.getDocument(owner, legacyDescriptorProject.project.id);
    assert.deepEqual(
      (legacyDescriptorSnapshot.document as Record<string, unknown>).dataModel,
      { id: "ah2d.ecs", version: 0, componentSchemaVersion: 0 },
      "Studio strict validation must retain supported older descriptor versions",
    );

    await assert.rejects(
      () => service.createProject(owner, {
        name: "Future Data Model",
        document: {
          format: "AH2D",
          version: 4,
          dataModel: { id: "ah2d.ecs", version: 2, componentSchemaVersion: 1 },
          currentSceneId: "main",
          scenes: [{ id: "main", name: "Main", objects: [] }],
        },
      }),
      (error: unknown) => {
        if (!(error instanceof CollaborationError) || error.code !== "INVALID_AH2D_PROJECT") return false;
        const diagnostics = (error.details as { diagnostics?: Array<{ code?: string; pointer?: string }> } | undefined)?.diagnostics ?? [];
        return diagnostics.some(item => item.code === "E_FUTURE_DATA_MODEL_VERSION" && item.pointer === "/dataModel/version");
      },
    );

    await rejectsCode(
      () => service.createProject(owner, {
        name: "Non JSON Contract",
        document: {
          format: "AH2D",
          version: 4,
          currentSceneId: "main",
          scenes: [{ id: "main", name: "Main", objects: [] }],
          runtimeHandle: () => undefined,
        },
      }),
      "INVALID_PROJECT_DOCUMENT",
    );

    const publicProject = await service.createProject(viewer, { name: "Public Access" });
    const visibleProjects = await service.listProjects(editor);
    assert(visibleProjects.some((project) => project.id === publicProject.project.id));
    assert(visibleProjects.some((project) => project.id === legacyId));
    const publicPatch = await service.patchDocument(editor, publicProject.project.id, {
      expectedRevision: 1,
      operations: [{ op: "add", path: "/openAccess", value: true }],
    });
    assert.equal(publicPatch.revision, 2);
    assert.equal(publicPatch.action.actor.id, editor.id);

    const patched = await service.patchDocument(editor, projectId, {
      expectedRevision: 1,
      clientMutationId: "mutation-1",
      operations: [{ op: "add", path: "/editorMetadata", value: { zoom: 1.25 } }],
    });
    assert.equal(patched.revision, 2);
    assert.equal(patched.replayed, false);

    const replayed = await service.patchDocument(editor, projectId, {
      expectedRevision: 1,
      clientMutationId: "mutation-1",
      operations: [{ op: "add", path: "/ignoredRetry", value: true }],
    });
    assert.equal(replayed.revision, 2);
    assert.equal(replayed.replayed, true);

    await rejectsCode(
      () => service.patchDocument(editor, projectId, {
        expectedRevision: 1,
        operations: [{ op: "add", path: "/stale", value: true }],
      }),
      "REVISION_CONFLICT",
    );
    await rejectsCode(
      () => service.patchDocument(editor, projectId, {
        expectedRevision: 2,
        operations: [{ op: "add", path: "/constructor/polluted", value: true }],
      }),
      "UNSAFE_JSON_POINTER",
    );

    const concurrent = await Promise.allSettled([
      service.patchDocument(owner, projectId, {
        expectedRevision: 2,
        operations: [{ op: "add", path: "/concurrentOwner", value: true }],
      }),
      service.patchDocument(editor, projectId, {
        expectedRevision: 2,
        operations: [{ op: "add", path: "/concurrentEditor", value: true }],
      }),
    ]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = concurrent.find((result) => result.status === "rejected") as PromiseRejectedResult;
    assert(rejected.reason instanceof CollaborationError && rejected.reason.code === "REVISION_CONFLICT");

    const comment = await service.createComment(editor, projectId, {
      body: "Move this platform.",
      anchor: { sceneId: "main", entityId: "platform-1", x: 10, y: 20 },
      clientMutationId: "comment-1",
    });
    const duplicateComment = await service.createComment(editor, projectId, {
      body: "A retry must not duplicate this.",
      clientMutationId: "comment-1",
    });
    assert.equal(comment.comment.id, duplicateComment.comment.id);
    assert.equal((await service.listComments(viewer, projectId)).comments.length, 1);

    const publicCommentUpdate = await service.updateComment(viewer, projectId, comment.comment.id, {
      body: "Public edit",
      status: "resolved",
    });
    assert.equal(publicCommentUpdate.comment.body, "Public edit");
    assert.equal(publicCommentUpdate.comment.resolvedBy?.id, viewer.id);

    const eventTypes: string[] = [];
    const unsubscribe = hub.subscribe(projectId, (event) => eventTypes.push(event.type));
    const ownerConnection = hub.connect(projectId, "browser", owner);
    const editorConnection = hub.connect(projectId, "browser", editor);
    assert.equal(hub.listPresence(projectId).length, 2, "same client ID from different users must not collide");
    hub.updatePresence(projectId, "browser", editor, { sceneId: "main", entityIds: ["platform-1"] });
    hub.disconnect(projectId, "browser", editorConnection.token);
    hub.disconnect(projectId, "browser", ownerConnection.token);
    unsubscribe();
    assert.deepEqual(eventTypes, ["presence.joined", "presence.joined", "presence.updated", "presence.left", "presence.left"]);

    const history = await service.listHistory(owner, projectId, 0, 100);
    assert(history.actions.some((action) => action.type === "document.patched" && action.actor.id === editor.id));
    assert(history.actions.some((action) => action.type === "comment.created" && action.actor.id === editor.id));
    assert.equal(history.actions.filter((action) => action.clientMutationId === "comment-1").length, 1);

    const document = await service.getDocument(owner, projectId);
    assert.deepEqual((document.document as Record<string, unknown>).futureExtension, { preserved: true });
    assert.deepEqual((document.document as Record<string, unknown>).editorMetadata, { zoom: 1.25 });
    assert.equal("ignoredRetry" in (document.document as Record<string, unknown>), false);

    await rejectsCode(
      () => service.patchDocument(editor, projectId, {
        expectedRevision: document.revision,
        operations: Array.from({ length: 513 }, (_, index) => ({
          op: "add" as const,
          path: `/too-many-${index}`,
          value: index,
        })),
      }),
      "PATCH_TOO_LARGE",
    );
    await rejectsCode(
      () => service.patchDocument(editor, projectId, {
        expectedRevision: document.revision,
        operations: [{ op: "remove", path: "/scenes" }],
      }),
      "INVALID_AH2D_PROJECT",
    );
    assert.equal((await service.getDocument(owner, projectId)).revision, document.revision);

    const routeHeaders = {
      "Content-Type": "application/json",
      Origin: "http://localhost",
      "x-ah2d-actor-id": "route-actor",
      "x-ah2d-actor-name": "Route Actor",
    };
    const rejectedRouteMutation = await createProjectRoute(new Request("http://localhost/api/projects", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://example.invalid",
      },
      body: JSON.stringify({ name: "Rejected Cross-Origin Project" }),
    }));
    assert.equal(rejectedRouteMutation.status, 403);
    assert.equal(
      (await rejectedRouteMutation.json() as { error: { code: string } }).error.code,
      "INVALID_ORIGIN",
    );

    const engineResponse = await getEditorEngineRoute();
    assert.equal(engineResponse.status, 200);
    const engineBundle = await engineResponse.text();
    const enginePlanckIndex = engineBundle.indexOf("Planck.js v1.5.0");
    const engineDataModelIndex = engineBundle.indexOf("root.AH2DDataModel = api");
    const engineRuntimeIndex = engineBundle.indexOf("const DataModel = global.AH2DDataModel");
    assert(enginePlanckIndex >= 0);
    assert(engineDataModelIndex >= 0);
    assert(engineDataModelIndex > enginePlanckIndex);
    assert(engineRuntimeIndex > engineDataModelIndex);

    const frameResponse = await getEditorFrameRoute(new Request("http://localhost/api/editor/frame"));
    assert.equal(frameResponse.status, 200);
    const frameCsp = frameResponse.headers.get("content-security-policy") ?? "";
    assert.match(frameCsp, /default-src 'none'/);
    assert.doesNotMatch(frameCsp, /script-src[^;]*'unsafe-eval'/);
    assert.equal(frameResponse.headers.get("referrer-policy"), "no-referrer");
    const frameSource = await frameResponse.text();
    const framePixiIndex = frameSource.indexOf("var PIXI=(function");
    const framePixiCspIndex = frameSource.indexOf("generateUniformsSyncPolyfill");
    const framePlanckIndex = frameSource.indexOf("Planck.js v1.5.0");
    const frameDataModelIndex = frameSource.indexOf("root.AH2DDataModel = api");
    const frameRuntimeIndex = frameSource.indexOf("const DataModel = global.AH2DDataModel");
    assert(framePixiIndex >= 0);
    assert(framePixiCspIndex > framePixiIndex);
    assert(framePlanckIndex > framePixiCspIndex);
    assert(frameDataModelIndex >= 0);
    assert(frameRuntimeIndex > frameDataModelIndex);
    assert(frameDataModelIndex > framePlanckIndex);
    assert.equal(frameSource.includes('<script src="./node_modules/pixi.js/dist/pixi.min.js"></script>'), false);
    assert.equal(frameSource.includes('<script src="./node_modules/pixi.js/dist/packages/unsafe-eval.min.js"></script>'), false);
    assert.equal(frameSource.includes('<script src="./node_modules/planck/dist/planck.min.js"></script>'), false);
    assert.equal(frameSource.includes('<script src="./engine/AH2DEngine.js"></script>'), false);
    assert.equal(frameSource.includes('<script src="./engine/AH2DDataModel.js"></script>'), false);
    assert.match(frameSource, /const authoredKeys\s*=\s*\[[^\]]*"prefabs"/);
    assert.match(frameSource, /const REQUEST_ORIGIN = "http:\/\/localhost"/);
    assert.match(frameSource, /document\.referrer \? new URL\(document\.referrer\)\.origin : REQUEST_ORIGIN/);
    assert.match(frameSource, /event\.source !== window\.parent \|\| event\.origin !== EXPECTED_PARENT_ORIGIN/);
    assert.match(frameSource, /window\.__AH2D_HOSTED__ = window\.parent !== window/);
    assert.match(frameSource, /postMessage\([^\n]+EXPECTED_PARENT_ORIGIN\)/);
    assert.match(frameSource, /AH2D_SAVE_REQUEST/);
    assert.match(frameSource, /AH2D_EDITOR_COMMAND/);
    assert.match(frameSource, /merged\.animations\s*=\s*mergeAnimations\(baseProject\.animations, editorDocument\.animations\)/);
    assert.match(frameSource, /merged\.particles\s*=\s*mergeParticles\(baseProject\.particles, editorDocument\.particles\)/);
    assert.doesNotMatch(frameSource, /!Array\.isArray\(baseProject\.animations\)/);

    const bridgeSource = frameSource.match(
      /<script data-ah2d-workspace-bridge>\s*([\s\S]*?)<\/script>/,
    )?.[1];
    assert(bridgeSource, "the rendered Editor frame must contain its workspace bridge");

    const bridgeListeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
    const bridgeMessages: Array<Record<string, unknown>> = [];
    const bridgeParent = {
      postMessage(message: Record<string, unknown>, origin: string) {
        bridgeMessages.push({ ...structuredClone(message), targetOrigin: origin });
      },
    };
    let editorSnapshot: Record<string, unknown> | null = null;
    const bridgeWindow = {
      parent: bridgeParent,
      projectData: () => editorSnapshot,
      loadProject(project: Record<string, unknown>) {
        const sourceClip = (project.animations as Array<Record<string, unknown>>)[0];
        const sourceParticle = (project.particles as Array<Record<string, unknown>>)[0];
        editorSnapshot = {
          ...structuredClone(project),
          animations: [
            {
              id: sourceClip.id,
              name: sourceClip.name,
              fps: 24,
              frameCount: sourceClip.frameCount,
              loop: sourceClip.loop,
              tracks: structuredClone(sourceClip.tracks),
            },
            {
              id: "new-clip",
              name: "New Clip",
              fps: 10,
              frameCount: 2,
              loop: false,
              tracks: [],
            },
          ],
          particles: [
            {
              id: sourceParticle.id ?? "spark",
              name: sourceParticle.name,
              duration: 2,
              loop: sourceParticle.loop,
              maxParticles: sourceParticle.maxParticles,
              emission: { rate: 48, burst: 2 },
              lifetime: structuredClone(sourceParticle.lifetime),
              velocity: structuredClone(sourceParticle.velocity),
              shape: structuredClone(sourceParticle.shape),
              appearance: structuredClone(sourceParticle.appearance),
              curves: (sourceParticle.curves as Array<Record<string, unknown>>).map((curve) => ({
                id: curve.id,
                property: curve.property,
                interpolation: curve.interpolation,
                keys: (curve.keys as Array<Record<string, unknown>>).map((key) => ({
                  id: key.id,
                  time: key.time,
                  value: key.value,
                })),
              })),
            },
            {
              id: "new-particle",
              name: "New Particle",
              duration: 1,
              loop: false,
              maxParticles: 20,
              emission: { rate: 5, burst: 0 },
              lifetime: { min: 0.25, max: 0.5 },
              velocity: { speedMin: 10, speedMax: 20, angle: -90, spread: 20, gravityX: 0, gravityY: 10 },
              shape: { type: "point", radius: 0, width: 0, height: 0 },
              appearance: { color: "#ffffff", blend: "normal", baseScale: 1, baseOpacity: 1, baseHue: 0 },
              curves: [],
            },
          ],
        };
        return true;
      },
      addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
        const listeners = bridgeListeners.get(type) ?? [];
        listeners.push(listener);
        bridgeListeners.set(type, listeners);
      },
      setInterval() { return 1; },
      setTimeout() { return 1; },
      toast() {},
    };
    const bridgeDocument = {
      referrer: "http://localhost/",
      addEventListener() {},
      getElementById() { return null; },
    };
    vm.runInNewContext(bridgeSource, {
      window: bridgeWindow,
      document: bridgeDocument,
      URL,
      Date,
      JSON,
      Error,
      structuredClone,
      performance: { now: () => 0 },
    }, { filename: "editor-workspace-bridge.js" });

    const loadedProject = {
      format: "AH2D",
      version: 4,
      project: { name: "Animation Bridge" },
      scenes: [{ id: "main", name: "Main", objects: [] }],
      currentSceneId: "main",
      scene: [],
      animations: [
        {
          id: "walk",
          name: "Walk",
          fps: 12,
          frameCount: 4,
          loop: true,
          tracks: [],
          futureClipExtension: { curveEditor: "keep-me" },
        },
        {
          id: "delete-me",
          name: "Deleted in Editor",
          fps: 12,
          frameCount: 1,
          loop: false,
          tracks: [],
        },
      ],
      particles: [
        {
          name: "Spark",
          duration: 1,
          loop: true,
          maxParticles: 100,
          emission: { rate: 12, burst: 1, futureEmissionExtension: "keep-emission" },
          lifetime: { min: 0.5, max: 1 },
          velocity: { speedMin: 20, speedMax: 40, angle: -90, spread: 30, gravityX: 0, gravityY: 20 },
          shape: { type: "circle", radius: 8, width: 0, height: 0 },
          appearance: { color: "#80bfff", blend: "additive", baseScale: 1, baseOpacity: 1, baseHue: 0 },
          curves: [{
            id: "spark-opacity",
            property: "opacity",
            interpolation: "linear",
            futureCurveExtension: "keep-curve",
            keys: [
              { id: "spark-opacity-start", time: 0, value: 1, outTangent: 3, futureKeyExtension: "keep-key" },
              { id: "spark-opacity-end", time: 1, value: 0 },
            ],
          }],
          futureParticleExtension: { renderer: "keep-me" },
        },
        {
          id: "delete-particle",
          name: "Deleted in Editor",
          duration: 1,
          loop: false,
          maxParticles: 5,
          emission: { rate: 0, burst: 1 },
          lifetime: { min: 1, max: 1 },
          velocity: { speedMin: 0, speedMax: 0, angle: 0, spread: 0, gravityX: 0, gravityY: 0 },
          shape: { type: "point", radius: 0, width: 0, height: 0 },
          appearance: { color: "#ffffff", blend: "normal", baseScale: 1, baseOpacity: 1, baseHue: 0 },
          curves: [],
        },
      ],
    };
    const messageListener = bridgeListeners.get("message")?.[0];
    assert(messageListener, "the bridge must subscribe to parent messages");
    messageListener({
      source: bridgeParent,
      origin: "http://localhost",
      data: {
        source: "ah2d-studio",
        type: "AH2D_LOAD_PROJECT",
        requestId: "animation-load",
        document: loadedProject,
      },
    });
    const hostCommandListener = bridgeListeners.get("ah2d:host-command")?.[0];
    assert(hostCommandListener, "the bridge must subscribe to hosted save commands");
    hostCommandListener({ detail: { command: "save", document: editorSnapshot } });

    const saveMessage = bridgeMessages.find((message) => message.type === "AH2D_SAVE_REQUEST");
    assert(saveMessage, "an authored animation change must produce a hosted save request");
    const savedAnimations = (saveMessage.document as {
      animations: Array<Record<string, unknown>>;
    }).animations;
    assert.equal(savedAnimations.length, 2, "the authored clip list owns additions and deletions");
    assert.equal(savedAnimations[0].id, "walk");
    assert.equal(savedAnimations[0].fps, 24, "known authored values must replace the base clip values");
    assert.deepEqual(
      savedAnimations[0].futureClipExtension,
      { curveEditor: "keep-me" },
      "unknown clip fields must survive the Editor/bridge round-trip",
    );
    assert.equal(savedAnimations[1].id, "new-clip");
    assert.equal(
      savedAnimations.some((clip) => clip.id === "delete-me"),
      false,
      "clips removed by the Editor must not be restored by the bridge",
    );
    const savedParticles = (saveMessage.document as {
      particles: Array<Record<string, unknown>>;
    }).particles;
    assert.equal(savedParticles.length, 2, "the authored particle library owns additions and deletions");
    assert.equal(savedParticles[0].id, "spark");
    assert.equal(savedParticles[0].duration, 2);
    assert.deepEqual(savedParticles[0].emission, {
      rate: 48,
      burst: 2,
      futureEmissionExtension: "keep-emission",
    });
    assert.equal(
      (savedParticles[0].emission as Record<string, unknown>).futureEmissionExtension,
      "keep-emission",
    );
    assert.deepEqual(
      savedParticles[0].futureParticleExtension,
      { renderer: "keep-me" },
      "unknown legacy Particle Asset fields must survive ID normalization and the Editor/bridge round-trip",
    );
    const savedParticleCurves = savedParticles[0].curves as Array<Record<string, unknown>>;
    assert.equal(savedParticleCurves[0].futureCurveExtension, "keep-curve");
    assert.equal(
      ((savedParticleCurves[0].keys as Array<Record<string, unknown>>)[0]).futureKeyExtension,
      "keep-key",
    );
    assert.equal(
      "outTangent" in (savedParticleCurves[0].keys as Array<Record<string, unknown>>)[0],
      false,
      "clearing an optional Curve tangent in the Editor must not resurrect it during hosted merge",
    );
    assert.equal(savedParticles[1].id, "new-particle");
    assert.equal(savedParticles.some((asset) => asset.id === "delete-particle"), false);
    assert.equal(saveMessage.targetOrigin, "http://localhost");

    const routeProjectResponse = await createProjectRoute(new Request("http://localhost/api/projects", {
      method: "POST",
      headers: routeHeaders,
      body: JSON.stringify({ name: "Open Route Test" }),
    }));
    assert.equal(routeProjectResponse.status, 201);
    const routeProjectPayload = await routeProjectResponse.json() as {
      data: { project: { id: string }; action: { actor: CollaborationActor } };
    };
    const routeProjectId = routeProjectPayload.data.project.id;
    assert.deepEqual(routeProjectPayload.data.action.actor, { id: "route-actor", name: "Route Actor" });

    const listResponse = await listProjectsRoute(new Request("http://localhost/api/projects"));
    assert.equal(listResponse.status, 200);
    const listedRouteProjects = await listResponse.json() as { data: { projects: Array<{ id: string }> } };
    assert(listedRouteProjects.data.projects.some((project) => project.id === routeProjectId));

    const persisted = JSON.parse(await readFile(path.join(directory, `${projectId}.json`), "utf8"));
    assert.equal(persisted.revision, 3);
    assert.equal(persisted.schema, "ah2d.collaboration/project-v2");
    assert.equal("members" in persisted, false);
    console.log("AH2D collaboration tests passed");
  } finally {
    delete process.env.AH2D_COLLAB_DATA_DIR;
    const resolved = path.resolve(directory);
    assert(resolved.startsWith(path.resolve(os.tmpdir())), "test cleanup escaped the temporary directory");
    await rm(resolved, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
