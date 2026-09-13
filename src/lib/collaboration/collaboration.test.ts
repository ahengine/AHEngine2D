import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CollaborationError } from "./errors";
import { CollaborationEventHub } from "./event-hub";
import { CollaborationService } from "./service";
import { CollaborationProjectStore } from "./store";
import type { CollaborationActor } from "./types";
import { authenticatedApi, jsonBody } from "./api";
import { accountAllowsProjectRole } from "./account-role";
import { createLocalUser, loginWithCredentials, SESSION_COOKIE_NAME } from "../auth";
import { POST as createProjectRoute } from "../../app/api/projects/route";
import { POST as addMemberRoute } from "../../app/api/projects/[projectId]/members/route";
import { PATCH as updateMemberRoute } from "../../app/api/projects/[projectId]/members/[userId]/route";
import { GET as getEditorEngineRoute } from "../../app/api/editor/engine/route";
import { GET as getEditorFrameRoute } from "../../app/api/editor/frame/route";

const owner: CollaborationActor = { id: "owner-1", name: "Owner", email: "owner@example.test" };
const editor: CollaborationActor = { id: "editor-1", name: "Editor", email: "editor@example.test" };
const viewer: CollaborationActor = { id: "viewer-1", name: "Viewer", email: "viewer@example.test" };

async function rejectsCode(task: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(task, (error: unknown) =>
    error instanceof CollaborationError && error.code === code,
  );
}

