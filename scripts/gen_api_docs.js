'use strict';

// Generates the Apifox-importable API docs under docs/api/.
//
//   node scripts/gen_api_docs.js
//
// The tables below are the single source of truth for the written docs, but the
// script refuses to emit anything if they disagree with the code: every action
// in the OneBot action map and every name in UNIMPLEMENTED / REFUSED must have
// exactly one entry, and the Satori side is checked against KNOWN_METHODS and
// createHandlers().features. That is what keeps "done" from silently rotting.
//
// Status vocabulary:
//   ok       - the handler does real work (some can still refuse at runtime for
//              a documented build/permission reason, e.g. get_group_notice)
//   refused  - answering is deliberate: retcode 1400 / HTTP 501 with a reason

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'api');
const GENERATED = '由 scripts/gen_api_docs.js 生成；改接口先改脚本里的表，再重新生成。';

// ---------------------------------------------------------------------------
// OneBot v11 tables
// ---------------------------------------------------------------------------

const P = (name, type, required, desc, ex) => ({ name, type, required, desc, ex });
const A = (name, group, title, params, data, note, sample) => ({
  name, group, title, status: 'ok', params, data, note, sample
});
const NO = (name, group, title, reason, params = []) => ({
  name, group, title, status: 'refused', reason, params
});

