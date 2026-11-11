# qqproto 接口清单（Apifox 可导入）

> 由 scripts/gen_api_docs.js 生成；改接口先改脚本里的表，再重新生成。

这个目录是给 Apifox 用的：两个 OpenAPI 3.0 文件 + 这份人读的总表。状态来自代码本身（生成时会对 OneBot 的 action 表 / `UNIMPLEMENTED` / `REFUSED` 和 Satori 的 `KNOWN_METHODS` / `features` 逐个比对，对不上就不生成）。

## 怎么导入 Apifox

1. Apifox 打开项目 → 项目设置 → 导入数据 → OpenAPI / Swagger；
2. 选 `docs/api/onebot11.openapi.json`（OneBot v11，107 个动作）和 `docs/api/satori.openapi.json`（Satori，37 个方法）；
3. 按 `状态 · 已实现` / `状态 · 未实现` 两个标签筛选，就知道哪些能用；目录按协议面分组（`x-apifox-folder`）。

- OneBot 地址：`http://127.0.0.1:3100`（副本实例）/ `http://127.0.0.1:3000`（默认），WS 事件 `ws://127.0.0.1:3101/`；
- Satori 地址：`http://127.0.0.1:5141`（副本例）/ `http://127.0.0.1:5140`（默认），WS 事件 `ws://127.0.0.1:5141/v1/events`；
- 鉴权：`Authorization: Bearer <token>` 或 `?access_token=<token>`；
- OneBot 动作失败 HTTP 仍是 **200**，看 `retcode`；Satori 用 **HTTP 状态码**（4xx/5xx）。

事件与 WebSocket 不在 OpenAPI 里（OpenAPI 描述不了 WS 帧）：OneBot 的事件格式见仓库 HANDBOOK「事件格式」，Satori 的 opcode / 事件类型见「Satori 接口」。调试页 `http://127.0.0.1:5151/` 的「调用」面板也能直接点这些方法。

## 总数

| 协议面 | 可用 | 明确未实现 | 名字总数 |
| --- | --- | --- | --- |
| OneBot v11 | 73 | 34 | 107 |
| Satori | 30 | 7 | 37 |

OneBot 的 79 个动作是「注册了 handler」的数量，其中 6 个 handler 只会返回拒绝（`get_essence_msg_list`、`get_group_essence`、`get_forward_msg`、`fetch_cookie`、`upload_private_file`、`get_group_file_url`），所以可用是 73。`get_group_notice` 算可用，但这个 QQ build 的公告列表内核读不到，实际调用常以 1400 拒绝；发/删公告可用。

## 写操作的两道闸

1. **版本闸**：协议端只把 HANDBOOK「已验证版本」表里的 QQ build 当作可写；其他 build 读照常，写返回 Satori `403` / OneBot `retcode 1401`，消息里会提示 `--allow-untested`。调试 attach 路径没有版本字符串，不启用这道闸。
2. **行为闸（桥内）**：对外可见的写动作默认 30 次/分钟、600 次/小时、两次之间至少 300ms 并加 0–120ms 抖动；连续 3 次命中风控（典型 `sendMsg result=121`）就熔断 60s。超预算/熔断返回 Satori `429`，OneBot 以 `retcode 1200` 带原因。

预算可用 `app.config.json` 的 `write_budget` 或 `qq_start.bat --write-per-minute/--write-per-hour/--write-interval` 调整（只影响无头生产实例）。

## OneBot v11

