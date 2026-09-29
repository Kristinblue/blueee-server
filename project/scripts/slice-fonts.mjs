// 字体分片：把两个大字体（霞鹜文楷、更纱黑体）按「站点字符集」切成小片 woff2。
// 构建时统计全站笔记实际用到的字符（search-index.json），只保留这些字形，
// 再按 unicode-range 分片；浏览器只下载页面命中的片段。站点内容固定的前提下，
// 整站字体从 ~51MB 缩到几百 KB。访客评论打出未覆盖的字时回退系统字体。
// 评论、AI 聊天、页宠台词的字是动态的，统计不到——把它们手动收进
// assets/fonts/extra-chars.txt（带 # 注释分组，缺字就往里加）。
// 产物进 public/generated/fonts/，由 prepare-content.mjs 调用；
// 源字体在 assets/fonts/（不进 dist）；依赖 Python fonttools（pip install fonttools brotli）。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");
const SOURCE_DIR = path.join(projectRoot, "assets", "fonts");
const OUT_DIR = path.join(projectRoot, "public", "generated", "fonts");
const MANIFEST = path.join(projectRoot, ".font-slice-manifest.json");

// 切片规则（RANGES、过滤逻辑）变化时 +1，强制重建缓存——
// 缓存签名只含字体文件和字符集，感知不到规则本身的变化
const SLICE_RULES_VERSION = 2;

// 与 Google Fonts 同思路的分段：拉丁/标点/符号单独成片，CJK 主区等宽细切
const RANGES = [
  [0x0020, 0x00ff], // 基础拉丁与符号
  [0x0370, 0x03ff], // 希腊字母（颜文字常用 ω ε 等）
  [0x2000, 0x206f], // 常用标点（省略号、破折号等）
  [0x2190, 0x21ff], // 箭头（笔记里常见的 →）
  [0x2200, 0x22ff], // 数学符号（∀ ∞ ≈ 等颜文字部件）
  [0x2460, 0x24ff], // 带圈数字
  [0x2500, 0x257f], // 制表符（代码块 ASCII 图）
  [0x25a0, 0x27bf], // 几何图形、对错符号
  [0x3000, 0x303f], // 中文标点（，。、「」）
  [0x3220, 0x3247], // 带圈汉字数字
  [0xf900, 0xfaff], // 兼容表意文字
  [0xff00, 0xffef], // 全角形式
];
// CJK 统一表意文字 0x4e00–0x9fff 等宽细切（每段 ~0x160 码点）
for (let start = 0x4e00; start < 0xa000; start += 0x160) {
  RANGES.push([start, Math.min(start + 0x15f, 0x9fff)]);
}

function pyftsubset(args) {
  const python = process.platform === "win32" ? "python" : "python3";
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-m", "fontTools.subset", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`pyftsubset failed:\n${stderr}`))));
  });
}

async function runPool(tasks, limit) {
  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await queue.shift()();
  });
  await Promise.all(workers);
}

function rangeText(start, end) {
  let text = "";
  for (let cp = start; cp <= end; cp++) text += String.fromCodePoint(cp);
  return text;
}

// 段内码点 ∩ 站点字符集：没交集的段自然被丢弃
function rangeTextLimited(start, end, charset) {
  if (!charset) return rangeText(start, end);
  let text = "";
  for (let cp = start; cp <= end; cp++) {
    const ch = String.fromCodePoint(cp);
    if (charset.has(ch)) text += ch;
  }
  return text;
}

// 组件与页面源码里的中文：页宠消息、评论区界面、FAQ/投喂页面、页脚、
// 搜索面板文案等不在笔记内容里的展示文字（连注释一起收，多几个字形无伤大雅）
async function collectSourceCharset(charset) {
  const SRC_DIR = path.join(projectRoot, "src");
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(astro|css|ts|js|mjs)$/.test(entry.name)) {
        const text = await fs.readFile(full, "utf8");
        for (const ch of text) {
          const cp = ch.codePointAt(0);
          if (cp >= 0x2e80) charset.add(ch); // CJK 汉字与各类符号（ASCII 已全保）
        }
      }
    }
  };
  await walk(SRC_DIR);
}

// 全站字符集：笔记标题 + 正文纯文本 + 源码界面文字 + 界面必备（全部 ASCII、全部中文标点）
//             + extra-chars.txt 手动补充字库（聊天动态文字统计不到，见文件头说明）
async function loadSiteCharset() {
  const SEARCH_INDEX = path.join(projectRoot, "public", "generated", "search-index.json");
  const charset = new Set();
  for (let cp = 0x20; cp <= 0x7e; cp++) charset.add(String.fromCodePoint(cp)); // ASCII 全保
  for (let cp = 0x3000; cp <= 0x303f; cp++) charset.add(String.fromCodePoint(cp)); // 中文标点全保
  try {
    const extras = await fs.readFile(path.join(SOURCE_DIR, "extra-chars.txt"), "utf8");
    for (const line of extras.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue; // # 开头是注释
      for (const ch of trimmed) charset.add(ch);
    }
  } catch {
    // 补充字库不存在不报错，其余字符集照常
  }
  try {
    const docs = JSON.parse(await fs.readFile(SEARCH_INDEX, "utf8"));
    for (const doc of docs) {
      for (const ch of `${doc.title}${doc.text}`) charset.add(ch);
    }
  } catch {
    return null; // 索引还没生成：退回全量分段（首次构建 prepare-content 会先写索引再切字体）
  }
  await collectSourceCharset(charset);
  return charset;
}

