/**
 * 竹知了 计数后端
 * 单个 SQLite Durable Object 承载全站计数（唯一访客/访问次数/全球哇数），
 * WebSocket Hibernation 维持所有在线玩家的实时推送。
 */
import { DurableObject } from 'cloudflare:workers';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/* 只接受本站自己的页面来源：fork 出去的部署不该把哇数记进本站统计，也不该消耗本站额度。
   浏览器不允许网页伪造 Origin，这层对所有网页来源都成立（WebSocket 握手与 sendBeacon 都会带上）；
   curl 之类可以随便伪造，但那是另一个威胁模型，不是这里要防的。前端 API_ORIGIN 白名单与此一致。 */
function originAllowed(request) {
  const raw = request.headers.get('Origin');
  if (!raw) return false;                                  // 非浏览器来源
  let u;
  try { u = new URL(raw); } catch (_) { return false; }    // file:// 的 "null" 等非法值
  if (u.protocol !== 'https:') return false;
  return u.hostname === 'zhuzhiliao.imsai.cc'
      || u.hostname === 'zhuzhiliao.pages.dev'
      || u.hostname.endsWith('.zhuzhiliao.pages.dev');     // 自家 Pages 预览域
}

const WAH_BATCH_MAX = 30;     // 单条消息最多记多少哇（客户端 1.2s 一批，物理上甩不过 ~6 圈/秒）
const WAH_RATE_MAX = 80;      // 单连接 10 秒窗口内的哇数上限
const MAX_SOCKETS = 500;      // 并发连接上限（广播成本兜底）
const IP_WINDOW_MS = 60_000;  // 按 IP 的滑动窗口
const IP_CONNECT_MAX = 30;    // 单 IP 每分钟最多建立的连接数
const IP_BEACON_MAX = 10;     // 单 IP 每分钟最多的 REST 补报次数

