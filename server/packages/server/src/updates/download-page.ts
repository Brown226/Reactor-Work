/**
 * 公开下载页（UPD）：给**还没装 Reactor 的普通内网用户**一个「打开浏览器就能下安装包」的页面。
 *
 * 为什么是服务端直出的一页自包含 HTML，而不是管理台页面或另一个前端产物：
 *  - 面向的是**没有账号、没有客户端**的人，不能要求登录，也不能塞进管理台（`/console` 是管理员面）；
 *  - 安装包本来就存在服务端的更新数据卷里、下载接口也在服务端，页面放在旁边最顺；
 *  - **自包含**（内联 CSS/JS、零外部资源）→ 离线内网直接可用，也不新增前端构建产物
 *    （管理台产物在 Windows 上构建会 OOM，能不动就不动）。
 *
 * 数据取自同源的公开接口 `GET /api/v1/releases/published`，因此页面本身不需要任何配置项。
 *
 * 安全：页面渲染一律走 DOM 的 textContent（不用 innerHTML 插值），
 * 发布名 / 版本号 / 文件名即使是管理员填的自由文本也不会变成注入点。
 */

import { DOWNLOAD_BRAND_ICON_DATA_URI } from "./download-icon.js";

/** 公开下载页路径。挂在 identity 的**公开段**（与客户端下发面同段，不能进 authed 组）。 */
export const DOWNLOAD_PAGE_PATH = "/download";

/** 平台串 → 人看的名字；回退显示原串（新增平台不至于显示成空白）。 */
const PLATFORM_LABELS: Record<string, string> = {
  "windows-x64": "Windows（64 位）",
  "windows-arm64": "Windows（ARM64）",
  "darwin-arm64": "macOS（Apple 芯片）",
  "darwin-x64": "macOS（Intel）",
  "linux-x64": "Linux（x64）",
  "linux-arm64": "Linux（ARM64）",
};

const CHANNEL_LABELS: Record<string, string> = { stable: "正式版", preview: "预览版" };

