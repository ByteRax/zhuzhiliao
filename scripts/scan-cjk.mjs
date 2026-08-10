// CJK 文案扫描器 —— 扫描源文件中尚未迁移到 i18n 资源的硬编码中日韩文本。
// 用法：node scripts/scan-cjk.mjs [--html index.html] [--js 3d/*.js]
// 默认扫描 index.html 与 3d/*.js，输出每处中文文本的行号与上下文。
// 零依赖。退出码：0（仅报告，不阻断 CI，由人工决定迁移）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DEFAULT_TARGETS = ['index.html', '3d/model.js', '3d/boot3d.js'];

// CJK 范围：CJK 统一表意 + 扩展A + 日文假名 + 韩文音节
const CJK = /[\u{3400}-\u{9fff}\u{f900}-\u{faff}\u{3040}-\u{30ff}\u{ac00}-\u{d7af}]/u;

const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : DEFAULT_TARGETS;

let total = 0;
for (const rel of targets) {
  const abs = join(ROOT, rel);
  let raw;
  try { raw = readFileSync(abs, 'utf8'); }
  catch (e) { console.error(`跳过 ${rel}: ${e.message}`); continue; }
  const lines = raw.split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    // 跳过注释行与纯空白
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return;
    if (!CJK.test(line)) return;
    // 已迁移的行（含 data-i18n）跳过，只报告尚未迁移的
    if (/data-i18n/.test(line)) return;
    // 跳过 JSON-LD / SEO meta（约定本期不迁移 SEO，见 docs/i18n.md 决策C）
    if (rel === 'index.html' && (i + 1) <= 250 && /meta\s+name|application\/ld\+json|og:|twitter:|@type/.test(line)) return;
    hits.push({ line: i + 1, text: trimmed.slice(0, 80) });
  });
  if (hits.length) {
    console.log(`\n=== ${rel}（${hits.length} 处未迁移 CJK）===`);
    hits.forEach((h) => { console.log(`  ${rel}:${h.line}  ${h.text}`); total++; });
  } else {
    console.log(`${rel}: 无未迁移 CJK`);
  }
}
console.log(`\n合计未迁移 CJK：${total} 处`);
console.log('注：SEO meta / JSON-LD（1-250 行）按本期决策 C 保留中文，不在统计内。');
process.exit(0);
