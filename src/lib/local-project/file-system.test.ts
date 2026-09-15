import assert from "node:assert/strict";
import test from "node:test";
import {
  findProjectInDirectory,
  listLocalProjectAssetPaths,
  localImageMimeType,
  normalizeLocalAssetPath,
  resolveProjectAssetFiles,
  writeProjectText,
  type ProjectDirectoryHandle,
  type WritableProjectFileHandle,
} from "./file-system";

const PROJECT = JSON.stringify({
  format: "AH2D",
  version: 4,
  currentSceneId: "main",
  scenes: [{ id: "main", name: "Main", objects: [] }],
});

function fakeFileHandle(name: string, initialText: string) {
  let text = initialText;
  let closed = false;
  const handle = {
    kind: "file",
    name,
    async getFile() {
      return new File([text], name, { type: "application/json" });
    },
    async createWritable() {
      let staged = text;
      return {
        async write(value: string | Blob) {
          staged = typeof value === "string" ? value : await value.text();
        },
        async close() {
          text = staged;
          closed = true;
        },
      };
    },
  } as unknown as WritableProjectFileHandle;
  return { handle, text: () => text, closed: () => closed };
}

function fakeDirectory(name: string, files: Array<{ name: string; handle: WritableProjectFileHandle }>) {
  return {
    kind: "directory",
    name,
    async *entries() {
      for (const file of files) yield [file.name, file.handle] as [string, FileSystemHandle];
    },
  } as unknown as ProjectDirectoryHandle;
}

test("folder resolution opens the canonical manifest and ignores unrelated JSON", async () => {
  const manifest = fakeFileHandle("project.ah2d.json", PROJECT);
  const packageFile = fakeFileHandle("package.json", JSON.stringify({ name: "not-a-project" }));
  const selected = await findProjectInDirectory(fakeDirectory("Demo", [
    { name: packageFile.handle.name, handle: packageFile.handle },
    { name: manifest.handle.name, handle: manifest.handle },
  ]));
  assert.equal(selected.fileName, "project.ah2d.json");
  assert.equal(selected.document.format, "AH2D");
});

test("folder resolution accepts one legacy exported JSON project", async () => {
  const manifest = fakeFileHandle("AH2D_Project.json", PROJECT);
  const selected = await findProjectInDirectory(fakeDirectory("Demo", [
    { name: manifest.handle.name, handle: manifest.handle },
  ]));
  assert.equal(selected.fileName, "AH2D_Project.json");
});

test("filesystem writes commit and close the writable stream", async () => {
  const target = fakeFileHandle("project.ah2d.json", PROJECT);
  await writeProjectText(target.handle, "next snapshot\n");
  assert.equal(target.text(), "next snapshot\n");
  assert.equal(target.closed(), true);
});

test("local asset paths stay inside the selected project directory", () => {
  assert.equal(localImageMimeType("sprite.PNG"), "image/png");
  assert.equal(localImageMimeType("art/vector.svg?revision=2"), "image/svg+xml");
  assert.equal(localImageMimeType("palette.bmp"), "image/bmp");
  assert.equal(localImageMimeType("readme.txt"), null);
  assert.equal(normalizeLocalAssetPath("./textures/hero%20one.png?cache=1"), "textures/hero one.png");
  assert.equal(normalizeLocalAssetPath("textures\\hero.png"), "textures/hero.png");
  assert.equal(normalizeLocalAssetPath("../secret.png"), null);
  assert.equal(normalizeLocalAssetPath("textures%5c..%5csecret.png"), null);
  assert.equal(normalizeLocalAssetPath("C%3A%5csecret.png"), null);
  assert.equal(normalizeLocalAssetPath("%2fetc%2fsecret.png"), null);
  assert.equal(normalizeLocalAssetPath("/absolute/secret.png"), null);
  assert.equal(normalizeLocalAssetPath("https://example.com/hero.png"), null);
  assert.equal(normalizeLocalAssetPath("data:image/png;base64,AA=="), null);
  assert.deepEqual(listLocalProjectAssetPaths({
    format: "AH2D", version: 4,
    assets: [{ id: "hero", imageSrc: "textures/hero.png" }, { id: "inline", imageSrc: "data:image/png;base64,AA==" }],
    scenes: [],
  }), ["textures/hero.png"]);
});

test("folder projects resolve nested Universal image assets without rewriting their paths", async () => {
  const hero = new File(["hero"], "hero.png", { type: "image/png" });
  const icon = new File(["icon"], "icon.webp", { type: "image/webp" });
  const fileHandle = (file: File) => ({ kind: "file", name: file.name, getFile: async () => file }) as unknown as WritableProjectFileHandle;
  const directories = new Map<string, ProjectDirectoryHandle>();
  const directory = (name: string, files: Record<string, File>) => ({
    kind: "directory",
    name,
    async *entries() {},
    async getDirectoryHandle(child: string) {
      const found = directories.get(child);
      if (!found) throw new DOMException("Missing", "NotFoundError");
      return found;
    },
    async getFileHandle(fileName: string) {
      const file = files[fileName];
      if (!file) throw new DOMException("Missing", "NotFoundError");
      return fileHandle(file);
    },
  }) as unknown as ProjectDirectoryHandle;
  directories.set("textures", directory("textures", { "hero.png": hero }));
  directories.set("ui", directory("ui", { "icon.webp": icon }));
  const root = directory("Demo", {});
  const document = JSON.parse(PROJECT);
  document.assets = [{ id: "hero", imageSrc: "textures/hero.png" }, { id: "missing", imageSrc: "textures/missing.png" }];
  document.scenes[0].objects.push({ id: "icon", components: { Renderable: { imageSrc: "ui/icon.webp" } } });

  const resolved = await resolveProjectAssetFiles(root, document);
  assert.deepEqual(resolved.missing, ["textures/missing.png"]);
  assert.deepEqual(resolved.files.map((entry) => entry.source), ["textures/hero.png", "ui/icon.webp"]);
  assert.ok(resolved.files[0].aliases.includes("hero"), "Asset IDs must resolve to the same ephemeral URL as their relative source");
  assert.equal(resolved.files[0].file, hero);
  assert.equal(resolved.files[1].file, icon);
});