const OB_ACTIONS = [
  // -- meta ---------------------------------------------------------------
  A('get_status', '元信息', '运行状态', [],
    { online: true, good: true, checker: true, app_initialized: true }),
  A('get_version_info', '元信息', '实现信息', [],
    { ver: '1.0.0', implement: 'qqproto', product: 'qq-hook-poc', version: '1.0.0', protocol: 11, official_url: 'local' }),
  A('get_login_info', '元信息', '当前账号', [],
    { user_id: 10000001, nickname: '测试账号', uid: 'u_test_self' }),
  A('can_send_msg', '元信息', '能否发消息', [],
    { can_send: true, reason: '', status: 'available' }),
  A('can_send_image', '元信息', '能否发图片', [],
    { can_send: true, reason: '', status: 'available', detail: 'image sends take a local file path' },
    '图片只接受本机已存在的文件路径（或收图事件里的 path），url / base64 会被拒绝。'),
  A('can_send_record', '元信息', '能否发语音', [],
    { can_send: false, reason: 'voice upload is not implemented by this endpoint', status: 'unavailable' },
    '语音上传没做，这个查询会如实回答不可用。'),
  A('can_get_http_file', '元信息', '能否下载文件', [],
    { can_get: false, reason: 'file download is not implemented by this endpoint', status: 'unavailable' },
    '本协议端不做媒体下载。'),
  A('can_handle_url_unsafe_tags', '元信息', '是否处理 url 危险标签', [],
    { can_handle: false, reason: 'not implemented by this endpoint', status: 'unavailable' }),

  // -- contacts -----------------------------------------------------------
  A('get_friend_list', '联系人', '好友列表', [P('force', 'boolean', false, '绕过缓存强制刷新（NapCat 的 refresh）')],
    [{ user_id: 10000002, uid: 'u_xxx', nickname: '测试好友', remark: '测试好友', displayname: '测试好友', sex: 0, age: 0, level: 0, category_id: 0, join_time: 0, group_id: 0, avatar: 'https://q1.qlogo.cn/g?b=qq&nk=10000002&s=640' }]),
  A('get_group_list', '联系人', '群列表', [P('force', 'boolean', false, '绕过缓存强制刷新')],
    [{ group_id: 123456789, group_code: '123456789', group_name: '测试群', remark: '', member_count: 42, max_member_count: 500, active_member_count: 0, type: '', info: '' }]),
  A('get_group_info', '联系人', '群信息', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('force', 'boolean', false, '绕过缓存强制刷新')
  ], { group_id: 123456789, group_code: '123456789', group_name: '测试群', remark: '', member_count: 42, max_member_count: 500, active_member_count: 0, type: '', info: '' }),
  A('get_group_member_list', '联系人', '群成员列表', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('force', 'boolean', false, '绕过缓存强制刷新')
  ], [
    { group_id: 123456789, user_id: 10000002, uid: 'u_xxx', nickname: '测试好友', card: '测试好友', remark: '', sex: 0, age: 0, area: '', level: '1', qq_level: 0, join_time: 1700000000, last_sent_time: 1790000000, title_expire_time: 0, unfriendly: false, card_changeable: true, is_robot: false, shut_up_timestamp: 0, shut_up_remaining: 0, role: 'member', title: '' }
  ]),
  A('get_group_member_info', '联系人', '单个群成员', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('user_id', 'integer', true, 'QQ 号', 10000002),
    P('force', 'boolean', false, '跳过缓存重新拉成员列表')
  ], { group_id: 123456789, user_id: 10000002, nickname: '测试好友', card: '', role: 'member', join_time: 1700000000, shut_up_timestamp: 0 }),
  A('get_stranger_info', '联系人', '陌生人资料', [P('user_id', 'integer', true, 'QQ 号', 10000002)],
    { user_id: 10000002, uid: 'u_xxx', nickname: '测试好友', remark: '测试好友', sex: 0, age: 0, level: 0, login_days: 0, avatar: 'https://q1.qlogo.cn/g?b=qq&nk=10000002&s=640' }),
  A('get_user_info', '联系人', '用户资料（get_stranger_info 别名）', [P('user_id', 'integer', true, 'QQ 号', 10000002)]),
  A('get_buddy_list', '联系人', '好友列表（get_friend_list 别名）', [P('force', 'boolean', false, '绕过缓存强制刷新')]),
  A('set_friend_remark', '联系人', '设置好友备注', [
    P('user_id', 'integer', true, 'QQ 号', 10000002),
    P('remark', 'string', false, '新备注；留空即清除', '')
  ], {}, '写操作，真机验过。'),
  A('delete_friend', '联系人', '删除好友', [
    P('user_id', 'integer', true, 'QQ 号', 10000002),
    P('block', 'boolean', false, '同时拉黑，默认 false'),
    P('delete_both', 'boolean', false, '双向删除，默认 true')
  ], {}, '危险写操作，HANDBOOK 里列为只能手动触发。'),
  NO('get_stranger_list', '联系人', '陌生人列表', 'QQNT 内核没有对应的陌生人列表调用。'),
  NO('get_recent_groups', '联系人', '最近群组', 'QQNT 内核没有对应的最近群组调用。'),
  NO('get_friend_profiles', '联系人', '好友资料批量', 'QQNT 内核没有对应的批量资料调用。'),

  // -- messaging ----------------------------------------------------------
  A('send_private_msg', '消息', '发送私聊消息', [
    P('user_id', 'integer', true, '对方 QQ 号', 10000002),
    P('message', 'message', true, '消息内容：段数组或 CQ 码字符串', [{ type: 'text', data: { text: 'hello' } }]),
    P('auto_escape', 'boolean', false, 'message 是字符串时按纯文本处理，不解析 CQ 码')
  ], { message_id: 1234, real_id: '7701602212777096975', time: 1793169000 },
    '发送只支持 text / at / image（本机路径）；record、video、file、reply、face 等会在到达内核前被拒（retcode 1400）。', { user_id: 10000002, message: 'hello' }),
  A('send_group_msg', '消息', '发送群消息', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('message', 'message', true, '消息内容：段数组或 CQ 码字符串', [{ type: 'text', data: { text: 'hello' } }]),
    P('auto_escape', 'boolean', false, 'message 是字符串时按纯文本处理')
  ], { message_id: 1235, real_id: '7701602212777096976', time: 1793169001 },
    '发送只支持 text / at / image（本机路径）。', { group_id: 123456789, message: 'hello' }),
  A('send_msg', '消息', '发送消息（自动判断私聊/群）', [
    P('message_type', 'string', false, 'private | group；省略时按有没有 group_id 判断'),
    P('user_id', 'integer', false, '私聊对象，message_type=private 时必填', 10000002),
    P('group_id', 'integer', false, '群号，message_type=group 时必填', 123456789),
    P('message', 'message', true, '消息内容', [{ type: 'text', data: { text: 'hello' } }]),
    P('auto_escape', 'boolean', false, 'message 是字符串时按纯文本处理')
  ], { message_id: 1236, real_id: '7701602212777096977', time: 1793169002 },
    '发送只支持 text / at / image（本机路径）。'),
  A('get_msg', '消息', '按 message_id 取消息', [P('message_id', 'integer', true, '数字 id（本端映射表）或原生 64 位 msgId', 1234)],
    { post_type: 'message', message_type: 'private', sub_type: 'friend', time: 1793169000, self_id: 10000001, user_id: 10000002, target_id: 10000002, message: [{ type: 'text', data: { text: 'hello' } }], raw_message: 'hello', font: 0, sender: { user_id: 10000002, nickname: '测试好友', card: '' }, message_id: 1234, real_id: '7701602212777096975' },
    '只能取本进程启动后见过的消息（内存缓存），不读 QQ 数据库。'),
  A('get_group_msg_history', '消息', '群历史（缓存）', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('count', 'integer', false, '条数，默认 20，上限 100'),
    P('message_seq', 'integer', false, '兼容字段，当前忽略')
  ], { messages: [] }, '只来自内存缓存，重启即空；不向 QQ 翻页。'),
  A('get_friend_msg_history', '消息', '私聊历史（缓存）', [
    P('user_id', 'integer', true, 'QQ 号', 10000002),
    P('count', 'integer', false, '条数，默认 20，上限 100')
  ], { messages: [] }, '只来自内存缓存，重启即空。'),
  A('delete_msg', '消息', '撤回消息', [P('message_id', 'integer', true, '数字 id 或原生 msgId', 1234)],
    null, '可撤回自己发的；别人的消息能否撤回由 QQ 权限决定。'),
  A('set_msg_read', '消息', '标记已读（按消息）', [P('message_id', 'integer', true, '消息 id', 1234)], {},
    '失败不报错，避免打断机器人循环。'),
  A('mark_msg_as_read', '消息', '标记已读（消息/群/好友）', [
    P('message_id', 'integer', false, '消息 id'),
    P('group_id', 'integer', false, '群号'),
    P('user_id', 'integer', false, 'QQ 号')
  ], {}, '三者给一个即可。'),
  A('mark_group_msg_as_read', '消息', '标记群消息已读', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('user_id', 'integer', false, '可选会话 id')
  ], {}),
  A('set_msg_reaction', '消息', '给消息贴表情回应', [
    P('message_id', 'integer', true, '消息 id', 1234),
    P('emoji_id', 'string', true, '表情 id（或 key/name）', '76'),
    P('emoji_type', 'string', false, '表情类型'),
    P('sequence', 'string', false, '内核 sequence；省略时从缓存找')
  ], {},
    'QQ 每条消息每个账号只保留一个表情回应：设置会覆盖之前的，撤销只撤销这个账号的。message_id 必须指向本进程见过的消息。'),
  A('del_msg_reaction', '消息', '撤销表情回应', [
    P('message_id', 'integer', true, '消息 id', 1234),
    P('emoji_id', 'string', true, '表情 id', '76')
  ], {}, '与 set_msg_reaction 同一限制。'),
  A('set_essence_msg', '消息', '设为群精华', [
    P('message_id', 'integer', true, '消息 id', 1234),
    P('group_id', 'integer', false, '群号'),
    P('sequence', 'string', false, '内核 sequence'),
    P('random', 'string', false, '内核 random')
  ], {}),
  A('unset_essence_msg', '消息', '取消群精华', [
    P('message_id', 'integer', true, '消息 id', 1234),
    P('group_id', 'integer', false, '群号'),
    P('sequence', 'string', false, '内核 sequence'),
    P('random', 'string', false, '内核 random')
  ], {}),
  A('send_group_forward_msg', '消息', '发送群合并转发', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('message_id', 'integer', false, '要转发的消息 id（与 messages 二选一）'),
    P('messages', 'array', false, '节点数组，item.message_id 指向本端见过的消息')
  ], { message_id: 1237, real_id: '7701602212777096978', forwarded: ['7701602212777096975'] },
    '转发由 QQ 内核复制原消息，不是本端重建节点；node 内容列表不支持。'),
  A('send_private_forward_msg', '消息', '发送私聊合并转发', [
    P('user_id', 'integer', true, 'QQ 号', 10000002),
    P('message_id', 'integer', false, '要转发的消息 id'),
    P('messages', 'array', false, '节点数组')
  ], { message_id: 1238, real_id: '7701602212777096979', forwarded: ['7701602212777096975'] }),
  A('translate_enzh', '消息', '英译中', [
    P('text', 'string', false, '原文（或 word）', 'hello'),
    P('words', 'array', false, '批量词条')
  ], { original: 'hello', translated: '你好', words: [{ source: 'hello', target: '你好' }] }),
  A('ocr_image', '消息', '图片 OCR', [P('image', 'string', false, '本机图片路径（或 file/url）', 'D:/pic/a.png')],
    {}, '走内核 OCR，真机需自行确认该 build 的返回。'),
  A('image_ocr', '消息', '图片 OCR（ocr_image 别名）', [P('image', 'string', false, '本机图片路径', 'D:/pic/a.png')]),
  NO('get_forward_msg', '消息', '读取合并转发', '需要读本地消息数据库，本项目明确不读库。'),
  NO('get_forward_msg_single', '消息', '读取单条转发', '需要读本地消息数据库，本项目明确不读库。'),
  NO('get_essence_msg_list', '消息', '群精华列表', '内核读不到精华列表（promise 不落地），只能走 qun.qq.com web api；设置/取消精华可用。'),
  NO('get_group_essence', '消息', '群精华列表（别名）', '同 get_essence_msg_list：列表读不到，设置/取消可用。'),
  NO('get_collection_list', '消息', '收藏列表', '需要读本地消息数据库，本项目明确不读库。'),
  NO('get_message_like', '消息', '消息点赞列表', '需要 OIDB 包，内核没有对应调用。'),
  NO('get_ocr_languages', '消息', 'OCR 语言列表', 'QQNT 内核没有对应调用。'),
  NO('query_ocr', '消息', 'OCR 查询', 'QQNT 内核没有对应调用。'),
  NO('friend_poke', '消息', '戳好友', 'QQNT 内核没有对应调用。'),
  NO('group_poke', '消息', '戳群成员', 'QQNT 内核没有对应调用。'),
  NO('poke', '消息', '戳一戳', 'QQNT 内核没有对应调用。'),
  NO('send_dms_msg', '消息', '私信频道消息', 'QQNT 内核没有对应调用。'),
  NO('send_gms_msg', '消息', '群频道消息', 'QQNT 内核没有对应调用。'),
  NO('push_msg', '消息', '主动推送', 'QQNT 内核没有对应调用。'),

  // -- group administration ------------------------------------------------
  A('set_group_name', '群管理', '改群名', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('group_name', 'string', true, '新群名', '新群名')
  ], {}),
  A('set_group_remark', '群管理', '设备注（群备注）', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('remark', 'string', false, '新备注', '')
  ], {}),
  A('set_group_card', '群管理', '改群名片', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('user_id', 'integer', true, 'QQ 号', 10000002),
    P('card', 'string', false, '新名片', '')
  ], {}),
  A('set_group_special_title', '群管理', '设专属头衔', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('user_id', 'integer', true, 'QQ 号', 10000002),
    P('special_title', 'string', false, '头衔（或 title）', ''),
    P('duration', 'integer', false, '有效期秒数')
  ], {}),
  A('set_group_role', '群管理', '设群角色', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('user_id', 'integer', true, 'QQ 号', 10000002),
    P('role', 'string', true, 'admin | member；owner 会明确拒绝', 'admin')
  ], {}, '转让群主不支持（retcode 1400）。'),
  A('set_group_admin', '群管理', '设/取消管理员', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('user_id', 'integer', true, 'QQ 号', 10000002),
    P('enable', 'boolean', false, 'true 设管理员，false 取消，默认 true')
  ], {}),
  A('set_group_kick', '群管理', '踢人', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('user_id', 'integer', true, 'QQ 号', 10000002),
    P('reason', 'string', false, '理由'),
    P('reject_add_request', 'boolean', false, '同时拒绝再次加群，默认 false')
  ], {}, '危险写操作。'),
  A('set_group_ban', '群管理', '禁言', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('user_id', 'integer', true, 'QQ 号', 10000002),
    P('duration', 'integer', false, '秒数，默认 1200；0 解除禁言')
  ], {}, 'duration=0 即解禁。'),
  A('set_group_whole_ban', '群管理', '全员禁言', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('enable', 'boolean', false, 'true 开启，false 关闭，默认 true')
  ], {}),
  A('set_group_leave', '群管理', '退群/解散', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('is_dismiss', 'boolean', false, 'true 解散（仅群主），默认 false 退群')
  ], {}, '危险写操作；解散要求群主。'),
  A('get_group_at_all_remain', '群管理', '@全体剩余次数', [P('group_id', 'integer', true, '群号', 123456789)],
    { can_at_all: true, remain_at_all_count_for_group: 10, remain_at_all_count_for_uin: 5 }),
  A('get_group_banned_list', '群管理', '禁言列表（别名）', [P('group_id', 'integer', true, '群号', 123456789)],
    { members: [] }),
  A('get_group_shut_list', '群管理', '禁言列表', [P('group_id', 'integer', true, '群号', 123456789)],
    { members: [] }),
  A('get_group_detail_info', '群管理', '群详情', [P('group_id', 'integer', true, '群号', 123456789)], {}),
  A('get_group_level_info', '群管理', '群等级信息', [P('group_id', 'integer', true, '群号', 123456789)], {}),
  NO('create_group', '群管理', '建群', 'QQNT 内核没有建群调用；建群/退群在本项目里是手动操作。'),
  NO('create_discuss', '群管理', '建讨论组', 'QQNT 内核没有对应调用。'),
  NO('get_discussion', '群管理', '讨论组信息', 'QQNT 内核没有对应调用。'),
  NO('get_forum', '群管理', '论坛/频道', 'QQNT 内核没有对应调用。'),
  NO('get_group_honor_info', '群管理', '群荣誉', '需要 OIDB 包。'),
  NO('get_group_member_profile', '群管理', '群成员详细资料', '需要 OIDB 包。'),
  NO('send_group_sign', '群管理', '群签到', '需要 OIDB 包。'),
  NO('get_school_clockin', '群管理', '校园打卡', '需要 qun.qq.com web api 与账号 cookie。'),
  NO('get_banned_groups', '群管理', '被封群列表', '需要 qun.qq.com web api 与账号 cookie。'),
  NO('get_group_ignore_tip', '群管理', '群忽略提示', '需要 qun.qq.com web api 与账号 cookie。'),

  // -- requests & notices --------------------------------------------------
  A('get_group_system_msg', '请求与通知', '群通知/申请列表', [
    P('doubt', 'boolean', false, '是否读“可能认识”那一屏，默认 false'),
    P('count', 'integer', false, '条数，默认 50')
  ], {
    join_requests: [{ flag: 'seq-1', group_id: 123456789, user_id: 10000002, user_nick: '测试好友', comment: '申请理由', is_processed: false }],
    invited_requests: [], InvitedRequest: [], other_requests: []
  }, '只把 type 1/5/7 当申请；管理员变更（type 8）单独放 other_requests，不会让机器人误点同意。'),
  A('get_group_add_request', '请求与通知', '加群申请（别名）', [
    P('doubt', 'boolean', false, '是否读“可能认识”那一屏'),
    P('count', 'integer', false, '条数，默认 50')
  ]),
  A('set_group_add_request', '请求与通知', '处理加群申请', [
    P('flag', 'string', false, '申请 flag（也可用 seq/request_id/notice_id）', 'seq-1'),
    P('approve', 'boolean', false, 'true 同意，false 拒绝，默认 true'),
    P('reason', 'string', false, '拒绝理由'),
    P('doubt', 'boolean', false, '是否在“可能认识”屏'),
    P('type', 'string', false, "OneBot 的 'add'/'invite' 字符串；数值 type 才透传"),
    P('group_id', 'integer', false, '群号'),
    P('user_id', 'integer', false, '申请者 QQ')
  ], { handled: true, seq: 'seq-1', doubt: false, approve: true, result: 0 },
    '不给数值 type 时，桥会按 flag 回查申请列表，顺便确定它在哪一屏。'),
  A('get_friend_requests', '请求与通知', '好友申请列表', [P('only_incoming', 'boolean', false, '只看收到的，默认 true')],
    { unread: 0, requests: [{ flag: 'req-1', req_time: 'req-1', req_type: 1, user_id: 10000002, user_uid: 'u_xxx', user_nick: '测试好友', comment: '你好', unread: true }] }),
  A('set_friend_add_request', '请求与通知', '处理好友申请', [
    P('flag', 'string', false, '申请 flag（也可用 req_time/request_id/seq）', 'req-1'),
    P('approve', 'boolean', false, 'true 同意，默认 true'),
    P('remark', 'string', false, '同意后的备注'),
    P('user_uid', 'string', false, '申请者 uid')
  ], {}),
  A('mark_group_notify_as_read', '请求与通知', '群通知标已读', [
    P('doubt', 'boolean', false, '是否“可能认识”屏'),
    P('group_id', 'integer', false, '群号')
  ], {}),
  A('clear_friend_notice', '请求与通知', '清好友申请红点', [], {}),
  A('send_group_notice', '请求与通知', '发群公告', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('content', 'string', false, '正文（或 text）', '公告正文'),
    P('image', 'string', false, '公告图片（本机路径）'),
    P('pinned', 'boolean', false, '置顶（或 show_obvious）'),
    P('confirm_required', 'boolean', false, '需要群成员确认'),
    P('notice_id', 'string', false, '编辑已有公告时给 id')
  ], { notice_id: 'notice-1', group_id: 123456789 }),
  A('get_group_notice', '请求与通知', '读群公告', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('start_index', 'integer', false, '起始页'),
    P('count', 'integer', false, '条数'),
    P('arg_variant', 'string', false, 'base|swap|num|str-page|one，诊断参数布局用'),
    P('debug', 'boolean', false, '把内核原始推送写到 %TEMP%\\qqhook_proto.log')
  ], [{ notice_id: 'notice-1', group_id: 123456789, sender_id: 10000001, publish_time: 1790000000, pinned: false, text: { title: '', content: '公告正文' }, title: '', content: '公告正文' }],
    '注意：这个 QQ build 的 getGroupBulletinList 实测只回全默认空信封，所以经常以 retcode 1400 明确拒绝（不会假装“没有公告”）。发公告/删公告走内核，可用。'),
  A('set_group_announcement', '请求与通知', '发群公告（别名）', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('content', 'string', false, '正文')
  ]),
  A('del_group_notice', '请求与通知', '删群公告', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('notice_id', 'string', true, '公告 id', 'notice-1')
  ], {}),
  A('delete_group_notice', '请求与通知', '删群公告（别名）', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('notice_id', 'string', true, '公告 id', 'notice-1')
  ], {}),
  NO('get_online_clients', '请求与通知', '在线设备', '需要 qun.qq.com web api 与账号 cookie。'),
  NO('get_risk_tips_info', '请求与通知', '风控提示', '需要 qun.qq.com web api 与账号 cookie。'),
  NO('get_vip_info', '请求与通知', 'VIP 信息', '需要 OIDB 包。'),

  // -- group files ---------------------------------------------------------
  A('get_group_file_list', '群文件', '群文件列表', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('folder_id', 'string', false, '目录 id，默认 /'),
    P('start_index', 'integer', false, '起始位置'),
    P('file_count', 'integer', false, '条数，默认 50，上限 100（也认 count）'),
    P('sort_type', 'integer', false, '排序字段，默认 2'),
    P('sort_order', 'integer', false, '升/降序，默认 2')
  ], { group_id: 123456789, folder_id: '/', is_end: true, total: 1, next_index: 1, files: [{ file_id: 'file-1', file_name: 'a.txt', busid: 102, file_size: 12 }] }),
  A('get_group_file_count', '群文件', '群文件数量', [P('group_id', 'integer', true, '群号', 123456789)],
    { group_id: 123456789, count: 1 }),
  A('del_group_file', '群文件', '删群文件', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('file_id', 'string', true, '文件 id', 'file-1'),
    P('busid', 'integer', false, '取自 get_group_file_list')
  ], {}),
  A('create_group_file_folder', '群文件', '建群文件夹', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('folder_name', 'string', false, '文件夹名（或 name）', '新文件夹'),
    P('parent_id', 'string', false, '父目录 id')
  ], {}),
  A('delete_group_file_folder', '群文件', '删群文件夹', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('folder_id', 'string', false, '目录 id（或 id/name）', '/folder-1')
  ], {}),
  A('rename_group_file_folder', '群文件', '重命名群文件夹', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('folder_id', 'string', false, '目录 id（或 id）', '/folder-1'),
    P('folder_name', 'string', false, '新名字（或 name）', '改名后')
  ], {}),
  A('move_group_file', '群文件', '移动群文件', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('file_id', 'string', true, '文件 id', 'file-1'),
    P('busid', 'integer', false, '取自 get_group_file_list'),
    P('current_parent_directory', 'string', false, '原目录'),
    P('target_parent_directory', 'string', false, '目标目录（或 folder_id）', '/')
  ], {}),
  A('upload_group_file', '群文件', '上传群文件', [
    P('group_id', 'integer', true, '群号', 123456789),
    P('file', 'string', true, '本机文件路径', 'D:/files/a.txt'),
    P('name', 'string', false, '显示名'),
    P('folder', 'string', false, '目标目录 id（或 folder_id）', '/'),
    P('upload_file', 'boolean', false, '默认 true；false（只登记不上传）会被明确拒绝')
  ], { file_id: 'file-2', message_id: 1239, file_name: 'a.txt', file_size: 12 },
    '文件由 QQ 客户端自己上传（落进账号的媒体树再交 fileElement），不走 Highway；file 必须是本机已存在的路径。'),
  NO('upload_private_file', '群文件', '私聊发文件', '私聊文件路径还没有验证过；群文件上传可用。', [
    P('user_id', 'integer', true, 'QQ 号'),
    P('file', 'string', true, '本机文件路径'),
    P('name', 'string', false, '显示名')
  ]),
  NO('get_group_file_url', '群文件', '群文件下载链接', '需要 OIDB 包，内核没有对应调用。', [
    P('group_id', 'integer', true, '群号'),
    P('file_id', 'string', true, '文件 id'),
    P('busid', 'integer', false, 'busid')
  ]),

  // -- other ---------------------------------------------------------------
  A('send_like', '其它', '点赞', [
    P('user_id', 'integer', true, 'QQ 号', 10000002),
    P('times', 'integer', false, '次数，默认 1（也认 count）'),
    P('group_id', 'integer', false, '群号（群点赞入口）')
  ], {}, '有频控，短时间内重复会被 QQ 拒绝。'),
  NO('set_qq_avatar', '其它', '设置头像', '头像上传路径未验证。'),
  NO('fetch_cookie', '其它', '读取 cookie', '本协议端明确不读账号 cookie——这是设计边界，不是没做。')
];

