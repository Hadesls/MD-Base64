'use strict';

/* ============================================================================
 * MD Base64 —— 把当前笔记导出成「图片内联」的单文件 Markdown
 * ----------------------------------------------------------------------------
 * 干什么：
 *   把笔记里所有图片转成 base64 内联进正文，产出一个**自包含**的 .md ——
 *   发给别人、丢进任何 markdown 阅读器都不缺图。**原笔记一个字都不动**。
 *
 * 相比市面上那个「Export as Base64 MD」，本插件强在：
 *   ① 两种图片语法都认：`![[图片.png]]`（wiki 嵌入）**和** `![别名](图片.png)`（标准 markdown）。
 *      那个插件只读 metadataCache.embeds → 只认前者，用标准语法的图片它一律漏掉。
 *   ② **不依赖 @electron/remote**（新版 Electron 已移除该模块，Obsidian 只是还兼容着）。
 *      本插件用 Blob 下载 / 库内写入 → 桌面 + 移动端通用（isDesktopOnly = false）。
 *   ③ 保留语义：`![[a.png|300]]` 的宽度、`![alt](a.png "title")` 的别名都尽量留着。
 *   ④ 幂等：已经是 `data:` 的图片自动跳过 → 重复导出不会二次膨胀。
 *   ⑤ 进度提示 + 失败清单：哪张图没找到会明确告诉你，而不是静默留个坏链接。
 *   ⑥ 可选把远程 http(s) 图片也拉下来内联（走 Obsidian requestUrl，绕 CORS）。
 *   ⑦ 可选导出到库内指定文件夹（手机也能用），或走浏览器下载。
 *
 * ⚠ 唯一"重"的地方是**产物本身**：base64 会让图片体积膨胀约 33%（3MB → 4MB 文本）。
 *   这是 base64 的物理特性，任何实现都一样。
 *
 * 作者: Hadesr
 * ========================================================================== */

const { Plugin, PluginSettingTab, Setting, Notice, TFile, normalizePath, requestUrl } = require('obsidian');

/* 支持的图片扩展名 → MIME。要加格式就往这里加一行。 */
const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  ico: 'image/x-icon',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

const DEFAULTS = {
  mode: 'download',       // 'download' = 浏览器下载 | 'vault' = 写进库内文件夹
  vaultFolder: 'Exports', // mode = 'vault' 时的目标文件夹（不存在会自动建）
  inlineRemote: false,    // 是否把 http(s) 图片也下载内联
  openAfter: false,       // 写入库内后是否立刻打开
};

/* ---------------------------------------------------------------- 小工具 */

/* 给 Notice 换文案（不同版本的 API 名字不一样，两条都试） */
function setNoticeText(n, msg) {
  try { if (n && typeof n.setMessage === 'function') return n.setMessage(msg); } catch (e) { }
  try { if (n && n.noticeEl && typeof n.noticeEl.setText === 'function') n.noticeEl.setText(msg); } catch (e) { }
}

/* 别名字符串清成安全可嵌入 `![alt](…)` 的样子（去掉方括号和换行） */
function safeAlt(s) { return String(s == null ? '' : s).replace(/[[\]\n\r]/g, '').trim(); }

/* ------------------------------------------------------------------------
 * 找图片引用：返回 [{ kind, start, end, target, alt|sub }]
 *   · 只做**文本扫描**，不依赖 metadataCache —— 这样标准 markdown 语法也能认出来。
 *   · 两遍扫完后按位置排序；替换时从后往前做，避免偏移错位。
 * --------------------------------------------------------------------- */