/** 渲染下载页 HTML。把平台 / 通道的中文名在服务端序列化好，避免前端再维护一份字典。 */
export function renderDownloadPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>下载 Reactor</title>
<meta name="description" content="下载 Reactor 桌面端安装包" />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #161616; color: #e8eaee;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 880px; margin: 0 auto; padding: 0 24px; }
  .wrap-body { padding-top: 56px; padding-bottom: 96px; }
  /* 顶栏：左品牌（带应用图标，点击回门户首页）+ 右返回入口。
     下载页经门户 nginx 反代，浏览器地址栏就是门户同源，因此 "/" 即门户首页，
     用相对路径也符合门户"零外链"纪律。 */
  .topbar { border-bottom: 1px solid #23252a; }
  .topbar-inner { display: flex; align-items: center; gap: 16px; height: 60px; }
  .brand { display: inline-flex; align-items: center; gap: 10px; text-decoration: none; color: #e8eaee; }
  .brand-logo { display: block; width: 26px; height: 26px; border-radius: 6px; flex: none; }
  .brand-text { font-weight: 700; letter-spacing: -0.2px; font-size: 15px; display: inline-flex; align-items: baseline; gap: 8px; }
  .brand-sub { font-weight: 400; font-size: 13px; color: #8b9099; }
  .topbar-back { margin-left: auto; font-size: 13px; color: #a3a8b2; text-decoration: none; }
  .topbar-back:hover { color: #e8eaee; }
  h1 { font-size: clamp(28px, 4.2vw, 40px); margin: 40px 0 10px; letter-spacing: -0.4px; }
  .sub { color: #a3a8b2; margin: 0 0 36px; line-height: 1.7; }
  .list { display: grid; gap: 14px; }
  .card {
    display: flex; align-items: center; justify-content: space-between; gap: 18px; flex-wrap: wrap;
    border: 1px solid #2a2c31; border-radius: 12px; padding: 18px 20px; background: #1b1c20;
  }
  .meta { min-width: 0; }
  .meta .name { font-weight: 600; font-size: 15px; }
  .meta .plat { color: #a3a8b2; font-size: 13px; margin-top: 6px; }
  /* 更新说明按 Markdown 子集渲染成节点（见下方 renderNotes）；
     不再用 white-space: pre-wrap —— 那是给纯文本留的，富文本会被强制换行打乱排版。 */
  .meta .notes { color: #8b9099; font-size: 12.5px; margin-top: 8px; line-height: 1.6; max-width: 560px; display: flex; flex-direction: column; gap: 6px; }
  .meta .notes p { margin: 0; }
  .meta .notes h2, .meta .notes h3, .meta .notes h4,
  .meta .notes h5, .meta .notes h6 { font-size: 13px; margin: 2px 0 0; color: #e8eaee; }
  .meta .notes ul, .meta .notes ol { margin: 0; padding-left: 18px; }
  .meta .notes li { margin: 0; }
  .meta .notes code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #23252a; border-radius: 4px; padding: 1px 4px; }
  .meta .notes pre { margin: 0; padding: 8px 10px; background: #23252a; border-radius: 6px; overflow-x: auto; }
  .meta .notes pre code { background: none; padding: 0; }
  .meta .notes blockquote { margin: 0; padding: 4px 10px; border-left: 2px solid #4a4d55; color: #9aa0a8; }
  .meta .notes hr { border: none; border-top: 1px solid #2c2f35; margin: 2px 0; }
  .meta .notes a { color: #5aa0ff; }
  .ver { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; color: #8b9099; margin-top: 6px; }
  .btn {
    flex: 0 0 auto; display: inline-block; background: #5b8df7; color: #fff; text-decoration: none;
    padding: 10px 20px; border-radius: 999px; font-size: 14px; font-weight: 600; white-space: nowrap;
  }
  .btn:hover { background: #6f9bf9; }
  .empty { border: 1px dashed #2a2c31; border-radius: 12px; padding: 32px; text-align: center; color: #8b9099; line-height: 1.8; }
  .foot { margin-top: 40px; color: #6d727b; font-size: 12.5px; line-height: 1.8; }
  .foot code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #a3a8b2; }
</style>
</head>
<body>
<header class="topbar">
  <div class="wrap topbar-inner">
    <a class="brand" href="/">
      <img class="brand-logo" src="${DOWNLOAD_BRAND_ICON_DATA_URI}" alt="Reactor" />
      <span class="brand-text">Reactor<span class="brand-sub">数智堆脑</span></span>
    </a>
    <a class="topbar-back" href="/">← 返回门户首页</a>
  </div>
</header>
<div class="wrap wrap-body">
  <h1>下载 Reactor 桌面端</h1>
  <p class="sub">选择与你的系统对应的安装包。安装包含命令行与 Web 运行时，安装后按内网服务端地址登录即可使用。</p>
  <div class="list" id="list">
    <div class="empty">正在读取可用版本…</div>
  </div>
  <p class="foot">
    没有看到你需要的平台？请联系内网管理员确认该平台是否已发布版本。<br />
    命令行 / Web 发行包不在此页分发，获取方式见产品说明书。
  </p>
</div>
<script>
  (function () {
    var PLATFORM_LABELS = ${JSON.stringify(PLATFORM_LABELS)};
    var CHANNEL_LABELS = ${JSON.stringify(CHANNEL_LABELS)};

    function fmtSize(bytes) {
      if (!bytes || bytes <= 0) return "";
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
      return (bytes / 1024 / 1024).toFixed(1) + " MB";
    }

    function el(tag, cls, text) {
      var node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text !== undefined && text !== null) node.textContent = String(text);
      return node;
    }

    // 更新说明按 Markdown 写（管理台「更新说明（中文，Markdown）」）。
    // 零依赖子集渲染：标题 / 有序与无序列表 / 粗体 / 斜体 / 行内代码 / 代码块 / 链接 / 引用 / 分割线。
    //
    // 反例（上一版）：el("div", "notes", row.releaseNotesZh) 把原文直接塞进 textContent，
    // 页面上看到的就是 "## 标题"、"**粗体**" 这样的原始符号。
    //
    // 安全：全部 createElement + textContent，不拼 HTML、不用 innerHTML；
    // 链接只认 http(s)，其他协议在正则层面就不匹配，会降级成纯文本。
    var INLINE_MD = /\\[([^\\]]+)\\]\\((https?:[^\\s)]+)\\)|\\*\\*([^*]+)\\*\\*|\\x60([^\\x60]+)\\x60|\\*([^*]+)\\*/g;

    function inlineMd(text) {
      var frag = document.createDocumentFragment();
      var last = 0;
      var m;
      INLINE_MD.lastIndex = 0;
      while ((m = INLINE_MD.exec(text)) !== null) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        if (m[1] !== undefined) {
          var a = document.createElement("a");
          a.textContent = m[1];
          a.href = m[2];
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          frag.appendChild(a);
        } else if (m[3] !== undefined) {
          var strong = document.createElement("strong");
          strong.textContent = m[3];
          frag.appendChild(strong);
        } else if (m[4] !== undefined) {
          var code = document.createElement("code");
          code.textContent = m[4];
          frag.appendChild(code);
        } else {
          var em = document.createElement("em");
          em.textContent = m[5];
          frag.appendChild(em);
        }
        last = INLINE_MD.lastIndex;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      return frag;
    }

    function renderNotes(md) {
      var box = document.createElement("div");
      box.className = "notes";
      var lines = String(md || "").split(/\\r?\\n/);
      var para = [];
      var list = null;
      var listTag = "";
      var inCode = false;
      var codeLines = [];

      function flushPara() {
        if (para.length === 0) return;
        var p = document.createElement("p");
        p.appendChild(inlineMd(para.join(" ")));
        box.appendChild(p);
        para = [];
      }
      function flushList() {
        if (list === null) return;
        box.appendChild(list);
        list = null;
        listTag = "";
      }

      for (var i = 0; i < lines.length; i += 1) {
        var raw = lines[i];
        var line = raw.trim();

        if (inCode) {
          if (line.indexOf("\\x60\\x60\\x60") === 0) {
            var pre = document.createElement("pre");
            var codeEl = document.createElement("code");
            codeEl.textContent = codeLines.join("\\n");
            pre.appendChild(codeEl);
            box.appendChild(pre);
            inCode = false;
            codeLines = [];
          } else {
            codeLines.push(raw);
          }
          continue;
        }
        if (line.indexOf("\\x60\\x60\\x60") === 0) {
          flushPara();
          flushList();
          inCode = true;
          continue;
        }
        if (!line) {
          flushPara();
          flushList();
          continue;
        }

        var heading = /^(#{1,6})\\s+(.*)$/.exec(line);
        if (heading) {
          flushPara();
          flushList();
          var level = Math.min(6, heading[1].length + 1);
          var h = document.createElement("h" + level);
          h.appendChild(inlineMd(heading[2]));
          box.appendChild(h);
          continue;
        }

        if (/^(-{3,}|\\*{3,}|_{3,})$/.test(line)) {
          flushPara();
          flushList();
          box.appendChild(document.createElement("hr"));
          continue;
        }

        var quote = /^>\\s?(.*)$/.exec(line);
        if (quote) {
          flushPara();
          flushList();
          var bq = document.createElement("blockquote");
          bq.appendChild(inlineMd(quote[1]));
          box.appendChild(bq);
          continue;
        }

        var ul = /^[-*+]\\s+(.*)$/.exec(line);
        var ol = /^(\\d+)[.)]\\s+(.*)$/.exec(line);
        if (ul || ol) {
          flushPara();
          var tag = ul ? "ul" : "ol";
          if (listTag !== tag) {
            flushList();
            listTag = tag;
            list = document.createElement(tag);
          }
          var li = document.createElement("li");
          li.appendChild(inlineMd(ul ? ul[1] : ol[2]));
          list.appendChild(li);
          continue;
        }

        flushList();
        para.push(line);
      }

      if (inCode && codeLines.length > 0) {
        var preTail = document.createElement("pre");
        var codeTail = document.createElement("code");
        codeTail.textContent = codeLines.join("\\n");
        preTail.appendChild(codeTail);
        box.appendChild(preTail);
      }
      flushPara();
      flushList();
      return box;
    }

    function renderCard(row) {
      var card = el("div", "card");
      var meta = el("div", "meta");

      meta.appendChild(el("div", "name", row.releaseName || ("Reactor " + row.version)));
      var plat = (PLATFORM_LABELS[row.platform] || row.platform) + " · " + (CHANNEL_LABELS[row.channel] || row.channel);
      if (row.sizeBytes) plat += " · " + fmtSize(row.sizeBytes);
      meta.appendChild(el("div", "plat", plat));
      meta.appendChild(el("div", "ver", "v" + row.version + (row.fileName ? " · " + row.fileName : "")));
      if (row.releaseNotesZh) meta.appendChild(renderNotes(row.releaseNotesZh));

      var link = el("a", "btn", "下载");
      link.href = row.downloadPath;
      link.setAttribute("download", "");
      card.appendChild(meta);
      card.appendChild(link);
      return card;
    }

    function render(rows) {
      var list = document.getElementById("list");
      list.textContent = "";
      if (!rows || rows.length === 0) {
        list.appendChild(el("div", "empty", "当前还没有已发布的安装包。请联系内网管理员在管理台上线一个版本。"));
        return;
      }
      rows.forEach(function (row) { list.appendChild(renderCard(row)); });
    }

    fetch("/api/v1/releases/published", { headers: { accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) { render(data.releases); })
      .catch(function () {
        var list = document.getElementById("list");
        list.textContent = "";
        list.appendChild(el("div", "empty", "读取版本列表失败，请稍后重试，或联系内网管理员。"));
      });
  })();
</script>
</body>
</html>`;
}
