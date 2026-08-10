// SEO 一致性检查（CI 用，零依赖）。
// 用法：node scripts/check-seo.mjs
// 检查项：
//   1. 四语 seo.json 顶层 key 一致（title/description/keywords/.../jsonld）
//   2. 生成的 4 份 HTML 无 {{ 占位符残留
//   3. 每份 HTML 含完整 hreflang 互链（四语 + x-default）
//   4. 每份 HTML 的 JSON-LD 可解析、@id 路径与 canonical 匹配
// 退出码：0 = 通过，1 = 有错误。
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const LANGS = ['zh-cn', 'en', 'ja', 'ko'];
const HTML_FILES = [
  ['index.html', '/'],
  ['en/index.html', '/en/'],
  ['ja/index.html', '/ja/'],
  ['ko/index.html', '/ko/'],
];
const HREFLANG_SET = ['zh-Hans', 'en', 'ja', 'ko', 'x-default'];
const REQUIRED_SEO_KEYS = ['title', 'description', 'keywords', 'appName', 'ogLocale',
  'ogTitle', 'ogDescription', 'ogImageAlt', 'twitterDescription', 'llmsTitle', 'jsonld'];

let errors = 0;

// 1. seo.json 顶层 key 一致
const refKeys = Object.keys(JSON.parse(readFileSync(join(ROOT, 'locales/zh-cn/seo.json'), 'utf8')))
  .filter((k) => k !== 'jsonld');
for (const lang of LANGS) {
  const obj = JSON.parse(readFileSync(join(ROOT, 'locales', lang, 'seo.json'), 'utf8'));
  const keys = Object.keys(obj).filter((k) => k !== 'jsonld');
  const missing = REQUIRED_SEO_KEYS.filter((k) => !(k in obj));
  const extra = keys.filter((k) => !REQUIRED_SEO_KEYS.includes(k));
  if (missing.length || extra.length) {
    errors++;
    console.error(`✗ ${lang}/seo.json: 缺失 ${missing} / 多余 ${extra}`);
  } else {
    console.log(`✓ ${lang}/seo.json 顶层 key 完整`);
  }
  // jsonld 必须有 @graph
  if (!obj.jsonld || !Array.isArray(obj.jsonld['@graph'])) {
    errors++;
    console.error(`✗ ${lang}/seo.json: jsonld 缺少 @graph 数组`);
  }
}

// 2-4. 生成的 HTML 检查
for (const [file, pathPrefix] of HTML_FILES) {
  const fp = join(ROOT, file);
  if (!existsSync(fp)) { errors++; console.error(`✗ ${file} 不存在`); continue; }
  const html = readFileSync(fp, 'utf8');

  // 2. 占位符残留
  if (/\{\{[^}]+\}\}/.test(html)) {
    errors++;
    const m = html.match(/\{\{[^}]+\}\}/g);
    console.error(`✗ ${file}: 残留占位符 ${JSON.stringify(m)}`);
  }

  // 3. hreflang 完整
  for (const h of HREFLANG_SET) {
    const re = new RegExp(`hreflang="${h}"`);
    if (!re.test(html)) { errors++; console.error(`✗ ${file}: 缺少 hreflang="${h}"`); }
  }

  // 4. JSON-LD 解析 + @id 路径
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!m) { errors++; console.error(`✗ ${file}: 未找到 JSON-LD`); continue; }
  try {
    const obj = JSON.parse(m[1]);
    const site = obj['@graph'].find((n) => n['@type'] === 'WebSite');
    // pathPrefix 已是规范化的路径表示：'/' 或 '/en/'
    const base = 'https://zzl.tanranran.cn';
    const expectedCanonical = base + pathPrefix;  // '/' 或 '/en/'
    const expectedId = base + pathPrefix + '#website';  // ...cn/#website 或 ...cn/en/#website（pathPrefix 已含尾斜杠）
    if (site['@id'] !== expectedId) {
      errors++;
      console.error(`✗ ${file}: WebSite @id=${site['@id']} 预期=${expectedId}`);
    }
    // canonical 匹配
    const canonical = html.match(/rel="canonical" href="([^"]+)"/);
    if (canonical && canonical[1] !== expectedCanonical) {
      errors++;
      console.error(`✗ ${file}: canonical=${canonical[1]} 预期=${expectedCanonical}`);
    }
    console.log(`✓ ${file}: JSON-LD 合法, @id/canonical 正确, hreflang 完整`);
  } catch (e) {
    errors++;
    console.error(`✗ ${file}: JSON-LD 解析失败: ${e.message}`);
  }
}

if (errors > 0) {
  console.error(`\nSEO 检查失败：${errors} 处错误`);
  process.exit(1);
} else {
  console.log('\nSEO 检查通过');
  process.exit(0);
}