// 源字体的修改时间签名，变了才需要重新分片
async function fontSignature(files) {
  const parts = [];
  for (const file of files) {
    const stat = await fs.stat(file);
    parts.push(`${path.basename(file)}:${stat.size}:${Math.round(stat.mtimeMs)}`);
  }
  return parts.join("|");
}

async function sliceFont({ srcFile, fontFamily, cssExtras, tag, charset }) {
  const cssParts = [];
  let slice = 0;
  const tasks = [];

  for (const [start, end] of RANGES) {
    const outName = `${tag}-${String(slice).padStart(3, "0")}.woff2`;
    const outPath = path.join(OUT_DIR, outName);
    const rangeCss = `U+${start.toString(16).toUpperCase()}-${end.toString(16).toUpperCase()}`;
    slice += 1;

    // 并行任务各用独立临时文件，避免读写竞态
    const tempFile = path.join(os.tmpdir(), `slice-${tag}-${slice}.txt`);
    tasks.push(async () => {
      await fs.writeFile(tempFile, rangeTextLimited(start, end, charset), "utf8");
      await pyftsubset([
        srcFile,
        `--text-file=${tempFile}`,
        `--output-file=${outPath}`,
        "--flavor=woff2",
        "--layout-features=*",
        "--no-hinting",
        "--desubroutinize",
      ]);
      // 该片在字体里一个字形都没有时产物是空壳，直接丢掉、不写 CSS
      const { size } = await fs.stat(outPath);
      await fs.rm(tempFile, { force: true });
      if (size < 400) {
        await fs.rm(outPath, { force: true });
        return;
      }
      cssParts.push({
        css: `@font-face{font-family:"${fontFamily}";src:url("/generated/fonts/${outName}") format("woff2");font-style:normal;font-weight:400;font-display:swap;${cssExtras}unicode-range:${rangeCss};}`,
        index: start,
      });
    });
  }

  await runPool(tasks, 10);
  cssParts.sort((a, b) => a.index - b.index);
  return cssParts.map((part) => part.css);
}

async function cacheValid(sources, charsetKey) {
  try {
    const saved = JSON.parse(await fs.readFile(MANIFEST, "utf8"));
    if (saved.signature !== `${await fontSignature(sources)}|${charsetKey}|${SLICE_RULES_VERSION}`) return false;
    await fs.access(path.join(OUT_DIR, "fonts.css"));
    return true;
  } catch {
    return false;
  }
}

export async function sliceFonts({ force = false } = {}) {
  const sources = [
    path.join(SOURCE_DIR, "LXGWWenKai-Regular.ttf"),
    path.join(SOURCE_DIR, "SarasaMonoSC-Regular.ttf"),
  ];

  const charset = await loadSiteCharset();
  const charsetKey = charset ? [...charset].sort().join("") : "full";
  if (!force && (await cacheValid(sources, charsetKey))) {
    return { skipped: true };
  }

  const t0 = Date.now();
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });

  const lxgwCss = await sliceFont({
    srcFile: sources[0],
    fontFamily: "LXGW WenKai Web",
    cssExtras: "",
    tag: "lxgw",
    charset,
  });
  const sarasaCss = await sliceFont({
    srcFile: sources[1],
    fontFamily: "Sarasa Mono SC Web",
    cssExtras: "size-adjust:78%;",
    tag: "sarasa",
    charset,
  });

  // Ubuntu Mono 只有 190KB 且纯拉丁，不值得分片，整体复制
  await fs.copyFile(
    path.join(projectRoot, "public", "fonts", "UbuntuMono-Regular.ttf"),
    path.join(OUT_DIR, "UbuntuMono-Regular.ttf"),
  );

  const css = [...lxgwCss, ...sarasaCss].join("\n") + "\n";
  await fs.writeFile(path.join(OUT_DIR, "fonts.css"), css, "utf8");
  await fs.writeFile(
    MANIFEST,
    JSON.stringify({ signature: `${await fontSignature(sources)}|${charsetKey}|${SLICE_RULES_VERSION}` }, null, 2),
    "utf8",
  );

  const files = await fs.readdir(OUT_DIR);
  const sizes = await Promise.all(files.map((f) => fs.stat(path.join(OUT_DIR, f)).then((s) => s.size)));
  return {
    skipped: false,
    slices: lxgwCss.length + sarasaCss.length,
    files: files.length,
    totalKB: Math.round(sizes.reduce((a, b) => a + b, 0) / 1024),
    seconds: Math.round((Date.now() - t0) / 1000),
  };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  const r = await sliceFonts({ force: process.argv.includes("--force") });
  console.log(
    r.skipped
      ? "字体分片未变化，跳过。"
      : `字体分片完成：${r.slices} 片 CSS、${r.files} 个文件共 ${r.totalKB}KB，耗时 ${r.seconds}s。`,
  );
}
