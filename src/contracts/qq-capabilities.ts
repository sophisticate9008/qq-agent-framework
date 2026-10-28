import type { JsonObject } from './data.ts';

export type QqCapabilityPermission = 'all' | 'owner' | 'autonomous';
export interface QqCapabilityDefinition {
  readonly id: string;
  readonly description: string;
  readonly category: string;
  readonly inputSchema: JsonObject;
  readonly write: boolean;
  /** Default entry policy; trusted host services enforce their own caller identity. */
  readonly permission: QqCapabilityPermission;
  readonly scope: { readonly kind: 'account' | 'group' | 'conversation'; readonly targetFields: readonly string[] };
  readonly transport: 'json' | 'stream';
  readonly returnsVoid: boolean;
}
export interface QqCapabilitiesInspection {
  readonly protocol: string;
  readonly version: string | null;
  readonly source: 'napcat-version-map' | 'reported-actions' | 'unverified';
  readonly supportedIds: readonly string[];
}
export const QQ_CAPABILITY_CATEGORIES = Object.freeze([
  { "id": "messages", "label": "消息与互动", "description": "消息发送、查询、撤回与互动" },
  { "id": "stickers", "label": "收藏表情", "description": "收藏表情查询、添加、删除与描述" },
  { "id": "profile", "label": "账号资料", "description": "账号资料、昵称、头像及状态" },
  { "id": "friends", "label": "好友与请求", "description": "好友目录、备注与好友申请" },
  { "id": "groups", "label": "群资料与管理", "description": "群目录、成员、申请及管理" },
  { "id": "files", "label": "文件与传输", "description": "群文件、在线文件、闪传与流传输" },
  { "id": "albums", "label": "群相册", "description": "群相册、媒体、点赞与评论" },
  { "id": "qzone", "label": "空间", "description": "QQ空间说说发布与删除" },
  { "id": "media", "label": "媒体与识别", "description": "图片、语音、识别与AI语音" },
  { "id": "system", "label": "连接与运维", "description": "协议身份、凭据、诊断与运维" },
] as const);

/** Payloads statically checked against the installed NapCat 4.18.41 action registry.
 * Handler defaults remain visible; handler-required alternatives are made explicit.
 * Test actions and generated async/rate-limited aliases are excluded. */
