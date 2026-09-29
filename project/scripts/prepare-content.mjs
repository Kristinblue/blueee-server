import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import matter from "gray-matter";
import { sliceFonts } from "./slice-fonts.mjs";
import hljs from "highlight.js";
import { marked } from "marked";

marked.use({
  extensions: [
    {
      name: "obsidian-highlight",
      level: "inline",
      start(source) {
        return source.indexOf("==");
      },
      tokenizer(source) {
        const match = /^==(?=\S)([\s\S]*?\S)==/.exec(source);
        if (!match) return undefined;
        return {
          type: "obsidian-highlight",
          raw: match[0],
          tokens: this.lexer.inlineTokens(match[1]),
        };
      },
      renderer(token) {
        return `<mark>${this.parser.parseInline(token.tokens)}</mark>`;
      },
    },
  ],
});

const projectRoot = path.resolve(import.meta.dirname, "..");

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function encodeUrlPath(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

function normalizeKey(value) {
  return value.trim().replace(/\\/g, "/").replace(/\.md$/i, "").toLowerCase();
}

function headingIdFromMarkdown(value) {
  return value
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/[*_~]/g, "")
    .trim();
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function plainTextFromHtml(value) {
  return value
    .replace(/<[^>]*>/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .trim();
}

// 供前端全文搜索使用：块级标签换成换行，再剥掉所有标签和实体，
// 这样摘录里的代码、列表内容都保留，且不会带出 HTML 标签。
function searchableTextFromHtml(value) {
  return value
    .replace(/<(script|style)[\s\S]*?<\/(script|style)>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-6]|li|pre|div|tr|blockquote|aside)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function normalizeCodeLanguage(language) {
  const aliases = {
    cxx: "cpp",
    "c++": "cpp",
    js: "javascript",
    ts: "typescript",
    py: "python",
    ps1: "powershell",
    pwsh: "powershell",
    sh: "bash",
    shell: "bash",
    yml: "yaml",
    text: "plaintext",
    txt: "plaintext",
  };
  const normalized = language.trim().toLowerCase().split(/\s+/)[0];
  return aliases[normalized] ?? normalized;
}

function createMarkdownRenderer() {
  const renderer = new marked.Renderer();
  const headingCounts = new Map();

  renderer.code = ({ text, lang }) => {
    const requestedLanguage = normalizeCodeLanguage(lang || "plaintext");
    const canHighlight = requestedLanguage !== "plaintext" && hljs.getLanguage(requestedLanguage);
    const highlighted = canHighlight
      ? hljs.highlight(text, { language: requestedLanguage }).value
      : escapeHtml(text);
    const languageClass = canHighlight ? ` language-${escapeHtml(requestedLanguage)}` : "";
    const languageLabel = lang ? ` data-language="${escapeHtml(lang.trim())}"` : "";
    return `<pre class="code-block"${languageLabel}><code class="hljs${languageClass}">${highlighted}</code></pre>\n`;
  };

  renderer.heading = function ({ tokens, depth }) {
    const content = this.parser.parseInline(tokens);
    const baseId = plainTextFromHtml(content) || `heading-${depth}`;
    const count = (headingCounts.get(baseId) ?? 0) + 1;
    headingCounts.set(baseId, count);
    const id = count === 1 ? baseId : `${baseId}-${count}`;
    return `<h${depth} id="${escapeHtml(id)}">${content}</h${depth}>\n`;
  };

  return renderer;
}

function transformRenderedCallouts(html) {
  const labels = {
    abstract: "学习概览",
    summary: "摘要",
    note: "说明",
    info: "信息",
    todo: "待办",
    tip: "提示",
    important: "重要",
    warning: "警告",
    danger: "危险",
    example: "示例",
    quote: "引用",
  };

  return html.replace(
    // 标题只取 [!type] 后的第一行；同一 <p> 里可能还跟着链接等内容
    // （如概览里的目录跳转），restInP 必须原样保留，否则整块内容会丢。
    /<blockquote>\s*<p>\[!([a-zA-Z0-9_-]+)\](?:[+-])?[ \t]*([^\n<]*)\n?([\s\S]*?)<\/p>([\s\S]*?)<\/blockquote>/g,
    (_full, rawType, rawTitle, restInP, body) => {
      const type = rawType.toLowerCase();
      const title = rawTitle.trim() || labels[type] || type;
      return `<aside class="callout callout-${escapeHtml(type)}"><div class="callout-title">${escapeHtml(title)}</div>${restInP}${body}</aside>`;
    },
  );
}

function slugFromFile(file, contentRoot) {
  const relative = toPosix(path.relative(contentRoot, file));
  const withoutExtension = relative.replace(/\.md$/i, "");
  return withoutExtension.endsWith("/index")
    ? withoutExtension.slice(0, -"/index".length)
    : withoutExtension;
}

async function listFiles(directory) {
  const results = [];
  let entries = [];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return results;
    throw error;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  for (const entry of entries) {
    if (entry.name === ".obsidian") continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...(await listFiles(fullPath)));
    else results.push(fullPath);
  }
  return results;
}

function findFirstHeading(markdown) {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

// 「上次修改」：优先取该文件最后一次 git 提交的时间（和仓库里能看到的历史一致），
// 文件还没提交过或环境里没有 git 时，回退用文件本身的修改时间。
function lastModifiedIso(file) {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%cI", "--", file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = out.trim();
    if (trimmed) return trimmed;
  } catch {
    // 没有 git 或不在仓库里，走 mtime 回退
  }
  return null;
}

function buildResolver(notes) {
  const exact = new Map();
  const byName = new Map();

  for (const note of notes) {
    const keys = [note.slug, note.title, path.posix.basename(note.slug)];
    for (const key of keys) {
      const normalized = normalizeKey(key);
      if (!exact.has(normalized)) exact.set(normalized, note);
    }

    const base = normalizeKey(path.posix.basename(note.slug));
    const candidates = byName.get(base) ?? [];
    candidates.push(note);
    byName.set(base, candidates);
  }

  return (target, source) => {
    const key = normalizeKey(target);
    if (exact.has(key)) return exact.get(key);

    const sameDirectory = normalizeKey(path.posix.join(path.posix.dirname(source.slug), target));
    if (exact.has(sameDirectory)) return exact.get(sameDirectory);

    const candidates = byName.get(normalizeKey(path.posix.basename(target))) ?? [];
    return candidates.length === 1 ? candidates[0] : null;
  };
}

// 整个 contentRoot 当作一个 Obsidian 库扫描：所有非 md 文件只复制一份，
// 图片按文件名全局匹配。所以一篇笔记一个文件夹、或多篇平铺 md 共用任意
// 位置的 assets 文件夹，都能正常显示。
async function copySharedAssets(contentRoot, publicAssetsRoot) {
  const assetMap = new Map();
  const files = await listFiles(contentRoot);
  for (const asset of files.filter((file) => !/\.md$/i.test(file))) {
    const relative = toPosix(path.relative(contentRoot, asset));
    const destination = path.join(publicAssetsRoot, ...relative.split("/"));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(asset, destination);
    const base = path.basename(asset).toLowerCase();
    if (!assetMap.has(base)) {
      assetMap.set(base, `/generated/note-assets/${encodeUrlPath(relative)}`);
    }
  }
  return assetMap;
}

function transformMarkdown(note, resolveNote, assetMap, graphLinks) {
  let markdown = note.markdown;

  markdown = markdown.replace(/!\[\[([^\]]+)\]\]/g, (_full, value) => {
    const [rawTarget, rawSize] = value.split("|");
    const target = rawTarget.trim();
    const url = assetMap.get(path.basename(target).toLowerCase());
    if (!url) return `> 缺少图片：${target}`;
    const size = /^\d+$/.test(rawSize?.trim() ?? "") ? ` width="${rawSize.trim()}"` : "";
    return `<img src="${url}" alt="${path.basename(target, path.extname(target))}"${size}>`;
  });

  markdown = markdown.replace(/!\[([^\]]*)\]\((?!https?:|data:|\/)([^)]+)\)/g, (_full, alt, rawTarget) => {
    const cleanTarget = rawTarget.trim().replace(/^\.\//, "");
    const url =
      assetMap.get(path.basename(cleanTarget).toLowerCase()) ??
      `/generated/note-assets/${encodeUrlPath(note.slug)}/${encodeUrlPath(cleanTarget)}`;
    return `![${alt}](${url})`;
  });

  markdown = markdown.replace(/(?<!!)\[\[([^\]]+)\]\]/g, (_full, value) => {
    const [rawDestination, rawLabel] = value.split("|");
    const [rawTarget, rawHeading] = rawDestination.split("#");
    const target = rawTarget.trim();
    const label = (rawLabel || rawHeading || target).trim();

    if (!target) {
      return rawHeading ? `[${label}](#${encodeURIComponent(headingIdFromMarkdown(rawHeading))})` : label;
    }

    const resolved = resolveNote(target, note);
    if (!resolved) return label;

    if (note.slug !== resolved.slug) {
      graphLinks.push({ source: note.slug, target: resolved.slug });
    }
    const anchor = rawHeading ? `#${encodeURIComponent(headingIdFromMarkdown(rawHeading))}` : "";
    return `[${label}](${resolved.url}${anchor})`;
  });

  return markdown;
}

