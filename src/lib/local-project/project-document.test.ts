import assert from "node:assert/strict";
import test from "node:test";
import { POST as createTemplate } from "../../app/api/editor/project-template/route";
import {
  AH2D_PROJECT_MANIFEST,
  LocalProjectDocumentError,
  parseUniversalProject,
  resolveProjectManifestName,
  safeProjectDirectoryName,
  serializeUniversalProject,
} from "./project-document";

test("safe project directory names preserve useful Unicode and avoid Windows reserved names", () => {
  assert.equal(safeProjectDirectoryName(" بازی  من "), "بازی-من");
  assert.equal(safeProjectDirectoryName("CON"), "ah2d-CON");
  assert.equal(safeProjectDirectoryName("A/B:* Demo"), "A-B-Demo");
});

test("manifest resolution prefers the canonical file and rejects ambiguous manifests", () => {
  assert.equal(
    resolveProjectManifestName(["level.ah2d.json", AH2D_PROJECT_MANIFEST], "MyGame"),
    AH2D_PROJECT_MANIFEST,
  );
  assert.equal(resolveProjectManifestName(["MyGame.ah2d.json"], "MyGame"), "MyGame.ah2d.json");
  assert.throws(
    () => resolveProjectManifestName(["a.ah2d.json", "b.ah2d.json"]),
    (error) => error instanceof LocalProjectDocumentError && error.code === "AMBIGUOUS_PROJECT_MANIFEST",
  );
});

test("project parsing validates the Universal container without dropping unknown fields", () => {
  const source = {
    format: "AH2D",
    version: 4,
    currentSceneId: "main",
    scenes: [{ id: "main", name: "Main", objects: [] }],
    extensionOwnedByAgent: { untouched: true },
  };
  const parsed = parseUniversalProject(JSON.stringify(source));
  assert.deepEqual(parsed.extensionOwnedByAgent, { untouched: true });
  assert.match(serializeUniversalProject(parsed), /"extensionOwnedByAgent"/);
  assert.ok(serializeUniversalProject(parsed).endsWith("\n"));
  assert.throws(() => parseUniversalProject("{}"), /AH2D Universal Project/);
});

test("project template endpoint uses the canonical v4 contract", async () => {
  const response = await createTemplate(new Request("http://localhost/api/editor/project-template", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Local Game" }),
  }));
  assert.equal(response.status, 200);
  const payload = await response.json() as { ok: boolean; document: Record<string, unknown> };
  assert.equal(payload.ok, true);
  assert.equal(payload.document.format, "AH2D");
  assert.equal(payload.document.version, 4);
  assert.deepEqual(payload.document.dataModel, {
    id: "ah2d.ecs",
    version: 1,
    componentSchemaVersion: 1,
  });
  assert.equal((payload.document.engine as Record<string, unknown>).runtime, "pixijs");
  assert.ok(Array.isArray(payload.document.scenes));
  assert.ok(Array.isArray(payload.document.prefabs));
});