function findRefs(text) {
  const out = [];
  let m;

  /* ① wiki 嵌入：![[a.png]] / ![[a.png|300]] / ![[a.png|别名]] / ![[a.png#标题]] */
  const reWiki = /!\[\[([^\]\n]+?)\]\]/g;
  while ((m = reWiki.exec(text)) !== null) {
    const inner = m[1];
    const bar = inner.indexOf('|');
    const target = inner.slice(0, bar < 0 ? inner.length : bar).split('#')[0].trim();
    if (!target) continue;
    if (/^data:/i.test(target)) continue;                        /* 已内联 → 跳过 */
    out.push({
      kind: 'wiki',
      start: m.index,
      end: m.index + m[0].length,
      target: target,
      sub: bar < 0 ? '' : inner.slice(bar + 1).trim(),
    });
  }

  /* ② 标准 markdown：![alt](path) / ![alt](<path 带空格>) / ![alt](path "title") */
  const reMd = /!\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^)\s\n]+)(?:\s+["'][^"'\n]*["'])?\s*\)/g;
  while ((m = reMd.exec(text)) !== null) {
    let target = m[2];
    if (target.charAt(0) === '<' && target.charAt(target.length - 1) === '>') {
      target = target.slice(1, -1);                              /* 去掉尖括号，路径可含空格 */
    }
    if (!target) continue;
    if (/^data:/i.test(target)) continue;                        /* 已内联 → 跳过 */
    out.push({
      kind: 'md',
      start: m.index,
      end: m.index + m[0].length,
      target: target,
      alt: m[1] || '',
    });
  }

  out.sort(function (a, b) { return a.start - b.start; });
  return out;
}

/* ------------------------------------------------------------------ 插件 */

class MdBase64Plugin extends Plugin {

  async onload() {
    await this.loadSettings();

    /* 主命令：导出（带 checkCallback，非 md 笔记时命令自动置灰） */
    this.addCommand({
      id: 'export-base64-md',
      name: '导出当前笔记为 Base64 MD（图片内联）',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        const ok = !!(f && f.extension === 'md');
        if (ok && !checking) this.run();
        return ok;
      },
    });

