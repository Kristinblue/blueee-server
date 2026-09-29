export interface TocHeading {
  depth: number;
  id: string;
  text: string;
  children: TocHeading[];
}

// 笔记 HTML 由 prepare-content.mjs 自己渲染，标题一定带 id，结构可预期。
const HEADING_PATTERN = /<h([1-6]) id="([^"]*)"[^>]*>([\s\S]*?)<\/h\1>/g;

function decodeEntities(value: string) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

// 从渲染后的笔记 HTML 里抽出标题树。正文开头与页面标题相同的 h1
// 不进目录（页面上方已经展示过一次），其余按 h2~h6 逐级嵌套。
export function extractTocTree(html: string, noteTitle: string): TocHeading[] {
  const flat: { depth: number; id: string; text: string }[] = [];
  for (const match of html.matchAll(HEADING_PATTERN)) {
    const depth = Number(match[1]);
    const id = decodeEntities(match[2]).trim();
    const text = decodeEntities(match[3].replace(/<[^>]*>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
    if (!id || !text) continue;
    if (depth === 1 && text === noteTitle.trim()) continue;
    flat.push({ depth, id, text });
  }

  const root: TocHeading[] = [];
  const stack: TocHeading[] = [];
  for (const heading of flat) {
    const node: TocHeading = { ...heading, children: [] };
    while (stack.length && stack[stack.length - 1].depth >= heading.depth) stack.pop();
    (stack.at(-1)?.children ?? root).push(node);
    stack.push(node);
  }
  return root;
}
