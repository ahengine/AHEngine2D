import assert from "node:assert/strict";
import test from "node:test";
import {
  findProjectInDirectory,
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
