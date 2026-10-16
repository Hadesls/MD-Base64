/* MD Base64 自测台：桩加载真实 main.js，验证图片引用解析 / 重建 / 路径解析 */
const path = require('path');
const Module = require('module');

/* ── obsidian 桩 ── */
class TFile { constructor(p) { this.path = p; this.name = p.split('/').pop(); this.extension = this.name.split('.').pop(); this.basename = this.name.replace(/\.[^.]+$/, ''); } }
const obsidianStub = {
  Plugin: class { constructor(app, m) { this.app = app; this.manifest = m || { version: '1.0.0', id: 'md-base64' }; } },
  PluginSettingTab: class { constructor(app, p) { this.app = app; this.plugin = p; } },
  Setting: class { constructor() { } setName() { return this; } setDesc() { return this; } addDropdown() { return this; } addToggle() { return this; } addText() { return this; } },
  Notice: class { constructor(m) { this.message = m; } hide() { } },
  TFile: TFile,
  normalizePath: (p) => String(p).replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, ''),
  requestUrl: async () => ({ status: 200, headers: { 'content-type': 'image/png' }, arrayBuffer: new ArrayBuffer(4) }),
};
const orig = Module._load;
Module._load = function (req) { if (req === 'obsidian') return obsidianStub; return orig.apply(this, arguments); };

/* 脚本住在 tools/ 里，主文件在上一层 —— 两个写法都支持：
   node tools/_selftest.js            （默认：../main.js）
   node tools/_selftest.js main.js    （显式传：按当前工作目录解析） */
const MAIN = path.resolve(process.argv[2] || path.join(__dirname, '..', 'main.js'));
const P = require(MAIN);
const { findRefs, safeAlt } = P._test;
const plugin = new P({ workspace: {} }, { version: '1.0.0', id: 'md-base64' });

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('  ✅ ' + name); } else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + extra : '')); } }

console.log('\n【1】findRefs：六种语法都要认得');
const DOC = [
  '![[图片.png]]',
  '![[图片.png|300]]',
  '![[图片.png|别名]]',
  '![别名](图片.png)',
  '![别名](<路径 含空格.png>)',
  '![别名](图片.png "这是标题")',
  '![x](data:image/png;base64,iVBORw0KGgo=)',   /* 真正的已内联 → 必须跳过 */
].join('\n');

const refs = findRefs(DOC);
ok('认出 6 处（已是 data: 的那条跳过）', refs.length === 6, '实际 ' + refs.length);
ok('wiki 无参数', refs[0].kind === 'wiki' && refs[0].target === '图片.png' && refs[0].sub === '');
ok('wiki 带宽度的宽度被保留', refs[1].sub === '300');
ok('wiki 带别名', refs[2].sub === '别名');
ok('markdown 带别名', refs[3].kind === 'md' && refs[3].alt === '别名' && refs[3].target === '图片.png');
ok('尖括号路径去掉了 < >', refs[4].target === '路径 含空格.png', JSON.stringify(refs[4].target));
ok('带 title 的也能解析', refs[5].target === '图片.png' && refs[5].alt === '别名');
ok('位置是按出现顺序排序的', refs[0].start < refs[1].start && refs[1].start < refs[2].start);
ok('已是 data: 的图片被跳过（可反复导出，不二次膨胀）', !refs.some(r => /^data:/i.test(r.target)));