// ---------------------------------------------------------------------------
// Satori tables
// ---------------------------------------------------------------------------

const S = (name, group, title, params, data, note, sample) => ({
  name, group, title, status: 'ok', params, data, note, sample
});
const SNO = (name, group, title, reason, params = []) => ({
  name, group, title, status: 'refused', reason, params
});

const S_METHODS = [
  S('login.get', '登录', '登录信息与能力表', [], {
    sn: 1, adapter: 'qq-hook', platform: 'qq', status: 1,
    features: ['login.get', 'user.get', 'friend.list', 'message.create', 'upload.create'],
    user: { id: '10000001', name: '测试账号', nick: '测试账号', avatar: 'https://q1.qlogo.cn/g?b=qq&nk=10000001&s=640' }
  }, '客户端一般先 GET /v1/login.get 验 token 与能力表。'),
  S('user.get', '登录', '取用户资料', [
    P('user_id', 'string', true, 'QQ 号或 uid', '10000002'),
    P('guild_id', 'string', false, '群号，便于在群成员缓存里找')
  ], { id: '10000002', name: '测试好友', nick: '测试好友', avatar: 'https://q1.qlogo.cn/g?b=qq&nk=10000002&s=640' }),
  S('friend.list', '好友', '好友列表', [P('next', 'string', false, '翻页游标')],
    { data: [{ user: { id: '10000002', name: '测试好友', nick: '测试好友' }, nick: '测试好友' }] }),
  S('friend.delete', '好友', '删除好友', [P('user_id', 'string', true, 'QQ 号', '10000002')], null,
    '危险写操作。'),
  S('friend.approve', '好友', '处理好友申请', [
    P('message_id', 'string', true, '申请的 flag', 'req-1'),
    P('approve', 'boolean', false, '默认 true'),
    P('comment', 'string', false, '拒绝理由')
  ], null),
  S('guild.list', '群组', '群列表', [P('next', 'string', false, '翻页游标')],
    { data: [{ id: '123456789', name: '测试群' }] }),
  S('guild.get', '群组', '群信息', [P('guild_id', 'string', true, '群号', '123456789')],
    { id: '123456789', name: '测试群' }),
  S('guild.approve', '群组', '处理加群申请', [
    P('message_id', 'string', true, '申请的 flag', 'seq-1'),
    P('approve', 'boolean', false, '默认 true'),
    P('comment', 'string', false, '拒绝理由')
  ], null),
  S('guild.member.approve', '群成员', '处理加群申请（成员维度）', [
    P('message_id', 'string', true, '申请的 flag', 'seq-1'),
    P('approve', 'boolean', false, '默认 true'),
    P('comment', 'string', false, '拒绝理由')
  ], null),
  S('guild.member.list', '群成员', '群成员列表', [
    P('guild_id', 'string', true, '群号', '123456789'),
    P('next', 'string', false, '翻页游标')
  ], { data: [{ user: { id: '10000002', name: '测试好友' }, name: '测试好友', nick: '测试好友', roles: [] }] }),
  S('guild.member.get', '群成员', '单个群成员', [
    P('guild_id', 'string', true, '群号', '123456789'),
    P('user_id', 'string', true, 'QQ 号或 uid', '10000002')
  ], { user: { id: '10000002', name: '测试好友' }, name: '测试好友', nick: '测试好友', roles: [{ id: 'member', name: 'member' }] }),
  S('guild.member.kick', '群成员', '踢人', [
    P('guild_id', 'string', true, '群号', '123456789'),
    P('user_id', 'string', true, 'QQ 号', '10000002'),
    P('permanent', 'boolean', false, '同时拒绝再次加群')
  ], null, '危险写操作。'),
  S('guild.member.mute', '群成员', '禁言', [
    P('guild_id', 'string', true, '群号', '123456789'),
    P('user_id', 'string', true, 'QQ 号', '10000002'),
    P('duration', 'integer', false, '秒数；0 解除禁言')
  ], null),
  S('guild.member.role.set', '群成员', '设管理员', [
    P('guild_id', 'string', true, '群号', '123456789'),
    P('user_id', 'string', true, 'QQ 号', '10000002'),
    P('role_id', 'string', true, '只接受 admin / 3；member 会被拒', 'admin')
  ], null, 'QQ 只有 owner/admin/member 三种角色。'),
  S('guild.member.role.unset', '群成员', '取消管理员', [
    P('guild_id', 'string', true, '群号', '123456789'),
    P('user_id', 'string', true, 'QQ 号', '10000002'),
    P('role_id', 'string', true, 'admin / member', 'admin')
  ], null),
  S('guild.member.role.list', '群成员', '成员角色', [
    P('guild_id', 'string', true, '群号', '123456789'),
    P('user_id', 'string', true, 'QQ 号', '10000002')
  ], { data: [{ id: 'member' }] }),
  S('guild.role.list', '群成员', '角色表', [P('guild_id', 'string', true, '群号', '123456789')],
    { data: [{ id: 'owner', name: '群主', color: 0 }, { id: 'admin', name: '管理员', color: 0 }, { id: 'member', name: '成员', color: 0 }] },
    'QQ 没有角色表，这是内置的三个固定角色。'),
  S('channel.get', '频道', '取频道', [
    P('channel_id', 'string', true, '群号或好友 QQ', '123456789'),
    P('guild_id', 'string', false, '群号')
  ], { id: '123456789', type: 0, name: '测试群' }),
  S('channel.list', '频道', '群内频道列表', [P('guild_id', 'string', true, '群号', '123456789')],
    { data: [{ id: '123456789', type: 0, name: '测试群' }] }, 'QQ 一个群只有一个文本频道。'),
  S('user.channel.create', '频道', '私聊频道', [P('user_id', 'string', true, 'QQ 号', '10000002')],
    { id: '10000002', type: 1 }),
  S('channel.update', '频道', '改群名', [
    P('channel_id', 'string', true, '群号', '123456789'),
    P('data', 'object', false, '至少给 data.name', { name: '新群名' })
  ], null),
  S('channel.mute', '频道', '全员禁言', [
    P('channel_id', 'string', false, '群号（也认 guild_id）', '123456789'),
    P('enable', 'boolean', false, 'true 开启'),
    P('duration', 'integer', false, 'NoneBot 适配器用 duration；0 表示解禁')
  ], null),
  S('message.create', '消息', '发送消息', [
    P('channel_id', 'string', true, '群号或好友 QQ', '123456789'),
    P('content', 'string', true, '消息内容（内层片段文本：纯文本原样，媒体/at 用标签）', 'help'),
    P('referrer', 'string', false, '引用消息 id（对象形式取 .id）')
  ], [{
    id: '7701602212777096975',
    channel: { id: '123456789', type: 0, name: '测试群' },
    guild: { id: '123456789', name: '测试群' },
    user: { id: '10000001', name: '测试账号' },
    content: 'ok',
    timestamp: 1793169000000
  }],
    '只支持 text / at / img（本机路径）/ emoji / quote；record、video、file 会回 501。content 就是 @satorijs/element 的 toString()：`<at id="123"/> hi`、`<img src="D:/a.png"/>`。'),
  S('message.get', '消息', '取消息', [
    P('channel_id', 'string', true, '会话 id', '123456789'),
    P('message_id', 'string', true, '消息 id', '7701602212777096975')
  ], { id: '7701602212777096975', channel: { id: '123456789', type: 0 }, user: { id: '10000002', name: '测试好友' }, content: 'hello', timestamp: 1793169000000, created_at: 1793169000000 },
    '只能取本进程启动后见过的消息。'),
  S('message.list', '消息', '会话消息（缓存）', [
    P('channel_id', 'string', true, '会话 id', '123456789'),
    P('limit', 'integer', false, '每页条数，默认 50，上限 200'),
    P('next', 'string', false, '翻页游标'),
    P('order', 'string', false, 'asc | desc'),
    P('direction', 'string', false, 'before | after，未给 order 时决定排序')
  ], { data: [{ id: '7701602212777096975', channel: { id: '123456789', type: 0 }, content: 'hello', timestamp: 1793169000000 }], next: '50' },
    '只来自内存缓存，重启即空。'),
  S('message.delete', '消息', '撤回消息', [
    P('channel_id', 'string', true, '会话 id', '123456789'),
    P('message_id', 'string', true, '消息 id', '7701602212777096975')
  ], null),
  S('reaction.create', '互动', '贴表情', [
    P('message_id', 'string', true, '消息 id', '7701602212777096975'),
    P('emoji_id', 'string', true, 'QQ 表情 id', '76')
  ], null, 'QQ 每条消息每个账号只有一个表情位。'),
  S('reaction.delete', '互动', '撤销表情', [
    P('message_id', 'string', true, '消息 id', '7701602212777096975'),
    P('emoji_id', 'string', true, 'QQ 表情 id', '76')
  ], null),
  S('reaction.clear', '互动', '清空表情', [
    P('message_id', 'string', true, '消息 id', '7701602212777096975'),
    P('emoji_id', 'string', true, 'QQ 表情 id', '76')
  ], null),
  S('upload.create', '上传', '上传文件', [
    P('files', 'file', true, 'multipart/form-data，一个或多个文件；上限 8 个 / 32MB')
  ], ['file:///D:/qq-hook-poc/qqproto/data/upload/8c1f.png'],
    'body 必须是 multipart/form-data；落盘到 qqproto/data/upload，回 file:// 路径，不下载远程内容。'),
  SNO('message.update', '消息', '编辑消息', 'QQ 内核没有改消息 API。', [
    P('channel_id', 'string', true, '会话 id'),
    P('message_id', 'string', true, '消息 id'),
    P('content', 'string', true, '新内容')
  ]),
  SNO('reaction.list', '互动', '表情列表', 'QQ 能设置表情，但不能列出谁贴了什么。', [
    P('message_id', 'string', true, '消息 id')
  ]),
  SNO('channel.create', '频道', '建群/建频道', '内核服务不暴露建群；建群/退群在本项目里是手动操作。', [
    P('guild_id', 'string', false, '群号'),
    P('data', 'object', false, '频道信息')
  ]),
  SNO('channel.delete', '频道', '退群/解散', '退群/解散被刻意做成了手动操作。', [
    P('channel_id', 'string', true, '群号')
  ]),
  SNO('guild.role.create', '群成员', '新建角色', 'QQ 角色固定为 owner/admin/member，不是可编辑的角色表。', [
    P('guild_id', 'string', true, '群号'),
    P('role', 'object', true, '角色定义')
  ]),
  SNO('guild.role.update', '群成员', '修改角色', 'QQ 角色固定为 owner/admin/member，不是可编辑的角色表。', [
    P('guild_id', 'string', true, '群号'),
    P('role_id', 'string', true, '角色 id'),
    P('role', 'object', true, '角色定义')
  ]),
  SNO('guild.role.delete', '群成员', '删除角色', 'QQ 角色固定为 owner/admin/member，不是可编辑的角色表。', [
    P('guild_id', 'string', true, '群号'),
    P('role_id', 'string', true, '角色 id')
  ])
];

