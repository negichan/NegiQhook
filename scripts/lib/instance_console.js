// The QQ command set for the launcher console.
//
// Everything that touches the running instance goes through the endpoint's own
// loopback surface - the same HTTP calls the debug page and the chat page make -
// so the console cannot invent a path that a real client would not have. Reads
// are GET /api/*; the writes carry x-debug-call: 1 and allow_write: true, which
// is the endpoint's own opt-in guard, plus a local `writes off` switch on top.
//
// Nothing here talks to QQ directly and nothing binds a port.

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

function apiRequest({ port, pathname, method = 'GET', body, timeout = 15000 }) {
  return new Promise((resolve, reject) => {
    if (!port) {
      reject(new Error('端点没在跑（这套实例没开协议端，或 --protocol 里没带端口）'));
      return;
    }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { accept: 'application/json' };
    if (payload) {
      headers['content-type'] = 'application/json; charset=utf-8';
      headers['content-length'] = String(payload.length);
      // The debug page's POST guard: a browser cannot set this cross-site without
      // a preflight, and the server never grants one.
      headers['x-debug-call'] = '1';
    }
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method, headers, timeout }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let value = null;
        try { value = text ? JSON.parse(text) : null; } catch (e) { value = { raw: text }; }
        if (response.statusCode >= 400) {
          const detail = (value && (value.error || value.message)) || text.slice(0, 200) || response.statusMessage;
          reject(new Error('HTTP ' + response.statusCode + '：' + detail));
          return;
        }
        resolve(value);
      });
    });
    request.on('timeout', () => request.destroy(new Error('调试端口 127.0.0.1:' + port + ' 超时')));
    request.on('error', (error) => reject(new Error(error.code === 'ECONNREFUSED'
      ? '调试端口 127.0.0.1:' + port + ' 连不上（协议端可能刚被重启或没起来）'
      : error.message)));
    request.end(payload);
  });
}

function readTail(file, count) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim());
    return lines.slice(-Math.max(1, count || 12));
  } catch (e) {
    return ['（还没有 ' + file + '）'];
  }
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const parts = [];
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) parts.push(d + 'd');
  if (d || h) parts.push(h + 'h');
  if (d || h || m) parts.push(m + 'm');
  parts.push((seconds % 60) + 's');
  return parts.join(' ');
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value > 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB';
  if (value > 1024) return Math.round(value / 1024) + ' KB';
  return value + ' B';
}

// A number is a QQ 号 or a 群号 to a human; keep both readable in the console by
// printing what the endpoint says it is, not a bare id.
function describeTarget(value) {
  const text = String(value || '');
  if (/^g[:：]/i.test(text)) return { channel: text.slice(2), hint: '群' };
  if (/^\d+$/.test(text)) return { channel: text, hint: text.length >= 9 ? '群或号（内核判断）' : '号' };
  return { channel: text, hint: '' };
}

