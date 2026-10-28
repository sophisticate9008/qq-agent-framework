# QQ 协议能力清单

更新日期：2026-10-28。能力清单按连接协议端实际支持情况开放；能力存在与本次调用权限分别判断。已接入不等于已逐项执行过真实 QQ 操作。

## 常用聊天入口

| 能力 | 调用范围 |
| --- | --- |
| 回复、图片与文件、引用、@、合并转发、媒体读取、会话查询、戳一戳 | 全部白名单会话 |
| 收藏表情：查询、添加、删除、修改备注；给消息贴表情及移除 | 全部白名单会话 |
| 修改当前群自身名片、撤回当前会话中自己发送的消息 | 主人或自主 |
| 空间图文说说发布与删除 | 主人或自主，通过能力目录查找 |
| QQ 与插件会话的查询、创建和绑定管理 | 主人，通过会话管理目录 |

模型通常只看到常用工具与两个目录入口。通过 `qaf_capability_catalog` 读取分类或搜索摘要，再按 `id` 取具体参数，通过 `qaf_capability_call` 执行。参数不会全部常驻聊天上下文。

原始协议动作以 `qq.<动作名>` 放在二级目录，模型调用统一核验真实主人。上表的常用工具提供更窄的会话范围，支持全部或自主使用。可信插件直接使用 `runtime.capabilities`，身份由宿主注入；命令发言者权限在插件入口检查，定时任务无需伪造 QQ 主人消息。

## 适配范围

当前版本表覆盖 NapCat.Onebot 4.18.41 的 177 个生产动作，排除协议端开发测试动作。另支持协议端明确返回的动作清单；未知版本且未返回动作清单时，只展示已经核验的动作，不猜测 SnowLuma 或其他 OneBot 实现支持全部 NapCat 扩展。输入参数按登记 schema 验证，流式和普通 JSON 返回均有容量上限；写操作结果未知不自动重发。

添加收藏表情的常用工具目前要求框架与协议 HTTP 端在同一本机；远程协议端可使用其自身支持的原生文件参数。QQ 空间当前版本提供发布与删除，没有说说读取、评论或点赞接口。

## 已登记底层动作

下表为适配器登记表，不代表未连接的协议端也支持；运行时只返回当前确认支持的子集。每项参数由具体能力查询提供。

