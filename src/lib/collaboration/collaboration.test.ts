import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
    assert.deepEqual(defaultDocument.prefab, []);
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
    const engineDataModelIndex = engineBundle.indexOf("root.AH2DDataModel = api");
    const engineRuntimeIndex = engineBundle.indexOf("const DataModel = global.AH2DDataModel");
    assert(engineDataModelIndex >= 0);
    assert(engineRuntimeIndex > engineDataModelIndex);

    const frameResponse = await getEditorFrameRoute();
    assert.equal(frameResponse.status, 200);
    assert.match(frameResponse.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.equal(frameResponse.headers.get("referrer-policy"), "no-referrer");
    const frameSource = await frameResponse.text();
    const framePixiIndex = frameSource.indexOf("var PIXI=(function");
    const frameDataModelIndex = frameSource.indexOf("root.AH2DDataModel = api");
    const frameRuntimeIndex = frameSource.indexOf("const DataModel = global.AH2DDataModel");
    assert(framePixiIndex >= 0);
    assert(frameDataModelIndex >= 0);
    assert(frameRuntimeIndex > frameDataModelIndex);
    assert(frameDataModelIndex > framePixiIndex);
    assert.equal(frameSource.includes('<script src="./node_modules/pixi.js/dist/pixi.min.js"></script>'), false);
    assert.equal(frameSource.includes('<script src="./engine/AH2DEngine.js"></script>'), false);
    assert.equal(frameSource.includes('<script src="./engine/AH2DDataModel.js"></script>'), false);

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
