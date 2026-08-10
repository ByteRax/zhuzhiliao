// 竹知了 i18n 运行时 —— 零依赖原生 ES Module。
// 功能：语言检测 / 原子切换 / 懒加载 / 插值 / Intl 格式化 / 竞态保护 / 可插拔 reportError。
// 设计见 docs/i18n.md（方案摘要、检测流程、回滚方案）。
//
// 安全：所有 lang 值在使用前都经 SUPPORTED 白名单校验，禁止直接拼入路径或 URL。
// 富文本不在此处处理，见 index.html 中 installtip 的 DOM 构造。

/* ============================================================
   常量与类型
   ============================================================ */

/** 支持的语言代码白名单（小写）。新增语言须同时加资源目录与归一化映射。 */
export const SUPPORTED = ['zh-cn', 'en', 'ja', 'ko'];

/** 回退语言。key 缺失或资源加载失败时的最终兜底。 */
export const FALLBACK = 'zh-cn';

/** localStorage 键名。 */
export const LS_KEY = 'app_locale';

/**
 * 全局开关。置 false 时，i18n 不接管文案，运行时回到改造前中文硬编码路径。
 * 由 index.html 在引入本模块前设置 window.ENABLE_I18N。
 */
export const ENABLE_I18N = (() => {
  try { return window.ENABLE_I18N !== false; }
  catch (_) { return true; } // window 未定义（如 SSR）默认开，由宿主决定
})();

/** 对外事件名：语言切换成功后广播。 */
export const LOCALE_EVENT = 'localechange';

/**
 * @typedef {Object} LocaleMessage
 * @property {string} locale       最终选定的语言代码（已归一化、已校验）
 * @property {string} source       命中的检测阶段，取值见 detectLocale 的注释
 * @property {string} [reason]     降级原因（当最终落到 fallback 时给出）
 * @property {string} [raw]        原始输入值（调试用）
 */

/**
 * @typedef {(err: Error, ctx?: Record<string, unknown>) => void} ReportError
 * 可插拔错误上报钩子。默认只 dev 控制台输出；线上可由宿主覆盖接入监控。
 */

/* ============================================================
   纯函数：归一化与检测（可独立单测，无 DOM 依赖）
   ============================================================ */

/**
 * 把任意语言标签归一化到 SUPPORTED 中的值或 null。
 * 规则：转小写 → 区域降级（en-us→en, ja-jp→ja, ko-kr→ko）→
 *      中文系（zh-tw/zh-hk/zh-hant/zh-* 无 region）→ zh-cn →
 *      其余不在白名单的返回 null。
 * @param {string|null|undefined} tag
 * @returns {string|null} SUPPORTED 内的代码，或 null（表示未知）
 */
export function normalizeLocale(tag) {
  if (typeof tag !== 'string') return null;
  const s = tag.trim().toLowerCase();
  if (!s) return null;
  // 精确命中
  if (SUPPORTED.includes(s)) return s;
  const primary = s.split(/[-_]/)[0]; // 主语言标签
  // 区域降级：英语/日语/韩语统统归并到主语言
  if (primary === 'en') return 'en';
  if (primary === 'ja') return 'ja';
  if (primary === 'ko') return 'ko';
  // 中文系：繁体、港澳台、新加坡、无 region 一律视作简体（本项目只提供 zh-cn 译文）
  if (primary === 'zh') return 'zh-cn';
  return null;
}

/**
 * 在一个语言标签数组里挑出第一个能命中的语言。
 * 先精确匹配（如 'ja-jp' 命中 'ja' 的精确规则），再主语言降级。
 * @param {string[]} list
 * @returns {LocaleMessage} 始终返回结果对象，locale 字段可能为 FALLBACK。
 */
function matchFromList(list, source) {
  if (Array.isArray(list)) {
    // 第一轮：逐项归一化（归一化函数已含区域降级）
    for (const raw of list) {
      const hit = normalizeLocale(raw);
      if (hit) return { locale: hit, source, raw };
    }
  }
  return { locale: FALLBACK, source: 'fallback', reason: 'no-match-in-list' };
}