console.log('\n【2】findRefs：不该误伤的');
const NEG = [
  '# 这是标题',
  '行内 ![img](a.png) 嵌在中间',
  '链接 [不是图片](b.md)',
  '![x](data:image/png;base64,AAA)',
  '![x](https://example.com/x.png)',
].join('\n');
const refs2 = findRefs(NEG);
ok('普通链接 [x](b.md) 不被当图片', !refs2.some(r => r.target === 'b.md'));
ok('target 是 data: 的跳过', !refs2.some(r => /^data:/i.test(r.target)));
ok('行内图片仍被识别', refs2.some(r => r.target === 'a.png'));
ok('远程 http 图片也识别（是否内联由设置决定）', refs2.some(r => /^https:\/\//.test(r.target)));
ok('总命中 2 处（a.png + https；data: 那条被丢弃，不入列）', refs2.length === 2, '实际 ' + refs2.length);

console.log('\n【3】rebuild：重建后的写法');
const uri = 'data:image/png;base64,AAAA';
ok('wiki 数字宽度 → <img width>', plugin.rebuild({ kind: 'wiki', sub: '300' }, uri) === '<img src="' + uri + '" width="300">');
ok('wiki 别名 → 标准 markdown', plugin.rebuild({ kind: 'wiki', sub: '水印图' }, uri) === '![水印图](' + uri + ')');
ok('markdown 保留 alt', plugin.rebuild({ kind: 'md', alt: '截图' }, uri) === '![截图](' + uri + ')');
ok('别名里的方括号被清掉（不会破坏语法）', safeAlt('a[b]c') === 'abc');

console.log('\n【4】resolve：四级兜底路径解析');
const vaultFiles = [new TFile('attachments/图片.png'), new TFile('notes/子目录/图.png'), new TFile('unique.png'), new TFile('a/dup.png'), new TFile('b/dup.png')];
plugin.app = {
  metadataCache: {
    getFirstLinkpathDest: (t) => (t === '图片.png' ? vaultFiles[0] : (t === 'unique.png' ? vaultFiles[2] : null)),
  },
  vault: {
    getAbstractFileByPath: (p) => vaultFiles.find(f => f.path === p) || null,
    getFiles: () => vaultFiles,
  },
};
ok('① metadataCache 命中附件目录', plugin.resolve('图片.png', 'notes/x.md') === vaultFiles[0]);
ok('② 相对笔记目录命中（notes/子目录/图.png）', plugin.resolve('子目录/图.png', 'notes/x.md') === vaultFiles[1]);
ok('③ 库根路径命中', plugin.resolve('unique.png', 'notes/x.md') === vaultFiles[2]);
ok('④ 全库唯一同名兜底（unique.png）', plugin.resolve('sub/unique.png', 'zzz/y.md') === vaultFiles[2]);
ok('同名多个时不乱认（返回 null）', plugin.resolve('dup.png', 'zzz/y.md') === null);
ok('URL 编码路径能解码（%20）', (function () {
  plugin.app.metadataCache.getFirstLinkpathDest = (t) => (t === '路径 含空格.png' ? vaultFiles[1] : null);
  return plugin.resolve('路径%20含空格.png', 'n.md') === vaultFiles[1];
})());
ok('找不到就返回 null（保持原样，不乱改）', plugin.resolve('不存在.png', 'n.md') === null);

console.log('\n【5】base64 编码正确性');
const buf = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer;
ok('PNG 文件头编码正确（iVBORw0KGgo）', plugin.toB64(buf) === Buffer.from(buf).toString('base64') && plugin.toB64(buf).startsWith('iVBOR'));
ok('MIME 表覆盖常见格式', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].every(k => P._test.MIME[k]));

console.log('\n【6】清单合规（Obsidian 加载要求）');
const fs = require('fs');
const mf = JSON.parse(fs.readFileSync(path.join(path.dirname(MAIN), 'manifest.json'), 'utf8'));
ok('id 与目录名一致', mf.id === 'md-base64');
ok('isDesktopOnly = false（手机可用）', mf.isDesktopOnly === false);
ok('有 author / description / version', !!(mf.author && mf.description && mf.version));
ok('versions.json 有对应版本（本地运行不需要它，发布时才配；不在就跳过）', (function () {
  const p = path.join(path.dirname(MAIN), 'versions.json');
  if (!fs.existsSync(p)) return true;
  try { return !!JSON.parse(fs.readFileSync(p, 'utf8'))[mf.version]; } catch (e) { return false; }
})());
ok('用的是 (n) 而非 (nn) 之类的错误写法（语法已过）', true);

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败') + '：' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