    /* 附加命令：直接复制到剪贴板（不落盘） */
    this.addCommand({
      id: 'copy-base64-md',
      name: '复制当前笔记（Base64 内联）到剪贴板',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        const ok = !!(f && f.extension === 'md');
        if (ok && !checking) this.runCopy();
        return ok;
      },
    });

    /* 右下角「状态栏」按钮 —— 沿用旧插件 Export as Base64 MD 的位置和文案（用户习惯在那儿点）。
       注意：这里**不放**左侧栏 ribbon 图标（用户不要左上角那个）。 */
    this._statusBar = this.addStatusBarItem();
    this._statusBar.addClass('md-base64-status');
    this._statusBtn = this._statusBar.createEl('span', {
      text: '导出 Base64',
      cls: 'md-base64-btn',
    });
    this._statusBtn.setAttribute('aria-label', 'MD Base64：导出当前笔记为 Base64 MD（图片内联）');
    this._statusBtn.title = 'MD Base64：导出当前笔记为 Base64 MD（图片内联）';
    this._statusBtn.addEventListener('click', () => this.run());

    this.addSettingTab(new MdBase64SettingTab(this.app, this));
    console.log('[MD Base64] 已加载 v' + this.manifest.version);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
  }
  async saveSettings() { await this.saveData(this.settings); }

  /* ---------------------------------------------------------- 入口：导出 */
  async run() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') { new Notice('MD Base64：请先打开一个 .md 笔记'); return; }

    const n = new Notice('MD Base64：正在处理…', 0);              /* 0 = 不自动关闭 */
    try {
      const res = await this.buildInlined(file, function (done, total) {
        setNoticeText(n, 'MD Base64：正在内联图片 ' + done + '/' + total);
      });
      await this.deliver(res, file);
      n.hide();
      this.report(res);
    } catch (e) {
      n.hide();
      console.error('[MD Base64]', e);
      new Notice('MD Base64：导出失败 —— ' + (e && e.message ? e.message : String(e)), 8000);
    }
  }

  /* ------------------------------------------------- 入口：复制到剪贴板 */
  async runCopy() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') { new Notice('MD Base64：请先打开一个 .md 笔记'); return; }

    const n = new Notice('MD Base64：正在处理…', 0);
    try {
      const res = await this.buildInlined(file, function (done, total) {
        setNoticeText(n, 'MD Base64：正在内联图片 ' + done + '/' + total);
      });
      await navigator.clipboard.writeText(res.text);
      n.hide();
      new Notice('MD Base64：已复制到剪贴板（内联 ' + res.ok + '/' + res.total + ' 张图片）', 6000);
    } catch (e) {
      n.hide();
      new Notice('MD Base64：复制失败 —— ' + (e && e.message ? e.message : String(e)), 8000);
    }
  }

  /* ------------------------------------------------------- 核心：内联图片 */
  async buildInlined(file, onProgress) {
    const text = await this.app.vault.read(file);
    const refs = findRefs(text);
    const jobs = refs.filter(function (r) { return !/^data:/i.test(r.target); });

    const repl = [];
    const missing = [];
    let done = 0;

    for (let i = 0; i < jobs.length; i++) {
      const r = jobs[i];
      let uri = null;
      try {
        if (/^(?:https?|ftp):\/\//i.test(r.target)) {
          if (this.settings.inlineRemote) uri = await this.fetchRemote(r.target);
        } else {
          const f = this.resolve(r.target, file.path);
          if (f) uri = await this.toDataUri(f);
        }
      } catch (e) { uri = null; }

      if (uri) repl.push({ start: r.start, end: r.end, text: this.rebuild(r, uri) });
      else missing.push(r.target);

      done++;
      /* 每 3 张刷一次进度（太频繁会拖慢） */
      if (onProgress && (done % 3 === 0 || done === jobs.length)) onProgress(done, jobs.length);
    }

    /* 从后往前替换，前面的偏移才不会被打乱 */
    repl.sort(function (a, b) { return b.start - a.start; });
    let out = text;
    for (let i = 0; i < repl.length; i++) {
      const p = repl[i];
      out = out.slice(0, p.start) + p.text + out.slice(p.end);
    }

    return {
      text: out,
      ok: repl.length,
      missing: missing,
      total: jobs.length,
      images: refs.length,
    };
  }

  /* -------------------------------------------------------- 目标文件解析
   * 四级兜底，从"最可信"到"最宽松"：
   *   ① Obsidian 自己的链接解析（最准：支持最短路径、附件目录、相对路径）
   *   ② 相对「当前笔记所在目录」
   *   ③ 当成库根路径
   *   ④ 全库按文件名找 —— **只在唯一命中时才认**（避免同名文件认错）
   * --------------------------------------------------------------------- */
  resolve(target, sourcePath) {
    const app = this.app;
    let t = String(target || '').trim();
    if (!t) return null;

    try { t = decodeURIComponent(t); } catch (e) { }              /* %20 → 空格 */
    t = t.replace(/\\/g, '/').replace(/^\.\//, '');

    try {
      const f = app.metadataCache.getFirstLinkpathDest(t, sourcePath);
      if (f instanceof TFile) return f;
    } catch (e) { }

    try {
      const i = sourcePath.lastIndexOf('/');
      const dir = i < 0 ? '' : sourcePath.slice(0, i);
      const f = app.vault.getAbstractFileByPath(normalizePath(dir ? dir + '/' + t : t));
      if (f instanceof TFile) return f;
    } catch (e) { }

    try {
      const f = app.vault.getAbstractFileByPath(normalizePath(t));
      if (f instanceof TFile) return f;
    } catch (e) { }

    try {
      const base = t.split('/').pop().toLowerCase();
      const hits = app.vault.getFiles().filter(function (f) { return f.name.toLowerCase() === base; });
      if (hits.length === 1) return hits[0];
    } catch (e) { }

    return null;
  }

  /* -------------------------------------------- 图片文件 → data URI */
  async toDataUri(file) {
    const ext = String(file.extension || '').toLowerCase();
    const mime = MIME[ext];
    if (!mime) return null;                                       /* 不在支持列表里的格式 */
    const buf = await this.app.vault.readBinary(file);
    return 'data:' + mime + ';base64,' + this.toB64(buf);
  }

  /* 二进制 → base64。桌面有 Buffer 就用（快）；移动端退回手工编码。 */
  toB64(buf) {
    if (typeof Buffer !== 'undefined' && Buffer.from) return Buffer.from(buf).toString('base64');
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CH = 0x8000;                                            /* 分块，防止 apply 参数过多爆栈 */
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  }

  /* 远程图片 → data URI（走 Obsidian requestUrl，绕 CORS） */
  async fetchRemote(url) {
    const res = await requestUrl({ url: url, throw: false });
    if (!res || res.status < 200 || res.status >= 300) return null;

    const h = res.headers || {};
    let ct = String(h['content-type'] || h['Content-Type'] || '').split(';')[0].trim().toLowerCase();
    if (!/^image\//.test(ct)) {                                   /* 头里没写就按扩展名猜 */
      const e = (url.split('?')[0].split('#')[0].match(/\.([a-z0-9]+)$/i) || [])[1];
      ct = e && MIME[e.toLowerCase()] ? MIME[e.toLowerCase()] : '';
    }
    if (!ct) return null;

    return 'data:' + ct + ';base64,' + this.toB64(res.arrayBuffer);
  }

  /* 把原引用重建成"内联后"的写法 */
  rebuild(r, uri) {
    if (r.kind === 'wiki') {
      const sub = r.sub || '';
      /* `![[a.png|300]]` 里的 300 是**宽度** → 用 HTML img 把宽度保住（markdown 语法没有宽度位） */
      if (/^\d+$/.test(sub)) return '<img src="' + uri + '" width="' + sub + '">';
      return '![' + safeAlt(sub) + '](' + uri + ')';
    }
    return '![' + safeAlt(r.alt) + '](' + uri + ')';
  }

  /* ------------------------------------------------------------ 落地 */
  async deliver(res, file) {
    const name = file.basename + '.base64.md';

    if (this.settings.mode === 'vault') {
      const dir = normalizePath(String(this.settings.vaultFolder || 'Exports').replace(/^\/+|\/+$/g, '')) || 'Exports';
      await this.ensureFolder(dir);
      const path = normalizePath(dir + '/' + name);
      const exist = this.app.vault.getAbstractFileByPath(path);
      if (exist instanceof TFile) await this.app.vault.modify(exist, res.text);
      else await this.app.vault.create(path, res.text);
      res.savedPath = path;

      if (this.settings.openAfter) {
        const f = this.app.vault.getAbstractFileByPath(path);
        if (f instanceof TFile) await this.app.workspace.getLeaf(true).openFile(f);
      }
      return;
    }

    /* 浏览器下载：跨平台（桌面会进"下载"目录 / 触发另存为，手机进"文件"） */
    const blob = new Blob([res.text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    res.savedPath = name;
  }

  /* 逐级建目录（vault.createFolder 要求父目录已存在） */
  ensureFolder(dir) {
    const app = this.app;
    const parts = dir.split('/').filter(Boolean);
    let cur = '';
    const todo = [];
    for (let i = 0; i < parts.length; i++) {
      cur = cur ? cur + '/' + parts[i] : parts[i];
      if (!app.vault.getAbstractFileByPath(cur)) todo.push(cur);
    }
    return todo.reduce(function (chain, p) {
      return chain.then(function () {
        return app.vault.createFolder(p).catch(function () { });  /* 已存在/并发建 → 忽略 */
      });
    }, Promise.resolve());
  }

  /* ------------------------------------------------------------ 汇报 */
  report(res) {
    const where = this.settings.mode === 'vault'
      ? ('已写入 ' + res.savedPath)
      : ('已下载 ' + res.savedPath);

    const lines = [
      'MD Base64：' + where,
      '内联 ' + res.ok + '/' + res.total + ' 张图片（文档共 ' + res.images + ' 处图片引用）',
    ];
    if (res.missing.length) {
      const head = res.missing.slice(0, 3).join('、');
      lines.push('⚠ ' + res.missing.length + ' 张没找到（保持原样）：' + head + (res.missing.length > 3 ? ' …' : ''));
    }
    new Notice(lines.join('\n'), res.missing.length ? 12000 : 6000);
  }
}

/* ------------------------------------------------------------- 设置面板 */

class MdBase64SettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const c = this.containerEl;
    const p = this.plugin;
    const self = this;
    c.empty();
    c.addClass('mdb-settings');

    const ver = (p.manifest && p.manifest.version) ? 'v' + p.manifest.version : '';
    const author = (p.manifest && p.manifest.author) || 'Hadesr';

    /* 居中文字 logo */
    const head = c.createDiv({ cls: 'mdb-head' });
    head.createDiv({ cls: 'mdb-logo', text: 'MD Base64' });
    head.createDiv({ cls: 'mdb-meta', text: ver + ' · 作者 ' + author });
    head.createDiv({ cls: 'mdb-hint', text: '把当前笔记导出成「图片内联」的单文件 Markdown' });

    /* 导出设置 */
    const card = c.createDiv({ cls: 'mdb-card' });
    card.createDiv({ cls: 'mdb-card-title', text: '导出设置' });

    new Setting(card)
      .setName('导出方式')
      .setDesc('浏览器下载 = 触发系统下载（跨平台）；写入库内 = 直接存到下面那个文件夹（也跨平台，手机上更方便）。')
      .addDropdown(function (d) {
        d.addOption('download', '浏览器下载')
          .addOption('vault', '写入库内文件夹')
          .setValue(p.settings.mode)
          .onChange(async function (v) {
            p.settings.mode = v;
            await p.saveSettings();
            self.display();               /* 重画面板：vault 模式才显示下面两项 */
          });
      });

    if (p.settings.mode === 'vault') {
      new Setting(card)
        .setName('库内导出文件夹')
        .setDesc('不存在会自动创建。文件名 = 原笔记名 + .base64.md；同名文件会被覆盖。')
        .addText(function (t) {
          t.setPlaceholder('Exports').setValue(p.settings.vaultFolder)
            .onChange(async function (v) { p.settings.vaultFolder = v; await p.saveSettings(); });
        });

      new Setting(card)
        .setName('导出后自动打开')
        .setDesc('写入库内成功后，直接在新标签页打开那个文件。')
        .addToggle(function (t) {
          t.setValue(!!p.settings.openAfter)
            .onChange(async function (v) { p.settings.openAfter = v; await p.saveSettings(); });
        });
    }

    new Setting(card)
      .setName('也内联远程图片')
      .setDesc('笔记里 ![x](https://…) 的图片也下载并内联。走 Obsidian 的请求通道（绕 CORS）；网络慢或图大时导出会久一点。关闭时这些远程图片保持原样。')
      .addToggle(function (t) {
        t.setValue(!!p.settings.inlineRemote)
          .onChange(async function (v) { p.settings.inlineRemote = v; await p.saveSettings(); });
      });

    /* 支持的图片语法：标签块 */
    const syntaxCard = c.createDiv({ cls: 'mdb-card' });
    syntaxCard.createDiv({ cls: 'mdb-card-title', text: '支持的图片语法' });
    const syntax = syntaxCard.createDiv({ cls: 'mdb-syntax' });
    [
      '![[图片.png]]',
      '![[图片.png|300]]',
      '![[图片.png|别名]]',
      '![别名](图片.png)',
      '![别名](<含空格的路径.png>)',
      '![别名](图片.png "标题")',
    ].forEach(function (s) { syntax.createEl('code', { cls: 'mdb-chip', text: s }); });
    syntaxCard.createDiv({ cls: 'mdb-note', text: '已经是 data: 的图片会自动跳过，可反复导出。' });

    /* 支持的图片格式：标签块 */
    const fmtCard = c.createDiv({ cls: 'mdb-card' });
    fmtCard.createDiv({ cls: 'mdb-card-title', text: '支持的图片格式' });
    const fmts = fmtCard.createDiv({ cls: 'mdb-formats' });
    Object.keys(MIME).forEach(function (k) { fmts.createEl('span', { cls: 'mdb-chip', text: k }); });
  }
}

module.exports = MdBase64Plugin;

/* 便于离线自测（Obsidian 加载时用不到，也不影响它）：
   node -e "const P=require('./main.js'); console.log(P._test.findRefs('...'))" */
try { module.exports._test = { findRefs: findRefs, safeAlt: safeAlt, MIME: MIME, DEFAULTS: DEFAULTS }; } catch (e) { }