| 分组 | 动作 | 状态 | 说明 |
| --- | --- | --- | --- |
| 元信息 | `get_status` | ✅ 可用 | 运行状态 |
| 元信息 | `get_version_info` | ✅ 可用 | 实现信息 |
| 元信息 | `get_login_info` | ✅ 可用 | 当前账号 |
| 元信息 | `can_send_msg` | ✅ 可用 | 能否发消息 |
| 元信息 | `can_send_image` | ✅ 可用 | 图片只接受本机已存在的文件路径（或收图事件里的 path），url / base64 会被拒绝。 |
| 元信息 | `can_send_record` | ✅ 可用 | 语音上传没做，这个查询会如实回答不可用。 |
| 元信息 | `can_get_http_file` | ✅ 可用 | 本协议端不做媒体下载。 |
| 元信息 | `can_handle_url_unsafe_tags` | ✅ 可用 | 是否处理 url 危险标签 |
| 联系人 | `get_friend_list` | ✅ 可用 | 好友列表 |
| 联系人 | `get_group_list` | ✅ 可用 | 群列表 |
| 联系人 | `get_group_info` | ✅ 可用 | 群信息 |
| 联系人 | `get_group_member_list` | ✅ 可用 | 群成员列表 |
| 联系人 | `get_group_member_info` | ✅ 可用 | 单个群成员 |
| 联系人 | `get_stranger_info` | ✅ 可用 | 陌生人资料 |
| 联系人 | `get_user_info` | ✅ 可用 | 用户资料（get_stranger_info 别名） |
| 联系人 | `get_buddy_list` | ✅ 可用 | 好友列表（get_friend_list 别名） |
| 联系人 | `set_friend_remark` | ✅ 可用 | 写操作，真机验过。 |
| 联系人 | `delete_friend` | ✅ 可用 | 危险写操作，HANDBOOK 里列为只能手动触发。 |
| 联系人 | `get_stranger_list` | ⚠️ 未实现 | QQNT 内核没有对应的陌生人列表调用。 |
| 联系人 | `get_recent_groups` | ⚠️ 未实现 | QQNT 内核没有对应的最近群组调用。 |
| 联系人 | `get_friend_profiles` | ⚠️ 未实现 | QQNT 内核没有对应的批量资料调用。 |
| 消息 | `send_private_msg` | ✅ 可用 | 发送只支持 text / at / image（本机路径）；record、video、file、reply、face 等会在到达内核前被拒（retcode 1400）。 |
| 消息 | `send_group_msg` | ✅ 可用 | 发送只支持 text / at / image（本机路径）。 |
| 消息 | `send_msg` | ✅ 可用 | 发送只支持 text / at / image（本机路径）。 |
| 消息 | `get_msg` | ✅ 可用 | 只能取本进程启动后见过的消息（内存缓存），不读 QQ 数据库。 |
| 消息 | `get_group_msg_history` | ✅ 可用 | 只来自内存缓存，重启即空；不向 QQ 翻页。 |
| 消息 | `get_friend_msg_history` | ✅ 可用 | 只来自内存缓存，重启即空。 |
| 消息 | `delete_msg` | ✅ 可用 | 可撤回自己发的；别人的消息能否撤回由 QQ 权限决定。 |
| 消息 | `set_msg_read` | ✅ 可用 | 失败不报错，避免打断机器人循环。 |
| 消息 | `mark_msg_as_read` | ✅ 可用 | 三者给一个即可。 |
| 消息 | `mark_group_msg_as_read` | ✅ 可用 | 标记群消息已读 |
| 消息 | `set_msg_reaction` | ✅ 可用 | QQ 每条消息每个账号只保留一个表情回应：设置会覆盖之前的，撤销只撤销这个账号的。message_id 必须指向本进程见过的消息。 |
| 消息 | `del_msg_reaction` | ✅ 可用 | 与 set_msg_reaction 同一限制。 |
| 消息 | `set_essence_msg` | ✅ 可用 | 设为群精华 |
| 消息 | `unset_essence_msg` | ✅ 可用 | 取消群精华 |
| 消息 | `send_group_forward_msg` | ✅ 可用 | 转发由 QQ 内核复制原消息，不是本端重建节点；node 内容列表不支持。 |
| 消息 | `send_private_forward_msg` | ✅ 可用 | 发送私聊合并转发 |
| 消息 | `translate_enzh` | ✅ 可用 | 英译中 |
| 消息 | `ocr_image` | ✅ 可用 | 走内核 OCR，真机需自行确认该 build 的返回。 |
| 消息 | `image_ocr` | ✅ 可用 | 图片 OCR（ocr_image 别名） |
| 消息 | `get_forward_msg` | ⚠️ 未实现 | 需要读本地消息数据库，本项目明确不读库。 |
| 消息 | `get_forward_msg_single` | ⚠️ 未实现 | 需要读本地消息数据库，本项目明确不读库。 |
| 消息 | `get_essence_msg_list` | ⚠️ 未实现 | 内核读不到精华列表（promise 不落地），只能走 qun.qq.com web api；设置/取消精华可用。 |
| 消息 | `get_group_essence` | ⚠️ 未实现 | 同 get_essence_msg_list：列表读不到，设置/取消可用。 |
| 消息 | `get_collection_list` | ⚠️ 未实现 | 需要读本地消息数据库，本项目明确不读库。 |
| 消息 | `get_message_like` | ⚠️ 未实现 | 需要 OIDB 包，内核没有对应调用。 |
| 消息 | `get_ocr_languages` | ⚠️ 未实现 | QQNT 内核没有对应调用。 |
| 消息 | `query_ocr` | ⚠️ 未实现 | QQNT 内核没有对应调用。 |
| 消息 | `friend_poke` | ⚠️ 未实现 | QQNT 内核没有对应调用。 |
| 消息 | `group_poke` | ⚠️ 未实现 | QQNT 内核没有对应调用。 |
| 消息 | `poke` | ⚠️ 未实现 | QQNT 内核没有对应调用。 |
| 消息 | `send_dms_msg` | ⚠️ 未实现 | QQNT 内核没有对应调用。 |
| 消息 | `send_gms_msg` | ⚠️ 未实现 | QQNT 内核没有对应调用。 |
| 消息 | `push_msg` | ⚠️ 未实现 | QQNT 内核没有对应调用。 |
| 群管理 | `set_group_name` | ✅ 可用 | 改群名 |
| 群管理 | `set_group_remark` | ✅ 可用 | 设备注（群备注） |
| 群管理 | `set_group_card` | ✅ 可用 | 改群名片 |
| 群管理 | `set_group_special_title` | ✅ 可用 | 设专属头衔 |
| 群管理 | `set_group_role` | ✅ 可用 | 转让群主不支持（retcode 1400）。 |
| 群管理 | `set_group_admin` | ✅ 可用 | 设/取消管理员 |
| 群管理 | `set_group_kick` | ✅ 可用 | 危险写操作。 |
| 群管理 | `set_group_ban` | ✅ 可用 | duration=0 即解禁。 |
| 群管理 | `set_group_whole_ban` | ✅ 可用 | 全员禁言 |
| 群管理 | `set_group_leave` | ✅ 可用 | 危险写操作；解散要求群主。 |
| 群管理 | `get_group_at_all_remain` | ✅ 可用 | @全体剩余次数 |
| 群管理 | `get_group_banned_list` | ✅ 可用 | 禁言列表（别名） |
| 群管理 | `get_group_shut_list` | ✅ 可用 | 禁言列表 |
| 群管理 | `get_group_detail_info` | ✅ 可用 | 群详情 |
| 群管理 | `get_group_level_info` | ✅ 可用 | 群等级信息 |
| 群管理 | `create_group` | ⚠️ 未实现 | QQNT 内核没有建群调用；建群/退群在本项目里是手动操作。 |
| 群管理 | `create_discuss` | ⚠️ 未实现 | QQNT 内核没有对应调用。 |
| 群管理 | `get_discussion` | ⚠️ 未实现 | QQNT 内核没有对应调用。 |
| 群管理 | `get_forum` | ⚠️ 未实现 | QQNT 内核没有对应调用。 |
| 群管理 | `get_group_honor_info` | ⚠️ 未实现 | 需要 OIDB 包。 |
| 群管理 | `get_group_member_profile` | ⚠️ 未实现 | 需要 OIDB 包。 |
| 群管理 | `send_group_sign` | ⚠️ 未实现 | 需要 OIDB 包。 |
| 群管理 | `get_school_clockin` | ⚠️ 未实现 | 需要 qun.qq.com web api 与账号 cookie。 |
| 群管理 | `get_banned_groups` | ⚠️ 未实现 | 需要 qun.qq.com web api 与账号 cookie。 |
| 群管理 | `get_group_ignore_tip` | ⚠️ 未实现 | 需要 qun.qq.com web api 与账号 cookie。 |
| 请求与通知 | `get_group_system_msg` | ✅ 可用 | 只把 type 1/5/7 当申请；管理员变更（type 8）单独放 other_requests，不会让机器人误点同意。 |
| 请求与通知 | `get_group_add_request` | ✅ 可用 | 加群申请（别名） |
| 请求与通知 | `set_group_add_request` | ✅ 可用 | 不给数值 type 时，桥会按 flag 回查申请列表，顺便确定它在哪一屏。 |
| 请求与通知 | `get_friend_requests` | ✅ 可用 | 好友申请列表 |
| 请求与通知 | `set_friend_add_request` | ✅ 可用 | 处理好友申请 |
| 请求与通知 | `mark_group_notify_as_read` | ✅ 可用 | 群通知标已读 |
| 请求与通知 | `clear_friend_notice` | ✅ 可用 | 清好友申请红点 |
| 请求与通知 | `send_group_notice` | ✅ 可用 | 发群公告 |
| 请求与通知 | `get_group_notice` | ✅ 可用 | 注意：这个 QQ build 的 getGroupBulletinList 实测只回全默认空信封，所以经常以 retcode 1400 明确拒绝（不会假装“没有公告”）。发公告/删公告走内核，可用。 |
| 请求与通知 | `set_group_announcement` | ✅ 可用 | 发群公告（别名） |
| 请求与通知 | `del_group_notice` | ✅ 可用 | 删群公告 |
| 请求与通知 | `delete_group_notice` | ✅ 可用 | 删群公告（别名） |
| 请求与通知 | `get_online_clients` | ⚠️ 未实现 | 需要 qun.qq.com web api 与账号 cookie。 |
| 请求与通知 | `get_risk_tips_info` | ⚠️ 未实现 | 需要 qun.qq.com web api 与账号 cookie。 |
| 请求与通知 | `get_vip_info` | ⚠️ 未实现 | 需要 OIDB 包。 |
| 群文件 | `get_group_file_list` | ✅ 可用 | 群文件列表 |
| 群文件 | `get_group_file_count` | ✅ 可用 | 群文件数量 |
| 群文件 | `del_group_file` | ✅ 可用 | 删群文件 |
| 群文件 | `create_group_file_folder` | ✅ 可用 | 建群文件夹 |
| 群文件 | `delete_group_file_folder` | ✅ 可用 | 删群文件夹 |
| 群文件 | `rename_group_file_folder` | ✅ 可用 | 重命名群文件夹 |
| 群文件 | `move_group_file` | ✅ 可用 | 移动群文件 |
| 群文件 | `upload_group_file` | ✅ 可用 | 文件由 QQ 客户端自己上传（落进账号的媒体树再交 fileElement），不走 Highway；file 必须是本机已存在的路径。 |
| 群文件 | `upload_private_file` | ⚠️ 未实现 | 私聊文件路径还没有验证过；群文件上传可用。 |
| 群文件 | `get_group_file_url` | ⚠️ 未实现 | 需要 OIDB 包，内核没有对应调用。 |
| 其它 | `send_like` | ✅ 可用 | 有频控，短时间内重复会被 QQ 拒绝。 |
| 其它 | `set_qq_avatar` | ⚠️ 未实现 | 头像上传路径未验证。 |
| 其它 | `fetch_cookie` | ⚠️ 未实现 | 本协议端明确不读账号 cookie——这是设计边界，不是没做。 |