/**
 * 语言检测（确定性算法，纯函数，无副作用）。
 *
 * 优先级：
 *   1. URL ?lang= （经白名单校验，非法值忽略）
 *   2. localStorage['app_locale'] （须在支持列表内，否则视为无效）
 *   3. navigator.languages 逐项归一化
 *   4. navigator.language
 *   5. fallback zh-CN
 *
 * 注：本项目纯 CSR，不做 Accept-Language 协商（SSR N/A）。
 *
 * @param {Object} [env] 测试桩注入，缺省读真实浏览器环境
 * @param {Object} [env.location]
 * @param {(key:string)=>string|null} [env.lsGet] localStorage 读
 * @param {string[]|readonly string[]} [env.languages] navigator.languages
 * @param {string} [env.language] navigator.language
 * @returns {LocaleMessage}
 */
export function detectLocale(env) {
  const e = env || {};
  // 是否完全使用传入桩（测试用）：传了 env 就只读 env，不回退真实 navigator。
  const useStubs = !!env;
  // SSR / 非浏览器：直接 fallback
  if (typeof window === 'undefined' && !useStubs) {
    return { locale: FALLBACK, source: 'fallback', reason: 'no-window' };
  }
  // 1. URL ?lang=
  try {
    const loc = e.location || (!useStubs && typeof location !== 'undefined' ? location : null);
    if (loc && typeof loc.search === 'string') {
      const sp = new URLSearchParams(loc.search);
      const raw = sp.get('lang');
      if (raw) {
        const hit = normalizeLocale(raw);
        if (hit) return { locale: hit, source: 'url', raw };
        // 非法值不阻断后续检测，仅记录
        devLog({ level: 'warn', event: 'detect.url.invalid', raw });
      }
    }
  } catch (_) { /* 访问 location 可能抛错，忽略继续 */ }

  // 1b. URL pathname 语言前缀（SEO 多语言子路径协调）
  //     /en/ /ja/ /ko/ 表示用户明确访问某语言版本；根路径 / 无前缀，跳过。
  //     这保证爬虫抓到的静态 HTML 语言与运行时 i18n 语言一致，避免 localStorage 记忆导致的串语言。
  try {
    const loc = e.location || (!useStubs && typeof location !== 'undefined' ? location : null);
    if (loc && typeof loc.pathname === 'string') {
      const m = loc.pathname.match(/^\/(en|ja|ko)(\/|$)/);
      if (m) return { locale: m[1], source: 'pathname', raw: m[1] };
    }
  } catch (_) { /* ignore */ }

  // 2. localStorage
  try {
    let raw = null;
    if (useStubs) {
      if (typeof e.lsGet === 'function') raw = e.lsGet(LS_KEY);
    } else {
      raw = safeLsGet(LS_KEY);
    }
    if (raw) {
      const hit = normalizeLocale(raw);
      if (hit) return { locale: hit, source: 'localStorage', raw };
      // 已下线/非法：交给宿主清理（这里只检测不写，避免检测有副作用）
      devLog({ level: 'warn', event: 'detect.ls.invalid', raw });
    }
  } catch (_) { /* SecurityError 等忽略 */ }

  // 3. navigator.languages
  try {
    const langs = useStubs ? e.languages
      : (typeof navigator !== 'undefined' ? navigator.languages : null);
    if (langs && langs.length) {
      const m = matchFromList(langs, 'navigator.languages');
      if (m.source === 'navigator.languages') return m;
    }
  } catch (_) { /* ignore */ }

  // 4. navigator.language
  try {
    const lang = useStubs ? e.language
      : (typeof navigator !== 'undefined' ? navigator.language : null);
    if (lang) {
      const hit = normalizeLocale(lang);
      if (hit) return { locale: hit, source: 'navigator.language', raw: lang };
    }
  } catch (_) { /* ignore */ }

  // 5. fallback
  return { locale: FALLBACK, source: 'fallback', reason: 'all-sources-missed' };
}

/* ============================================================
   实例状态与运行时
   ============================================================ */

