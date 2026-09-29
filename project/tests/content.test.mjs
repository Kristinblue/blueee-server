import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildContent } from "../scripts/prepare-content.mjs";

test("笔记可生成文章和关系图谱", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "blueee-notes-test-"));
  try {
    const result = await buildContent({
      contentRoot: path.resolve("tests/fixtures/notes"),
      generatedNotesFile: path.join(temporaryRoot, "notes.json"),
      publicGeneratedRoot: path.join(temporaryRoot, "public"),
    });

    assert.equal(result.notes.length, 2);
    assert.equal(result.graph.nodes.length, 2);
    assert.deepEqual(result.graph.links, [
      { source: "vision/intro", target: "vision/filter" },
    ]);
    const intro = result.notes.find((note) => note.slug === "vision/intro");
    assert.ok(intro);
    assert.equal(intro.sourcePath, "vision/intro/index.md");
    assert.ok(intro.lastModified, "每篇笔记应带「上次修改」时间");
    assert.match(intro.html, /\/notes\/vision\/filter/);
    const filter = result.notes.find((note) => note.slug === "vision/filter");
    assert.ok(filter);
    assert.match(filter.html, /data-language="python"/);
    assert.match(filter.html, /hljs-keyword/);
    assert.match(filter.html, /<mark>测试重点<\/mark>/);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("空笔记目录也能生成空图谱", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "blueee-empty-notes-test-"));
  try {
    const emptyContent = path.join(temporaryRoot, "content");
    await fs.mkdir(emptyContent, { recursive: true });
    const result = await buildContent({
      contentRoot: emptyContent,
      generatedNotesFile: path.join(temporaryRoot, "notes.json"),
      publicGeneratedRoot: path.join(temporaryRoot, "public"),
    });

    assert.deepEqual(result.notes, []);
    assert.deepEqual(result.graph, { nodes: [], links: [] });
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Obsidian 式平铺笔记共享 assets 只复制一份", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "blueee-shared-assets-test-"));
  try {
    const result = await buildContent({
      contentRoot: path.resolve("tests/fixtures/shared-assets"),
      generatedNotesFile: path.join(temporaryRoot, "notes.json"),
      publicGeneratedRoot: path.join(temporaryRoot, "public"),
    });

    assert.equal(result.notes.length, 2);
    const expectedUrl = "/generated/note-assets/assets/pic.png";
    for (const note of result.notes) {
      assert.ok(note.html.includes(expectedUrl), `${note.slug} 应引用共享图片`);
    }

    async function countFiles(directory) {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      let count = 0;
      for (const entry of entries) {
        if (entry.isDirectory()) count += await countFiles(path.join(directory, entry.name));
        else count += 1;
      }
      return count;
    }
    assert.equal(await countFiles(path.join(temporaryRoot, "public", "note-assets")), 1);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