const SCHEMA_0: JsonObject = {
  "type": "object",
  "properties": { "character": { "type": "string", "description": "角色ID" }, "group_id": { "type": "string", "description": "群号" }, "text": { "type": "string", "description": "语音文本内容" } },
  "additionalProperties": false,
  "required": ["character", "group_id", "text"]
};
const SCHEMA_1: JsonObject = {
  "type": { "const": "face" },
  "data": {
    "type": "object",
    "properties": { "id": { "type": "string", "description": "表情ID" }, "resultId": { "type": "string", "description": "结果ID" }, "chainCount": { "type": "number", "description": "连击数" } },
    "additionalProperties": false,
    "required": ["id"]
  }
};
const SCHEMA_2: JsonObject = {
  "type": "object",
  "properties": { "user_id": { "type": "string", "description": "用户 QQ" }, "msg_id": { "type": "string", "description": "消息 ID" }, "element_id": { "type": "string", "description": "元素 ID" } },
  "additionalProperties": false,
  "required": ["user_id", "msg_id", "element_id"]
};
const SCHEMA_3: JsonObject = {
  "data": { "anyOf": [{ "type": "string" }, { "type": "object", "properties": {  }, "additionalProperties": false }], "description": "JSON数据" },
  "config": { "type": "object", "properties": { "token": { "type": "string", "description": "token" } }, "additionalProperties": false, "required": ["token"] }
};
const SCHEMA_4: JsonObject = {
  "type": "object",
  "properties": {
    "message_id": { "anyOf": [{ "type": "number" }, { "type": "string" }], "description": "消息ID" },
    "group_id": { "type": "string", "description": "目标群号" },
    "user_id": { "type": "string", "description": "目标用户QQ" }
  },
  "additionalProperties": false,
  "required": ["message_id"]
};
const SCHEMA_5: JsonObject = {
  "type": "object",
  "properties": {
    "group_id": { "anyOf": [{ "type": "string" }, { "type": "number" }], "description": "群号" },
    "message_id": { "type": "string", "description": "消息ID" },
    "message_seq": { "type": "string", "description": "消息Seq (可选)" }
  },
  "additionalProperties": false,
  "required": ["group_id"]
};
const SCHEMA_6: JsonObject = {
  "type": "object",
  "properties": {
    "type": { "anyOf": [{ "const": "qq" }, { "const": "163" }, { "const": "kugou" }, { "const": "migu" }, { "const": "kuwo" }], "description": "音乐平台类型" },
    "id": { "anyOf": [{ "type": "string" }, { "type": "number" }], "description": "音乐ID" }
  },
  "additionalProperties": false,
  "required": ["type", "id"]
};
const SCHEMA_7: JsonObject = {
  "type": "object",
  "properties": {
    "file": { "type": "string", "description": "文件路径或 URL" },
    "file_id": { "type": "string", "description": "文件 ID" },
    "chunk_size": { "type": "number", "default": 65536, "description": "分块大小 (字节)" }
  },
  "additionalProperties": false,
  "anyOf": [{ "required": ["file"] }, { "required": ["file_id"] }]
};
const SCHEMA_8: JsonObject = {
  "type": "object",
  "properties": {
    "type": { "const": "xml" },
    "data": { "type": "object", "properties": { "data": { "type": "string", "description": "XML数据" } }, "additionalProperties": false, "required": ["data"] }
  },
  "additionalProperties": false,
  "required": ["type", "data"],
  "$id": "OB11MessageXml",
  "description": "XML消息段"
};
const SCHEMA_9: JsonObject = {
  "type": "object",
  "properties": {
    "type": { "const": "text" },
    "data": { "type": "object", "properties": { "text": { "type": "string", "description": "纯文本内容" } }, "additionalProperties": false, "required": ["text"] }
  },
  "additionalProperties": false,
  "required": ["type", "data"],
  "$id": "OB11MessageText",
  "description": "纯文本消息段"
};
const SCHEMA_10: JsonObject = {
  "type": "object",
  "properties": {
    "type": { "const": "miniapp" },
    "data": { "type": "object", "properties": { "data": { "type": "string", "description": "小程序数据" } }, "additionalProperties": false, "required": ["data"] }
  },
  "additionalProperties": false,
  "required": ["type", "data"],
  "$id": "OB11MessageMiniApp",
  "description": "小程序消息段"
};
const SCHEMA_11: JsonObject = {
  "type": "object",
  "properties": {
    "group_id": { "type": "string", "description": "群号" },
    "album_id": { "type": "string", "description": "相册ID" },
    "batch_id": { "type": "string", "description": "batch_id" },
    "lloc": { "type": "string", "description": "lloc，若对整个上传操作则不填" }
  },
  "additionalProperties": false,
  "required": ["group_id", "album_id", "batch_id"]
};
const SCHEMA_12: JsonObject = { "type": { "const": "music" }, "data": SCHEMA_6 };
const SCHEMA_13: JsonObject = {
  "type": "object",
  "properties": {
    "type": { "const": "markdown" },
    "data": { "type": "object", "properties": { "content": { "type": "string", "description": "Markdown内容" } }, "additionalProperties": false, "required": ["content"] }
  },
  "additionalProperties": false,
  "required": ["type", "data"],
  "$id": "OB11MessageMarkdown",
  "description": "Markdown消息段"
};
const SCHEMA_14: JsonObject = {
  "type": "object",
  "properties": {
    "emoji_package_id": { "type": "number", "description": "表情包ID" },
    "emoji_id": { "type": "string", "description": "表情ID" },
    "key": { "type": "string", "description": "表情key" },
    "summary": { "type": "string", "description": "表情摘要" }
  },
  "additionalProperties": false,
  "required": ["emoji_package_id", "emoji_id", "key", "summary"]
};
const SCHEMA_15: JsonObject = {
  "type": "object",
  "properties": {
    "lat": { "anyOf": [{ "type": "string" }, { "type": "number" }], "description": "纬度" },
    "lon": { "anyOf": [{ "type": "string" }, { "type": "number" }], "description": "经度" },
    "title": { "type": "string", "description": "标题" },
    "content": { "type": "string", "description": "内容" }
  },
  "additionalProperties": false,
  "required": ["lat", "lon"]
};
const SCHEMA_16: JsonObject = {
  "type": "object",
  "properties": {
    "type": { "const": "flashtransfer" },
    "data": { "type": "object", "properties": { "fileSetId": { "type": "string", "description": "文件集ID" } }, "additionalProperties": false, "required": ["fileSetId"] }
  },
  "additionalProperties": false,
  "required": ["type", "data"],
  "$id": "OB11MessageFlashTransfer",
  "description": "QQ闪传消息段"
};
const SCHEMA_17: JsonObject = {
  "type": "object",
  "properties": {
    "type": { "const": "rps" },
    "data": {
      "type": "object",
      "properties": { "result": { "anyOf": [{ "type": "number" }, { "type": "string" }], "description": "猜拳结果" } },
      "additionalProperties": false,
      "required": ["result"]
    }
  },
  "additionalProperties": false,
  "required": ["type", "data"],
  "$id": "OB11MessageRPS",
  "description": "猜拳消息段"
};
const SCHEMA_18: JsonObject = {
  "type": "object",
  "properties": {
    "type": { "const": "dice" },
    "data": {
      "type": "object",
      "properties": { "result": { "anyOf": [{ "type": "number" }, { "type": "string" }], "description": "骰子结果" } },
      "additionalProperties": false,
      "required": ["result"]
    }
  },
  "additionalProperties": false,
  "required": ["type", "data"],
  "$id": "OB11MessageDice",
  "description": "骰子消息段"
};
const SCHEMA_19: JsonObject = {
  "type": "object",
  "properties": {
    "type": { "const": "reply" },
    "data": {
      "type": "object",
      "properties": { "id": { "type": "string", "description": "消息ID的短ID映射" }, "seq": { "type": "number", "description": "消息序列号，优先使用" } },
      "additionalProperties": false
    }
  },
  "additionalProperties": false,
  "required": ["type", "data"],
  "$id": "OB11MessageReply",
  "description": "回复消息段"
};
const SCHEMA_20: JsonObject = {
  "type": "object",
  "properties": {
    "type": { "const": "at" },
    "data": {
      "type": "object",
      "properties": { "qq": { "type": "string", "description": "QQ号或all" }, "name": { "type": "string", "description": "显示名称" } },
      "additionalProperties": false,
      "required": ["qq"]
    }
  },
  "additionalProperties": false,
  "required": ["type", "data"],
  "$id": "OB11MessageAt",
  "description": "@消息段"
};
const SCHEMA_21: JsonObject = {
  "file": { "type": "string", "description": "文件路径/URL/file:///" },
  "path": { "type": "string", "description": "文件路径" },
  "url": { "type": "string", "description": "文件URL" },
  "name": { "type": "string", "description": "文件名" },
  "thumb": { "type": "string", "description": "缩略图" },
  "summary": { "type": "string", "description": "图片摘要" },
  "sub_type": { "type": "number", "description": "图片子类型" }
};
const SCHEMA_22: JsonObject = { "type": "object", "properties": SCHEMA_3, "additionalProperties": false, "required": ["data"] };
const SCHEMA_23: JsonObject = {
  "type": "object",
  "properties": {
    "type": { "const": "poke" },
    "data": {
      "type": "object",
      "properties": { "type": { "type": "string", "description": "戳一戳类型" }, "id": { "type": "string", "description": "戳一戳ID" } },
      "additionalProperties": false,
      "required": ["type", "id"]
    }
  },
  "additionalProperties": false,
  "required": ["type", "data"],
  "$id": "OB11MessagePoke",
  "description": "戳一戳消息段"
};
const SCHEMA_24: JsonObject = {
  "type": "object",
  "properties": {
    "type": { "const": "forward" },
    "data": {
      "type": "object",
      "properties": { "id": { "type": "string", "description": "合并转发ID" }, "content": { "description": "消息内容 (OB11Message[])" } },
      "additionalProperties": false,
      "required": ["id"]
    }
  },
  "additionalProperties": false,
  "required": ["type", "data"],
  "$id": "OB11MessageForward",
  "description": "合并转发消息段"
};
const SCHEMA_25: JsonObject = { "type": { "const": "mface" }, "data": SCHEMA_14 };
const SCHEMA_26: JsonObject = { "type": { "const": "location" }, "data": SCHEMA_15 };
const SCHEMA_27: JsonObject = {
  "type": "object",
  "properties": {
    "file": { "type": "string", "description": "文件路径/URL/file:///" },
    "path": { "type": "string", "description": "文件路径" },
    "url": { "type": "string", "description": "文件URL" },
    "name": { "type": "string", "description": "文件名" },
    "thumb": { "type": "string", "description": "缩略图" }
  },
  "additionalProperties": false,
  "required": ["file"],
  "$id": "FileBaseData",
  "description": "文件消息段基础数据"
};
const SCHEMA_28: JsonObject = {
  "type": "object",
  "properties": {
    "msgId": { "type": "string", "description": "消息ID" },
    "elementId": { "type": "string", "description": "元素ID" },
    "fileName": { "type": "string", "description": "文件名" },
    "fileSize": { "type": "string", "description": "文件大小" },
    "isDir": { "type": "boolean", "description": "是否为目录" }
  },
  "additionalProperties": false,
  "required": ["msgId", "elementId", "fileName", "fileSize", "isDir"]
};
const SCHEMA_29: JsonObject = { "type": { "const": "json" }, "data": SCHEMA_22 };
const SCHEMA_30: JsonObject = {
  "type": "object",
  "properties": {
    "type": { "const": "contact" },
    "data": {
      "type": "object",
      "properties": { "type": { "anyOf": [{ "const": "qq" }, { "const": "group" }], "description": "联系人类型" }, "id": { "type": "string", "description": "联系人ID" } },
      "additionalProperties": false,
      "required": ["type", "id"]
    }
  },
  "additionalProperties": false,
  "required": ["type", "data"],
  "$id": "OB11MessageContact",
  "description": "联系人消息段"
};
const SCHEMA_31: JsonObject = { "type": "object", "properties": SCHEMA_1, "additionalProperties": false, "required": ["type", "data"], "$id": "OB11MessageFace", "description": "QQ表情消息段" };
const SCHEMA_32: JsonObject = { "type": { "const": "file" }, "data": SCHEMA_27 };
const SCHEMA_33: JsonObject = { "type": { "const": "video" }, "data": SCHEMA_27 };
const SCHEMA_34: JsonObject = { "type": { "const": "record" }, "data": SCHEMA_27 };
const SCHEMA_35: JsonObject = { "type": { "const": "onlinefile" }, "data": SCHEMA_28 };
const SCHEMA_36: JsonObject = { "type": "object", "properties": SCHEMA_21, "additionalProperties": false, "required": ["file"] };
const SCHEMA_37: JsonObject = {
  "type": { "anyOf": [{ "const": "qq" }, { "const": "163" }, { "const": "kugou" }, { "const": "migu" }, { "const": "kuwo" }, { "const": "custom" }], "description": "音乐平台类型" },
  "id": { "not": {  }, "description": "协议字段必须省略" },
  "url": { "type": "string", "description": "点击后跳转URL" },
  "audio": { "type": "string", "description": "音频URL" },
  "title": { "type": "string", "description": "音乐标题" },
  "image": { "type": "string", "description": "封面图片URL" },
  "content": { "type": "string", "description": "音乐简介" }
};
const SCHEMA_38: JsonObject = { "type": { "const": "image" }, "data": SCHEMA_36 };
const SCHEMA_39: JsonObject = { "type": "object", "properties": SCHEMA_12, "additionalProperties": false, "required": ["type", "data"], "$id": "OB11MessageIdMusic", "description": "ID音乐消息段" };
const SCHEMA_40: JsonObject = { "type": "object", "properties": SCHEMA_25, "additionalProperties": false, "required": ["type", "data"], "$id": "OB11MessageMFace", "description": "商城表情消息段" };
const SCHEMA_41: JsonObject = { "type": "object", "properties": SCHEMA_26, "additionalProperties": false, "required": ["type", "data"], "$id": "OB11MessageLocation", "description": "位置消息段" };
const SCHEMA_42: JsonObject = { "type": "object", "properties": SCHEMA_29, "additionalProperties": false, "required": ["type", "data"], "$id": "OB11MessageJson", "description": "JSON消息段" };
const SCHEMA_43: JsonObject = { "type": "object", "properties": SCHEMA_37, "additionalProperties": false, "required": ["type", "url", "image"] };
const SCHEMA_44: JsonObject = { "type": "object", "properties": SCHEMA_32, "additionalProperties": false, "required": ["type", "data"], "$id": "OB11MessageFile", "description": "文件消息段" };
const SCHEMA_45: JsonObject = { "type": "object", "properties": SCHEMA_33, "additionalProperties": false, "required": ["type", "data"], "$id": "OB11MessageVideo", "description": "视频消息段" };
const SCHEMA_46: JsonObject = { "type": "object", "properties": SCHEMA_34, "additionalProperties": false, "required": ["type", "data"], "$id": "OB11MessageRecord", "description": "语音消息段" };
const SCHEMA_47: JsonObject = { "type": "object", "properties": SCHEMA_35, "additionalProperties": false, "required": ["type", "data"], "$id": "OB11MessageOnlineFile", "description": "在线文件消息段" };
const SCHEMA_48: JsonObject = { "type": { "const": "music" }, "data": SCHEMA_43 };
const SCHEMA_49: JsonObject = { "type": "object", "properties": SCHEMA_38, "additionalProperties": false, "required": ["type", "data"], "$id": "OB11MessageImage", "description": "图片消息段" };
const SCHEMA_50: JsonObject = { "type": "object", "properties": SCHEMA_48, "additionalProperties": false, "required": ["type", "data"], "$id": "OB11MessageCustomMusic", "description": "自定义音乐消息段" };
const SCHEMA_51: JsonObject = {
  "id": { "type": "string", "description": "转发消息ID" },
  "user_id": { "anyOf": [{ "type": "number" }, { "type": "string" }], "description": "发送者QQ号" },
  "uin": { "anyOf": [{ "type": "number" }, { "type": "string" }], "description": "发送者QQ号(兼容go-cqhttp)" },
  "nickname": { "type": "string", "description": "发送者昵称" },
  "name": { "type": "string", "description": "发送者昵称(兼容go-cqhttp)" },
  "content": { "description": "消息内容 (OB11MessageMixType)" },
  "source": { "type": "string", "description": "消息来源" },
  "news": { "type": "array", "items": { "type": "object", "properties": { "text": { "type": "string", "description": "新闻文本" } }, "additionalProperties": false, "required": ["text"] } },
  "summary": { "type": "string", "description": "摘要" },
  "prompt": { "type": "string", "description": "提示" },
  "time": { "type": "string", "description": "时间" }
};
const SCHEMA_52: JsonObject = { "type": "object", "properties": SCHEMA_51, "additionalProperties": false, "required": ["nickname", "content"] };
const SCHEMA_53: JsonObject = { "type": { "const": "node" }, "data": SCHEMA_52 };
const SCHEMA_54: JsonObject = { "type": "object", "properties": SCHEMA_53, "additionalProperties": false, "required": ["type", "data"], "$id": "OB11MessageNode", "description": "合并转发消息节点" };
const SCHEMA_55: JsonObject = {
  "anyOf": [SCHEMA_9, SCHEMA_31, SCHEMA_40, SCHEMA_20, SCHEMA_19, SCHEMA_49, SCHEMA_46, SCHEMA_45, SCHEMA_44, SCHEMA_39, SCHEMA_50, SCHEMA_23, SCHEMA_18, SCHEMA_17, SCHEMA_30, SCHEMA_41, SCHEMA_42, SCHEMA_8, SCHEMA_13, SCHEMA_10, SCHEMA_54, SCHEMA_24, SCHEMA_47, SCHEMA_16],
  "$id": "OB11MessageData",
  "description": "OneBot 11 消息段"
};
const SCHEMA_56: JsonObject = { "type": "array", "items": SCHEMA_55 };
const SCHEMA_57: JsonObject = { "anyOf": [SCHEMA_56, { "type": "string" }, SCHEMA_55], "$id": "OB11MessageMixType", "description": "OneBot 11 消息混合类型" };
const SCHEMA_58: JsonObject = {
  "message_type": { "anyOf": [{ "const": "private" }, { "const": "group" }], "description": "消息类型 (private/group)" },
  "user_id": { "type": "string", "description": "用户QQ" },
  "group_id": { "type": "string", "description": "群号" },
  "message": SCHEMA_57,
  "auto_escape": { "anyOf": [{ "type": "boolean" }, { "type": "string" }], "description": "是否作为纯文本发送" },
  "source": { "type": "string", "description": "合并转发来源" },
  "news": { "type": "array", "items": { "type": "object", "properties": { "text": { "type": "string" } }, "additionalProperties": false, "required": ["text"] }, "description": "合并转发新闻" },
  "summary": { "type": "string", "description": "合并转发摘要" },
  "prompt": { "type": "string", "description": "合并转发提示" },
  "timeout": { "type": "number", "description": "自定义发送超时(毫秒)，覆盖自动计算值" }
};
const SCHEMA_59: JsonObject = { "type": "object", "properties": SCHEMA_58, "additionalProperties": false, "required": ["message", "user_id"] };
const SCHEMA_60: JsonObject = { "type": "object", "properties": SCHEMA_58, "additionalProperties": false, "required": ["message", "group_id"] };
const SCHEMA_61: JsonObject = { "type": "object", "properties": SCHEMA_58, "additionalProperties": false, "required": ["message"], "anyOf": [{ "required": ["group_id"] }, { "required": ["user_id"] }] };