/** 当前语言（小写）。 */
let currentLocale = FALLBACK;
/** 已加载的语言包：locale -> 扁平 key->value 字典。 */
const bundles = Object.create(null);
/** 语言包加载中的 Promise，防止重复 fetch。 */
const loading = Object.create(null);
/** setLocale 请求序列号，用于竞态保护（后发起的请求先返回时丢弃旧结果）。 */
let switchSeq = 0;
/** 当前生效的 i18n 实例对外接口（t/getLocale 等）。 */
let reportErrorFn = null;

/**
 * 设置可插拔错误上报钩子。宿主可接入既有监控体系（非硬编码 SDK）。
 * @param {ReportError} fn
 */
export function setReportError(fn) {
  if (typeof fn === 'function') reportErrorFn = fn;
}

/** @returns {string} 当前生效语言 */
export function getLocale() { return currentLocale; }

/** @returns {boolean} 是否已初始化 */
export function isReady() { return !!bundles[currentLocale]; }

/**
 * 取值。插值用命名占位符 {name}。
 * 行为契约：
 *   - key 命中当前语言：返回插值后的值；
 *   - 当前语言缺失但 fallback 有：返回 fallback 值；
 *   - 都缺失：dev 抛 warn + 返回 key；prod 返回空串并上报。
 * 绝不抛异常中断渲染。
 * @param {string} key 点分 key，如 'ui.btn.auto'
 * @param {Record<string, string|number>} [params] 命名插值
 * @returns {string}
 */
export function t(key, params) {
  if (typeof key !== 'string' || !key) return '';
  // 当前语言
  let val = lookup(bundles[currentLocale], key);
  // 缺失 → fallback
  if (val === undefined && currentLocale !== FALLBACK) {
    val = lookup(bundles[FALLBACK], key);
  }
  if (val === undefined || val === null) {
    // dev: warn 并返回 key（便于发现遗漏）
    if (isDev()) {
      // eslint-disable-next-line no-console
      console.warn('[i18n] missing key:', key, '@', currentLocale);
      return key;
    }
    // prod: 上报 + 空串
    reportOnce(new Error('i18n missing key: ' + key), { key, locale: currentLocale });
    return '';
  }
  // 空字符串译文：按契约允许（译文就是空），直接返回
  if (val === '') return '';
  return params ? interpolate(val, params) : val;
}

/**
 * 在已加载的扁平字典里按点分 key 取值。
 * @param {Object} dict
 * @param {string} key
 * @returns {unknown}
 */
function lookup(dict, key) {
  if (!dict) return undefined;
  const parts = key.split('.');
  let cur = dict;
  for (const p of parts) {
    if (cur && Object.prototype.hasOwnProperty.call(cur, p)) cur = cur[p];
    else return undefined;
  }
  return typeof cur === 'string' ? cur : undefined;
}

/**
 * 命名占位符插值：{name} → params.name。
 * 不做任何 HTML 转义——渲染由调用方走 textContent（纯文本）。
 * @param {string} str
 * @param {Record<string, string|number>} params
 */
export function interpolate(str, params) {
  return str.replace(/\{(\w+)\}/g, (m, name) =>
    (params && Object.prototype.hasOwnProperty.call(params, name))
      ? String(params[name])
      : m);
}

/* ============================================================
   资源加载（懒加载 + 竞态 + 404/解析失败处理）
   ============================================================ */

/**
 * 加载某语言的所有命名空间。已加载则直接返回缓存。
 * @param {string} lang 必须已通过白名单校验
 * @returns {Promise<Object>} 该语言的合并字典
 */
export async function loadBundle(lang) {
  const safe = normalizeLocale(lang) || FALLBACK;
  if (bundles[safe]) return bundles[safe];
  if (loading[safe]) return loading[safe];

  // 命名空间清单（与目录下文件一一对应，由 CI 一致性脚本校验四语齐全）
  const NS = ['ui', 'faq', 'error'];
  const p = (async () => {
    const merged = Object.create(null);
    // 串行 fetch（首屏只一次、体积小，避免并发竞争与构建复杂度）
    for (const ns of NS) {
      const url = resourceUrl(safe, ns);
      const resp = await fetch(url, { cache: 'force-cache' });
      if (!resp.ok) {
        throw new Error('i18n bundle ' + resp.status + ': ' + url);
      }
      let json;
      try { json = await resp.json(); }
      catch (e) { throw new Error('i18n bundle parse failed: ' + url); }
      merged[ns] = json;
    }
    bundles[safe] = merged;
    delete loading[safe];
    return merged;
  })();

  loading[safe] = p.catch((e) => { delete loading[safe]; throw e; });
  return loading[safe];
}

