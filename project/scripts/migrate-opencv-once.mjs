// One-off migration: restructure OpenCV入门 into one folder per section
// (分类/笔记名称/index.md + assets/), retiring the legacy asset-folder titles
// ("入门-basic functions" etc.) by renaming images to <章节号>-<原文件名>.
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dir = path.join(root, "src", "content", "notes", "OpenCV入门");
const backup = path.resolve(root, "..", ".backup-OpenCV入门-20260927");

// old asset folder -> default new home for its unreferenced images
const defaults = {
  "入门-basic image knowledge": "1.2 图像、像素与坐标",
  "入门-resizeing and cropping改变大小和剪切": "2.2 缩放裁剪与拼接",
  "cv2.threshold 的使用方法": "2.5 二值化与阈值",
  "入门 - color detection": "2.7 HSV颜色检测",
  "入门-basic functions": "1.3 读取显示与保存图像",
  "入门- shape detection": "3.5 多边形逼近与形状识别",
  "入门- shapes and texts": "2.3 绘制图形与文字",
  "入门-warp perspective透视": "3.6 外接矩形与透视变换",
  "得到矩形box，面积": "3.6 外接矩形与透视变换",
  "凸包，凸凹陷": "3.7 凸包凸缺陷与Solidity",
  "3.3 轮廓层级": "3.3 轮廓层级",
};

await fs.rm(backup, { recursive: true, force: true });
await fs.cp(dir, backup, { recursive: true });
console.log("backup ->", backup);

const entries = await fs.readdir(dir, { withFileTypes: true });
const mdNames = entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name);
const sections = new Map(); // folder -> { folder, prefix }
for (const name of mdNames) {
  const folder = name.replace(/\.md$/, "");
  const prefix = /^(\d+\.\d+)/.exec(folder)?.[1] ?? folder;
  sections.set(folder, { folder, prefix });
}

// collect references: section -> array of { folder, file, size }
const notes = [];
for (const name of mdNames) {
  const folder = name.replace(/\.md$/, "");
  const text = await fs.readFile(path.join(dir, name), "utf8");
  const refs = [];
  const replaced = text.replace(/!\[\[([^\]]+)\]\]/g, (full, inner) => {
    const [rawTarget, rawSize] = inner.split("|");
    const clean = rawTarget.trim().replace(/^OpenCV入门\/系统学习\//, "");
    let oldFolder = "";
    let file = clean;
    if (clean.includes("/")) {
      const parts = clean.split("/");
      if (parts[0] !== "assets" || parts.length !== 3) return full; // unexpected form, leave as is
      [ , oldFolder, file] = parts;
    }
    refs.push({ oldFolder, file, size: rawSize?.trim() ?? "" });
    return full;
  });
  notes.push({ folder, name, text: replaced, refs });
}

// plan image destinations: referenced files follow their referrers, others the default home
const imagesRoot = path.join(dir, "assets");
const oldFolders = (await fs.readdir(imagesRoot, { withFileTypes: true })).filter((e) => e.isDirectory());
const homeOfBareFile = new Map(); // bare filename -> old folder that actually contains it
for (const old of oldFolders) {
  const files = await fs.readdir(path.join(imagesRoot, old.name));
  for (const file of files) if (!homeOfBareFile.has(file.toLowerCase())) homeOfBareFile.set(file.toLowerCase(), old.name);
}
const lookup = new Map(); // `${section}|${oldFolder}|${file}` -> final asset name
const moves = []; // { srcFiles:[...], destDir, newName }
const takenNames = new Map(); // section -> Set(names)
const nameFor = (section, file) => {
  const used = takenNames.get(section.folder) ?? new Set();
  takenNames.set(section.folder, used);
  let name = `${section.prefix}-${file}`;
  for (let i = 2; used.has(name); i++) name = `${section.prefix}-${file.replace(/(\.[^.]+)$/, `-${i}$1`)}`;
  used.add(name);
  return name;
};
const addMove = (section, oldFolder, file, src) => {
  const key = `${section.folder}|${oldFolder}|${file}`;
  if (lookup.has(key)) return;
  const newName = nameFor(section, file);
  lookup.set(key, newName);
  moves.push({ src, destDir: path.join(dir, section.folder, "assets"), newName });
};

for (const note of notes) {
  for (const ref of note.refs) {
    const oldFolder = ref.oldFolder || homeOfBareFile.get(ref.file.toLowerCase());
    if (!oldFolder) throw new Error(`cannot locate image ${ref.file} for ${note.folder}`);
    ref.oldFolder = oldFolder;
    addMove(sections.get(note.folder), oldFolder, ref.file, path.join(imagesRoot, oldFolder, ref.file));
  }
}
for (const note of notes) {
  for (const ref of note.refs) {
    if (!ref.oldFolder) continue;
    addMove(sections.get(note.folder), ref.oldFolder, ref.file, path.join(imagesRoot, ref.oldFolder, ref.file));
  }
}
for (const old of oldFolders) {
  const files = (await fs.readdir(path.join(imagesRoot, old.name))).filter((f) => !f.startsWith("."));
  for (const file of files) {
    const src = path.join(imagesRoot, old.name, file);
    const home = defaults[old.name];
    if (!home) throw new Error(`no default home for old folder ${old.name}`);
    addMove(sections.get(home), old.name, file, src);
  }
}

// apply: index.md with rewritten refs
for (const note of notes) {
  const section = sections.get(note.folder);
  const text = note.text.replace(/!\[\[([^\]]+)\]\]/g, (full, inner) => {
    const [rawTarget, rawSize] = inner.split("|");
    const clean = rawTarget.trim().replace(/^OpenCV入门\/系统学习\//, "");
    let oldFolder = "";
    let file = clean;
    if (clean.includes("/")) {
      const parts = clean.split("/");
      if (parts[0] !== "assets" || parts.length !== 3) return full;
      [ , oldFolder, file] = parts;
    } else {
      oldFolder = homeOfBareFile.get(file.toLowerCase()) ?? "";
    }
    const finalName = lookup.get(`${section.folder}|${oldFolder}|${file}`);
    if (!finalName) return full;
    return `![[assets/${finalName}${rawSize ? "|" + rawSize : ""}]]`;
  });
  const folderPath = path.join(dir, section.folder);
  await fs.mkdir(folderPath, { recursive: true });
  await fs.writeFile(path.join(folderPath, "index.md"), text, "utf8");
  await fs.rm(path.join(dir, note.name));
}
// apply: copy images (a source can feed several sections), then drop the old tree
for (const move of moves) {
  await fs.mkdir(move.destDir, { recursive: true });
  await fs.copyFile(move.src, path.join(move.destDir, move.newName));
}
for (const old of oldFolders) await fs.rm(path.join(imagesRoot, old.name), { recursive: true, force: true });
await fs.rm(imagesRoot, { recursive: true, force: true });
console.log(`migrated ${notes.length} notes, ${moves.length} image placements`);