export async function buildContent({
  contentRoot = path.join(projectRoot, "src", "content", "notes"),
  generatedNotesFile = path.join(projectRoot, "src", "generated", "notes.json"),
  publicGeneratedRoot = path.join(projectRoot, "public", "generated"),
} = {}) {
  contentRoot = path.resolve(contentRoot);
  const allFiles = await listFiles(contentRoot);
  const markdownFiles = allFiles.filter((file) => /\.md$/i.test(file));
  const notes = [];

  for (const file of markdownFiles) {
    const source = await fs.readFile(file, "utf8");
    const parsed = matter(source);
    if (parsed.data.draft === true || parsed.data.publish === false) continue;

    const slug = slugFromFile(file, contentRoot);
    if (!slug) continue;
    const stat = await fs.stat(file);
    notes.push({
      slug,
      url: `/notes/${encodeUrlPath(slug)}`,
      title: String(parsed.data.title || findFirstHeading(parsed.content) || path.basename(slug)),
      description: String(parsed.data.description || ""),
      markdown: parsed.content,
      directory: path.dirname(file),
      // 源文件相对 contentRoot 的路径（含 .md），供「contribute」链接定位源码
      sourcePath: toPosix(path.relative(contentRoot, file)),
      lastModified: lastModifiedIso(file) ?? stat.mtime.toISOString(),
    });
  }

  const resolveNote = buildResolver(notes);
  const graphLinks = [];
  // 只清理由本脚本生成的内容，fonts/（slice-fonts.mjs 的产物，带缓存）保留
  await fs.rm(path.join(publicGeneratedRoot, "note-assets"), { recursive: true, force: true });
  for (const file of ["graph.json", "search-index.json"]) {
    await fs.rm(path.join(publicGeneratedRoot, file), { force: true });
  }
  const noteAssetsRoot = path.join(publicGeneratedRoot, "note-assets");
  await fs.mkdir(noteAssetsRoot, { recursive: true });
  const assetMap = await copySharedAssets(contentRoot, noteAssetsRoot);

  const renderedNotes = [];
  for (const note of notes) {
    const transformed = transformMarkdown(note, resolveNote, assetMap, graphLinks);
    const renderedHtml = await marked.parse(transformed, {
      gfm: true,
      renderer: createMarkdownRenderer(),
    });
    renderedNotes.push({
      slug: note.slug,
      url: note.url,
      title: note.title,
      description: note.description,
      sourcePath: note.sourcePath,
      lastModified: note.lastModified,
      html: transformRenderedCallouts(renderedHtml),
    });
  }

  const uniqueLinks = [
    ...new Map(
      graphLinks.map((link) => [
        [link.source, link.target].sort((a, b) => a.localeCompare(b, "zh-CN")).join("\0"),
        link,
      ]),
    ).values(),
  ];
  const graph = {
    nodes: notes.map(({ slug, title, url }) => ({ id: slug, title, url })),
    links: uniqueLinks,
  };

  await fs.mkdir(path.dirname(generatedNotesFile), { recursive: true });
  await fs.writeFile(generatedNotesFile, `${JSON.stringify(renderedNotes, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(publicGeneratedRoot, "graph.json"), `${JSON.stringify(graph, null, 2)}\n`, "utf8");

  // 全文搜索索引：前端侧栏搜索框按关键字在这份纯文本里做严格匹配。
  const searchIndex = renderedNotes.map(({ slug, url, title, html }) => ({
    slug,
    url,
    title,
    text: searchableTextFromHtml(html),
  }));
  await fs.writeFile(
    path.join(publicGeneratedRoot, "search-index.json"),
    `${JSON.stringify(searchIndex)}\n`,
    "utf8",
  );
  // 字体分片（源字体没变时走缓存，秒过）
  const fontSlices = await sliceFonts();
  if (!fontSlices.skipped) {
    console.log(`字体分片：${fontSlices.slices} 片共 ${fontSlices.totalKB}KB，耗时 ${fontSlices.seconds}s。`);
  }
  return { notes: renderedNotes, graph };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  const result = await buildContent();
  console.log(`已准备 ${result.notes.length} 篇笔记、${result.graph.links.length} 条关系。`);
}