async function main(): Promise<void> {
  const unauthenticated = await authenticatedApi(
    new Request("http://localhost/api/projects"),
    async () => Response.json({ ok: true }),
  );
  assert.equal(unauthenticated.status, 401, "project APIs must reject missing sessions as 401");

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

  assert.equal(accountAllowsProjectRole("VIEWER", "viewer"), true);
  assert.equal(accountAllowsProjectRole("VIEWER", "commenter"), false);
  assert.equal(accountAllowsProjectRole("COMMENTER", "editor"), false);
  assert.equal(accountAllowsProjectRole("EDITOR", "editor"), true);

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
    assert.equal(created.project.role, "owner");
    const normalizedSnapshot = await service.getDocument(owner, projectId);
    const normalizedDocument = normalizedSnapshot.document as {
      scenes: Array<{ objects: unknown[] }>;
      scene: unknown[];
      meta: { currentSceneId: string };
    };
    assert.deepEqual(normalizedDocument.scene, normalizedDocument.scenes[0].objects);
    assert.equal(normalizedDocument.meta.currentSceneId, "main");


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

    await rejectsCode(
      () => service.createProject({ ...viewer, accountRole: "VIEWER" }, { name: "Forbidden" }),
      "ACCOUNT_PERMISSION_DENIED",
    );

    await service.upsertMember(owner, projectId, { ...editor, userId: editor.id, role: "editor" });
    await service.upsertMember(owner, projectId, { ...viewer, userId: viewer.id, role: "viewer" });
    await rejectsCode(
      () => service.upsertMember(owner, projectId, { ...owner, userId: owner.id, role: "editor" }),
      "OWNER_ROLE_IMMUTABLE",
    );
    assert.equal((await service.listProjects(editor))[0].role, "editor");

    await rejectsCode(
      () => service.patchDocument(viewer, projectId, {
        expectedRevision: 1,
        operations: [{ op: "replace", path: "/currentSceneId", value: "other" }],
      }),
      "PROJECT_PERMISSION_DENIED",
    );
    await rejectsCode(
      () => service.patchDocument({ ...editor, accountRole: "VIEWER" }, projectId, {
        expectedRevision: 1,
        operations: [{ op: "add", path: "/forbidden", value: true }],
      }),
      "ACCOUNT_PERMISSION_DENIED",
    );

    const demotedAccount: CollaborationActor = {
      id: "commenter-with-editor-membership",
      name: "Demoted Account",
      email: "demoted@example.test",
      accountRole: "COMMENTER",
    };
    await service.upsertMember(owner, defaults.project.id, {
      ...demotedAccount,
      userId: demotedAccount.id,
      role: "editor",
    });
    await rejectsCode(
      () => service.patchDocument(demotedAccount, defaults.project.id, {
        expectedRevision: 1,
        operations: [{ op: "add", path: "/forbiddenByAccountRole", value: true }],
      }),
      "ACCOUNT_PERMISSION_DENIED",
    );
    const permittedComment = await service.createComment(demotedAccount, defaults.project.id, {
      body: "Comment permission remains available after account-role demotion.",
    });
    assert.equal(permittedComment.comment.author.id, demotedAccount.id);

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

    await rejectsCode(
      () => service.updateComment(viewer, projectId, comment.comment.id, { body: "Unauthorized edit" }),
      "PROJECT_PERMISSION_DENIED",
    );
    await service.updateComment(editor, projectId, comment.comment.id, { status: "resolved" });

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

    process.env.AH2D_AUTH_STORE_PATH = path.join(directory, "route-auth.json");
    process.env.AH2D_AUTH_SECRET = "collaboration-route-test-secret-at-least-thirty-two-bytes";
    const routeOwner = await createLocalUser({
      email: "route-owner@example.test",
      displayName: "Route Owner",
      password: "route-owner-password",
      role: "OWNER",
    });
    const routeViewer = await createLocalUser({
      email: "route-viewer@example.test",
      displayName: "Route Viewer",
      password: "route-viewer-password",
      role: "VIEWER",
    });
    const routeSession = await loginWithCredentials({
      email: routeOwner.email,
      password: "route-owner-password",
      ip: "member-cap-test",
    });
    const routeHeaders = {
      "Content-Type": "application/json",
      Cookie: `${SESSION_COOKIE_NAME}=${routeSession.token}`,
      Origin: "http://localhost",
    };
    const editorHeaders = { Cookie: `${SESSION_COOKIE_NAME}=${routeSession.token}` };
    const engineResponse = await getEditorEngineRoute(new Request(
      "http://localhost/api/editor/engine",
      { headers: editorHeaders },
    ));
    assert.equal(engineResponse.status, 200);
    const engineBundle = await engineResponse.text();
    const engineDataModelIndex = engineBundle.indexOf("root.AH2DDataModel = api");
    const engineRuntimeIndex = engineBundle.indexOf("const DataModel = global.AH2DDataModel");
    assert(engineDataModelIndex >= 0);
    assert(engineRuntimeIndex > engineDataModelIndex);

    const frameResponse = await getEditorFrameRoute(new Request(
      "http://localhost/api/editor/frame",
      { headers: editorHeaders },
    ));
    assert.equal(frameResponse.status, 200);
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
      body: JSON.stringify({ name: "Member Cap Route Test" }),
    }));
    assert.equal(routeProjectResponse.status, 201);
    const routeProjectPayload = await routeProjectResponse.json() as {
      data: { project: { id: string } };
    };
    const routeProjectId = routeProjectPayload.data.project.id;
    const membersUrl = `http://localhost/api/projects/${routeProjectId}/members`;
    const deniedMemberResponse = await addMemberRoute(new Request(membersUrl, {
      method: "POST",
      headers: routeHeaders,
      body: JSON.stringify({ userId: routeViewer.id, role: "editor" }),
    }), { params: Promise.resolve({ projectId: routeProjectId }) });
    assert.equal(deniedMemberResponse.status, 409);
    assert.equal((await deniedMemberResponse.json() as { error: { code: string } }).error.code, "ROLE_EXCEEDS_ACCOUNT");

    const allowedMemberResponse = await addMemberRoute(new Request(membersUrl, {
      method: "POST",
      headers: routeHeaders,
      body: JSON.stringify({ userId: routeViewer.id, role: "viewer" }),
    }), { params: Promise.resolve({ projectId: routeProjectId }) });
    assert.equal(allowedMemberResponse.status, 200);

    const deniedUpgradeResponse = await updateMemberRoute(new Request(`${membersUrl}/${routeViewer.id}`, {
      method: "PATCH",
      headers: routeHeaders,
      body: JSON.stringify({ role: "editor" }),
    }), { params: Promise.resolve({ projectId: routeProjectId, userId: routeViewer.id }) });
    assert.equal(deniedUpgradeResponse.status, 409);
    assert.equal((await deniedUpgradeResponse.json() as { error: { code: string } }).error.code, "ROLE_EXCEEDS_ACCOUNT");

    const persisted = JSON.parse(await readFile(path.join(directory, `${projectId}.json`), "utf8"));
    assert.equal(persisted.revision, 3);
    assert.equal(persisted.members[editor.id].role, "editor");
    console.log("AH2D collaboration tests passed");
  } finally {
    delete process.env.AH2D_AUTH_STORE_PATH;
    delete process.env.AH2D_AUTH_SECRET;
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