export class Counter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rate = new Map();          // ws → {win: 窗口起点, n: 窗口内哇数}
    this.ipRate = new Map();        // ip → {win, conn, beacon} 按 IP 频控（尽力而为，内存态）
    this.flushTimer = null;
    this.persistTimer = null;       // 写合并：2s 内的多次自增只落一次盘(免费额度行写入有限)
    this.dirty = new Set();
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec('CREATE TABLE IF NOT EXISTS visitors (uid TEXT PRIMARY KEY, ts INTEGER)');
      sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER)');
      const meta = Object.fromEntries(sql.exec('SELECT k, v FROM meta').toArray().map(r => [r.k, r.v]));
      this.visits = meta.visits ?? 0;
      this.wahs = meta.wahs ?? 0;
      this.uniques = meta.uniques ?? sql.exec('SELECT COUNT(*) AS c FROM visitors').one().c;
      // 客户端心跳直接由运行时应答，不唤醒 DO
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    });
  }

  /* 落盘（立即）：把指定计数写进 meta 表 */
  persistNow() {
    for (const key of this.dirty) {
      this.ctx.storage.sql.exec(
        'INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
        key, this[key]
      );
    }
    this.dirty.clear();
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; }
  }

  /* 落盘（合并）：脏标记 + 2s 定时器；定时器挂着时 DO 不会休眠，落盘不会丢 */
  persist(key) {
    this.dirty.add(key);
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, 2000);
  }

  stats() {
    return {
      t: 'stats',
      online: this.ctx.getWebSockets().length,
      visitors: this.uniques,
      visits: this.visits,
      wahs: this.wahs,
    };
  }

  /* 广播合并：350ms 内的多次变更只推一帧 */
  scheduleBroadcast() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const frame = JSON.stringify(this.stats());
      for (const ws of this.ctx.getWebSockets()) {
        try { ws.send(frame); } catch (_) { /* 对端已断 */ }
      }
    }, 350);
  }

  /* 按 IP 频控；kind: 'conn' | 'beacon'。超限返回 false */
  ipAllow(request, kind, max) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const now = Date.now();
    let r = this.ipRate.get(ip);
    if (!r || now - r.win > IP_WINDOW_MS) {
      r = { win: now, conn: 0, beacon: 0 };
      this.ipRate.set(ip, r);
    }
    if (this.ipRate.size > 5000) this.ipRate.clear();   // 兜底防内存膨胀
    if (r[kind] >= max) return false;
    r[kind] += 1;
    return true;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (url.pathname === '/api/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }
      if (this.ctx.getWebSockets().length >= MAX_SOCKETS
          || !this.ipAllow(request, 'conn', IP_CONNECT_MAX)) {
        return new Response('busy', { status: 503 });
      }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === '/api/stats') {
      return Response.json(this.stats(), { headers: CORS });
    }

    // sendBeacon 兜底：页面关闭时把没来得及走 WS 的哇补上
    if (url.pathname === '/api/wah' && request.method === 'POST') {
      if (!this.ipAllow(request, 'beacon', IP_BEACON_MAX)) {
        return new Response(null, { status: 429, headers: CORS });
      }
      let n = 0;
      try { n = (await request.json()).n | 0; } catch (_) {}
      if (n > 0) {
        this.wahs += Math.min(n, WAH_BATCH_MAX);
        this.persist('wahs');
        this.scheduleBroadcast();
      }
      return new Response(null, { status: 204, headers: CORS });
    }

    return new Response('not found', { status: 404, headers: CORS });
  }

  webSocketMessage(ws, message) {
    if (typeof message !== 'string') return;
    let m;
    try { m = JSON.parse(message); } catch (_) { return; }

    if (m.t === 'hi') {
      // 每个连接只认一次 hi，防止单连接刷访问数
      let att = null;
      try { att = ws.deserializeAttachment(); } catch (_) {}
      if (att && att.hi) return;
      try { ws.serializeAttachment({ hi: 1 }); } catch (_) {}
      // v=1 表示本次页面加载的首个连接（重连不重复计访问）
      if (m.v === 1) {
        this.visits += 1;
        this.persist('visits');
      }
      const uid = typeof m.uid === 'string' ? m.uid.slice(0, 64) : '';
      if (uid) {
        const seen = this.ctx.storage.sql
          .exec('SELECT 1 AS x FROM visitors WHERE uid = ?', uid).toArray().length > 0;
        if (!seen) {
          this.ctx.storage.sql.exec('INSERT INTO visitors (uid, ts) VALUES (?, ?)', uid, Date.now());
          this.uniques += 1;
          this.persist('uniques');
        }
      }
      ws.send(JSON.stringify(this.stats()));   // 新客户端立即拿到当前值
      this.scheduleBroadcast();                // 其他人稍后收到 online 变化
      return;
    }

    if (m.t === 'wah') {
      const n = Math.min(Math.max(m.n | 0, 0), WAH_BATCH_MAX);
      if (!n) return;
      // 单连接限速：10s 滑动窗口
      const now = Date.now();
      let r = this.rate.get(ws);
      if (!r || now - r.win > 10_000) { r = { win: now, n: 0 }; this.rate.set(ws, r); }
      if (r.n + n > WAH_RATE_MAX) return;
      r.n += n;
      this.wahs += n;
      this.persist('wahs');
      this.scheduleBroadcast();
    }
  }

  webSocketClose(ws) {
    this.rate.delete(ws);
    this.persistNow();     // 连接关闭顺手落盘，休眠前不留脏数据
    this.scheduleBroadcast();
  }

  webSocketError(ws) {
    this.rate.delete(ws);
    this.persistNow();
    this.scheduleBroadcast();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: CORS });      // 预检不必唤醒 DO
      }
      // 会改数的接口（建连计数 / beacon 补报）限本站来源；/api/stats 只读，保持开放便于 curl 查数
      if (url.pathname !== '/api/stats' && !originAllowed(request)) {
        return new Response('forbidden origin', { status: 403, headers: CORS });
      }
      return env.COUNTER.getByName('global').fetch(request);
    }
    return new Response('zhuzhiliao api', { headers: CORS });
  },
};