export const QQ_CAPABILITIES: readonly QqCapabilityDefinition[] = Object.freeze([
  {
    "id": ".handle_quick_operation",
    "description": "处理快速操作",
    "category": "system",
    "inputSchema": {
      "type": "object",
      "properties": {
        "context": {
          "type": "object",
          "properties": {
            "time": { "type": "number", "description": "事件发生时间" },
            "self_id": { "type": "number", "description": "收到事件的机器人 QQ 号" },
            "post_type": { "type": "string", "description": "上报类型" },
            "message_type": { "type": "string", "description": "消息类型" },
            "sub_type": { "type": "string", "description": "消息子类型" },
            "user_id": { "type": "string", "description": "发送者 QQ 号" },
            "group_id": { "type": "string", "description": "群号" },
            "message_id": { "type": "number", "description": "消息 ID" },
            "message_seq": { "type": "number", "description": "消息序列号" },
            "real_id": { "type": "number", "description": "真实消息 ID" },
            "sender": {
              "type": "object",
              "properties": {
                "user_id": { "type": "string", "description": "用户ID" },
                "nickname": { "type": "string", "description": "昵称" },
                "sex": { "type": "string", "description": "性别" },
                "age": { "type": "number", "description": "年龄" },
                "card": { "type": "string", "description": "群名片" },
                "level": { "type": "string", "description": "群等级" },
                "role": { "type": "string", "description": "群角色" }
              },
              "additionalProperties": false,
              "required": ["user_id", "nickname"]
            },
            "message": { "description": "消息内容" },
            "message_format": { "type": "string", "description": "消息格式" },
            "raw_message": { "type": "string", "description": "原始消息内容" },
            "font": { "type": "number", "description": "字体" },
            "notice_type": { "type": "string", "description": "通知类型" },
            "meta_event_type": { "type": "string", "description": "元事件类型" }
          },
          "additionalProperties": false,
          "required": ["time", "self_id", "post_type", "user_id"],
          "description": "事件上下文"
        },
        "operation": {
          "type": "object",
          "properties": {
            "reply": SCHEMA_57,
            "auto_escape": { "type": "boolean", "description": "是否作为纯文本发送" },
            "at_sender": { "type": "boolean", "description": "是否 @ 发送者" },
            "delete": { "type": "boolean", "description": "是否撤回该消息" },
            "kick": { "type": "boolean", "description": "是否踢出发送者" },
            "ban": { "type": "boolean", "description": "是否禁言发送者" },
            "ban_duration": { "type": "number", "description": "禁言时长" },
            "approve": { "type": "boolean", "description": "是否同意请求/加群" },
            "remark": { "type": "string", "description": "好友备注" },
            "reason": { "type": "string", "description": "拒绝理由" }
          },
          "additionalProperties": false,
          "description": "快速操作内容"
        }
      },
      "additionalProperties": false,
      "required": ["context", "operation"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": ".ocr_image",
    "description": "图片 OCR 识别 (内部)",
    "category": "media",
    "inputSchema": { "type": "object", "properties": { "image": { "type": "string", "description": "图片路径、URL或Base64" } }, "additionalProperties": false, "required": ["image"] },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "ArkShareGroup",
    "description": "分享群 (Ark)",
    "category": "messages",
    "inputSchema": { "type": "object", "properties": { "group_id": { "type": "string", "description": "群号" } }, "additionalProperties": false, "required": ["group_id"] },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "ArkSharePeer",
    "description": "分享用户 (Ark)",
    "category": "messages",
    "inputSchema": {
      "type": "object",
      "properties": {
        "user_id": { "type": "string", "description": "QQ号" },
        "group_id": { "type": "string", "description": "群号" },
        "phone_number": { "type": "string", "default": "", "description": "手机号" }
      },
      "additionalProperties": false
    },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id", "user_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "_del_group_notice",
    "description": "删除群公告",
    "category": "groups",
    "inputSchema": {
      "type": "object",
      "properties": { "group_id": { "type": "string", "description": "群号" }, "notice_id": { "type": "string", "description": "公告ID" } },
      "additionalProperties": false,
      "required": ["group_id", "notice_id"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "_get_group_notice",
    "description": "获取群公告",
    "category": "groups",
    "inputSchema": { "type": "object", "properties": { "group_id": { "type": "string", "description": "群号" } }, "additionalProperties": false, "required": ["group_id"] },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "_get_model_show",
    "description": "获取机型显示",
    "category": "profile",
    "inputSchema": { "type": "object", "properties": { "model": { "type": "string", "description": "模型名称" } }, "additionalProperties": false },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "_mark_all_as_read",
    "description": "标记所有消息已读",
    "category": "messages",
    "inputSchema": { "type": "object", "properties": {  }, "additionalProperties": false },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "_send_group_notice",
    "description": "发送群公告",
    "category": "groups",
    "inputSchema": {
      "type": "object",
      "properties": {
        "group_id": { "type": "string", "description": "群号" },
        "content": { "type": "string", "description": "公告内容" },
        "image": { "type": "string", "description": "公告图片路径或 URL" },
        "pinned": { "anyOf": [{ "type": "number" }, { "type": "string" }], "default": 0, "description": "是否置顶 (0/1)" },
        "type": { "anyOf": [{ "type": "number" }, { "type": "string" }], "default": 1, "description": "类型 (默认为 1)" },
        "confirm_required": { "anyOf": [{ "type": "number" }, { "type": "string" }], "default": 1, "description": "是否需要确认 (0/1)" },
        "is_show_edit_card": { "anyOf": [{ "type": "number" }, { "type": "string" }], "default": 0, "description": "是否显示修改群名片引导 (0/1)" },
        "tip_window_type": { "anyOf": [{ "type": "number" }, { "type": "string" }], "default": 0, "description": "弹窗类型 (默认为 0)" }
      },
      "additionalProperties": false,
      "required": ["group_id", "content"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "_set_model_show",
    "description": "设置机型",
    "category": "profile",
    "inputSchema": { "type": "object", "properties": {  }, "additionalProperties": false },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "add_custom_face",
    "description": "添加自定义表情",
    "category": "stickers",
    "inputSchema": {
      "type": "object",
      "properties": {
        "file": { "type": "string", "description": "本地表情文件路径" },
        "emoji_id": { "anyOf": [{ "type": "string" }, { "type": "number" }], "description": "表情ID，未提供时传空字符串" },
        "package_id": { "anyOf": [{ "type": "string" }, { "type": "number" }], "description": "表情包ID，未提供时传0" },
        "file_name": { "type": "string", "description": "文件名，未提供时从file路径取basename" },
        "file_size": { "anyOf": [{ "type": "string" }, { "type": "number" }], "description": "文件大小，未提供时读取本地文件" },
        "md5": { "type": "string", "description": "文件MD5，未提供时读取本地文件计算" },
        "is_mark_face": { "type": "boolean", "description": "是否商城表情" },
        "is_origin": { "type": "boolean", "description": "是否原图" }
      },
      "additionalProperties": false,
      "required": ["file"]
    },
    "write": true,
    "permission": "all",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "bot_exit",
    "description": "退出登录",
    "category": "system",
    "inputSchema": { "type": "object", "properties": {  }, "additionalProperties": false },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "can_send_image",
    "description": "是否可以发送图片",
    "category": "system",
    "inputSchema": { "type": "object", "properties": {  }, "additionalProperties": false },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "can_send_record",
    "description": "是否可以发送语音",
    "category": "media",
    "inputSchema": { "type": "object", "properties": {  }, "additionalProperties": false },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "cancel_group_album_media_like",
    "description": "取消点赞群相册媒体",
    "category": "albums",
    "inputSchema": SCHEMA_11,
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "cancel_group_todo",
    "description": "取消群待办",
    "category": "groups",
    "inputSchema": SCHEMA_5,
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id", "message_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "cancel_online_file",
    "description": "取消在线文件",
    "category": "files",
    "inputSchema": {
      "type": "object",
      "properties": { "user_id": { "type": "string", "description": "用户 QQ" }, "msg_id": { "type": "string", "description": "消息 ID" } },
      "additionalProperties": false,
      "required": ["user_id", "msg_id"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": ["user_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "check_url_safely",
    "description": "检查URL安全性",
    "category": "system",
    "inputSchema": { "type": "object", "properties": { "url": { "type": "string", "description": "要检查的 URL" } }, "additionalProperties": false, "required": ["url"] },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "clean_cache",
    "description": "清理缓存",
    "category": "system",
    "inputSchema": { "type": "object", "properties": {  }, "additionalProperties": false },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "clean_stream_temp_file",
    "description": "清理流式传输临时文件",
    "category": "files",
    "inputSchema": { "type": "object", "properties": {  }, "additionalProperties": false },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "click_inline_keyboard_button",
    "description": "点击内联键盘按钮",
    "category": "messages",
    "inputSchema": {
      "type": "object",
      "properties": {
        "group_id": { "type": "string", "description": "群号" },
        "bot_appid": { "type": "string", "description": "机器人AppID" },
        "button_id": { "type": "string", "default": "", "description": "按钮ID" },
        "callback_data": { "type": "string", "default": "", "description": "回调数据" },
        "msg_seq": { "type": "string", "default": "10086", "description": "消息序列号" }
      },
      "additionalProperties": false,
      "required": ["group_id", "bot_appid"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "complete_group_todo",
    "description": "完成群待办",
    "category": "groups",
    "inputSchema": SCHEMA_5,
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id", "message_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "create_collection",
    "description": "创建收藏",
    "category": "system",
    "inputSchema": {
      "type": "object",
      "properties": { "rawData": { "type": "string", "description": "原始数据" }, "brief": { "type": "string", "description": "简要描述" } },
      "additionalProperties": false,
      "required": ["rawData", "brief"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "create_flash_task",
    "description": "创建闪传任务",
    "category": "files",
    "inputSchema": {
      "type": "object",
      "properties": {
        "files": { "anyOf": [{ "type": "array", "items": { "type": "string" } }, { "type": "string" }], "description": "文件列表或单个文件路径" },
        "name": { "type": "string", "description": "任务名称" },
        "thumb_path": { "type": "string", "description": "缩略图路径" },
        "validitySeconds": { "type": "number", "description": "文件集有效期（秒），可选 14 天 1209600 / 90 天 7776000 / 180 天 15552000，默认 1209600" }
      },
      "additionalProperties": false,
      "required": ["files"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "create_group_file_folder",
    "description": "创建群文件目录",
    "category": "files",
    "inputSchema": {
      "type": "object",
      "properties": { "group_id": { "type": "string", "description": "群号" }, "folder_name": { "type": "string", "description": "文件夹名称" }, "name": { "type": "string", "description": "文件夹名称" } },
      "additionalProperties": false,
      "required": ["group_id"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "del_group_album_media",
    "description": "删除群相册媒体",
    "category": "albums",
    "inputSchema": {
      "type": "object",
      "properties": { "group_id": { "type": "string", "description": "群号" }, "album_id": { "type": "string", "description": "相册ID" }, "lloc": { "type": "string", "description": "媒体ID (lloc)" } },
      "additionalProperties": false,
      "required": ["group_id", "album_id", "lloc"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "delete_custom_face",
    "description": "删除自定义表情",
    "category": "stickers",
    "inputSchema": {
      "type": "object",
      "properties": {
        "res_id": {
          "anyOf": [{ "type": "string", "description": "fetch_custom_face_detail返回的resId" }, { "type": "array", "items": { "type": "string", "description": "fetch_custom_face_detail返回的resId" } }]
        },
        "id": {
          "anyOf": [{ "type": "string", "description": "native deleteFavEmoji字符串ID，通常为resId" }, { "type": "array", "items": { "type": "string", "description": "native deleteFavEmoji字符串ID，通常为resId" } }]
        },
        "ids": { "type": "array", "items": { "type": "string", "description": "native deleteFavEmoji字符串ID列表，通常为resId列表" } },
        "md5": {
          "anyOf": [{ "type": "string", "description": "表情MD5，不能直接删除，请先通过fetch_custom_face_detail获取resId" }, { "type": "array", "items": { "type": "string", "description": "表情MD5，不能直接删除，请先通过fetch_custom_face_detail获取resId" } }]
        }
      },
      "additionalProperties": false,
      "anyOf": [{ "required": ["res_id"] }, { "required": ["id"] }, { "required": ["ids"] }]
    },
    "write": true,
    "permission": "all",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "delete_essence_msg",
    "description": "移出精华消息",
    "category": "messages",
    "inputSchema": {
      "type": "object",
      "properties": {
        "message_id": { "anyOf": [{ "type": "number" }, { "type": "string" }], "description": "消息ID" },
        "msg_seq": { "type": "string", "description": "消息序号" },
        "msg_random": { "type": "string", "description": "消息随机数" },
        "group_id": { "type": "string", "description": "群号" }
      },
      "additionalProperties": false
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id", "message_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "delete_friend",
    "description": "删除好友",
    "category": "friends",
    "inputSchema": {
      "type": "object",
      "properties": {
        "friend_id": { "anyOf": [{ "type": "string" }, { "type": "number" }], "description": "好友 QQ 号" },
        "user_id": { "anyOf": [{ "type": "string" }, { "type": "number" }], "description": "用户 QQ 号" },
        "temp_block": { "type": "boolean", "description": "是否加入黑名单" },
        "temp_both_del": { "type": "boolean", "description": "是否双向删除" }
      },
      "additionalProperties": false
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": ["user_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "delete_group_file",
    "description": "删除群文件",
    "category": "files",
    "inputSchema": {
      "type": "object",
      "properties": {
        "group_id": { "type": "string", "description": "群号" },
        "file_id": { "type": "string", "description": "文件ID" },
        "bus_id": { "type": "number", "minimum": 1, "maximum": 4294967295, "multipleOf": 1, "description": "文件业务ID，默认使用文件列表中的 busid" },
        "busid": { "type": "number", "minimum": 1, "maximum": 4294967295, "multipleOf": 1, "description": "文件业务ID，兼容 busid 字段" }
      },
      "additionalProperties": false,
      "required": ["group_id", "file_id"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id", "file_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "delete_group_folder",
    "description": "删除群文件目录",
    "category": "files",
    "inputSchema": {
      "type": "object",
      "properties": { "group_id": { "type": "string", "description": "群号" }, "folder_id": { "type": "string", "description": "文件夹ID" }, "folder": { "type": "string", "description": "文件夹ID" } },
      "additionalProperties": false,
      "required": ["group_id"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "delete_msg",
    "description": "撤回消息",
    "category": "messages",
    "inputSchema": {
      "type": "object",
      "properties": { "message_id": { "anyOf": [{ "type": "number" }, { "type": "string" }], "description": "消息ID" } },
      "additionalProperties": false,
      "required": ["message_id"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": ["message_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "delete_qzone_msg",
    "description": "删除QQ空间说说",
    "category": "qzone",
    "inputSchema": {
      "type": "object",
      "properties": { "tid": { "type": "string", "description": "说说 tid (来自 get_qzone_msg_list / send_qzone_msg)" } },
      "additionalProperties": false,
      "required": ["tid"]
    },
    "write": true,
    "permission": "autonomous",
    "scope": { "kind": "account", "targetFields": ["tid"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "do_group_album_comment",
    "description": "发表群相册评论",
    "category": "albums",
    "inputSchema": {
      "type": "object",
      "properties": {
        "group_id": { "type": "string", "description": "群号" },
        "album_id": { "type": "string", "description": "相册 ID" },
        "lloc": { "type": "string", "description": "图片 ID；不传或为空时评论整个上传批次，此时必须提供 batch_id" },
        "batch_id": { "type": "string", "description": "上传批次 ID，可取自 get_group_album_media_list 返回的 batch.link_id 或 media[].batch_id" },
        "content": { "type": "string", "description": "评论内容" }
      },
      "additionalProperties": false,
      "required": ["group_id", "album_id", "content"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "download_file",
    "description": "下载文件",
    "category": "files",
    "inputSchema": {
      "type": "object",
      "properties": {
        "url": { "type": "string", "description": "下载链接" },
        "base64": { "type": "string", "description": "base64数据" },
        "name": { "type": "string", "description": "文件名" },
        "headers": { "anyOf": [{ "type": "string" }, { "type": "array", "items": { "type": "string" } }], "description": "请求头" }
      },
      "additionalProperties": false,
      "anyOf": [{ "required": ["url"] }, { "required": ["base64"] }]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "download_file_image_stream",
    "description": "下载图片文件流",
    "category": "files",
    "inputSchema": SCHEMA_7,
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": ["file_id"] },
    "transport": "stream",
    "returnsVoid": false
  },
  {
    "id": "download_file_record_stream",
    "description": "下载语音文件流",
    "category": "files",
    "inputSchema": {
      "type": "object",
      "properties": {
        "file": { "type": "string", "description": "文件路径或 URL" },
        "file_id": { "type": "string", "description": "文件 ID" },
        "chunk_size": { "type": "number", "default": 65536, "description": "分块大小 (字节)" },
        "out_format": { "type": "string", "description": "输出格式" }
      },
      "additionalProperties": false,
      "anyOf": [{ "required": ["file"] }, { "required": ["file_id"] }]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": ["file_id"] },
    "transport": "stream",
    "returnsVoid": false
  },
  {
    "id": "download_file_stream",
    "description": "下载文件流",
    "category": "files",
    "inputSchema": SCHEMA_7,
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": ["file_id"] },
    "transport": "stream",
    "returnsVoid": false
  },
  {
    "id": "download_fileset",
    "description": "下载文件集",
    "category": "files",
    "inputSchema": { "type": "object", "properties": { "fileset_id": { "type": "string", "description": "文件集 ID" } }, "additionalProperties": false, "required": ["fileset_id"] },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "fetch_custom_face",
    "description": "获取自定义表情",
    "category": "stickers",
    "inputSchema": { "type": "object", "properties": { "count": { "anyOf": [{ "type": "number" }, { "type": "string" }], "default": 48, "description": "获取数量" } }, "additionalProperties": false },
    "write": false,
    "permission": "all",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "fetch_custom_face_detail",
    "description": "获取自定义表情详情",
    "category": "stickers",
    "inputSchema": { "type": "object", "properties": { "count": { "anyOf": [{ "type": "number" }, { "type": "string" }], "default": 48, "description": "获取数量" } }, "additionalProperties": false },
    "write": false,
    "permission": "all",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "fetch_emoji_like",
    "description": "获取表情点赞详情",
    "category": "messages",
    "inputSchema": {
      "type": "object",
      "properties": {
        "message_id": { "anyOf": [{ "type": "number" }, { "type": "string" }], "description": "消息ID" },
        "emojiId": { "anyOf": [{ "type": "number" }, { "type": "string" }], "description": "表情ID" },
        "emojiType": { "anyOf": [{ "type": "number" }, { "type": "string" }], "description": "表情类型" },
        "count": { "anyOf": [{ "type": "number" }, { "type": "string" }], "default": 20, "description": "获取数量" },
        "cookie": { "type": "string", "default": "", "description": "分页Cookie" }
      },
      "additionalProperties": false,
      "required": ["message_id", "emojiId", "emojiType"]
    },
    "write": false,
    "permission": "all",
    "scope": { "kind": "conversation", "targetFields": ["message_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "fetch_ptt_text",
    "description": "获取语音转文字结果",
    "category": "media",
    "inputSchema": {
      "type": "object",
      "properties": { "message_id": { "anyOf": [{ "type": "number" }, { "type": "string" }], "description": "消息ID" } },
      "additionalProperties": false,
      "required": ["message_id"]
    },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": ["message_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "forward_friend_single_msg",
    "description": "转发单条消息",
    "category": "friends",
    "inputSchema": SCHEMA_4,
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id", "user_id", "message_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "forward_group_single_msg",
    "description": "转发单条消息",
    "category": "messages",
    "inputSchema": SCHEMA_4,
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id", "user_id", "message_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "friend_poke",
    "description": "发送戳一戳",
    "category": "friends",
    "inputSchema": {
      "type": "object",
      "properties": { "group_id": { "type": "string", "description": "群号" }, "user_id": { "type": "string", "description": "用户QQ" }, "target_id": { "type": "string", "description": "目标QQ" } },
      "additionalProperties": false,
      "required": ["user_id"]
    },
    "write": true,
    "permission": "all",
    "scope": { "kind": "conversation", "targetFields": ["group_id", "user_id", "target_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "get_ai_characters",
    "description": "获取AI角色列表",
    "category": "media",
    "inputSchema": {
      "type": "object",
      "properties": { "group_id": { "type": "string", "description": "群号" }, "chat_type": { "anyOf": [{ "type": "number" }, { "type": "string" }], "default": 1, "description": "聊天类型" } },
      "additionalProperties": false,
      "required": ["group_id"]
    },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_ai_record",
    "description": "获取 AI 语音",
    "category": "media",
    "inputSchema": SCHEMA_0,
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_clientkey",
    "description": "获取ClientKey",
    "category": "system",
    "inputSchema": { "type": "object", "properties": {  }, "additionalProperties": false },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_collection_list",
    "description": "获取收藏列表",
    "category": "system",
    "inputSchema": {
      "type": "object",
      "properties": { "category": { "type": "string", "description": "分类ID" }, "count": { "type": "string", "default": "50", "description": "获取数量" } },
      "additionalProperties": false,
      "required": ["category"]
    },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_cookies",
    "description": "获取 Cookies",
    "category": "system",
    "inputSchema": { "type": "object", "properties": { "domain": { "type": "string", "description": "需要获取 cookies 的域名" } }, "additionalProperties": false, "required": ["domain"] },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_credentials",
    "description": "获取登录凭证",
    "category": "system",
    "inputSchema": { "type": "object", "properties": { "domain": { "type": "string", "description": "需要获取 cookies 的域名" } }, "additionalProperties": false, "required": ["domain"] },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_csrf_token",
    "description": "获取 CSRF Token",
    "category": "system",
    "inputSchema": { "type": "object", "properties": {  }, "additionalProperties": false },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_doubt_friends_add_request",
    "description": "获取可疑好友申请",
    "category": "friends",
    "inputSchema": { "type": "object", "properties": { "count": { "type": "number", "default": 50, "description": "获取数量" } }, "additionalProperties": false },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_emoji_likes",
    "description": "获取消息表情点赞列表",
    "category": "messages",
    "inputSchema": {
      "type": "object",
      "properties": {
        "group_id": { "type": "string", "description": "群号，短ID可不传" },
        "message_id": { "type": "string", "description": "消息ID，可以传递长ID或短ID" },
        "emoji_id": { "type": "string", "description": "表情ID" },
        "emoji_type": { "type": "string", "description": "表情类型" },
        "count": { "type": "number", "default": 0, "description": "数量，0代表全部" }
      },
      "additionalProperties": false,
      "required": ["message_id", "emoji_id"]
    },
    "write": false,
    "permission": "all",
    "scope": { "kind": "conversation", "targetFields": ["group_id", "message_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_essence_msg_list",
    "description": "获取群精华消息",
    "category": "messages",
    "inputSchema": { "type": "object", "properties": { "group_id": { "type": "string", "description": "群号" } }, "additionalProperties": false, "required": ["group_id"] },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_file",
    "description": "获取文件",
    "category": "files",
    "inputSchema": {
      "type": "object",
      "properties": { "file": { "type": "string", "description": "文件路径、URL或Base64" }, "file_id": { "type": "string", "description": "文件ID" } },
      "additionalProperties": false,
      "anyOf": [{ "required": ["file"] }, { "required": ["file_id"] }]
    },
    "write": false,
    "permission": "all",
    "scope": { "kind": "conversation", "targetFields": ["file_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_fileset_id",
    "description": "获取文件集 ID",
    "category": "files",
    "inputSchema": { "type": "object", "properties": { "share_code": { "type": "string", "description": "分享码或分享链接" } }, "additionalProperties": false, "required": ["share_code"] },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_fileset_info",
    "description": "获取文件集信息",
    "category": "files",
    "inputSchema": { "type": "object", "properties": { "fileset_id": { "type": "string", "description": "文件集 ID" } }, "additionalProperties": false, "required": ["fileset_id"] },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_flash_file_list",
    "description": "获取闪传文件列表",
    "category": "files",
    "inputSchema": { "type": "object", "properties": { "fileset_id": { "type": "string", "description": "文件集 ID" } }, "additionalProperties": false, "required": ["fileset_id"] },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_flash_file_url",
    "description": "获取闪传文件链接",
    "category": "files",
    "inputSchema": {
      "type": "object",
      "properties": { "fileset_id": { "type": "string", "description": "文件集 ID" }, "file_name": { "type": "string", "description": "文件名" }, "file_index": { "type": "number", "description": "文件索引" } },
      "additionalProperties": false,
      "required": ["fileset_id"]
    },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_forward_msg",
    "description": "获取合并转发消息",
    "category": "messages",
    "inputSchema": {
      "type": "object",
      "properties": { "message_id": { "type": "string", "description": "消息ID" }, "id": { "type": "string", "description": "消息ID" } },
      "additionalProperties": false,
      "anyOf": [{ "required": ["message_id"] }, { "required": ["id"] }]
    },
    "write": false,
    "permission": "all",
    "scope": { "kind": "conversation", "targetFields": ["message_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_friend_list",
    "description": "获取好友列表",
    "category": "friends",
    "inputSchema": { "type": "object", "properties": { "no_cache": { "anyOf": [{ "type": "boolean" }, { "type": "string" }], "description": "是否不使用缓存" } }, "additionalProperties": false },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_friend_msg_history",
    "description": "获取好友历史消息",
    "category": "friends",
    "inputSchema": {
      "type": "object",
      "properties": {
        "user_id": { "type": "string", "description": "用户QQ" },
        "message_seq": { "type": "string", "description": "起始消息序号" },
        "count": { "type": "number", "default": 20, "description": "获取消息数量" },
        "reverse_order": { "type": "boolean", "default": false, "description": "是否反向排序" },
        "disable_get_url": { "type": "boolean", "default": false, "description": "是否禁用获取URL" },
        "parse_mult_msg": { "type": "boolean", "default": true, "description": "是否解析合并消息" },
        "quick_reply": { "type": "boolean", "default": false, "description": "是否快速回复" },
        "reverseOrder": { "type": "boolean", "default": false, "description": "是否反向排序(旧版本兼容)" }
      },
      "additionalProperties": false,
      "required": ["user_id"]
    },
    "write": false,
    "permission": "all",
    "scope": { "kind": "conversation", "targetFields": ["user_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_friends_with_category",
    "description": "获取带分组的好友列表",
    "category": "friends",
    "inputSchema": { "type": "object", "properties": {  }, "additionalProperties": false },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_group_album_media_list",
    "description": "获取群相册媒体列表",
    "category": "albums",
    "inputSchema": {
      "type": "object",
      "properties": {
        "group_id": { "type": "string", "description": "群号" },
        "album_id": { "type": "string", "description": "相册ID" },
        "attach_info": { "type": "string", "default": "", "description": "附加信息（用于分页）" }
      },
      "additionalProperties": false,
      "required": ["group_id", "album_id"]
    },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_group_at_all_remain",
    "description": "获取群艾特全体剩余次数",
    "category": "groups",
    "inputSchema": { "type": "object", "properties": { "group_id": { "type": "string", "description": "群号" } }, "additionalProperties": false, "required": ["group_id"] },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_group_detail_info",
    "description": "获取群详细信息",
    "category": "groups",
    "inputSchema": { "type": "object", "properties": { "group_id": { "type": "string", "description": "群号" } }, "additionalProperties": false, "required": ["group_id"] },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_group_file_system_info",
    "description": "获取群文件系统信息",
    "category": "files",
    "inputSchema": { "type": "object", "properties": { "group_id": { "type": "string", "description": "群号" } }, "additionalProperties": false, "required": ["group_id"] },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_group_file_url",
    "description": "获取群文件URL",
    "category": "files",
    "inputSchema": {
      "type": "object",
      "properties": { "group_id": { "type": "string", "description": "群号" }, "file_id": { "type": "string", "description": "文件ID" } },
      "additionalProperties": false,
      "required": ["group_id", "file_id"]
    },
    "write": false,
    "permission": "all",
    "scope": { "kind": "group", "targetFields": ["group_id", "file_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_group_files_by_folder",
    "description": "获取群文件夹文件列表",
    "category": "files",
    "inputSchema": {
      "type": "object",
      "properties": {
        "group_id": { "type": "string", "description": "群号" },
        "folder_id": { "type": "string", "description": "文件夹ID" },
        "folder": { "type": "string", "description": "文件夹ID" },
        "file_count": { "anyOf": [{ "type": "number" }, { "type": "string" }], "default": 50, "description": "文件数量" }
      },
      "additionalProperties": false,
      "required": ["group_id"]
    },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_group_honor_info",
    "description": "获取群荣誉信息",
    "category": "groups",
    "inputSchema": {
      "type": "object",
      "properties": { "group_id": { "type": "string", "description": "群号" }, "type": { "enum": ["all", "talkative", "performer", "legend", "strong_newbie", "emotion"], "description": "荣誉类型" } },
      "additionalProperties": false,
      "required": ["group_id"]
    },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_group_ignore_add_request",
    "description": "获取群被忽略的加群请求",
    "category": "groups",
    "inputSchema": { "type": "object", "properties": {  }, "additionalProperties": false },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_group_ignored_notifies",
    "description": "获取群忽略通知",
    "category": "groups",
    "inputSchema": { "type": "object", "properties": {  }, "additionalProperties": false, "description": "群忽略通知负载" },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_group_info",
    "description": "获取群信息",
    "category": "groups",
    "inputSchema": { "type": "object", "properties": { "group_id": { "type": "string", "description": "群号" } }, "additionalProperties": false, "required": ["group_id"] },
    "write": false,
    "permission": "all",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_group_info_ex",
    "description": "获取群详细信息 (扩展)",
    "category": "groups",
    "inputSchema": { "type": "object", "properties": { "group_id": { "type": "string", "description": "群号" } }, "additionalProperties": false, "required": ["group_id"] },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_group_list",
    "description": "获取群列表",
    "category": "groups",
    "inputSchema": { "type": "object", "properties": { "no_cache": { "anyOf": [{ "type": "boolean" }, { "type": "string" }], "description": "是否不使用缓存" } }, "additionalProperties": false },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_group_member_info",
    "description": "获取群成员信息",
    "category": "groups",
    "inputSchema": {
      "type": "object",
      "properties": {
        "group_id": { "type": "string", "description": "群号" },
        "user_id": { "type": "string", "description": "QQ号" },
        "no_cache": { "anyOf": [{ "type": "boolean" }, { "type": "string" }], "description": "是否不使用缓存" }
      },
      "additionalProperties": false,
      "required": ["group_id", "user_id"]
    },
    "write": false,
    "permission": "all",
    "scope": { "kind": "group", "targetFields": ["group_id", "user_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_group_member_list",
    "description": "获取群成员列表",
    "category": "groups",
    "inputSchema": {
      "type": "object",
      "properties": { "group_id": { "type": "string", "description": "群号" }, "no_cache": { "anyOf": [{ "type": "boolean" }, { "type": "string" }], "description": "是否不使用缓存" } },
      "additionalProperties": false,
      "required": ["group_id"]
    },
    "write": false,
    "permission": "all",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_group_msg_history",
    "description": "获取群历史消息",
    "category": "messages",
    "inputSchema": {
      "type": "object",
      "properties": {
        "group_id": { "type": "string", "description": "群号" },
        "message_seq": { "type": "string", "description": "起始消息序号" },
        "count": { "type": "number", "default": 20, "description": "获取消息数量" },
        "reverse_order": { "type": "boolean", "default": false, "description": "是否反向排序" },
        "disable_get_url": { "type": "boolean", "default": false, "description": "是否禁用获取URL" },
        "parse_mult_msg": { "type": "boolean", "default": true, "description": "是否解析合并消息" },
        "quick_reply": { "type": "boolean", "default": false, "description": "是否快速回复" },
        "reverseOrder": { "type": "boolean", "default": false, "description": "是否反向排序(旧版本兼容)" }
      },
      "additionalProperties": false,
      "required": ["group_id"]
    },
    "write": false,
    "permission": "all",
    "scope": { "kind": "conversation", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_group_root_files",
    "description": "获取群根目录文件列表",
    "category": "files",
    "inputSchema": {
      "type": "object",
      "properties": { "group_id": { "type": "string", "description": "群号" }, "file_count": { "anyOf": [{ "type": "number" }, { "type": "string" }], "default": 50, "description": "文件数量" } },
      "additionalProperties": false,
      "required": ["group_id"]
    },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_group_share_link",
    "description": "获取群分享链接",
    "category": "groups",
    "inputSchema": {
      "type": "object",
      "properties": {
        "group_id": { "anyOf": [{ "type": "number" }, { "type": "string" }], "description": "群号" },
        "need_short_url": { "anyOf": [{ "type": "boolean" }, { "type": "string" }], "default": true, "description": "是否返回短链 (qm.qq.com/q/xxx)，false 返回完整 universal-share 链接" },
        "src_id": { "anyOf": [{ "type": "number" }, { "type": "string" }], "default": 73, "description": "分享来源 ID" },
        "additional_param": { "type": "string", "default": "", "description": "附加参数" }
      },
      "additionalProperties": false,
      "required": ["group_id"]
    },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_group_shut_list",
    "description": "获取群禁言列表",
    "category": "groups",
    "inputSchema": { "type": "object", "properties": { "group_id": { "type": "string", "description": "群号" } }, "additionalProperties": false, "required": ["group_id"] },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_group_signed_list",
    "description": "获取群组今日打卡列表",
    "category": "messages",
    "inputSchema": {
      "type": "object",
      "properties": { "group_id": { "anyOf": [{ "type": "string" }, { "type": "number" }], "description": "群号" } },
      "additionalProperties": false,
      "required": ["group_id"]
    },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_group_system_msg",
    "description": "获取群系统消息",
    "category": "messages",
    "inputSchema": { "type": "object", "properties": { "count": { "anyOf": [{ "type": "number" }, { "type": "string" }], "default": 50, "description": "获取的消息数量" } }, "additionalProperties": false },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_guild_list",
    "description": "获取频道列表",
    "category": "system",
    "inputSchema": { "type": "object", "properties": {  }, "additionalProperties": false },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "get_guild_service_profile",
    "description": "获取频道个人信息",
    "category": "files",
    "inputSchema": { "type": "object", "properties": {  }, "additionalProperties": false },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "get_image",
    "description": "获取图片",
    "category": "media",
    "inputSchema": {
      "type": "object",
      "properties": { "file": { "type": "string", "description": "文件路径、URL或Base64" }, "file_id": { "type": "string", "description": "文件ID" } },
      "additionalProperties": false,
      "anyOf": [{ "required": ["file"] }, { "required": ["file_id"] }]
    },
    "write": false,
    "permission": "all",
    "scope": { "kind": "conversation", "targetFields": ["file_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_login_info",
    "description": "获取登录号信息",
    "category": "system",
    "inputSchema": { "type": "object", "properties": {  }, "additionalProperties": false },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_mini_app_ark",
    "description": "获取小程序 Ark",
    "category": "messages",
    "inputSchema": {
      "anyOf": [{
          "type": "object",
          "properties": {
            "type": { "anyOf": [{ "const": "bili" }, { "const": "weibo" }], "description": "模板类型" },
            "title": { "type": "string", "description": "标题" },
            "desc": { "type": "string", "description": "描述" },
            "picUrl": { "type": "string", "description": "图片URL" },
            "jumpUrl": { "type": "string", "description": "跳转URL" },
            "webUrl": { "type": "string", "description": "网页URL" },
            "rawArkData": { "anyOf": [{ "type": "string" }], "description": "是否返回原始Ark数据" }
          },
          "additionalProperties": false,
          "required": ["type", "title", "desc", "picUrl", "jumpUrl"]
        }, {
          "type": "object",
          "properties": {
            "title": { "type": "string", "description": "标题" },
            "desc": { "type": "string", "description": "描述" },
            "picUrl": { "type": "string", "description": "图片URL" },
            "jumpUrl": { "type": "string", "description": "跳转URL" },
            "iconUrl": { "type": "string", "description": "图标URL" },
            "webUrl": { "type": "string", "description": "网页URL" },
            "appId": { "type": "string", "description": "小程序AppID" },
            "scene": { "type": "string", "description": "场景ID" },
            "templateType": { "type": "string", "description": "模板类型" },
            "businessType": { "type": "string", "description": "业务类型" },
            "verType": { "type": "string", "description": "版本类型" },
            "shareType": { "type": "string", "description": "分享类型" },
            "versionId": { "type": "string", "description": "版本ID" },
            "sdkId": { "type": "string", "description": "SDK ID" },
            "withShareTicket": { "type": "string", "description": "是否携带分享票据" },
            "rawArkData": { "type": "string", "description": "是否返回原始Ark数据" }
          },
          "additionalProperties": false,
          "required": ["title", "desc", "picUrl", "jumpUrl", "iconUrl", "appId", "scene", "templateType", "businessType", "verType", "shareType", "versionId", "sdkId", "withShareTicket"]
        }],
      "description": "小程序Ark参数"
    },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_msg",
    "description": "获取消息",
    "category": "messages",
    "inputSchema": {
      "type": "object",
      "properties": { "message_id": { "anyOf": [{ "type": "number" }, { "type": "string" }], "description": "消息ID" } },
      "additionalProperties": false,
      "required": ["message_id"]
    },
    "write": false,
    "permission": "all",
    "scope": { "kind": "conversation", "targetFields": ["message_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_online_clients",
    "description": "获取在线客户端",
    "category": "system",
    "inputSchema": { "type": "object", "properties": {  }, "additionalProperties": false, "description": "在线客户端负载" },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_online_file_msg",
    "description": "获取在线文件消息",
    "category": "files",
    "inputSchema": { "type": "object", "properties": { "user_id": { "type": "string", "description": "用户 QQ" } }, "additionalProperties": false, "required": ["user_id"] },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": ["user_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_private_file_url",
    "description": "获取私聊文件URL",
    "category": "files",
    "inputSchema": { "type": "object", "properties": { "file_id": { "type": "string", "description": "文件ID" } }, "additionalProperties": false, "required": ["file_id"] },
    "write": false,
    "permission": "all",
    "scope": { "kind": "account", "targetFields": ["file_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_profile_like",
    "description": "获取资料点赞",
    "category": "files",
    "inputSchema": {
      "type": "object",
      "properties": {
        "user_id": { "type": "string", "description": "QQ号" },
        "start": { "anyOf": [{ "type": "number" }, { "type": "string" }], "default": 0, "description": "起始位置" },
        "count": { "anyOf": [{ "type": "number" }, { "type": "string" }], "default": 10, "description": "获取数量" }
      },
      "additionalProperties": false
    },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": ["user_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_qun_album_list",
    "description": "获取群相册列表",
    "category": "albums",
    "inputSchema": {
      "type": "object",
      "properties": { "group_id": { "type": "string", "description": "群号" }, "attach_info": { "type": "string", "default": "", "description": "附加信息（用于分页，从上一次返回结果中获取）" } },
      "additionalProperties": false,
      "required": ["group_id"]
    },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_recent_contact",
    "description": "获取最近会话",
    "category": "system",
    "inputSchema": { "type": "object", "properties": { "count": { "anyOf": [{ "type": "number" }, { "type": "string" }], "default": 10, "description": "获取的数量" } }, "additionalProperties": false },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_record",
    "description": "获取语音",
    "category": "media",
    "inputSchema": {
      "type": "object",
      "properties": {
        "file": { "type": "string", "description": "文件路径、URL或Base64" },
        "file_id": { "type": "string", "description": "文件ID" },
        "out_format": { "type": "string", "description": "输出格式" }
      },
      "additionalProperties": false,
      "required": ["out_format"],
      "anyOf": [{ "required": ["file"] }, { "required": ["file_id"] }]
    },
    "write": false,
    "permission": "all",
    "scope": { "kind": "conversation", "targetFields": ["file_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_rkey",
    "description": "获取扩展 RKey",
    "category": "system",
    "inputSchema": { "type": "object", "properties": {  }, "additionalProperties": false },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_rkey_server",
    "description": "获取 RKey 服务器",
    "category": "system",
    "inputSchema": { "type": "object", "properties": {  }, "additionalProperties": false },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_robot_uin_range",
    "description": "获取机器人 UIN 范围",
    "category": "system",
    "inputSchema": { "type": "object", "properties": {  }, "additionalProperties": false },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_share_link",
    "description": "获取文件分享链接",
    "category": "system",
    "inputSchema": { "type": "object", "properties": { "fileset_id": { "type": "string", "description": "文件集 ID" } }, "additionalProperties": false, "required": ["fileset_id"] },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_status",
    "description": "获取运行状态",
    "category": "system",
    "inputSchema": { "type": "object", "properties": {  }, "additionalProperties": false },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_stranger_info",
    "description": "获取陌生人信息",
    "category": "friends",
    "inputSchema": {
      "type": "object",
      "properties": { "user_id": { "type": "string", "description": "用户QQ" }, "no_cache": { "anyOf": [{ "type": "boolean" }, { "type": "string" }], "default": false, "description": "是否不使用缓存" } },
      "additionalProperties": false,
      "required": ["user_id"]
    },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": ["user_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_unidirectional_friend_list",
    "description": "获取单向好友列表",
    "category": "friends",
    "inputSchema": { "type": "object", "properties": {  }, "additionalProperties": false },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "get_version_info",
    "description": "获取版本信息",
    "category": "system",
    "inputSchema": { "type": "object", "properties": {  }, "additionalProperties": false },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "group_poke",
    "description": "发送戳一戳",
    "category": "messages",
    "inputSchema": {
      "type": "object",
      "properties": { "group_id": { "type": "string", "description": "群号" }, "user_id": { "type": "string", "description": "用户QQ" }, "target_id": { "type": "string", "description": "目标QQ" } },
      "additionalProperties": false,
      "required": ["user_id"]
    },
    "write": true,
    "permission": "all",
    "scope": { "kind": "conversation", "targetFields": ["group_id", "user_id", "target_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "mark_group_msg_as_read",
    "description": "标记群聊已读",
    "category": "messages",
    "inputSchema": {
      "type": "object",
      "properties": {
        "user_id": { "anyOf": [{ "type": "string" }, { "type": "number" }], "description": "用户QQ" },
        "group_id": { "type": "string", "description": "群号" },
        "message_id": { "type": "string", "description": "消息ID" }
      },
      "additionalProperties": false
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id", "user_id", "message_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "mark_msg_as_read",
    "description": "标记消息已读 (Go-CQHTTP)",
    "category": "messages",
    "inputSchema": {
      "type": "object",
      "properties": {
        "user_id": { "anyOf": [{ "type": "string" }, { "type": "number" }], "description": "用户QQ" },
        "group_id": { "type": "string", "description": "群号" },
        "message_id": { "type": "string", "description": "消息ID" }
      },
      "additionalProperties": false
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id", "user_id", "message_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "mark_private_msg_as_read",
    "description": "标记私聊已读",
    "category": "messages",
    "inputSchema": {
      "type": "object",
      "properties": {
        "user_id": { "anyOf": [{ "type": "string" }, { "type": "number" }], "description": "用户QQ" },
        "group_id": { "type": "string", "description": "群号" },
        "message_id": { "type": "string", "description": "消息ID" }
      },
      "additionalProperties": false
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id", "user_id", "message_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "move_group_file",
    "description": "移动群文件",
    "category": "files",
    "inputSchema": {
      "type": "object",
      "properties": {
        "group_id": { "type": "string", "description": "群号" },
        "file_id": { "type": "string", "description": "文件ID" },
        "current_parent_directory": { "type": "string", "description": "当前父目录" },
        "target_parent_directory": { "type": "string", "description": "目标父目录" }
      },
      "additionalProperties": false,
      "required": ["group_id", "file_id", "current_parent_directory", "target_parent_directory"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id", "file_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "nc_get_packet_status",
    "description": "获取Packet状态",
    "category": "system",
    "inputSchema": { "type": "object", "properties": {  }, "additionalProperties": false },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "nc_get_rkey",
    "description": "获取 RKey",
    "category": "system",
    "inputSchema": { "type": "object", "properties": {  }, "additionalProperties": false },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "nc_get_user_status",
    "description": "获取用户在线状态",
    "category": "system",
    "inputSchema": { "type": "object", "properties": { "user_id": { "type": "string", "description": "QQ号" } }, "additionalProperties": false, "required": ["user_id"] },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": ["user_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "ocr_image",
    "description": "图片 OCR 识别",
    "category": "media",
    "inputSchema": { "type": "object", "properties": { "image": { "type": "string", "description": "图片路径、URL或Base64" } }, "additionalProperties": false, "required": ["image"] },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "receive_online_file",
    "description": "接收在线文件",
    "category": "files",
    "inputSchema": SCHEMA_2,
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": ["user_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "refuse_online_file",
    "description": "拒绝在线文件",
    "category": "files",
    "inputSchema": SCHEMA_2,
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": ["user_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "rename_group_file",
    "description": "重命名群文件",
    "category": "files",
    "inputSchema": {
      "type": "object",
      "properties": {
        "group_id": { "type": "string", "description": "群号" },
        "file_id": { "type": "string", "description": "文件ID" },
        "current_parent_directory": { "type": "string", "description": "当前父目录" },
        "new_name": { "type": "string", "description": "新文件名" }
      },
      "additionalProperties": false,
      "required": ["group_id", "file_id", "current_parent_directory", "new_name"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id", "file_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "send_ark_share",
    "description": "分享用户 (Ark)",
    "category": "messages",
    "inputSchema": {
      "type": "object",
      "properties": {
        "user_id": { "type": "string", "description": "QQ号" },
        "group_id": { "type": "string", "description": "群号" },
        "phone_number": { "type": "string", "default": "", "description": "手机号" }
      },
      "additionalProperties": false
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id", "user_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "send_flash_msg",
    "description": "发送闪传消息",
    "category": "files",
    "inputSchema": {
      "type": "object",
      "properties": { "fileset_id": { "type": "string", "description": "文件集 ID" }, "user_id": { "type": "string", "description": "用户 QQ" }, "group_id": { "type": "string", "description": "群号" } },
      "additionalProperties": false,
      "required": ["fileset_id"],
      "anyOf": [{ "required": ["group_id"] }, { "required": ["user_id"] }]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id", "user_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "send_forward_msg",
    "description": "发送合并转发消息",
    "category": "messages",
    "inputSchema": SCHEMA_61,
    "write": true,
    "permission": "all",
    "scope": { "kind": "conversation", "targetFields": ["group_id", "user_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "send_group_ai_record",
    "description": "发送群 AI 语音",
    "category": "media",
    "inputSchema": SCHEMA_0,
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "send_group_ark_share",
    "description": "分享群 (Ark)",
    "category": "groups",
    "inputSchema": { "type": "object", "properties": { "group_id": { "type": "string", "description": "群号" } }, "additionalProperties": false, "required": ["group_id"] },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "send_group_forward_msg",
    "description": "发送群合并转发消息",
    "category": "messages",
    "inputSchema": SCHEMA_60,
    "write": true,
    "permission": "all",
    "scope": { "kind": "conversation", "targetFields": ["group_id", "user_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "send_group_msg",
    "description": "发送群消息",
    "category": "messages",
    "inputSchema": SCHEMA_60,
    "write": true,
    "permission": "all",
    "scope": { "kind": "conversation", "targetFields": ["group_id", "user_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "send_group_sign",
    "description": "群打卡",
    "category": "messages",
    "inputSchema": { "type": "object", "properties": { "group_id": { "type": "string", "description": "群号" } }, "additionalProperties": false, "required": ["group_id"] },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "send_like",
    "description": "点赞",
    "category": "messages",
    "inputSchema": {
      "type": "object",
      "properties": { "user_id": { "type": "string", "description": "对方 QQ 号" }, "times": { "anyOf": [{ "type": "number" }, { "type": "string" }], "default": 1, "description": "点赞次数" } },
      "additionalProperties": false,
      "required": ["user_id"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": ["user_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "send_msg",
    "description": "发送消息",
    "category": "messages",
    "inputSchema": SCHEMA_61,
    "write": true,
    "permission": "all",
    "scope": { "kind": "conversation", "targetFields": ["group_id", "user_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "send_online_file",
    "description": "发送在线文件",
    "category": "files",
    "inputSchema": {
      "type": "object",
      "properties": {
        "user_id": { "type": "string", "description": "用户 QQ" },
        "file_path": { "type": "string", "description": "本地文件路径" },
        "file_name": { "type": "string", "description": "文件名 (可选)" }
      },
      "additionalProperties": false,
      "required": ["user_id", "file_path"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": ["user_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "send_online_folder",
    "description": "发送在线文件夹",
    "category": "files",
    "inputSchema": {
      "type": "object",
      "properties": {
        "user_id": { "type": "string", "description": "用户 QQ" },
        "folder_path": { "type": "string", "description": "本地文件夹路径" },
        "folder_name": { "type": "string", "description": "文件夹名称 (可选)" }
      },
      "additionalProperties": false,
      "required": ["user_id", "folder_path"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": ["user_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "send_packet",
    "description": "发送原始数据包",
    "category": "system",
    "inputSchema": {
      "type": "object",
      "properties": {
        "cmd": { "type": "string", "description": "命令字" },
        "data": { "type": "string", "description": "十六进制数据" },
        "rsp": { "anyOf": [{ "type": "string" }, { "type": "boolean" }], "default": true, "description": "是否等待响应" }
      },
      "additionalProperties": false,
      "required": ["cmd", "data"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "send_poke",
    "description": "发送戳一戳",
    "category": "messages",
    "inputSchema": {
      "type": "object",
      "properties": { "group_id": { "type": "string", "description": "群号" }, "user_id": { "type": "string", "description": "用户QQ" }, "target_id": { "type": "string", "description": "目标QQ" } },
      "additionalProperties": false,
      "required": ["user_id"]
    },
    "write": true,
    "permission": "all",
    "scope": { "kind": "conversation", "targetFields": ["group_id", "user_id", "target_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "send_private_forward_msg",
    "description": "发送私聊合并转发消息",
    "category": "messages",
    "inputSchema": SCHEMA_59,
    "write": true,
    "permission": "all",
    "scope": { "kind": "conversation", "targetFields": ["group_id", "user_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "send_private_msg",
    "description": "发送私聊消息",
    "category": "messages",
    "inputSchema": SCHEMA_59,
    "write": true,
    "permission": "all",
    "scope": { "kind": "conversation", "targetFields": ["group_id", "user_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "send_qzone_msg",
    "description": "发表QQ空间说说",
    "category": "qzone",
    "inputSchema": {
      "type": "object",
      "properties": {
        "content": { "type": "string", "description": "说说正文" },
        "images": { "type": "array", "items": { "type": "string" }, "description": "图片数组, 支持 file:// http(s):// base64:// , 自动上传" },
        "ugc_right": { "anyOf": [{ "type": "number" }, { "type": "string" }], "default": 1, "description": "查看权限: 1所有人可见 4好友可见 16部分好友可见 64仅自己可见 128部分好友不可见" },
        "target_uins": { "type": "array", "items": { "anyOf": [{ "type": "number" }, { "type": "string" }] }, "description": "ugc_right为16/128时, 权限作用的QQ号数组" }
      },
      "additionalProperties": false,
      "required": ["content"]
    },
    "write": true,
    "permission": "autonomous",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "set_custom_face_desc",
    "description": "修改自定义表情描述",
    "category": "stickers",
    "inputSchema": {
      "type": "object",
      "properties": {
        "emoji_id": { "anyOf": [{ "type": "number" }, { "type": "string" }], "description": "表情ID" },
        "res_id": { "type": "string", "description": "资源ID" },
        "md5": { "type": "string", "description": "表情MD5" },
        "desc": { "type": "string", "description": "新的表情描述" }
      },
      "additionalProperties": false,
      "required": ["emoji_id", "res_id", "md5", "desc"]
    },
    "write": true,
    "permission": "all",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "set_diy_online_status",
    "description": "设置自定义在线状态",
    "category": "profile",
    "inputSchema": {
      "type": "object",
      "properties": {
        "face_id": { "anyOf": [{ "type": "number" }, { "type": "string" }], "description": "图标ID" },
        "face_type": { "anyOf": [{ "type": "number" }, { "type": "string" }], "default": "1", "description": "图标类型" },
        "wording": { "type": "string", "default": " ", "description": "状态文字内容" }
      },
      "additionalProperties": false,
      "required": ["face_id"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "set_doubt_friends_add_request",
    "description": "处理可疑好友申请",
    "category": "friends",
    "inputSchema": {
      "type": "object",
      "properties": { "flag": { "type": "string", "description": "请求 flag" }, "approve": { "type": "boolean", "default": true, "description": "是否同意 (强制为 true)" } },
      "additionalProperties": false,
      "required": ["flag"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "set_essence_msg",
    "description": "设置精华消息",
    "category": "messages",
    "inputSchema": {
      "type": "object",
      "properties": { "message_id": { "anyOf": [{ "type": "number" }, { "type": "string" }], "description": "消息ID" } },
      "additionalProperties": false,
      "required": ["message_id"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": ["message_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "set_friend_add_request",
    "description": "处理加好友请求",
    "category": "friends",
    "inputSchema": {
      "type": "object",
      "properties": {
        "flag": { "type": "string", "description": "加好友请求的 flag (需从上报中获取)" },
        "approve": { "anyOf": [{ "type": "string" }, { "type": "boolean" }], "description": "是否同意请求" },
        "remark": { "type": "string", "description": "添加后的好友备注" }
      },
      "additionalProperties": false,
      "required": ["flag"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "set_friend_remark",
    "description": "设置好友备注",
    "category": "friends",
    "inputSchema": {
      "type": "object",
      "properties": { "user_id": { "type": "string", "description": "对方 QQ 号" }, "remark": { "type": "string", "description": "备注内容" } },
      "additionalProperties": false,
      "required": ["user_id", "remark"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": ["user_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "set_group_add_option",
    "description": "设置群加群选项",
    "category": "groups",
    "inputSchema": {
      "type": "object",
      "properties": {
        "group_id": { "type": "string", "description": "群号" },
        "add_type": { "type": "number", "description": "加群方式" },
        "group_question": { "type": "string", "description": "加群问题" },
        "group_answer": { "type": "string", "description": "加群答案" }
      },
      "additionalProperties": false,
      "required": ["group_id", "add_type"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "set_group_add_request",
    "description": "处理加群请求",
    "category": "groups",
    "inputSchema": {
      "type": "object",
      "properties": {
        "flag": { "type": "string", "description": "请求flag" },
        "approve": { "anyOf": [{ "type": "boolean" }, { "type": "string" }], "description": "是否同意" },
        "reason": { "anyOf": [{ "type": "string", "default": " " }, { "type": "null" }], "description": "拒绝理由" },
        "count": { "type": "number", "default": 100, "description": "搜索通知数量" }
      },
      "additionalProperties": false,
      "required": ["flag"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "set_group_admin",
    "description": "设置群管理员",
    "category": "groups",
    "inputSchema": {
      "type": "object",
      "properties": {
        "group_id": { "type": "string", "description": "群号" },
        "user_id": { "type": "string", "description": "用户QQ" },
        "enable": { "anyOf": [{ "type": "boolean" }, { "type": "string" }], "description": "是否设置为管理员" }
      },
      "additionalProperties": false,
      "required": ["group_id", "user_id"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id", "user_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "set_group_album_media_like",
    "description": "点赞群相册媒体",
    "category": "albums",
    "inputSchema": SCHEMA_11,
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "set_group_ban",
    "description": "群组禁言",
    "category": "groups",
    "inputSchema": {
      "type": "object",
      "properties": {
        "group_id": { "type": "string", "description": "群号" },
        "user_id": { "type": "string", "description": "用户QQ" },
        "duration": { "anyOf": [{ "type": "number" }, { "type": "string" }], "default": 0, "description": "禁言时长(秒)" }
      },
      "additionalProperties": false,
      "required": ["group_id", "user_id"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id", "user_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "set_group_card",
    "description": "设置群名片",
    "category": "groups",
    "inputSchema": {
      "type": "object",
      "properties": { "group_id": { "type": "string", "description": "群号" }, "user_id": { "type": "string", "description": "用户QQ" }, "card": { "type": "string", "description": "群名片" } },
      "additionalProperties": false,
      "required": ["group_id", "user_id"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id", "user_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "set_group_kick",
    "description": "群组踢人",
    "category": "groups",
    "inputSchema": {
      "type": "object",
      "properties": {
        "group_id": { "type": "string", "description": "群号" },
        "user_id": { "type": "string", "description": "用户QQ" },
        "reject_add_request": { "anyOf": [{ "type": "boolean" }, { "type": "string" }], "description": "是否拒绝加群请求" }
      },
      "additionalProperties": false,
      "required": ["group_id", "user_id"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id", "user_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "set_group_kick_members",
    "description": "批量踢出群成员",
    "category": "groups",
    "inputSchema": {
      "type": "object",
      "properties": {
        "group_id": { "type": "string", "description": "群号" },
        "user_id": { "type": "array", "items": { "type": "string" }, "description": "QQ号列表" },
        "reject_add_request": { "anyOf": [{ "type": "boolean" }, { "type": "string" }], "description": "是否拒绝加群请求" }
      },
      "additionalProperties": false,
      "required": ["group_id", "user_id"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id", "user_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "set_group_leave",
    "description": "退出群组",
    "category": "groups",
    "inputSchema": {
      "type": "object",
      "properties": { "group_id": { "type": "string", "description": "群号" }, "is_dismiss": { "anyOf": [{ "type": "boolean" }, { "type": "string" }], "description": "是否解散" } },
      "additionalProperties": false,
      "required": ["group_id"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "set_group_member_invite_policy",
    "description": "设置群成员邀请策略",
    "category": "groups",
    "inputSchema": {
      "type": "object",
      "properties": {
        "group_id": { "type": "string", "description": "群号" },
        "policy": {
          "anyOf": [{ "const": "disabled" }, { "const": "require_approval" }, { "const": "no_approval" }, { "const": "no_approval_under_100" }],
          "description": "成员邀请策略：禁止、需要管理员审核、无需审核、群成员少于100人时无需审核"
        }
      },
      "additionalProperties": false,
      "required": ["group_id", "policy"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "set_group_member_permissions",
    "description": "设置群成员功能权限",
    "category": "groups",
    "inputSchema": {
      "type": "object",
      "properties": {
        "group_id": { "type": "string", "description": "群号" },
        "allow_member_upload_album": { "type": "boolean", "description": "允许成员上传群相册" },
        "allow_member_temporary_session": { "type": "boolean", "description": "允许成员发起临时会话" },
        "allow_member_create_group": { "type": "boolean", "description": "允许成员发起新的群聊" }
      },
      "additionalProperties": false,
      "required": ["group_id"],
      "anyOf": [{ "required": ["allow_member_upload_album"] }, { "required": ["allow_member_temporary_session"] }, { "required": ["allow_member_create_group"] }]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "set_group_name",
    "description": "设置群名称",
    "category": "groups",
    "inputSchema": {
      "type": "object",
      "properties": { "group_id": { "type": "string", "description": "群号" }, "group_name": { "type": "string", "description": "群名称" } },
      "additionalProperties": false,
      "required": ["group_id", "group_name"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "set_group_new_member_history_visibility",
    "description": "设置新成员历史消息可见性",
    "category": "groups",
    "inputSchema": {
      "type": "object",
      "properties": { "group_id": { "type": "string", "description": "群号" }, "visible": { "type": "boolean", "description": "新成员默认可见最近聊天记录" } },
      "additionalProperties": false,
      "required": ["group_id", "visible"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "set_group_portrait",
    "description": "设置群头像",
    "category": "groups",
    "inputSchema": {
      "type": "object",
      "properties": { "file": { "type": "string", "description": "头像文件路径或 URL" }, "group_id": { "type": "string", "description": "群号" } },
      "additionalProperties": false,
      "required": ["file", "group_id"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "set_group_remark",
    "description": "设置群备注",
    "category": "groups",
    "inputSchema": {
      "type": "object",
      "properties": { "group_id": { "type": "string", "description": "群号" }, "remark": { "type": "string", "description": "备注" } },
      "additionalProperties": false,
      "required": ["group_id", "remark"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "set_group_robot_add_option",
    "description": "设置群机器人加群选项",
    "category": "groups",
    "inputSchema": {
      "type": "object",
      "properties": {
        "group_id": { "type": "string", "description": "群号" },
        "robot_member_switch": { "type": "number", "description": "机器人成员开关" },
        "robot_member_examine": { "type": "number", "description": "机器人成员审核" }
      },
      "additionalProperties": false,
      "required": ["group_id"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "set_group_search",
    "description": "设置群搜索选项",
    "category": "groups",
    "inputSchema": {
      "type": "object",
      "properties": {
        "group_id": { "type": "string", "description": "群号" },
        "no_code_finger_open": { "type": "number", "description": "未知" },
        "no_finger_open": { "type": "number", "description": "未知" }
      },
      "additionalProperties": false,
      "required": ["group_id"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "set_group_sign",
    "description": "群打卡",
    "category": "messages",
    "inputSchema": { "type": "object", "properties": { "group_id": { "type": "string", "description": "群号" } }, "additionalProperties": false, "required": ["group_id"] },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "set_group_special_title",
    "description": "设置专属头衔",
    "category": "groups",
    "inputSchema": {
      "type": "object",
      "properties": {
        "group_id": { "type": "string", "description": "群号" },
        "user_id": { "type": "string", "description": "QQ号" },
        "special_title": { "type": "string", "default": "", "description": "专属头衔" }
      },
      "additionalProperties": false,
      "required": ["group_id", "user_id"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id", "user_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "set_group_todo",
    "description": "设置群待办",
    "category": "groups",
    "inputSchema": SCHEMA_5,
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id", "message_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "set_group_whole_ban",
    "description": "全员禁言",
    "category": "groups",
    "inputSchema": {
      "type": "object",
      "properties": { "group_id": { "type": "string", "description": "群号" }, "enable": { "anyOf": [{ "type": "boolean" }, { "type": "string" }], "description": "是否开启全员禁言" } },
      "additionalProperties": false,
      "required": ["group_id"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "set_input_status",
    "description": "设置输入状态",
    "category": "messages",
    "inputSchema": {
      "type": "object",
      "properties": { "user_id": { "type": "string", "description": "QQ号" }, "event_type": { "type": "number", "description": "事件类型" } },
      "additionalProperties": false,
      "required": ["user_id", "event_type"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": ["user_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "set_msg_emoji_like",
    "description": "设置消息表情点赞",
    "category": "messages",
    "inputSchema": {
      "type": "object",
      "properties": {
        "message_id": { "anyOf": [{ "type": "number" }, { "type": "string" }], "description": "消息ID" },
        "emoji_id": { "anyOf": [{ "type": "number" }, { "type": "string" }], "description": "表情ID" },
        "set": { "anyOf": [{ "type": "boolean" }, { "type": "string" }], "description": "是否设置" }
      },
      "additionalProperties": false,
      "required": ["message_id", "emoji_id"]
    },
    "write": true,
    "permission": "all",
    "scope": { "kind": "conversation", "targetFields": ["message_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "set_online_status",
    "description": "设置在线状态",
    "category": "profile",
    "inputSchema": {
      "type": "object",
      "properties": {
        "status": { "anyOf": [{ "type": "number" }, { "type": "string" }], "description": "在线状态" },
        "ext_status": { "anyOf": [{ "type": "number" }, { "type": "string" }], "description": "扩展状态" },
        "battery_status": { "anyOf": [{ "type": "number" }, { "type": "string" }], "description": "电量状态" }
      },
      "additionalProperties": false,
      "required": ["status", "ext_status", "battery_status"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "set_qq_avatar",
    "description": "设置QQ头像",
    "category": "profile",
    "inputSchema": { "type": "object", "properties": { "file": { "type": "string", "description": "图片路径、URL或Base64" } }, "additionalProperties": false, "required": ["file"] },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "set_qq_profile",
    "description": "设置QQ资料",
    "category": "files",
    "inputSchema": {
      "type": "object",
      "properties": {
        "nickname": { "type": "string", "description": "昵称" },
        "personal_note": { "type": "string", "description": "个性签名" },
        "sex": { "anyOf": [{ "type": "number" }, { "type": "string" }], "description": "性别 (0: 未知, 1: 男, 2: 女)" }
      },
      "additionalProperties": false,
      "required": ["nickname"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "set_restart",
    "description": "重启服务",
    "category": "system",
    "inputSchema": { "type": "object", "properties": {  }, "additionalProperties": false },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": true
  },
  {
    "id": "set_self_longnick",
    "description": "设置个性签名",
    "category": "profile",
    "inputSchema": { "type": "object", "properties": { "longNick": { "type": "string", "description": "签名内容" } }, "additionalProperties": false, "required": ["longNick"] },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "trans_group_file",
    "description": "传输群文件",
    "category": "files",
    "inputSchema": {
      "type": "object",
      "properties": { "group_id": { "type": "string", "description": "群号" }, "file_id": { "type": "string", "description": "文件ID" } },
      "additionalProperties": false,
      "required": ["group_id", "file_id"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id", "file_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "translate_en2zh",
    "description": "英文单词翻译",
    "category": "system",
    "inputSchema": { "type": "object", "properties": { "words": { "type": "array", "items": { "type": "string" }, "description": "待翻译单词列表" } }, "additionalProperties": false, "required": ["words"] },
    "write": false,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "upload_file_stream",
    "description": "上传文件流",
    "category": "files",
    "inputSchema": {
      "type": "object",
      "properties": {
        "stream_id": { "type": "string", "description": "流 ID" },
        "chunk_data": { "type": "string", "description": "分块数据 (Base64)" },
        "chunk_index": { "type": "number", "description": "分块索引" },
        "total_chunks": { "type": "number", "description": "总分块数" },
        "file_size": { "type": "number", "description": "文件总大小" },
        "expected_sha256": { "type": "string", "description": "期望的 SHA256" },
        "is_complete": { "type": "boolean", "description": "是否完成" },
        "filename": { "type": "string", "description": "文件名" },
        "reset": { "type": "boolean", "description": "是否重置" },
        "verify_only": { "type": "boolean", "description": "是否仅验证" },
        "file_retention": { "type": "number", "default": 300000, "description": "文件保留时间 (毫秒)" }
      },
      "additionalProperties": false,
      "required": ["stream_id"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": [] },
    "transport": "stream",
    "returnsVoid": false
  },
  {
    "id": "upload_group_file",
    "description": "上传群文件",
    "category": "files",
    "inputSchema": {
      "type": "object",
      "properties": {
        "group_id": { "type": "string", "description": "群号" },
        "file": { "type": "string", "description": "资源路径或URL" },
        "name": { "type": "string", "description": "文件名" },
        "folder": { "type": "string", "description": "父目录 ID" },
        "folder_id": { "type": "string", "description": "父目录 ID (兼容性字段)" },
        "upload_file": { "type": "boolean", "default": true, "description": "是否执行上传" }
      },
      "additionalProperties": false,
      "required": ["group_id", "file", "name"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "upload_image_to_qun_album",
    "description": "上传图片到群相册",
    "category": "albums",
    "inputSchema": {
      "type": "object",
      "properties": {
        "group_id": { "type": "string", "description": "群号" },
        "album_id": { "type": "string", "description": "相册ID" },
        "album_name": { "type": "string", "description": "相册名称" },
        "file": { "type": "string", "description": "图片路径、URL或Base64" }
      },
      "additionalProperties": false,
      "required": ["group_id", "album_id", "album_name", "file"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "upload_images_to_qun_album",
    "description": "上传多张图片到群相册",
    "category": "albums",
    "inputSchema": {
      "type": "object",
      "properties": {
        "group_id": { "type": "string", "description": "群号" },
        "album_id": { "type": "string", "description": "相册ID" },
        "album_name": { "type": "string", "description": "相册名称" },
        "files": { "type": "array", "items": { "type": "string" }, "description": "图片路径、URL或Base64 数组，一次上传多张" }
      },
      "additionalProperties": false,
      "required": ["group_id", "album_id", "album_name", "files"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "upload_private_file",
    "description": "上传私聊文件",
    "category": "files",
    "inputSchema": {
      "type": "object",
      "properties": {
        "user_id": { "type": "string", "description": "用户 QQ" },
        "file": { "type": "string", "description": "资源路径或URL" },
        "name": { "type": "string", "description": "文件名" },
        "upload_file": { "type": "boolean", "default": true, "description": "是否执行上传" }
      },
      "additionalProperties": false,
      "required": ["user_id", "file", "name"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "account", "targetFields": ["user_id"] },
    "transport": "json",
    "returnsVoid": false
  },
  {
    "id": "upload_video_to_qun_album",
    "description": "上传视频到群相册",
    "category": "albums",
    "inputSchema": {
      "type": "object",
      "properties": {
        "group_id": { "type": "string", "description": "群号" },
        "album_id": { "type": "string", "description": "相册ID" },
        "album_name": { "type": "string", "description": "相册名称" },
        "file": { "type": "string", "description": "视频路径、URL或Base64" }
      },
      "additionalProperties": false,
      "required": ["group_id", "album_id", "album_name", "file"]
    },
    "write": true,
    "permission": "owner",
    "scope": { "kind": "group", "targetFields": ["group_id"] },
    "transport": "json",
    "returnsVoid": false
  },
]);

export function findQqCapability(id: string): QqCapabilityDefinition | undefined {
  return QQ_CAPABILITIES.find(capability => capability.id === id);
}