// ---------------------------------------------------------------------------
// Cross-check against the code
// ---------------------------------------------------------------------------

const { createActions, UNIMPLEMENTED, REFUSED: OB_REFUSED } = require('../qqproto/protocols/onebot11/actions');
const { createHandlers, KNOWN_METHODS } = require('../qqproto/protocols/satori/methods');

function assert(condition, message) {
  if (!condition) {
    console.error('gen_api_docs: ' + message);
    process.exitCode = 1;
  }
}

const stubCore = new Proxy({}, { get: () => () => {} });
const { actions } = createActions({
  core: { rpc: {}, ensureSelf: async () => {} },
  store: {},
  unique: {},
  logger: { child: () => stubCore, info() {}, warn() {}, debug() {}, error() {} }
});
const obNames = Object.keys(actions);
const obRefused = new Set([...UNIMPLEMENTED, ...OB_REFUSED]);
const obOkNames = obNames.filter((name) => !obRefused.has(name));
const obExpected = new Set([...obNames, ...UNIMPLEMENTED]);

const docOk = new Set(OB_ACTIONS.filter((a) => a.status === 'ok').map((a) => a.name));
const docRefused = new Set(OB_ACTIONS.filter((a) => a.status === 'refused').map((a) => a.name));
const docAll = new Set([...docOk, ...docRefused]);