function createInstanceConsole(ctx) {
  const peers = {
    friends: new Map(),   // uin -> display
    groups: new Map(),    // group id -> name
    members: new Map()    // group id -> Map(uin -> display)
  };
  const gate = { writes: ctx.writesAllowed !== false };
  const state = { tail: true, snapshot: null, snapshotAt: 0, bootAt: ctx.bootAt || Date.now() };

  // Once QQ is gone the window stays open on purpose (the failure is the reason
  // you are looking at it), but half the commands need a live endpoint. Say so
  // instead of throwing a socket error at the user.
  function deadPlain() {
    return '这套实例已经停了（' + (ctx.deadReason ? ctx.deadReason() : '原因未知') +
      '）：这条命令要活的协议端。log qq / log ep / health 还能翻现场。';
  }
  function deadMessage() {
    return ctx.paint(deadPlain(), 'yellow');
  }
  function needLive(handler) {
    return (call) => (ctx.dead && ctx.dead()) ? deadMessage() : handler(call);
  }

  // One place decides "is there an endpoint to talk to at all", so every command
  // gets the same answer instead of each one re-deriving it from a socket error.
  function api(opts) {
    if (ctx.dead && ctx.dead()) {
      const error = new Error(deadPlain());
      error.dead = true;
      return Promise.reject(error);
    }
    return apiRequest({ ...opts, port: ctx.uiPort });
  }

  function remember(payload) {
    if (!payload) return payload;
    for (const friend of (payload.friends || [])) {
      if (friend.uin) peers.friends.set(String(friend.uin), friend.display || friend.remark || friend.nick || friend.uin);
    }
    for (const group of (payload.groups || [])) {
      if (group.id) peers.groups.set(String(group.id), group.name || group.id);
    }
    return payload;
  }

  // The console hands every completer (index, { tokens, raw, token }); these two
  // only care about the word under the cursor.
  function targetList(index, context) {
    // `say <target>` completes with the ids we already know, and the display name
    // is what a server console would complete on.
    const token = (context && context.token) || '';
    const values = [];
    if (index === 1) {
      for (const uin of peers.friends.keys()) values.push(uin);
      for (const id of peers.groups.keys()) values.push('g:' + id);
    }
    return values.filter((value) => !token || String(value).startsWith(token));
  }

  function groupList(index, context) {
    const token = (context && context.token) || '';
    return [...peers.groups.keys()].filter((value) => !token || String(value).startsWith(token));
  }

  async function snapshot(force) {
    if (!force && state.snapshot && Date.now() - state.snapshotAt < 3000) return state.snapshot;
    const value = await api({ pathname: '/api/snapshot' });
    state.snapshot = value;
    state.snapshotAt = Date.now();
    return value;
  }

  function healthOf() {
    try {
      const text = fs.readFileSync(ctx.healthFile, 'utf8');
      const value = JSON.parse(text);
      return { value, ageMs: Date.now() - fs.statSync(ctx.healthFile).mtimeMs };
    } catch (e) {
      return { value: null, ageMs: Infinity };
    }
  }

  // One line, the thing you want to see while the logs scroll past.
  function statusLine() {
    const { value: health, ageMs } = healthOf();
    const parts = [];
    if (!health) return '协议端还没有健康文件（' + ctx.healthFile + '）';
    const bridge = health.bridge || {};
    const limits = bridge.limits || {};
    const self = health.self || {};
    parts.push(self.uin ? (self.uin + ' ' + (self.nick || '')) : '未登录');
    parts.push('QQ pid=' + ctx.launchedPid() + (ctx.pidAlive(ctx.launchedPid()) ? '' : '(没了!)'));
    if (bridge.connected) {
      parts.push('桥 g' + (bridge.generation || '?') + ' 心跳 ' + Math.max(0, Math.round((Date.now() - (bridge.lastHeartbeatAt || 0)) / 1000)) + 's 前');
    } else {
      parts.push('桥 已断开');
    }
    parts.push('qq=' + (bridge.qqVersion || '?') + (health.compat && health.compat.tested ? '' : ' 未测'));
    if (limits.budget) {
      parts.push('写 ' + (limits.used_minute || 0) + '/' + limits.budget.per_minute + '·min' + (limits.open ? ' 熔断' : ''));
    }
    const counters = bridge.counters || {};
    parts.push('事件 ' + (counters.events || 0) + '/动作 ' + (counters.actions || 0));
    parts.push('健康 ' + Math.round(ageMs / 1000) + 's');
    return parts.join(' · ');
  }

  const commands = [
    {
      name: 'status',
      aliases: ['s'],
      group: '实时',
      usage: 'status',
      desc: '这套实例现在什么样（进程/桥/版本闸/写预算/端口）',
      run: async () => {
        const lines = [];
        const alive = ctx.pidAlive(ctx.launchedPid());
        lines.push(ctx.paint('实例　', 'bold') + (ctx.headed ? '有头 QQ' : '无头 QQ') +
          '  pid=' + ctx.launchedPid() + (alive ? ' 运行中' : ' 已经不在了') +
          '  profile=' + ctx.profile);
        const endpointAlive = ctx.imageRunning(ctx.endpointPid(), 'node.exe');
        let snap = null;
        try {
          snap = await snapshot(true);
        } catch (error) {
          lines.push(ctx.paint('　　　　' + error.message, 'yellow'));
        }
        lines.push(ctx.paint('协议端', 'bold') + '  pid=' + (ctx.endpointPid() || '-') +
          (endpointAlive ? ' 运行中' : ' 没在跑') +
          '  协议=' + ((snap && snap.protocol) || ctx.protocol) +
          '  已启动 ' + formatDuration(Date.now() - state.bootAt));
        const { value: health, ageMs } = healthOf();
        const bridge = (snap && snap.bridgeConnected !== undefined)
          ? {
            connected: snap.bridgeConnected,
            generation: snap.bridgeGeneration,
            peer: snap.bridgeAddress,
            qqVersion: snap.qqVersion,
            version: snap.bridgeVersion
          }
          : ((health && health.bridge) || {});
        lines.push(ctx.paint('桥　　', 'bold') + (bridge.connected ? '已连接' : '未连接') +
          (bridge.generation ? '  generation=' + bridge.generation : '') +
          (bridge.peer ? '  来自 ' + bridge.peer : '') +
          (bridge.qqVersion ? '  QQ ' + bridge.qqVersion : '') +
          (bridge.connected && health ? '  心跳 ' + Math.max(0, Math.round((Date.now() - (health.bridge.lastHeartbeatAt || 0)) / 1000)) + 's 前' : '') +
          (snap && snap.offline ? ctx.paint('  被踢下线', 'red') : ''));
        const compat = (snap && snap.compat) || (health && health.compat) || null;
        if (compat) {
          lines.push(ctx.paint('版本闸', 'bold') + '  ' + (compat.tested ? '已测版本，写操作放行' :
              compat.known ? '认识但没测过这个 build' : '不认识的版本') +
            (compat.writesBlocked ? ctx.paint('  写操作被拦住（--allow-untested 可放开）', 'red') : '') +
            (compat.criticalMissing && compat.criticalMissing.length
              ? ctx.paint('  内核缺方法：' + compat.criticalMissing.join('、'), 'red') : '') +
            (compat.warnings && compat.warnings.length ? '  ' + compat.warnings.join('；') : ''));
        }
        const limits = (snap && snap.bridgeLimits) || (health && health.bridge && health.bridge.limits) || null;
        if (limits && limits.budget) {
          lines.push(ctx.paint('写预算', 'bold') + '  本分钟 ' + (limits.used_minute || 0) + '/' + limits.budget.per_minute +
            '  本小时 ' + (limits.used_hour || 0) + '/' + limits.budget.per_hour +
            '  最小间隔 ' + limits.budget.min_interval_ms + 'ms(+抖动 ' + limits.budget.jitter_ms + 'ms)' +
            '  连续失败 ' + (limits.strikes || 0) + '/' + limits.budget.breaker_errors +
            (limits.open ? ctx.paint('  熔断中，还要等 ' + Math.round((limits.open_until - Date.now()) / 1000) + 's', 'red') : ''));
        }
        lines.push(ctx.paint('自检　', 'bold') + '健康文件 ' + (health ? (health.ok ? 'ok' : '不 ok') : '无') +
          '  ' + Math.round(ageMs / 1000) + 's 前写过');
        lines.push(ctx.paint('端口　', 'bold') + ctx.portLine());
        lines.push(ctx.paint('本地　', 'bold') + '调试页 http://127.0.0.1:' + ctx.uiPort + '/ 与 /chat  ·  网络配置 /config  ·  ' +
          '控制台写操作开关：' + (gate.writes ? '开（say/recall/emit 会真发）' : '关（只读）') + '　用 writes 切换');
        return lines;
      }
    },
    {
      name: 'uptime',
      group: '实时',
      usage: 'uptime',
      desc: '这套实例跑了多久',
      run: async () => {
        const { value: health } = healthOf();
        let snap = null;
        try { snap = await snapshot(false); } catch (e) { /* offline */ }
        const ms = snap && snap.uptimeMs ? snap.uptimeMs : (health ? health.uptimeMs : Date.now() - state.bootAt);
        const self = (snap && snap.self) || (health && health.self) || {};
        return ctx.paint('已运行 ', 'bold') + formatDuration(ms) +
          (self.uin ? '　账号 ' + self.uin + ' ' + (self.nick || '') : '　还没登录');
      }
    },
    {
      name: 'health',
      group: '实时',
      usage: 'health [json]',
      desc: '健康快照（桥/版本闸/预算/内存），health json 看原始数据',
      run: async ({ args }) => {
        const { value: health, ageMs } = healthOf();
        if (!health) return ctx.paint('还没有健康文件：' + ctx.healthFile + '（协议端没起来？）', 'red');
        if (args[0] === 'json') return JSON.stringify(health, null, 2);
        const bridge = health.bridge || {};
        const limits = bridge.limits || {};
        const memory = health.memory || {};
        const lines = [
          ctx.paint('ok=', 'bold') + (health.ok ? ctx.paint('true', 'green') : ctx.paint('false', 'red')) +
            '　文件 ' + Math.round(ageMs / 1000) + 's 前（每 5s 重写）　pid=' + health.pid,
          '桥：' + (bridge.connected ? '连着，generation=' + bridge.generation : '断了') +
            '　心跳 ' + Math.max(0, Math.round((Date.now() - (bridge.lastHeartbeatAt || 0)) / 1000)) + 's 前' +
            '　待回动作=' + (bridge.pendingActions || 0) +
            '　断线旧桥=' + (bridge.staleBridges || 0),
          '能力：动作 ' + ((bridge.capabilities && bridge.capabilities.actions) || '?') +
            ' 个，缺 ' + JSON.stringify((bridge.capabilities && bridge.capabilities.missing) || []) +
            '　版本闸 ' + (health.compat && health.compat.tested ? '已测' : '未测') +
            (health.compat && health.compat.writesBlocked ? '（写被拦）' : ''),
          '写：本分钟 ' + (limits.used_minute || 0) + '/' + ((limits.budget && limits.budget.per_minute) || '?') +
            '　总计 ' + (limits.total || 0) + '　被拦 ' + (limits.blocked || 0) +
            '　熔断 ' + (limits.open ? '中' : '关') + (limits.last_error ? '　上次失败：' + limits.last_error : ''),
          '进程：RSS ' + formatBytes(memory.rss) + '　堆 ' + formatBytes(memory.heapUsed) +
            '　客户端 ' + JSON.stringify(health.clients || {}) +
            (health.offline ? '　被踢下线' : '')
        ];
        if (health.compat && health.compat.warnings && health.compat.warnings.length) {
          lines.push(ctx.paint('提示：' + health.compat.warnings.join('；'), 'yellow'));
        }
        return lines;
      }
    },
    {
      name: 'stats',
      group: '实时',
      usage: 'stats',
      desc: '计数与吞吐：事件、动作、错误、发送、撤回',
      run: async () => {
        let snap = null;
        try { snap = await snapshot(true); } catch (error) { return ctx.paint(error.message, 'red'); }
        const counters = snap.counters || {};
        const bridge = snap.bridgeLimits || {};
        const self = snap.self || {};
        return [
          ctx.paint('账号 ', 'bold') + (self.uin || '未登录') + ' ' + (self.nick || '') +
            '　协议 ' + snap.protocol + '　Satori 客户端 ' + ((snap.satori && snap.satori.clients) || 0) +
            '　OneBot 客户端 ' + ((snap.onebot && snap.onebot.clients) || 0),
          ctx.paint('端点 ', 'bold') + '内核事件 ' + (counters.kernelEvents || 0) +
            '　已投递给框架 ' + (counters.delivered || 0) +
            '　页面/控制台调用 ' + (counters.apiCalls || 0) +
            '　聊天发送 ' + (counters.chatSends || 0) + '　撤回 ' + (counters.chatRecalls || 0),
          ctx.paint('桥　 ', 'bold') + '本分钟写 ' + ((bridge.used_minute || 0)) + '/' + ((bridge.budget && bridge.budget.per_minute) || '?') +
            '　累计 ' + (bridge.total || 0) + '　被拦 ' + (bridge.blocked || 0) +
            '　熔断 ' + (bridge.open ? '中' : '关') + '　连续失败 ' + (bridge.strikes || 0),
          ctx.paint('内核 ', 'bold') + 'QQ ' + (snap.qqVersion || '?') + '　桥版本 ' + (snap.bridgeVersion || '?') +
            '　方法实现 Satori ' + ((snap.satori && snap.satori.implemented) || 0) + '/' + ((snap.satori && snap.satori.known) || 0) +
            '　OneBot ' + ((snap.onebot && snap.onebot.implemented) || 0) + '/' + ((snap.onebot && snap.onebot.known) || 0)
        ];
      }
    },
    {
      name: 'log',
      group: '实时',
      usage: 'log [qq|ep] [行数]',
      desc: '看日志文件的最后几行（不只看这个窗口打出来的）',
      detail: 'qq 是无头内核的 app.log，ep 是协议端的 endpoint.log。两个文件都是 append 的，\n所以这里能看到这个窗口开始之前的历史。',
      complete: (index, { token }) => (index === 1 ? ['qq', 'ep'].filter((v) => v.startsWith(token || '')) : ['12', '40', '120']),
      run: ({ args }) => {
        const which = String(args[0] || 'both').toLowerCase();
        const count = Number(args[1]) || Number(which) || 12;
        const lines = [];
        const wanted = which === 'qq' ? [['qq', ctx.appLog]]
          : which === 'ep' ? [['ep', ctx.endpointLog]]
            : [['qq', ctx.appLog], ['ep', ctx.endpointLog]];
        for (const [label, file] of wanted) {
          lines.push(ctx.paint('--- ' + label + ' ' + file + ' ---', 'magenta'));
          for (const line of readTail(file, count)) lines.push('[' + label + '] ' + line);
        }
        return lines;
      }
    },
    {
      name: 'tail',
      group: '实时',
      usage: 'tail [on|off]',
      desc: '要不要把日志实时打到这个控制台（默认开）',
      complete: (index, { token }) => (index === 1 ? ['on', 'off'].filter((v) => v.startsWith(token || '')) : []),
      run: ({ args }) => {
        const value = String(args[0] || 'on').toLowerCase();
        if (value !== 'on' && value !== 'off') return ctx.paint('用法：tail on|off', 'red');
        state.tail = value === 'on';
        ctx.setTail(state.tail);
        return ctx.paint('实时日志已' + (state.tail ? '打开' : '关掉') + '（log 命令仍然可以翻文件）', 'grey');
      }
    },
    {
      name: 'self',
      group: 'QQ 数据',
      usage: 'self',
      desc: '当前登录的账号（走协议端，不是本地缓存）',
      run: async () => {
        const snap = await snapshot(true);
        const self = snap.self || {};
        if (!self.uin) return ctx.paint('协议端还没有 self：桥没连上或还没登录', 'yellow');
        return ctx.paint('self ', 'bold') + self.uin + '　uid=' + (self.uid || '?') + '　昵称 ' + (self.nick || '') +
          (snap.offline ? ctx.paint('　已下线（被踢）', 'red') : ctx.paint('　在线', 'green'));
      }
    },
    {
      name: 'friends',
      aliases: ['buddies'],
      group: 'QQ 数据',
      usage: 'friends [名字过滤]',
      desc: '好友列表（顺便给 say 的 Tab 补全喂数据）',
      run: async ({ args }) => {
        const payload = remember(await api({ pathname: '/api/chats' }));
        const filter = String(args.join(' ') || '').toLowerCase();
        const list = (payload.friends || []).filter((friend) =>
          !filter || (friend.display || '').toLowerCase().includes(filter) || String(friend.uin).includes(filter));
        if (!list.length) return ctx.paint('没有匹配的好友（共 ' + (payload.friends || []).length + ' 个）', 'yellow');
        const lines = [ctx.paint('好友 ' + list.length + ' / ' + (payload.friends || []).length + '　' +
          '（self ' + ((payload.self && payload.self.uin) || '?') + '）', 'bold')];
        for (const friend of list.slice(0, 40)) {
          lines.push('  ' + ctx.paint(String(friend.uin).padStart(11), 'cyan') + '  ' + (friend.display || '') +
            (friend.provisional ? ctx.paint('  临时', 'grey') : ''));
        }
        if (list.length > 40) lines.push(ctx.paint('  …还有 ' + (list.length - 40) + ' 个，用 friends <过滤> 收窄', 'grey'));
        return lines;
      }
    },
    {
      name: 'groups',
      aliases: ['guilds'],
      group: 'QQ 数据',
      usage: 'groups [名字过滤]',
      desc: '群列表',
      run: async ({ args }) => {
        const payload = remember(await api({ pathname: '/api/chats' }));
        const filter = String(args.join(' ') || '').toLowerCase();
        const list = (payload.groups || []).filter((group) =>
          !filter || (group.name || '').toLowerCase().includes(filter) || String(group.id).includes(filter));
        if (!list.length) return ctx.paint('没有匹配的群（共 ' + (payload.groups || []).length + ' 个）', 'yellow');
        const lines = [ctx.paint('群 ' + list.length + ' / ' + (payload.groups || []).length, 'bold')];
        for (const group of list.slice(0, 40)) {
          lines.push('  ' + ctx.paint(String(group.id).padStart(12), 'cyan') + '  ' + (group.name || '') +
            '  ' + ctx.paint('成员 ' + (group.member_count || '?'), 'grey'));
        }
        return lines;
      }
    },
    {
      name: 'members',
      group: 'QQ 数据',
      usage: MEMBERS_USAGE,
      desc: '某个群的成员表',
      complete: groupList,
      run: async ({ args }) => {
        const group = String(args[0] || '').replace(/^g[:：]/i, '');
        if (!group) return ctx.paint('用法：members <群号>', 'red');
        const payload = await api({
          pathname: '/api/conversation?channel=' + encodeURIComponent(group) + '&limit=1'
        });
        const members = payload.members || [];
        const cache = new Map();
        for (const member of members) {
          if (member.uin) cache.set(String(member.uin), member.card || member.nick || member.uin);
        }
        peers.members.set(group, cache);
        if (!members.length) return ctx.paint('群 ' + group + ' 没有成员数据（可能不是群号，或内核还没拉到）', 'yellow');
        const lines = [ctx.paint('群 ' + group + '　' + (payload.name || '') + '　成员 ' + members.length, 'bold')];
        for (const member of members.slice(0, 60)) {
          lines.push('  ' + ctx.paint(String(member.uin || '').padStart(11), 'cyan') + '  ' +
            (member.nick || '') + (member.card ? ctx.paint('（' + member.card + '）', 'grey') : '') +
            (member.role ? ctx.paint(' ' + member.role, 'magenta') : ''));
        }
        if (members.length > 60) lines.push(ctx.paint('  …还有 ' + (members.length - 60) + ' 人', 'grey'));
        return lines;
      }
    },
    {
      name: 'chats',
      group: 'QQ 数据',
      usage: 'chats',
      desc: '这个端点见过的会话（内存里的，不是 QQ 的数据库）',
      run: async () => {
        const payload = remember(await api({ pathname: '/api/chats' }));
        const chats = payload.chats || [];
        if (!chats.length) return ctx.paint('还没有会话：协议端刚起来，内存里没消息。收一条或发一条就有了。', 'grey');
        const lines = [ctx.paint('会话 ' + chats.length + '（协议端内存缓存，重启即空）', 'bold')];
        for (const chat of chats.slice(0, 20)) {
          lines.push('  ' + ctx.paint((chat.channel || '').padEnd(14), 'cyan') +
            ctx.paint(chat.kind === 'group' ? '群 ' : '私 ', 'magenta') +
            ctx.paint(String(chat.name || '').padEnd(16), 'white') +
            ctx.paint('未读 ' + chat.unread + '　共 ' + chat.count + ' 条', 'grey') +
            (chat.last ? '　' + String(chat.last.raw || '').slice(0, 40) : ''));
        }
        return lines;
      }
    },
    {
      name: 'history',
      aliases: ['last'],
      group: 'QQ 数据',
      usage: 'history <号或g:群号> [条数]',
      desc: '某个会话最近的消息（带 message_id，方便 recall）',
      complete: targetList,
      run: async ({ args }) => {
        const target = describeTarget(args[0] || '');
        if (!target.channel) return ctx.paint('用法：history <QQ号|g:群号> [条数]', 'red');
        const limit = Number(args[1]) || 10;
        const payload = await api({
          pathname: '/api/conversation?channel=' + encodeURIComponent(target.channel) + '&limit=' + limit
        });
        const messages = payload.messages || [];
        const lines = [ctx.paint((payload.name || target.channel) + '　' + payload.kind + '　最近 ' + messages.length + ' 条', 'bold')];
        if (!messages.length) lines.push(ctx.paint('  这个会话在协议端内存里没有消息（只缓存它见过的，不读 QQ 的库）', 'grey'));
        for (const message of messages) {
          const sender = message.sender || {};
          const who = sender.remark || sender.card || sender.nick || sender.uin || '?';
          lines.push('  ' + ctx.paint(new Date((message.time || 0) * 1000).toTimeString().slice(0, 8), 'grey') +
            ' ' + ctx.paint((message.mine ? '我说 ' : who).slice(0, 16), message.mine ? 'green' : 'cyan') + '：' +
            String(message.raw || '').replace(/\s+/g, ' ').slice(0, 120) +
            (message.deleted ? ctx.paint('  已撤回', 'red') : '') +
            (message.synthetic ? ctx.paint('  合成', 'grey') : ''));
          if (message.id) lines.push('    ' + ctx.paint('id=' + message.id, 'grey'));
        }
        return lines;
      }
    },
    {
      name: 'say',
      aliases: ['msg', 'send'],
      group: '发消息',
      usage: 'say <QQ号|g:群号> <文字…>',
      desc: '真的发一条消息出去',
      detail: '数字按好友处理，g: 前缀强制当群；两边都叫得出号时内核按群列表判定。\n受 writes 开关、版本闸和桥的写预算三道限制。',
      complete: targetList,
      run: needLive(async ({ args }) => {
        if (!gate.writes) return ctx.paint('writes 现在是关的：这个控制台只做只读。要发就先 writes on', 'red');
        const target = describeTarget(args[0] || '');
        const text = args.slice(1).join(' ').trim();
        if (!target.channel || !text) return ctx.paint('用法：say <QQ号|g:群号> <文字>', 'red');
        const result = await api({
          pathname: '/api/chat/send',
          method: 'POST',
          timeout: 40000,
          body: { allow_write: true, channel: target.channel, text }
        });
        const data = (result && result.data) || result || {};
        return ctx.paint('已发送 ', 'green') + '→ ' + target.channel + '　message_id=' + (data.message_id || '?') +
          (data.real ? '　real=' + data.real : '') + (data.confirmed === false ? ctx.paint('　内核还没确认', 'yellow') : '');
      })
    },
    {
      name: 'recall',
      group: '发消息',
      usage: 'recall <号或g:群号> <message_id>',
      desc: '撤回一条消息',
      complete: (index, { tokens, token }) => (index === 1 ? targetList(1, token) : []),
      run: needLive(async ({ args }) => {
        if (!gate.writes) return ctx.paint('writes 现在是关的，撤回也算写操作。要撤就 writes on', 'red');
        const target = describeTarget(args[0] || '');
        const id = String(args[1] || '');
        if (!target.channel || !id) return ctx.paint('用法：recall <号|g:群号> <message_id>（id 用 history 拿）', 'red');
        await api({
          pathname: '/api/chat/recall',
          method: 'POST',
          body: { allow_write: true, channel: target.channel, message_id: id }
        });
        return ctx.paint('已撤回 ', 'green') + target.channel + ' 的 message_id=' + id;
      })
    },
    {
      name: 'emit',
      group: '发消息',
      usage: 'emit <QQ号|g:群号> <文字>',
      desc: '造一条“收到的消息”喂进事件流（不经过 QQ 服务器）',
      detail: '桥的 emit_test：框架那边会收到完整的 message-created。它自己不发消息，但如果你的 bot\n自动回复，那一条是真的发出去——所以它也归 writes 管。',
      complete: (index, { token }) => (index === 1 ? [...peers.friends.keys(), ...peers.groups.keys()].filter((v) => !token || String(v).startsWith(token)) : []),
      run: needLive(async ({ args }) => {
        if (!gate.writes) return ctx.paint('writes 现在是关的：合成事件可能触发框架真回复。要造就 writes on', 'red');
        const target = describeTarget(args[0] || '');
        const text = args.slice(1).join(' ').trim();
        if (!target.channel || !text) return ctx.paint('用法：emit <QQ号|群号> <文字>', 'red');
        const body = { text };
        if (/^g[:：]/i.test(args[0])) body.group_id = target.channel;
        else body.uin = target.channel;
        const result = await api({
          pathname: '/api/emit-test',
          method: 'POST',
          body
        });
        return ctx.paint('已合成 ', 'green') + JSON.stringify(result && result.data ? result.data : result).slice(0, 200);
      })
    },
    {
      name: 'writes',
      group: '发消息',
      usage: 'writes [on|off]',
      desc: '这个控制台的写操作总开关（默认开）',
      detail: '关掉以后 say/recall/emit 直接在这个窗口被拒，不碰协议端；协议端自己的版本闸、写预算和\nallow_write 仍然是独立的另外几道。',
      complete: (index, { token }) => (index === 1 ? ['on', 'off'].filter((v) => v.startsWith(token || '')) : []),
      run: ({ args }) => {
        const value = String(args[0] || (gate.writes ? 'on' : 'off')).toLowerCase();
        if (value !== 'on' && value !== 'off') return ctx.paint('用法：writes on|off', 'red');
        gate.writes = value === 'on';
        return ctx.paint('控制台写操作已' + (gate.writes ? '打开' : '关闭'), gate.writes ? 'yellow' : 'green');
      }
    },
    {
      name: 'qr',
      group: '运维',
      usage: 'qr',
      desc: '把现在缓存的登录二维码重新画在这里',
      run: () => {
        ctx.printQr();
        return null;
      }
    },
    {
      name: 'restart',
      group: '运维',
      usage: 'restart endpoint',
      desc: '重启协议端（QQ 和桥不动）',
      detail: '协议端进程被换掉后桥会自动重连，generation 会 +1；失败次数按退避策略限制（5 次/5 分钟）。',
      complete: (index, { token }) => (index === 1 ? ['endpoint'].filter((v) => v.startsWith(token || '')) : []),
      run: ({ args }) => {
        if (String(args[0] || '').toLowerCase() !== 'endpoint') {
          return ctx.paint('现在只有 restart endpoint（QQ 本身要重启请 stop 再起）', 'red');
        }
        ctx.requestEndpointRestart('控制台 restart endpoint');
        return ctx.paint('已请求重启协议端：看下面的 [ep] 行', 'grey');
      }
    },
    {
      name: 'ports',
      group: '运维',
      usage: 'ports',
      desc: '所有本地端口与令牌（只回环）',
      run: () => [ctx.paint('端口 ', 'bold') + ctx.portLine(), ctx.paint('全部只绑 127.0.0.1；桥端口 ' + ctx.bridgePort + ' 还需要本地令牌', 'grey')].concat(
        ctx.token ? [ctx.paint('Satori/OneBot 令牌：' + ctx.token + '（Authorization: Bearer）', 'grey')] : []
      )
    },
    {
      name: 'config',
      group: '运维',
      usage: 'config',
      desc: '网络配置页：WS 正反向 / HTTP / Satori（默认不启动，保存后热应用）',
      detail: '这个命令只读，真正的修改在页面里做（页面右下角要打开「允许修改」）。\n' +
        '配置写进 <profile>/network.json，重启实例后仍然生效；页面保存会立即改变监听端口。',
      run: async () => {
        if (!ctx.uiPort) {
          return ctx.paint('这个实例没开调试页（--ui-port 0），配置页打不开；直接编辑 ' +
            path.join(ctx.profile, 'network.json'), 'red');
        }
        const lines = [];
        lines.push(ctx.paint('配置页 ', 'bold') + 'http://127.0.0.1:' + ctx.uiPort + '/config');
        lines.push(ctx.paint('配置文件 ', 'bold') + path.join(ctx.profile, 'network.json'));
        let view = null;
        try {
          view = await api({ pathname: '/api/network-config' });
        } catch (error) {
          lines.push(ctx.paint('读取失败：' + error.message, 'yellow'));
          return lines;
        }
        const satori = view.status && view.status.satori;
        lines.push(ctx.paint('Satori ', 'bold') + (satori
          ? '已监听 ' + (satori.bound ? satori.bound.host + ':' + satori.bound.port : '?') +
            '　' + satori.clients + ' 个客户端'
          : (view.config.satori.enable ? '启用中（还没绑定）' : '未启用')));
        const networks = (view.config.onebot && view.config.onebot.networks) || [];
        if (!view.config.onebot || !view.config.onebot.enable) {
          lines.push(ctx.paint('OneBot ', 'bold') + '未启用');
        } else if (!networks.length) {
          lines.push(ctx.paint('OneBot ', 'bold') + '没有网络：去配置页新增一个');
        } else {
          const live = new Map(((view.status && view.status.onebot) || []).map((item) => [item.name, item]));
          lines.push(ctx.paint('OneBot ', 'bold') + networks.length + ' 个网络');
          for (const net of networks) {
            const status = live.get(net.name);
            const state = status ? status.status : (net.enable ? '未应用' : 'disabled');
            const where = net.url || ((net.host || '') + ':' + (net.port || ''));
            lines.push('　' + (net.enable ? '●' : '○') + ' ' + net.name + '  [' + net.type + ']  ' +
              state + '  ' + where);
          }
        }
        return lines;
      }
    },
    {
      name: 'stop',
      aliases: ['end', 'shutdown'],
      group: '运维',
      usage: 'stop',
      desc: '收掉整套：协议端，再无头 QQ（和关掉这个窗口、Ctrl+C 两次同一件事）',
      run: () => {
        // Print first: stopEverything ends the process, and the last words in a
        // server console should say why the window went quiet.
        ctx.log(ctx.paint('正在收掉整套（协议端 → QQ）…', 'yellow'));
        setTimeout(() => ctx.stopEverything('控制台 stop'), 30);
        return null;
      }
    }
  ];

  return { commands, gate, peers, statusLine, state, describeTarget, formatDuration };
}

const MEMBERS_USAGE = 'members <群号>';
module.exports = { createInstanceConsole, apiRequest, formatDuration, formatBytes, describeTarget };
