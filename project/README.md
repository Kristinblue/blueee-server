# Blueee 笔记关系图谱

评论接口的本地预览、宝塔部署、限流规则和数据查看方式见 [`docs/评论系统部署与查看.md`](docs/评论系统部署与查看.md)。

这是一个静态 Astro 网站：首页显示由 Markdown 双链自动生成的关系图谱，点击节点进入对应笔记。

当前包含：

- 可拖拽、滚轮缩放的弹性关系图谱，节点大小随链接数量变化；缩小时标题会渐隐；
- 首页 GIF 在 07:00–22:00 之间点击切换 hearts/sparkle，其余时间显示 doze；点击 GIF 会让节点向随机方向散开、碰撞，再被连线拉回；
- 可收起的笔记目录；
- White、Black 常驻右上角，其余配色（Blue、Pink、Yellow、Green、Purple）收进“更多”展开，选择都会记忆；
- 使用 `highlight.js` 的代码语法高亮；
- 本地内嵌的 Ubuntu Mono 代码字体；
- 本地内嵌的霞鹜文楷正文字体；
- Obsidian 双链、图片、Callout 和 `==高亮==` 兼容；
- 每篇笔记右上角的「在 GitHub 上编辑」链接，访客用自己的 GitHub 账号就能对笔记提出修改（Pull Request），合并后重新构建即上线。

## 笔记修改走 GitHub（contribute）

每篇笔记右上角的「contribute」指向 `Kristinblue/blueee-website` 仓库里该笔记的编辑页，旁边显示笔记的上次修改时间（取该文件最后一次 git 提交时间，未提交时用文件修改时间）。访客（比如供稿的同学）点开后用自己的 GitHub 账号登录，修改内容提交 Pull Request；在 GitHub 上审核合并后，本地重新 `npm run build` 并上传 `dist/`，网站即更新。仓库地址、分支和笔记目录写在 `src/pages/notes/[...slug].astro` 顶部的 `GITHUB_EDIT_BASE`，改动只需改那一处。

注意：`blueee-website` 需要保持 **Public** 并包含完整项目源码（`project/` 整个目录，含 `src/content/notes/` 和图片），部署仍然只上传 `dist/` 里的内容——仓库是大家共同编辑的地方，不是部署物本身。仓库里不能出现 `website-comments-config.php`（数据库密码）、服务器工具脚本和发布压缩包，`.gitignore` 已配置排除。

## 放置笔记

正式笔记放在：

```text
src/content/notes/
```

推荐一篇笔记一个目录：

```text
src/content/notes/computer-vision/opencv-basic/
├── index.md
└── images/
    └── result.png
```

也支持直接放置 `opencv-basic.md`。也支持 Obsidian 习惯：多篇 `.md` 平铺在同一文件夹、图片统一放在该文件夹的 `assets` 子目录里，`![[图片名]]` 按文件名自动匹配，共享素材只复制一份。`draft: true` 或 `publish: false` 的笔记不会发布。

示例：

```md
---
title: OpenCV 基础
description: OpenCV 入门笔记
---

# OpenCV 基础

下一篇：[[图像滤波]]

![[result.png|600]]
```

构建程序会读取 `[[双链]]` 生成关系连线，并支持同一笔记目录中的 Obsidian 图片嵌入和标准 Markdown 相对图片。

代码块请标注语言：

````md
```python
def hello():
    print("hello")
```
````

语言名称会显示在代码块右上角，并按语言生成高亮标记。

## 本地运行

```powershell
npm install
npm run dev
```

打开 `http://localhost:4321`。

新增或删除笔记后重新启动开发服务器，或者重新运行 `npm run build`，图谱和文章页就会更新。不需要修改组件中的函数或路径。

## 检查与构建

```powershell
npm test
npm run check
npm run build
```

构建产物位于 `dist/`。部署时将 `dist` **里面的内容**上传到宝塔站点根目录，使服务器上直接存在：

```text
/www/wwwroot/website/index.html
```

不要上传 `src`、`tests`、`node_modules`、原始笔记库或 SSL 私钥。

更详细的日常维护说明见 [`docs/维护与部署.md`](docs/维护与部署.md)。

## 调整首页动画和图谱

首页 GIF 文件放在 `public/media/home/`。在 `src/components/KnowledgeGraph.astro` 顶部修改 `HOME_GIF_SETTINGS`，即可更换时段、图片和播放时长；时间按访客设备的本地时间判断。07:00–22:00 在 03、08、10、dog_cute 中随机显示，每点一次随机换成另一张；22:00–00:00 显示 doze-hop；00:00–07:00 从 12 开始，连续双击切换到只播放一次的 14，随后循环播放 13，再点一次播放 15 并回到 12。每次点击都会触发图谱散开效果。

同一文件中的 `GRAPH_SETTINGS` 控制缩放范围、标题渐隐阈值、节点半径（`nodeBaseRadius`、`nodeRadiusPerLink`、`nodeRadiusExponent`、`nodeRadiusBonusLimit`）、中央 GIF 周围留白（`homeClearanceDesktop`、`homeClearanceMobile`、`homeGap`），以及点击 GIF 后散球效果的速度、连线松紧和持续时间（`scatterSpeedMin`、`scatterSpeedMax`、`scatterLinkStrength`、`scatterDurationMs`）。`ORBIT_SETTINGS` 控制链接数至少 10 的节点绕首页中心顺时针缓慢公转的速度。图谱使用圆形外边界，避免节点贴着画面边缘排成直线。

笔记右下角的小狗 GIF 放在 `public/media/notes/11-computer.gif`；它的图片路径、随机话语、轻微震荡和对话框样式在 `src/components/NoteCompanion.astro` 中修改。

笔记名称的显示门槛在 `KnowledgeGraph.astro` 的 `minimumLabelLinks`：节点链接数大于等于 3 才有资格显示名称，不足 3 的节点即使悬停也不显示。初始画面按链接数从高到低显示笔记总数乘以 `maximumLabelRatio`（默认 `2 / 3`，向下取整）的名称；名称拥挤时通过高频小步规划和平滑避让保持数量，高链接名称少移动、低链接名称主动让位。文字移动使用与屏幕刷新率无关的时间缓动，拖动或公转时不会逐段跳动。普通名称以节点下方为首选位置；链接数达到 10、参与公转的节点名称以远离中央 GIF 的一侧为首选位置。更改后重新构建并上传 `dist/`。