/**
 * 构造资源 URL。lang 已经 normalize 过，ns 来自硬编码列表，
 * 二者都不会含用户可控字符，从根上杜绝路径遍历。
 * @param {string} lang
 * @param {string} ns
 */
function resourceUrl(lang, ns) {
  // 防御性二次校验：只允许白名单 + 已知 ns
  if (!SUPPORTED.includes(lang)) throw new Error('locale not supported: ' + lang);
  if (!/^[a-z]+$/.test(ns)) throw new Error('invalid namespace: ' + ns);
  return `locales/${lang}/${ns}.json`;
}

/* ============================================================
   原子切换 setLocale
   ============================================================ */

/**
 * 原子切换语言。失败回滚到切换前语言，不留半切换状态。
 * 步骤：白名单校验 → 加载资源 → 更新实例 → 写 localStorage →
 *      更新 documentElement.lang → 广播事件。
 * 任一步失败：currentLocale 不变，已加载的资源保留（无害）。
 *
 * 竞态保护：每次调用递增 switchSeq；异步加载返回时若 seq 已过期，
 * 结果被丢弃，最终态以最后发起的 setLocale 为准。
 *
 * @param {string} lang
 * @param {Object} [opts]
 * @param {boolean} [opts.persist=true] 是否写 localStorage
 * @returns {Promise<boolean>} 是否切换成功
 */
export async function setLocale(lang, opts) {
  const o = opts || {};
  const persist = o.persist !== false;

  const target = normalizeLocale(lang);
  if (!target) {
    devLog({ level: 'warn', event: 'setLocale.invalid', raw: lang });
    return false;
  }
  if (target === currentLocale && bundles[target]) {
    return true; // 已是目标语言且已加载
  }

  const prev = currentLocale;
  const mySeq = ++switchSeq;

  let next;
  try {
    next = await loadBundle(target);
  } catch (e) {
    // 加载失败：回滚，不改 currentLocale / localStorage / documentElement
    reportOnce(e, { locale: target, stage: 'loadBundle' });
    devLog({ level: 'error', event: 'setLocale.loadFailed', locale: target, error: String(e) });
    return false;
  }

  // 竞态：期间又发起了更新的 setLocale，丢弃本次结果
  if (mySeq !== switchSeq) {
    devLog({ level: 'info', event: 'setLocale.superseded', locale: target });
    return false;
  }

  // —— 提交阶段（同步、尽量短）——
  bundles[target] = next;
  currentLocale = target;

  if (persist) safeLsSet(LS_KEY, target);

  try {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = bcp47(target);
    }
  } catch (_) { /* ignore */ }

  broadcast(target, prev);
  devLog({ level: 'info', event: 'setLocale.ok', locale: target, prev });
  return true;
}

/** 把内部小写代码转成 BCP47 写法用于 <html lang>。 */
function bcp47(lang) {
  if (lang === 'zh-cn') return 'zh-CN';
  return lang; // en/ja/ko 原样
}

/* ============================================================
   初始化
   ============================================================ */

/**
 * 初始化：检测语言并加载首屏语言包。ENABLE_I18N=false 时只加载 fallback。
 * @param {Object} [env] 测试桩
 * @returns {Promise<string>} 最终生效的语言
 */
export async function init(env) {
  if (!ENABLE_I18N) {
    await loadBundle(FALLBACK).catch(() => {});
    currentLocale = FALLBACK;
    return FALLBACK;
  }
  const msg = detectLocale(env);
  devLog({ level: 'info', event: 'detect.result', ...msg });
  // 检测结果若与 localStorage 不一致或来自 url/navigator，统一固化到 localStorage
  // （仅当检测命中有效语言，未知语言不写入——由 safeLsSet 上层契约保证）
  try {
    await setLocale(msg.locale, { persist: true });
  } catch (e) {
    reportOnce(e, { stage: 'init' });
    // 兜底
    await loadBundle(FALLBACK).catch(() => {});
    currentLocale = FALLBACK;
  }
  return currentLocale;
}