assert(docAll.size === OB_ACTIONS.length, 'duplicate OneBot entry in the tables');
assert(new Set(obOkNames).size === docOk.size &&
  obOkNames.every((name) => docOk.has(name)),
  'OneBot usable actions differ from the docs: ' +
  obOkNames.filter((name) => !docOk.has(name)).map((n) => '+' + n)
    .concat([...docOk].filter((n) => !obOkNames.includes(n)).map((n) => '-' + n)).join(' '));
assert(obRefused.size === docRefused.size && [...obRefused].every((name) => docRefused.has(name)),
  'OneBot refused actions differ from the docs: ' +
  [...obRefused].filter((name) => !docRefused.has(name)).map((n) => '+' + n)
    .concat([...docRefused].filter((n) => !obRefused.has(n)).map((n) => '-' + n)).join(' '));
assert([...obExpected].every((name) => docAll.has(name)),
  'documented OneBot names missing: ' + [...obExpected].filter((name) => !docAll.has(name)).join(' '));

const satori = createHandlers({ core: stubCore, store: stubCore, protocol: {} });
const satoriOk = new Set(satori.features);
const satoriRefused = new Set(KNOWN_METHODS.filter((name) => !satoriOk.has(name)));
const satoriDocOk = new Set(S_METHODS.filter((a) => a.status === 'ok').map((a) => a.name));
const satoriDocRefused = new Set(S_METHODS.filter((a) => a.status === 'refused').map((a) => a.name));
for (const name of satoriOk) assert(satoriDocOk.has(name), 'Satori usable method missing from docs: ' + name);
for (const name of satoriDocOk) assert(satoriOk.has(name), 'doc lists a non-usable Satori method: ' + name);
for (const name of satoriRefused) assert(satoriDocRefused.has(name), 'Satori refused method missing from docs: ' + name);
for (const name of satoriDocRefused) assert(satoriRefused.has(name), 'doc refuses an unknown Satori method: ' + name);

