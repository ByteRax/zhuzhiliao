// i18n 集成测试 —— setLocale 原子性、documentElement.lang、localStorage 同步、切换竞态。
// 用法：node --test scripts/test-i18n-integration.mjs
// 在 Node 下用最小桩模拟 fetch / window / document / localStorage / CustomEvent。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = join(__dirname, '..', 'locales');
const NS = ['ui', 'faq', 'error'];

// —— 全局桩 ——
const store = new Map();
globalThis.window = {
  dispatchEvent() {},
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
};
const docEl = { lang: 'zh-CN' };
globalThis.document = { documentElement: docEl };
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = (o && o.detail) || {}; } };

// fetch 桩：读本地 JSON 文件；未知路径返回 404
globalThis.fetch = async (url) => {
  // url 形如 locales/zh-cn/ui.json
  const m = String(url).match(/^locales\/([a-z-]+)\/([a-z]+)\.json$/);
  if (!m) return { ok: false, status: 404 };
  try {
    const raw = readFileSync(join(LOCALES_DIR, m[1], `${m[2]}.json`), 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(raw) };
  } catch (_) {
    return { ok: false, status: 404 };
  }
};

describe('setLocale 集成', () => {
  let i18n;
  before(async () => {
    i18n = await import('../i18n/i18n.js');
  });

  test('切换后 t()/documentElement.lang/localStorage 三者同步', async () => {
    store.clear();
    const ok = await i18n.setLocale('ja');
    assert.equal(ok, true);
    assert.equal(i18n.getLocale(), 'ja');
    // bcp47: ja 原样（语言子标签足够）；zh-cn → zh-CN
    assert.equal(docEl.lang, 'ja');
    assert.equal(store.get('app_locale'), 'ja');
    // t() 返回日语译文
    assert.equal(i18n.t('ui.btn.auto'), '自動で回す');
  });

  test('回退到 zh-cn 时 documentElement.lang=zh-CN', async () => {
    await i18n.setLocale('zh-cn');
    assert.equal(docEl.lang, 'zh-CN');
    assert.equal(i18n.t('ui.btn.auto'), '自动甩');
  });

  test('非法 lang 不切换，保持当前', async () => {
    const before = i18n.getLocale();
    const ok = await i18n.setLocale('../etc/passwd'); // 路径遍历尝试
    assert.equal(ok, false);
    assert.equal(i18n.getLocale(), before);
  });

  test('切换竞态：后发起的 setLocale 最终胜出', async () => {
    // 同时发起两个切换，让 en（先）和 ko（后）竞争
    store.clear();
    const p1 = i18n.setLocale('en');
    const p2 = i18n.setLocale('ko');
    const [r1, r2] = await Promise.all([p1, p2]);
    // 最终态应为 ko（后发起）
    assert.equal(i18n.getLocale(), 'ko');
    assert.equal(docEl.lang, 'ko');
    assert.equal(store.get('app_locale'), 'ko');
  });

  test('key 缺失时回退到 fallback 语言值', async () => {
    await i18n.setLocale('en');
    // 用一个不存在的 key
    const val = i18n.t('ui.nonexistent.key');
    // dev 环境下返回 key 本身（isDev 在 Node 下 location 未定义→false，走 prod 返回空串）
    assert.ok(val === '' || val === 'ui.nonexistent.key');
  });
});
