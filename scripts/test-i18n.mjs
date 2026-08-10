// i18n 单元测试 —— Node 原生 node:test，零依赖。
// 用法：node --test scripts/test-i18n.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLocale, detectLocale, interpolate } from '../i18n/i18n.js';

describe('normalizeLocale', () => {
  test('精确匹配小写', () => {
    assert.equal(normalizeLocale('zh-cn'), 'zh-cn');
    assert.equal(normalizeLocale('en'), 'en');
    assert.equal(normalizeLocale('ja'), 'ja');
    assert.equal(normalizeLocale('ko'), 'ko');
  });
  test('大小写归一', () => {
    assert.equal(normalizeLocale('EN'), 'en');
    assert.equal(normalizeLocale('JA'), 'ja');
  });
  test('英语区域降级 en-US/en-GB→en', () => {
    assert.equal(normalizeLocale('en-US'), 'en');
    assert.equal(normalizeLocale('en-GB'), 'en');
  });
  test('日语区域降级 ja-JP→ja', () => {
    assert.equal(normalizeLocale('ja-JP'), 'ja');
  });
  test('韩语区域降级 ko-KR→ko', () => {
    assert.equal(normalizeLocale('ko-KR'), 'ko');
  });
  test('中文系统一到 zh-cn', () => {
    assert.equal(normalizeLocale('zh-TW'), 'zh-cn');
    assert.equal(normalizeLocale('zh-HK'), 'zh-cn');
    assert.equal(normalizeLocale('zh-Hant'), 'zh-cn');
    assert.equal(normalizeLocale('zh-SG'), 'zh-cn');
    assert.equal(normalizeLocale('zh'), 'zh-cn');
  });
  test('未知语言返回 null', () => {
    assert.equal(normalizeLocale('fr-FR'), null);
    assert.equal(normalizeLocale('xx'), null);
  });
  test('空值/非字符串返回 null', () => {
    assert.equal(normalizeLocale(''), null);
    assert.equal(normalizeLocale(null), null);
    assert.equal(normalizeLocale(undefined), null);
    assert.equal(normalizeLocale('   '), null);
  });
});

describe('detectLocale', () => {
  // 用 env 桩注入，避免依赖真实 window/navigator/localStorage
  const baseEnv = { location: { search: '' }, lsGet: () => null };

  test('ja-JP 经 navigator.languages 命中 ja', () => {
    const r = detectLocale({ ...baseEnv, languages: ['ja-JP', 'en-US'] });
    assert.equal(r.locale, 'ja');
    assert.equal(r.source, 'navigator.languages');
  });
  test('ko-KR 经 navigator.languages 命中 ko', () => {
    const r = detectLocale({ ...baseEnv, languages: ['ko-KR', 'en'] });
    assert.equal(r.locale, 'ko');
    assert.equal(r.source, 'navigator.languages');
  });
  test('en-GB 经 navigator.languages 命中 en', () => {
    const r = detectLocale({ ...baseEnv, languages: ['en-GB'] });
    assert.equal(r.locale, 'en');
    assert.equal(r.source, 'navigator.languages');
  });
  test('zh-TW 归一到 zh-cn', () => {
    const r = detectLocale({ ...baseEnv, languages: ['zh-TW'] });
    assert.equal(r.locale, 'zh-cn');
  });
  test('fr-FR 未知 → fallback zh-cn', () => {
    const r = detectLocale({ ...baseEnv, languages: ['fr-FR'] });
    assert.equal(r.locale, 'zh-cn');
    assert.equal(r.source, 'fallback');
  });
  test('空字符串 languages → fallback', () => {
    const r = detectLocale({ ...baseEnv, languages: [] });
    assert.equal(r.locale, 'zh-cn');
    assert.equal(r.source, 'fallback');
  });
  test('undefined languages → fallback', () => {
    const r = detectLocale({ ...baseEnv, languages: undefined });
    assert.equal(r.locale, 'zh-cn');
    assert.equal(r.source, 'fallback');
  });
  test('非法 lang 参数值忽略，继续后续检测', () => {
    const r = detectLocale({ location: { search: '?lang=xx-zz' }, lsGet: () => null, languages: ['ko-KR'] });
    assert.equal(r.locale, 'ko');
  });
  test('URL ?lang= 最高优先级 + 白名单校验', () => {
    const r = detectLocale({ location: { search: '?lang=ja' }, lsGet: () => 'en', languages: ['en-US'] });
    assert.equal(r.locale, 'ja');
    assert.equal(r.source, 'url');
  });
  test('localStorage 次优先级', () => {
    const r = detectLocale({ location: { search: '' }, lsGet: (k) => (k === 'app_locale' ? 'ko' : null), languages: ['en-US'] });
    assert.equal(r.locale, 'ko');
    assert.equal(r.source, 'localStorage');
  });
  test('localStorage 非法值（已下线）被忽略', () => {
    const r = detectLocale({ location: { search: '' }, lsGet: (k) => (k === 'app_locale' ? 'de' : null), languages: ['ja-JP'] });
    assert.equal(r.locale, 'ja'); // 不因非法 localStorage 落 fallback
  });
  test('navigator.language 兜底（languages 为空时）', () => {
    const r = detectLocale({ ...baseEnv, languages: [], language: 'ko-KR' });
    assert.equal(r.locale, 'ko');
    assert.equal(r.source, 'navigator.language');
  });
});

describe('interpolate', () => {
  test('命名占位符替换', () => {
    assert.equal(interpolate('此刻 {online} 人', { online: 5 }), '此刻 5 人');
  });
  test('多占位符', () => {
    assert.equal(interpolate('{a}·{b}·{c}', { a: '1', b: '2', c: '3' }), '1·2·3');
  });
  test('缺省占位符保留原文', () => {
    assert.equal(interpolate('{a} {b}', { a: '1' }), '1 {b}');
  });
  test('无 params 原样返回', () => {
    assert.equal(interpolate('hello {x}', null), 'hello {x}');
  });
});