## Satori

| 分组 | 方法 | 状态 | 说明 |
| --- | --- | --- | --- |
| 登录 | `login.get` | ✅ 可用 | 客户端一般先 GET /v1/login.get 验 token 与能力表。 |
| 登录 | `user.get` | ✅ 可用 | 取用户资料 |
| 好友 | `friend.list` | ✅ 可用 | 好友列表 |
| 好友 | `friend.delete` | ✅ 可用 | 危险写操作。 |
| 好友 | `friend.approve` | ✅ 可用 | 处理好友申请 |
| 群组 | `guild.list` | ✅ 可用 | 群列表 |
| 群组 | `guild.get` | ✅ 可用 | 群信息 |
| 群组 | `guild.approve` | ✅ 可用 | 处理加群申请 |
| 群成员 | `guild.member.approve` | ✅ 可用 | 处理加群申请（成员维度） |
| 群成员 | `guild.member.list` | ✅ 可用 | 群成员列表 |
| 群成员 | `guild.member.get` | ✅ 可用 | 单个群成员 |
| 群成员 | `guild.member.kick` | ✅ 可用 | 危险写操作。 |
| 群成员 | `guild.member.mute` | ✅ 可用 | 禁言 |
| 群成员 | `guild.member.role.set` | ✅ 可用 | QQ 只有 owner/admin/member 三种角色。 |
| 群成员 | `guild.member.role.unset` | ✅ 可用 | 取消管理员 |
| 群成员 | `guild.member.role.list` | ✅ 可用 | 成员角色 |
| 群成员 | `guild.role.list` | ✅ 可用 | QQ 没有角色表，这是内置的三个固定角色。 |
| 频道 | `channel.get` | ✅ 可用 | 取频道 |
| 频道 | `channel.list` | ✅ 可用 | QQ 一个群只有一个文本频道。 |
| 频道 | `user.channel.create` | ✅ 可用 | 私聊频道 |
| 频道 | `channel.update` | ✅ 可用 | 改群名 |
| 频道 | `channel.mute` | ✅ 可用 | 全员禁言 |
| 消息 | `message.create` | ✅ 可用 | 只支持 text / at / img（本机路径）/ emoji / quote；record、video、file 会回 501。content 就是 @satorijs/element 的 toString()：`<at id="123"/> hi`、`<img src="D:/a.png"/>`。 |
| 消息 | `message.get` | ✅ 可用 | 只能取本进程启动后见过的消息。 |
| 消息 | `message.list` | ✅ 可用 | 只来自内存缓存，重启即空。 |
| 消息 | `message.delete` | ✅ 可用 | 撤回消息 |
| 互动 | `reaction.create` | ✅ 可用 | QQ 每条消息每个账号只有一个表情位。 |
| 互动 | `reaction.delete` | ✅ 可用 | 撤销表情 |
| 互动 | `reaction.clear` | ✅ 可用 | 清空表情 |
| 上传 | `upload.create` | ✅ 可用 | body 必须是 multipart/form-data；落盘到 qqproto/data/upload，回 file:// 路径，不下载远程内容。 |
| 消息 | `message.update` | ⚠️ 501 | QQ 内核没有改消息 API。 |
| 互动 | `reaction.list` | ⚠️ 501 | QQ 能设置表情，但不能列出谁贴了什么。 |
| 频道 | `channel.create` | ⚠️ 501 | 内核服务不暴露建群；建群/退群在本项目里是手动操作。 |
| 频道 | `channel.delete` | ⚠️ 501 | 退群/解散被刻意做成了手动操作。 |
| 群成员 | `guild.role.create` | ⚠️ 501 | QQ 角色固定为 owner/admin/member，不是可编辑的角色表。 |
| 群成员 | `guild.role.update` | ⚠️ 501 | QQ 角色固定为 owner/admin/member，不是可编辑的角色表。 |
| 群成员 | `guild.role.delete` | ⚠️ 501 | QQ 角色固定为 owner/admin/member，不是可编辑的角色表。 |

## 重新生成

```bat
node scripts\gen_api_docs.js
```

改了动作就改 `scripts/gen_api_docs.js` 里的表；名字对不上代码时脚本会直接报错退出，不会生成过期的文档。
