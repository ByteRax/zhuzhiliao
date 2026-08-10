// build-seo.mjs —— 从 src/index.html 模板 + locales/{lang}/seo.json 生成四语 HTML。
// 零依赖 Node 原生脚本（手动运行，非构建链）。
//
// 用法：node scripts/build-seo.mjs
// 输出：
//   ./index.html        中文根路径（canonical=/）
//   ./en/index.html     英文（canonical=/en/）
//   ./ja/index.html     日文（canonical=/ja/）
//   ./ko/index.html     韩文（canonical=/ko/）
//
// 日常维护：
//   - 改 UI 代码 → 改 src/index.html → 跑本脚本
//   - 改 SEO 文案 → 改 locales/{lang}/seo.json → 跑本脚本
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TEMPLATE = join(ROOT, 'src', 'index.html');

// 语言 → 子路径映射（中文留根路径）
const LANGS = [
  { lang: 'zh-cn', htmlLang: 'zh-CN', pathPrefix: '', dir: '' },
  { lang: 'en', htmlLang: 'en', pathPrefix: 'en', dir: 'en' },
  { lang: 'ja', htmlLang: 'ja', pathPrefix: 'ja', dir: 'ja' },
  { lang: 'ko', htmlLang: 'ko', pathPrefix: 'ko', dir: 'ko' },
];
const SITE = 'https://zzl.tanranran.cn';

// 读取模板
const template = readFileSync(TEMPLATE, 'utf8');

// hreflang 互链块：四语 + x-default，所有语言共用同一组
function hreflangBlock() {
  const entries = [
    ['zh-Hans', SITE + '/'],
    ['en', SITE + '/en/'],
    ['ja', SITE + '/ja/'],
    ['ko', SITE + '/ko/'],
    ['x-default', SITE + '/'],
  ];
  return entries.map(([h, href]) =>
    `<link rel="alternate" hreflang="${h}" href="${href}">`).join('\n');
}

const HREFLANG = hreflangBlock();

// JSON-LD 的 @id/url 路径按语言注入
function buildJsonld(jsonldTemplate, lang, pathPrefix) {
  // jsonldTemplate 是 seo.json 里的 JSON-LD 对象（已含各语言文案）
  // 只需修正路径相关的字段：@id、url、mainEntityOfPage 等
  const langPath = pathPrefix ? `${pathPrefix}/` : '';
  const fullUrl = SITE + '/' + langPath;
  // 深拷贝后修正路径
  const obj = JSON.parse(JSON.stringify(jsonldTemplate));
  const ORIGIN = 'https://zzl.tanranran.cn';
  const rewrites = (s) => {
    if (typeof s !== 'string') return s;
    // 把模板里的 {{site}}/ 替换为实际语言路径
    return s.replace(/\{\{site\}\}\//g, fullUrl)
            .replace(/\{\{langPath\}\}/g, langPath);
  };
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        out[k] = typeof v === 'string' ? rewrites(v) : walk(v);
      }
      return out;
    }
    return node;
  };
  return JSON.stringify(walk(obj), null, 2);
}

let ok = 0, fail = 0;
for (const { lang, htmlLang, pathPrefix, dir } of LANGS) {
  const seoPath = join(ROOT, 'locales', lang, 'seo.json');
  let seo;
  try {
    seo = JSON.parse(readFileSync(seoPath, 'utf8'));
  } catch (e) {
    console.error(`✗ ${lang}: 读取 ${seoPath} 失败: ${e.message}`);
    fail++;
    continue;
  }

  const langPath = pathPrefix ? `${pathPrefix}/` : '';
  const fullUrl = SITE + '/' + langPath;

  // 组装占位符替换表
  const replacements = {
    '{{html.lang}}': htmlLang,
    '{{seo.baseHref}}': SITE + '/',
    '{{seo.title}}': seo.title || '',
    '{{seo.description}}': seo.description || '',
    '{{seo.keywords}}': seo.keywords || '',
    '{{seo.appName}}': seo.appName || '',
    '{{seo.canonical}}': fullUrl,
    '{{seo.hreflang}}': HREFLANG,
    '{{seo.llmsHref}}': pathPrefix ? `/${pathPrefix}/llms.txt` : '/llms.txt',
    '{{seo.llmsTitle}}': seo.llmsTitle || '',
    '{{seo.manifestHref}}': pathPrefix ? `/${pathPrefix}/manifest.webmanifest` : '/manifest.webmanifest',
    '{{seo.ogLocale}}': seo.ogLocale || '',
    '{{seo.ogTitle}}': seo.ogTitle || '',
    '{{seo.ogDescription}}': seo.ogDescription || '',
    '{{seo.ogImageAlt}}': seo.ogImageAlt || '',
    '{{seo.twitterDescription}}': seo.twitterDescription || '',
    '{{jsonld}}': buildJsonld(seo.jsonld, lang, pathPrefix),
  };

  let out = template;
  for (const [k, v] of Object.entries(replacements)) {
    out = out.split(k).join(v);
  }

  // 残留占位符检查
  const leftover = out.match(/\{\{[^}]+\}\}/g);
  if (leftover) {
    console.error(`✗ ${lang}: 残留占位符 ${JSON.stringify(leftover)}`);
    fail++;
    continue;
  }

  // 写入
  const outDir = dir ? join(ROOT, dir) : ROOT;
  if (dir) mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'index.html');
  writeFileSync(outPath, out, 'utf8');
  console.log(`✓ ${lang} → ${dir || '.'}/index.html (canonical=${fullUrl})`);
  ok++;
}

if (fail > 0) {
  console.error(`\n生成失败：${fail} 个语言，${ok} 个成功`);
  process.exit(1);
} else {
  console.log(`\n生成完成：${ok} 份 HTML`);
}
