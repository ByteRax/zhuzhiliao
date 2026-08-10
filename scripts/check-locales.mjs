// 四语资源 key 一致性检查（CI 用，零依赖）。
// 用法：node scripts/check-locales.mjs
// 退出码：0 = 一致，1 = 有缺失/多余。
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = join(__dirname, '..', 'locales');
const LANGS = ['zh-cn', 'en', 'ja', 'ko'];
const NS = ['ui', 'faq', 'error'];

// 递归收集所有叶子 key 路径
function collectKeys(obj, prefix, out) {
  for (const k of Object.keys(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (obj[k] !== null && typeof obj[k] === 'object') {
      collectKeys(obj[k], path, out);
    } else {
      out.add(path);
    }
  }
  return out;
}

let diffs = 0;
const ref = new Set();
// 先以 zh-cn 为基准收集 key
for (const ns of NS) {
  const raw = JSON.parse(readFileSync(join(LOCALES_DIR, 'zh-cn', `${ns}.json`), 'utf8'));
  collectKeys(raw, ns, ref);
}
console.log(`基准 zh-cn key 数: ${ref.size}`);

for (const lang of LANGS) {
  if (lang === 'zh-cn') continue;
  const cur = new Set();
  for (const ns of NS) {
    let raw;
    try {
      raw = JSON.parse(readFileSync(join(LOCALES_DIR, lang, `${ns}.json`), 'utf8'));
    } catch (e) {
      console.error(`✗ ${lang}/${ns}.json 读取失败: ${e.message}`);
      diffs++;
      continue;
    }
    collectKeys(raw, ns, cur);
  }
  const missing = [...ref].filter((k) => !cur.has(k));
  const extra = [...cur].filter((k) => !ref.has(k));
  if (missing.length === 0 && extra.length === 0) {
    console.log(`✓ ${lang} 与 zh-cn key 完全一致 (${cur.size})`);
  } else {
    diffs += missing.length + extra.length;
    if (missing.length) console.error(`✗ ${lang} 缺失 key (${missing.length}):`);
    missing.forEach((k) => console.error(`    - ${k}`));
    if (extra.length) console.error(`✗ ${lang} 多余 key (${extra.length}):`);
    extra.forEach((k) => console.error(`    + ${k}`));
  }
}

// 空译文检查（译文值为空字符串视为潜在问题，列出供人工确认）
const empties = [];
for (const lang of LANGS) {
  for (const ns of NS) {
    const raw = JSON.parse(readFileSync(join(LOCALES_DIR, lang, `${ns}.json`), 'utf8'));
    const keys = new Set();
    collectKeys(raw, ns, keys);
    // 重新读取原始对象检查空值
    const check = (obj, prefix) => {
      for (const k of Object.keys(obj)) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (obj[k] !== null && typeof obj[k] === 'object') check(obj[k], path);
        else if (obj[k] === '') empties.push(`${lang}/${path}`);
      }
    };
    check(raw, ns);
  }
}
if (empties.length) {
  console.warn(`⚠ 空译文 (${empties.length})，请人工确认是否 intentional:`);
  empties.forEach((e) => console.warn(`    ${e}`));
} else {
  console.log('✓ 无空译文');
}

if (diffs > 0) {
  console.error(`\n一致性检查失败：${diffs} 处 key 差异`);
  process.exit(1);
} else {
  console.log('\n一致性检查通过');
  process.exit(0);
}