if (process.exitCode) process.exit(1);

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

const TOKEN_NOTE = '鉴权：`Authorization: Bearer <token>` 或 `?access_token=<token>`（HTTP 与 WebSocket 都认）。';

function ohMyMessageSchema() {
  return {
    description: '消息内容：段数组或 CQ 码字符串',
    oneOf: [
      { type: 'string', description: 'CQ 码字符串，例如 [CQ:at,qq=123] hi' },
      {
        type: 'array',
        description: '消息段数组，例如 [{"type":"text","data":{"text":"hi"}}]',
        items: { type: 'object', additionalProperties: true }
      }
    ]
  };
}

function obParamSchema(p) {
  if (p.name === 'message') return ohMyMessageSchema();
  if (p.type === 'file') {
    return { type: 'string', format: 'binary', description: p.desc };
  }
  if (p.type === 'integer') {
    return { type: 'integer', description: p.desc, ...(p.ex !== undefined ? { example: p.ex } : {}) };
  }
  if (p.type === 'boolean') {
    return { type: 'boolean', description: p.desc, ...(p.ex !== undefined ? { example: p.ex } : {}) };
  }
  if (p.type === 'object') {
    return { type: 'object', additionalProperties: true, description: p.desc, ...(p.ex !== undefined ? { example: p.ex } : {}) };
  }
  if (p.type === 'array') {
    return {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
      description: p.desc,
      ...(p.ex !== undefined ? { example: p.ex } : {})
    };
  }
  return { type: 'string', description: p.desc, ...(p.ex !== undefined ? { example: p.ex } : {}) };
}

const OB_ENVELOPE = {
  type: 'object',
  required: ['status', 'retcode', 'data', 'message', 'wording', 'echo'],
  properties: {
    status: { type: 'string', enum: ['ok', 'failed'], description: 'ok 仅当 retcode=0' },
    retcode: { type: 'integer', description: '0 成功；1200 内部错误；1400 参数错误/未实现；1401 权限不足；1403 令牌错误；1404 资源不存在' },
    data: { description: '动作返回值，视动作为对象、数组、字符串或 null' },
    message: { type: 'string' },
    wording: { type: 'string' },
    echo: { description: '请求里给什么就回什么，可以是任意 JSON 或 null' }
  }
};

function obSuccessExample(action) {
  const data = action.status === 'ok'
    ? (action.data === undefined ? {} : action.data)
    : null;
  return { status: 'ok', retcode: 0, data, message: '', wording: '', echo: null };
}

function obRefusalExample(action) {
  const message = action.status === 'refused'
    ? `${action.name} is not implemented by this endpoint: ${action.reason}`
    : 'not implemented';
  return { status: 'failed', retcode: 1400, data: null, message, wording: message, echo: null };
}

function obOperation(action) {
  const implemented = action.status === 'ok';
  const description = [
    implemented ? '**状态：已实现**' : '**状态：未实现**',
    action.note || '',
    implemented
      ? 'HTTP 与 WebSocket 都可以调用；HTTP 失败也返回 200，成功与否看 `retcode`。'
      : '这个动作仍然会路由并回答，但只会返回 retcode 1400 和原因；原因：' + action.reason,
    '`echo` 原样回传。消息段发送只支持 text / at / image（本机路径）。',
    TOKEN_NOTE
  ].filter(Boolean).join('\n\n');

  const properties = {};
  const required = [];
  for (const p of action.params) {
    properties[p.name] = obParamSchema(p);
    if (p.required) required.push(p.name);
  }
  properties.echo = { description: '可选，原样回传（任意 JSON）' };

  const body = {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties,
          ...(required.length ? { required } : {})
        }
      }
    }
  };
  if (action.sample) {
    body.content['application/json'].example = action.sample;
  }

  return {
    tags: [action.group, implemented ? '状态 · 已实现' : '状态 · 未实现'],
    summary: (implemented ? '✅ ' : '⚠️ 未实现 · ') + action.name + (action.title ? ' · ' + action.title : ''),
    description,
    operationId: 'ob_' + action.name,
    'x-apifox-folder': action.group,
    'x-apifox-status': implemented ? 'released' : 'designing',
    requestBody: action.params.length ? body : undefined,
    responses: {
      200: {
        description: implemented
          ? '统一信封；retcode=0 成功'
          : '统一信封；retcode=1400 明确拒绝',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/OneBotEnvelope' },
            examples: {
              success: { summary: implemented ? '成功' : '该名字仍会明确拒绝', value: implemented ? obSuccessExample(action) : obRefusalExample(action) }
            }
          }
        }
      },
      401: {
        description: 'token 不对',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/OneBotEnvelope' },
            example: { status: 'failed', retcode: 1403, data: null, message: 'unauthorized: bad access_token', wording: 'unauthorized: bad access_token', echo: null }
          }
        }
      }
    }
  };
}