/* ============================================================
   Intl 格式化封装（F4）
   ============================================================ */

/** @returns {string} Intl 用的 locale 标签 */
function intlLocale() {
  return {
    'zh-cn': 'zh-CN',
    'en': 'en-US',
    'ja': 'ja-JP',
    'ko': 'ko-KR',
  }[currentLocale] || 'zh-CN';
}

/**
 * 格式化日期。随语言切换。
 * @param {Date|number} date
 * @param {Intl.DateTimeFormatOptions} [opts]
 * @returns {string}
 */
export function formatDate(date, opts) {
  try {
    return new Intl.DateTimeFormat(intlLocale(), opts || { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
  } catch (_) {
    return new Date(date).toString();
  }
}

/**
 * 格式化数字。随语言切换。
 * @param {number} n
 * @param {Intl.NumberFormatOptions} [opts]
 * @returns {string}
 */
export function formatNumber(n, opts) {
  try {
    return new Intl.NumberFormat(intlLocale(), opts).format(n);
  } catch (_) {
    return String(n);
  }
}

/**
 * 格式化货币。随语言切换。
 * @param {number} n
 * @param {string} [currency='CNY']
 * @returns {string}
 */
export function formatCurrency(n, currency) {
  try {
    return new Intl.NumberFormat(intlLocale(), { style: 'currency', currency: currency || 'CNY' }).format(n);
  } catch (_) {
    return String(n);
  }
}

/* ============================================================
   DOM 绑定辅助：data-i18n 声明式渲染
   ============================================================ */

/**
 * 扫描文档中带 [data-i18n] 的元素，用 t() 填充 textContent。
 * 支持 data-i18n-attr="placeholder:t(key),title:t(key2)" 形式改属性。
 * 切换语言后调用 applyTranslations() 即可整页刷新。
 */
export function applyTranslations(root) {
  if (typeof document === 'undefined') return;
  const scope = root || document;
  scope.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  });
  scope.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    const spec = el.getAttribute('data-i18n-attr') || '';
    spec.split(',').forEach((pair) => {
      const m = pair.match(/^\s*([\w-]+)\s*:\s*(\S+)\s*$/);
      if (!m) return;
      el.setAttribute(m[1], t(m[2]));
    });
  });
}

/* ============================================================
   工具：localStorage 安全读写、广播、日志、上报
   ============================================================ */

function safeLsGet(key) {
  try { return window.localStorage.getItem(key); }
  catch (_) { return null; } // 隐私模式 / SecurityError
}
function safeLsSet(key, val) {
  try { window.localStorage.setItem(key, val); }
  catch (_) { /* 隐私模式写失败静默 */ }
}

function broadcast(locale, prev) {
  try {
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent(LOCALE_EVENT, { detail: { locale, prev } }));
    }
  } catch (_) { /* ignore */ }
}

function isDev() {
  try {
    return Boolean(location && (location.hostname === 'localhost'
      || location.hostname === '127.0.0.1'
      || location.protocol === 'file:'));
  } catch (_) { return false; }
}

function devLog(msg) {
  if (!isDev()) return;
  try {
    // eslint-disable-next-line no-console
    console.log('[i18n]', JSON.stringify(msg));
  } catch (_) { /* ignore */ }
}

const reportedKeys = new Set();
function reportOnce(err, ctx) {
  const sig = err.message + JSON.stringify(ctx || {});
  if (reportedKeys.has(sig)) return;
  reportedKeys.add(sig);
  reportErrorFn ? reportErrorFn(err, ctx) : devLog({ level: 'error', event: 'report', error: String(err), ctx });
}

// 默认导出一个聚合对象，便于宿主 import * 时用
export default {
  SUPPORTED, FALLBACK, LS_KEY, ENABLE_I18N, LOCALE_EVENT,
  detectLocale, normalizeLocale,
  getLocale, isReady, t, interpolate,
  loadBundle, setLocale, init,
  formatDate, formatNumber, formatCurrency,
  applyTranslations, setReportError,
};