| 类别 | 动作 | 用途 | 类型 |
| --- | --- | --- | --- |
| 连接与运维 | `.handle_quick_operation` | 处理快速操作 | 写入 |
| 媒体与识别 | `.ocr_image` | 图片 OCR 识别 (内部) | 读取 |
| 消息与互动 | `ArkShareGroup` | 分享群 (Ark) | 读取 |
| 消息与互动 | `ArkSharePeer` | 分享用户 (Ark) | 读取 |
| 群资料与管理 | `_del_group_notice` | 删除群公告 | 写入 |
| 群资料与管理 | `_get_group_notice` | 获取群公告 | 读取 |
| 账号资料 | `_get_model_show` | 获取机型显示 | 读取 |
| 消息与互动 | `_mark_all_as_read` | 标记所有消息已读 | 写入 |
| 群资料与管理 | `_send_group_notice` | 发送群公告 | 写入 |
| 账号资料 | `_set_model_show` | 设置机型 | 写入 |
| 收藏表情 | `add_custom_face` | 添加自定义表情 | 写入 |
| 连接与运维 | `bot_exit` | 退出登录 | 写入 |
| 连接与运维 | `can_send_image` | 是否可以发送图片 | 读取 |
| 媒体与识别 | `can_send_record` | 是否可以发送语音 | 读取 |
| 群相册 | `cancel_group_album_media_like` | 取消点赞群相册媒体 | 写入 |
| 群资料与管理 | `cancel_group_todo` | 取消群待办 | 写入 |
| 文件与传输 | `cancel_online_file` | 取消在线文件 | 写入 |
| 连接与运维 | `check_url_safely` | 检查URL安全性 | 读取 |
| 连接与运维 | `clean_cache` | 清理缓存 | 写入 |
| 文件与传输 | `clean_stream_temp_file` | 清理流式传输临时文件 | 写入 |
| 消息与互动 | `click_inline_keyboard_button` | 点击内联键盘按钮 | 写入 |
| 群资料与管理 | `complete_group_todo` | 完成群待办 | 写入 |
| 连接与运维 | `create_collection` | 创建收藏 | 写入 |
| 文件与传输 | `create_flash_task` | 创建闪传任务 | 写入 |
| 文件与传输 | `create_group_file_folder` | 创建群文件目录 | 写入 |
| 群相册 | `del_group_album_media` | 删除群相册媒体 | 写入 |
| 收藏表情 | `delete_custom_face` | 删除自定义表情 | 写入 |
| 消息与互动 | `delete_essence_msg` | 移出精华消息 | 写入 |
| 好友与请求 | `delete_friend` | 删除好友 | 写入 |
| 文件与传输 | `delete_group_file` | 删除群文件 | 写入 |
| 文件与传输 | `delete_group_folder` | 删除群文件目录 | 写入 |
| 消息与互动 | `delete_msg` | 撤回消息 | 写入 |
| 空间 | `delete_qzone_msg` | 删除QQ空间说说 | 写入 |
| 群相册 | `do_group_album_comment` | 发表群相册评论 | 写入 |
| 文件与传输 | `download_file` | 下载文件 | 写入 |
| 文件与传输 | `download_file_image_stream` | 下载图片文件流 | 写入 |
| 文件与传输 | `download_file_record_stream` | 下载语音文件流 | 写入 |
| 文件与传输 | `download_file_stream` | 下载文件流 | 写入 |
| 文件与传输 | `download_fileset` | 下载文件集 | 写入 |
| 收藏表情 | `fetch_custom_face` | 获取自定义表情 | 读取 |
| 收藏表情 | `fetch_custom_face_detail` | 获取自定义表情详情 | 读取 |
| 消息与互动 | `fetch_emoji_like` | 获取表情点赞详情 | 读取 |
| 媒体与识别 | `fetch_ptt_text` | 获取语音转文字结果 | 读取 |
| 好友与请求 | `forward_friend_single_msg` | 转发单条消息 | 写入 |
| 消息与互动 | `forward_group_single_msg` | 转发单条消息 | 写入 |
| 好友与请求 | `friend_poke` | 发送戳一戳 | 写入 |
| 媒体与识别 | `get_ai_characters` | 获取AI角色列表 | 读取 |
| 媒体与识别 | `get_ai_record` | 获取 AI 语音 | 写入 |
| 连接与运维 | `get_clientkey` | 获取ClientKey | 读取 |
| 连接与运维 | `get_collection_list` | 获取收藏列表 | 读取 |
| 连接与运维 | `get_cookies` | 获取 Cookies | 读取 |
| 连接与运维 | `get_credentials` | 获取登录凭证 | 读取 |
| 连接与运维 | `get_csrf_token` | 获取 CSRF Token | 读取 |
| 好友与请求 | `get_doubt_friends_add_request` | 获取可疑好友申请 | 读取 |
| 消息与互动 | `get_emoji_likes` | 获取消息表情点赞列表 | 读取 |
| 消息与互动 | `get_essence_msg_list` | 获取群精华消息 | 读取 |
| 文件与传输 | `get_file` | 获取文件 | 读取 |
| 文件与传输 | `get_fileset_id` | 获取文件集 ID | 读取 |
| 文件与传输 | `get_fileset_info` | 获取文件集信息 | 读取 |
| 文件与传输 | `get_flash_file_list` | 获取闪传文件列表 | 读取 |
| 文件与传输 | `get_flash_file_url` | 获取闪传文件链接 | 读取 |
| 消息与互动 | `get_forward_msg` | 获取合并转发消息 | 读取 |
| 好友与请求 | `get_friend_list` | 获取好友列表 | 读取 |
| 好友与请求 | `get_friend_msg_history` | 获取好友历史消息 | 读取 |
| 好友与请求 | `get_friends_with_category` | 获取带分组的好友列表 | 读取 |
| 群相册 | `get_group_album_media_list` | 获取群相册媒体列表 | 读取 |
| 群资料与管理 | `get_group_at_all_remain` | 获取群艾特全体剩余次数 | 读取 |
| 群资料与管理 | `get_group_detail_info` | 获取群详细信息 | 读取 |
| 文件与传输 | `get_group_file_system_info` | 获取群文件系统信息 | 读取 |
| 文件与传输 | `get_group_file_url` | 获取群文件URL | 读取 |
| 文件与传输 | `get_group_files_by_folder` | 获取群文件夹文件列表 | 读取 |
| 群资料与管理 | `get_group_honor_info` | 获取群荣誉信息 | 读取 |
| 群资料与管理 | `get_group_ignore_add_request` | 获取群被忽略的加群请求 | 读取 |
| 群资料与管理 | `get_group_ignored_notifies` | 获取群忽略通知 | 读取 |
| 群资料与管理 | `get_group_info` | 获取群信息 | 读取 |
| 群资料与管理 | `get_group_info_ex` | 获取群详细信息 (扩展) | 读取 |
| 群资料与管理 | `get_group_list` | 获取群列表 | 读取 |
| 群资料与管理 | `get_group_member_info` | 获取群成员信息 | 读取 |
| 群资料与管理 | `get_group_member_list` | 获取群成员列表 | 读取 |
| 消息与互动 | `get_group_msg_history` | 获取群历史消息 | 读取 |
| 文件与传输 | `get_group_root_files` | 获取群根目录文件列表 | 读取 |
| 群资料与管理 | `get_group_share_link` | 获取群分享链接 | 读取 |
| 群资料与管理 | `get_group_shut_list` | 获取群禁言列表 | 读取 |
| 消息与互动 | `get_group_signed_list` | 获取群组今日打卡列表 | 读取 |
| 消息与互动 | `get_group_system_msg` | 获取群系统消息 | 读取 |
| 连接与运维 | `get_guild_list` | 获取频道列表 | 读取 |
| 文件与传输 | `get_guild_service_profile` | 获取频道个人信息 | 读取 |
| 媒体与识别 | `get_image` | 获取图片 | 读取 |
| 连接与运维 | `get_login_info` | 获取登录号信息 | 读取 |
| 消息与互动 | `get_mini_app_ark` | 获取小程序 Ark | 读取 |
| 消息与互动 | `get_msg` | 获取消息 | 读取 |
| 连接与运维 | `get_online_clients` | 获取在线客户端 | 读取 |
| 文件与传输 | `get_online_file_msg` | 获取在线文件消息 | 读取 |
| 文件与传输 | `get_private_file_url` | 获取私聊文件URL | 读取 |
| 文件与传输 | `get_profile_like` | 获取资料点赞 | 读取 |
| 群相册 | `get_qun_album_list` | 获取群相册列表 | 读取 |
| 连接与运维 | `get_recent_contact` | 获取最近会话 | 读取 |
| 媒体与识别 | `get_record` | 获取语音 | 读取 |
| 连接与运维 | `get_rkey` | 获取扩展 RKey | 读取 |
| 连接与运维 | `get_rkey_server` | 获取 RKey 服务器 | 读取 |
| 连接与运维 | `get_robot_uin_range` | 获取机器人 UIN 范围 | 读取 |
| 连接与运维 | `get_share_link` | 获取文件分享链接 | 读取 |
| 连接与运维 | `get_status` | 获取运行状态 | 读取 |
| 好友与请求 | `get_stranger_info` | 获取陌生人信息 | 读取 |
| 好友与请求 | `get_unidirectional_friend_list` | 获取单向好友列表 | 读取 |
| 连接与运维 | `get_version_info` | 获取版本信息 | 读取 |
| 消息与互动 | `group_poke` | 发送戳一戳 | 写入 |
| 消息与互动 | `mark_group_msg_as_read` | 标记群聊已读 | 写入 |
| 消息与互动 | `mark_msg_as_read` | 标记消息已读 (Go-CQHTTP) | 写入 |
| 消息与互动 | `mark_private_msg_as_read` | 标记私聊已读 | 写入 |
| 文件与传输 | `move_group_file` | 移动群文件 | 写入 |
| 连接与运维 | `nc_get_packet_status` | 获取Packet状态 | 读取 |
| 连接与运维 | `nc_get_rkey` | 获取 RKey | 读取 |
| 连接与运维 | `nc_get_user_status` | 获取用户在线状态 | 读取 |
| 媒体与识别 | `ocr_image` | 图片 OCR 识别 | 读取 |
| 文件与传输 | `receive_online_file` | 接收在线文件 | 写入 |
| 文件与传输 | `refuse_online_file` | 拒绝在线文件 | 写入 |
| 文件与传输 | `rename_group_file` | 重命名群文件 | 写入 |
| 消息与互动 | `send_ark_share` | 分享用户 (Ark) | 写入 |
| 文件与传输 | `send_flash_msg` | 发送闪传消息 | 写入 |
| 消息与互动 | `send_forward_msg` | 发送合并转发消息 | 写入 |
| 媒体与识别 | `send_group_ai_record` | 发送群 AI 语音 | 写入 |
| 群资料与管理 | `send_group_ark_share` | 分享群 (Ark) | 写入 |
| 消息与互动 | `send_group_forward_msg` | 发送群合并转发消息 | 写入 |
| 消息与互动 | `send_group_msg` | 发送群消息 | 写入 |
| 消息与互动 | `send_group_sign` | 群打卡 | 写入 |
| 消息与互动 | `send_like` | 点赞 | 写入 |
| 消息与互动 | `send_msg` | 发送消息 | 写入 |
| 文件与传输 | `send_online_file` | 发送在线文件 | 写入 |
| 文件与传输 | `send_online_folder` | 发送在线文件夹 | 写入 |
| 连接与运维 | `send_packet` | 发送原始数据包 | 写入 |
| 消息与互动 | `send_poke` | 发送戳一戳 | 写入 |
| 消息与互动 | `send_private_forward_msg` | 发送私聊合并转发消息 | 写入 |
| 消息与互动 | `send_private_msg` | 发送私聊消息 | 写入 |
| 空间 | `send_qzone_msg` | 发表QQ空间说说 | 写入 |
| 收藏表情 | `set_custom_face_desc` | 修改自定义表情描述 | 写入 |
| 账号资料 | `set_diy_online_status` | 设置自定义在线状态 | 写入 |
| 好友与请求 | `set_doubt_friends_add_request` | 处理可疑好友申请 | 写入 |
| 消息与互动 | `set_essence_msg` | 设置精华消息 | 写入 |
| 好友与请求 | `set_friend_add_request` | 处理加好友请求 | 写入 |
| 好友与请求 | `set_friend_remark` | 设置好友备注 | 写入 |
| 群资料与管理 | `set_group_add_option` | 设置群加群选项 | 写入 |
| 群资料与管理 | `set_group_add_request` | 处理加群请求 | 写入 |
| 群资料与管理 | `set_group_admin` | 设置群管理员 | 写入 |
| 群相册 | `set_group_album_media_like` | 点赞群相册媒体 | 写入 |
| 群资料与管理 | `set_group_ban` | 群组禁言 | 写入 |
| 群资料与管理 | `set_group_card` | 设置群名片 | 写入 |
| 群资料与管理 | `set_group_kick` | 群组踢人 | 写入 |
| 群资料与管理 | `set_group_kick_members` | 批量踢出群成员 | 写入 |
| 群资料与管理 | `set_group_leave` | 退出群组 | 写入 |
| 群资料与管理 | `set_group_member_invite_policy` | 设置群成员邀请策略 | 写入 |
| 群资料与管理 | `set_group_member_permissions` | 设置群成员功能权限 | 写入 |
| 群资料与管理 | `set_group_name` | 设置群名称 | 写入 |
| 群资料与管理 | `set_group_new_member_history_visibility` | 设置新成员历史消息可见性 | 写入 |
| 群资料与管理 | `set_group_portrait` | 设置群头像 | 写入 |
| 群资料与管理 | `set_group_remark` | 设置群备注 | 写入 |
| 群资料与管理 | `set_group_robot_add_option` | 设置群机器人加群选项 | 写入 |
| 群资料与管理 | `set_group_search` | 设置群搜索选项 | 写入 |
| 消息与互动 | `set_group_sign` | 群打卡 | 写入 |
| 群资料与管理 | `set_group_special_title` | 设置专属头衔 | 写入 |
| 群资料与管理 | `set_group_todo` | 设置群待办 | 写入 |
| 群资料与管理 | `set_group_whole_ban` | 全员禁言 | 写入 |
| 消息与互动 | `set_input_status` | 设置输入状态 | 写入 |
| 消息与互动 | `set_msg_emoji_like` | 设置消息表情点赞 | 写入 |
| 账号资料 | `set_online_status` | 设置在线状态 | 写入 |
| 账号资料 | `set_qq_avatar` | 设置QQ头像 | 写入 |
| 文件与传输 | `set_qq_profile` | 设置QQ资料 | 写入 |
| 连接与运维 | `set_restart` | 重启服务 | 写入 |
| 账号资料 | `set_self_longnick` | 设置个性签名 | 写入 |
| 文件与传输 | `trans_group_file` | 传输群文件 | 写入 |
| 连接与运维 | `translate_en2zh` | 英文单词翻译 | 读取 |
| 文件与传输 | `upload_file_stream` | 上传文件流 | 写入 |
| 文件与传输 | `upload_group_file` | 上传群文件 | 写入 |
| 群相册 | `upload_image_to_qun_album` | 上传图片到群相册 | 写入 |
| 群相册 | `upload_images_to_qun_album` | 上传多张图片到群相册 | 写入 |
| 文件与传输 | `upload_private_file` | 上传私聊文件 | 写入 |
| 群相册 | `upload_video_to_qun_album` | 上传视频到群相册 | 写入 |

插件接入见[扩展开发](EXTENDING.md)，模型与会话见[插件模型](PLUGIN_MODELS.md)。