function buildOneBotDoc() {
  const paths = {};
  for (const action of OB_ACTIONS) paths['/' + action.name] = { post: obOperation(action) };
  const okCount = OB_ACTIONS.filter((a) => a.status === 'ok').length;
  const refusedCount = OB_ACTIONS.length - okCount;
  return {
    openapi: '3.0.3',
    info: {
      title: 'qqproto · OneBot v11 API（NapCat 风格）',
      version: '1.0.0',
      description: [
        'QQNT 注入桥的独立协议端，OneBot v11 面。HTTP 动作服务端默认 `--ob-port 3000`（副本实例 3100），另有独立 WebSocket 服务端 `--ob-ws-port 3001`（副本 3101）、HTTP 上报与反向 WS。',
        `本文件覆盖 ${OB_ACTIONS.length} 个动作名：**${okCount} 个可用**，**${refusedCount} 个明确拒绝**（返回 retcode 1400 并带原因，不是 404 装死）。`,
        'HTTP 调用方式：`POST /{action}`，JSON body 就是参数；也支持 `GET /{action}?参数` 与 `POST /` 带 `{action, params, echo}`。动作失败 HTTP 仍是 200，必须看 `retcode`。',
        '消息段：发送只支持 text / at / image（本机路径）；record、video、file、json、forward、reply、face、mface 等发送会在到达内核前被拒。接收方向支持全部段并附带 path/md5 等信息。',
        '事件：`message`、`message_sent`（默认不广播）、`notice`（group_recall/friend_recall/offline）、`request`、`meta_event`（lifecycle/heartbeat）。详见仓库 HANDBOOK 的事件格式一节。',
        TOKEN_NOTE,
        GENERATED
      ].join('\n\n')
    },
    servers: [
      { url: 'http://127.0.0.1:3100', description: '副本实例（qq_start.bat 默认，--protocol onebot|both）' },
      { url: 'http://127.0.0.1:3000', description: '独立协议端默认端口' }
    ],
    tags: [
      ...Object.entries({
        元信息: '运行状态、版本、当前账号与能力查询',
        联系人: '好友、群、群成员资料',
        消息: '收发、缓存历史、撤回、表情回应、精华、转发、翻译与 OCR',
        群管理: '群设置、成员角色、禁言、踢人、退群',
        请求与通知: '加群/好友申请、群公告',
        群文件: '群文件与文件夹管理',
        其它: '点赞，以及明确不做的边界能力'
      }).map(([name, description]) => ({ name, description })),
      { name: '状态 · 已实现', description: '有真实实现；仍可能因权限/build 限制在运行时拒绝，描述里会写明' },
      { name: '状态 · 未实现', description: '会路由并回答 retcode 1400 + 原因，绝不假装成功' }
    ],
    security: [{ bearerAuth: [] }, { tokenQuery: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
        tokenQuery: { type: 'apiKey', in: 'query', name: 'access_token' }
      },
      schemas: { OneBotEnvelope: OB_ENVELOPE }
    }
  };
}

// ---------------------------------------------------------------------------
// Satori
// ---------------------------------------------------------------------------

function satoriParamSchema(p) {
  if (p.type === 'integer') {
    return { type: 'integer', description: p.desc, ...(p.ex !== undefined ? { example: p.ex } : {}) };
  }
  if (p.type === 'boolean') {
    return { type: 'boolean', description: p.desc, ...(p.ex !== undefined ? { example: p.ex } : {}) };
  }
  if (p.type === 'object') {
    return { type: 'object', additionalProperties: true, description: p.desc, ...(p.ex !== undefined ? { example: p.ex } : {}) };
  }
  if (p.type === 'file') {
    return { type: 'string', format: 'binary', description: p.desc };
  }
  return { type: 'string', description: p.desc, ...(p.ex !== undefined ? { example: p.ex } : {}) };
}

function satoriOperation(method) {
  const implemented = method.status === 'ok';
  const description = [
    implemented ? '**状态：已实现**' : '**状态：未实现**',
    method.note || '',
    implemented
      ? '返回 HTTP 200 + 方法返回值本身（没有 OneBot 那种信封）。'
      : '返回 HTTP 501 和 `{"message": "..."}`；原因：' + method.reason,
    '参数放 JSON body（POST）或 query（GET）；multipart 例外见 upload.create。',
    TOKEN_NOTE
  ].filter(Boolean).join('\n\n');

  const properties = {};
  const required = [];
  for (const p of method.params) {
    properties[p.name] = satoriParamSchema(p);
    if (p.required) required.push(p.name);
  }

  const isUpload = method.name === 'upload.create';
  const content = isUpload
    ? {
      'multipart/form-data': {
        schema: {
          type: 'object',
          properties: {
            files: { type: 'array', items: { type: 'string', format: 'binary' }, description: '一个或多个文件（上限 8 个 / 32MB）' }
          },
          required: ['files']
        }
      }
    }
    : {
      'application/json': {
        schema: {
          type: 'object',
          properties,
          ...(required.length ? { required } : {})
        }
      }
    };
  if (!isUpload && method.sample) content['application/json'].example = method.sample;

  return {
    tags: [method.group, implemented ? '状态 · 已实现' : '状态 · 未实现'],
    summary: (implemented ? '✅ ' : '⚠️ 未实现 · ') + method.name + (method.title ? ' · ' + method.title : ''),
    description,
    operationId: 'satori_' + method.name,
    'x-apifox-folder': method.group,
    'x-apifox-status': implemented ? 'released' : 'designing',
    requestBody: method.params.length ? { required: true, content } : undefined,
    responses: implemented
      ? {
        200: {
          description: '方法返回值（对象/数组/null）',
          content: {
            'application/json': {
              schema: { description: '返回值本身（对象/数组/字符串或 null）' },
              examples: { success: { summary: '示例', value: method.data === undefined ? null : method.data } }
            }
          }
        },
        400: { $ref: '#/components/responses/SatoriBadRequest' },
        401: { $ref: '#/components/responses/SatoriUnauthorized' },
        403: { $ref: '#/components/responses/SatoriForbidden' },
        404: { $ref: '#/components/responses/SatoriNotFound' },
        501: { $ref: '#/components/responses/SatoriNotImplemented' }
      }
      : {
        501: {
          description: '未实现，带原因',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SatoriError' },
              example: { message: `${method.name} is not supported by the QQ adapter: ${method.reason}` }
            }
          }
        },
        401: { $ref: '#/components/responses/SatoriUnauthorized' }
      }
  };
}

function buildSatoriDoc() {
  const paths = {};
  for (const method of S_METHODS) paths['/v1/' + method.name] = { post: satoriOperation(method) };
  const okCount = S_METHODS.filter((m) => m.status === 'ok').length;
  const refusedCount = S_METHODS.length - okCount;
  return {
    openapi: '3.0.3',
    info: {
      title: 'qqproto · Satori API',
      version: '1.0.0',
      description: [
        'QQNT 注入桥的独立协议端，Satori 面。HTTP 默认 `--port 5140`（副本实例 5141），WebSocket 事件在 `ws /v1/events`。',
        `本文件覆盖 @satorijs/protocol 1.7.0 的 ${S_METHODS.length} 个方法：**${okCount} 个可用**，**${refusedCount} 个返回 501 并带原因**。`,
        'HTTP：`POST /v1/{method}`，JSON body 就是参数；`GET /v1/{method}?参数` 也行。成功直接返回方法结果，失败用 HTTP 状态码（400/401/403/404/501/500）+ `{message}`。',
        'WS：连接 `/v1/events`，IDENTIFY（op 3）携带 `{token, sn}`；READY（op 4）回 `{logins, proxy_urls}`；事件帧 op 0，心跳 op 1/2。详细事件类型见 HANDBOOK 的 Satori 一节。',
        TOKEN_NOTE,
        GENERATED
      ].join('\n\n')
    },
    servers: [
      { url: 'http://127.0.0.1:5141', description: '副本实例（qq_start.bat 默认，--protocol satori|both）' },
      { url: 'http://127.0.0.1:5140', description: '独立协议端默认端口' }
    ],
    tags: [
      ...Object.entries({
        登录: 'login.get / user.get',
        好友: '好友列表、删除、申请审批',
        群组: '群列表、群信息、加群审批',
        群成员: '成员查询、踢人、禁言、角色',
        频道: '频道查询与群名、全员禁言',
        消息: '发送、查询、缓存历史、撤回',
        互动: '消息表情回应',
        上传: 'multipart 文件上传（落盘后回 file://）'
      }).map(([name, description]) => ({ name, description })),
      { name: '状态 · 已实现', description: '有真实实现；权限不足等运行时错误按 403/404 返回' },
      { name: '状态 · 未实现', description: '返回 HTTP 501 和原因' }
    ],
    security: [{ bearerAuth: [] }, { tokenQuery: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
        tokenQuery: { type: 'apiKey', in: 'query', name: 'access_token' }
      },
      schemas: {
        SatoriError: { type: 'object', properties: { message: { type: 'string' } } }
      },
      responses: {
        SatoriBadRequest: {
          description: '参数错误',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/SatoriError' }, example: { message: 'channel_id is required' } } }
        },
        SatoriUnauthorized: {
          description: 'token 不对',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/SatoriError' }, example: { message: 'unauthorized' } } }
        },
        SatoriForbidden: {
          description: '权限不足（权限词、result=120101005 等）',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/SatoriError' }, example: { message: 'only the owner can do this' } } }
        },
        SatoriNotFound: {
          description: '找不到（用户/成员/消息）',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/SatoriError' }, example: { message: 'user not found' } } }
        },
        SatoriNotImplemented: {
          description: '明确未实现',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/SatoriError' }, example: { message: 'message.update is not supported by the QQ adapter: QQ has no edit-message API in this kernel build' } } }
        }
      }
    }
  };
}

// ---------------------------------------------------------------------------
// HANDBOOK
// ---------------------------------------------------------------------------

function esc(text) {
  return String(text).replace(/\|/g, '\\|');
}

function buildReadme() {
  const obOk = OB_ACTIONS.filter((a) => a.status === 'ok');
  const obNo = OB_ACTIONS.filter((a) => a.status === 'refused');
  const sOk = S_METHODS.filter((a) => a.status === 'ok');
  const sNo = S_METHODS.filter((a) => a.status === 'refused');

  const lines = [];
  lines.push('# qqproto 接口清单（Apifox 可导入）');
  lines.push('');
  lines.push('> ' + GENERATED);
  lines.push('');
  lines.push('这个目录是给 Apifox 用的：两个 OpenAPI 3.0 文件 + 这份人读的总表。状态来自代码本身（生成时会对 OneBot 的 action 表 / `UNIMPLEMENTED` / `REFUSED` 和 Satori 的 `KNOWN_METHODS` / `features` 逐个比对，对不上就不生成）。');
  lines.push('');
  lines.push('## 怎么导入 Apifox');
  lines.push('');
  lines.push('1. Apifox 打开项目 → 项目设置 → 导入数据 → OpenAPI / Swagger；');
  lines.push('2. 选 `docs/api/onebot11.openapi.json`（OneBot v11，' + OB_ACTIONS.length + ' 个动作）和 `docs/api/satori.openapi.json`（Satori，' + S_METHODS.length + ' 个方法）；');
  lines.push('3. 按 `状态 · 已实现` / `状态 · 未实现` 两个标签筛选，就知道哪些能用；目录按协议面分组（`x-apifox-folder`）。');
  lines.push('');
  lines.push('- OneBot 地址：`http://127.0.0.1:3100`（副本实例）/ `http://127.0.0.1:3000`（默认），WS 事件 `ws://127.0.0.1:3101/`；');
  lines.push('- Satori 地址：`http://127.0.0.1:5141`（副本例）/ `http://127.0.0.1:5140`（默认），WS 事件 `ws://127.0.0.1:5141/v1/events`；');
  lines.push('- 鉴权：`Authorization: Bearer <token>` 或 `?access_token=<token>`；');
  lines.push('- OneBot 动作失败 HTTP 仍是 **200**，看 `retcode`；Satori 用 **HTTP 状态码**（4xx/5xx）。');
  lines.push('');
  lines.push('事件与 WebSocket 不在 OpenAPI 里（OpenAPI 描述不了 WS 帧）：OneBot 的事件格式见仓库 HANDBOOK「事件格式」，Satori 的 opcode / 事件类型见「Satori 接口」。调试页 `http://127.0.0.1:5151/` 的「调用」面板也能直接点这些方法。');
  lines.push('');
  lines.push('## 总数');
  lines.push('');
  lines.push('| 协议面 | 可用 | 明确未实现 | 名字总数 |');
  lines.push('| --- | --- | --- | --- |');
  lines.push(`| OneBot v11 | ${obOk.length} | ${obNo.length} | ${OB_ACTIONS.length} |`);
  lines.push(`| Satori | ${sOk.length} | ${sNo.length} | ${S_METHODS.length} |`);
  lines.push('');
  lines.push('OneBot 的 79 个动作是「注册了 handler」的数量，其中 6 个 handler 只会返回拒绝（`get_essence_msg_list`、`get_group_essence`、`get_forward_msg`、`fetch_cookie`、`upload_private_file`、`get_group_file_url`），所以可用是 ' + obOk.length + '。`get_group_notice` 算可用，但这个 QQ build 的公告列表内核读不到，实际调用常以 1400 拒绝；发/删公告可用。');
  lines.push('');
  lines.push('## 写操作的两道闸');
  lines.push('');
  lines.push('1. **版本闸**：协议端只把 HANDBOOK「已验证版本」表里的 QQ build 当作可写；其他 build 读照常，写返回 Satori `403` / OneBot `retcode 1401`，消息里会提示 `--allow-untested`。调试 attach 路径没有版本字符串，不启用这道闸。');
  lines.push('2. **行为闸（桥内）**：对外可见的写动作默认 30 次/分钟、600 次/小时、两次之间至少 300ms 并加 0–120ms 抖动；连续 3 次命中风控（典型 `sendMsg result=121`）就熔断 60s。超预算/熔断返回 Satori `429`，OneBot 以 `retcode 1200` 带原因。');
  lines.push('');
  lines.push('预算可用 `app.config.json` 的 `write_budget` 或 `qq_start.bat --write-per-minute/--write-per-hour/--write-interval` 调整（只影响无头生产实例）。');
  lines.push('');
  lines.push('## OneBot v11');
  lines.push('');
  lines.push('| 分组 | 动作 | 状态 | 说明 |');
  lines.push('| --- | --- | --- | --- |');
  for (const action of OB_ACTIONS) {
    lines.push(`| ${esc(action.group)} | \`${action.name}\` | ${action.status === 'ok' ? '✅ 可用' : '⚠️ 未实现'} | ${esc(action.status === 'ok' ? (action.note || action.title) : action.reason)} |`);
  }
  lines.push('');
  lines.push('## Satori');
  lines.push('');
  lines.push('| 分组 | 方法 | 状态 | 说明 |');
  lines.push('| --- | --- | --- | --- |');
  for (const method of S_METHODS) {
    lines.push(`| ${esc(method.group)} | \`${method.name}\` | ${method.status === 'ok' ? '✅ 可用' : '⚠️ 501'} | ${esc(method.status === 'ok' ? (method.note || method.title) : method.reason)} |`);
  }
  lines.push('');
  lines.push('## 重新生成');
  lines.push('');
  lines.push('```bat');
  lines.push('node scripts\\gen_api_docs.js');
  lines.push('```');
  lines.push('');
  lines.push('改了动作就改 `scripts/gen_api_docs.js` 里的表；名字对不上代码时脚本会直接报错退出，不会生成过期的文档。');
  lines.push('');
  return lines.join('\n');
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'onebot11.openapi.json'), JSON.stringify(buildOneBotDoc(), null, 2) + '\n');
fs.writeFileSync(path.join(OUT_DIR, 'satori.openapi.json'), JSON.stringify(buildSatoriDoc(), null, 2) + '\n');
fs.writeFileSync(path.join(OUT_DIR, 'README.md'), buildReadme());

const obOkCount = OB_ACTIONS.filter((a) => a.status === 'ok').length;
const sOkCount = S_METHODS.filter((a) => a.status === 'ok').length;
console.log(`docs/api: OneBot ${obOkCount}/${OB_ACTIONS.length} usable, Satori ${sOkCount}/${S_METHODS.length} usable`);
console.log('wrote docs/api/onebot11.openapi.json, docs/api/satori.openapi.json, docs/api/README.md');
