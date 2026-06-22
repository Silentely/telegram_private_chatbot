// Cloudflare Worker：Telegram 双向机器人 v5.4 (合并 PR #11 + PR #12)

// --- 配置常量 ---
const CONFIG = {
  VERIFY_ID_LENGTH: 12,
  VERIFY_EXPIRE_SECONDS: 300, // 5分钟
  VERIFIED_EXPIRE_SECONDS: 2592000, // 30天
  MEDIA_GROUP_EXPIRE_SECONDS: 60,
  MEDIA_GROUP_DELAY_MS: 3000, // 3秒（从2秒增加）
  PENDING_MAX_MESSAGES: 10, // 验证期间最多暂存的消息数
  ADMIN_CACHE_TTL_SECONDS: 300, // 管理员权限缓存 5 分钟
  NEEDS_REVERIFY_TTL_SECONDS: 600, // 标记需重新验证的 TTL（用于并发兜底）
  RATE_LIMIT_MESSAGE: 45,
  RATE_LIMIT_VERIFY: 3,
  RATE_LIMIT_WINDOW: 60,
  BUTTON_COLUMNS: 2,
  MAX_TITLE_LENGTH: 128,
  MAX_NAME_LENGTH: 30,
  API_TIMEOUT_MS: 10000,
  CLEANUP_BATCH_SIZE: 10,
  MAX_CLEANUP_DISPLAY: 20,
  CLEANUP_LOCK_TTL_SECONDS: 1800, // /cleanup 防并发锁 30 分钟
  MAX_RETRY_ATTEMPTS: 3,
  THREAD_HEALTH_TTL_MS: 60000,
  // PR #12: Turnstile 和垃圾检测配置
  TURNSTILE_VERIFY_TTL: 600,            // Turnstile 验证 code 有效期 10 分钟
  NEW_USER_LINK_BLOCK_SECONDS: 86400,   // 新用户 24 小时内禁止发链接
  SPAM_MESSAGE_HASH_TTL: 3600,          // 消息去重 hash 缓存 1 小时
  SPAM_REPEAT_MESSAGE_LIMIT: 3,         // 相同内容重复次数阈值
  SPAM_NOTIFY_ADMIN: true,              // 是否通知管理员有骚扰消息
  SPAM_SILENCE_MODE: false              // 静默丢弃模式（不通知管理员）
};

// 线程健康检查缓存，减少频繁探测请求
const threadHealthCache = new Map();
// 同一实例内的并发保护：避免同一用户短时间内重复创建话题
const topicCreateInFlight = new Map();
// 管理员权限缓存（实例内）
const adminStatusCache = new Map();
// PR #12: 垃圾关键词集合（延迟初始化）
let spamKeywordsCache = null;
// PR #12: 消息哈希去重缓存（用于检测重复骚扰消息）
const messageHashCache = new Map();

// --- 本地题库 (15条) ---
const LOCAL_QUESTIONS = [
  {"question": "冰融化后会变成什么？", "correct_answer": "水", "incorrect_answers": ["石头", "木头", "火"]},
  {"question": "正常人有几只眼睛？", "correct_answer": "2", "incorrect_answers": ["1", "3", "4"]},
  {"question": "以下哪个属于水果？", "correct_answer": "香蕉", "incorrect_answers": ["白菜", "猪肉", "大米"]},
  {"question": "1 加 2 等于几？", "correct_answer": "3", "incorrect_answers": ["2", "4", "5"]},
  {"question": "5 减 2 等于几？", "correct_answer": "3", "incorrect_answers": ["1", "2", "4"]},
  {"question": "2 乘以 3 等于几？", "correct_answer": "6", "incorrect_answers": ["4", "5", "7"]},
  {"question": "10 加 5 等于几？", "correct_answer": "15", "incorrect_answers": ["10", "12", "20"]},
  {"question": "8 减 4 等于几？", "correct_answer": "4", "incorrect_answers": ["2", "3", "5"]},
  {"question": "在天上飞的交通工具是什么？", "correct_answer": "飞机", "incorrect_answers": ["汽车", "轮船", "自行车"]},
  {"question": "星期一的后面是星期几？", "correct_answer": "星期二", "incorrect_answers": ["星期日", "星期五", "星期三"]},
  {"question": "鱼通常生活在哪里？", "correct_answer": "水里", "incorrect_answers": ["树上", "土里", "火里"]},
  {"question": "我们用什么器官来听声音？", "correct_answer": "耳朵", "incorrect_answers": ["眼睛", "鼻子", "嘴巴"]},
  {"question": "晴朗的天空通常是什么颜色的？", "correct_answer": "蓝色", "incorrect_answers": ["绿色", "红色", "紫色"]},
  {"question": "太阳从哪个方向升起？", "correct_answer": "东方", "incorrect_answers": ["西方", "南方", "北方"]},
  {"question": "小狗发出的叫声通常是？", "correct_answer": "汪汪", "incorrect_answers": ["喵喵", "咩咩", "呱呱"]}
];

// --- PR #11: 屏蔽词列表（硬编码，用户可自行修改此数组） ---
const BLOCKED_WORDS = [
  "赌博",
  "色情",
  "代开发",
  "加微信",
  // ↑ 在此添加更多屏蔽词，每行一个，用引号包裹、逗号结尾
];

// 屏蔽词内存缓存（减少 KV 读取频率）
const blockedWordsCache = { data: null, ts: 0, ttl: 60000 }; // 缓存 60 秒

/**
 * 获取完整屏蔽词列表 = 硬编码 + KV 动态词库（合并去重）
 * @param {object} env - Worker 环境
 * @param {boolean} forceRefresh - 是否强制刷新缓存
 * @returns {Promise<string[]>}
 */
async function getBlockedWords(env, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && blockedWordsCache.data && (now - blockedWordsCache.ts < blockedWordsCache.ttl)) {
    return blockedWordsCache.data;
  }

  // 从 KV 读取动态屏蔽词
  let kvWords = [];
  try {
    const raw = await env.TOPIC_MAP.get("blocked_words_kv");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        kvWords = parsed.filter(w => typeof w === "string" && w.trim().length > 0);
      }
    }
  } catch (e) {
    Logger.warn('blocked_words_kv_parse_error', { error: e.message });
  }

  // 合并去重（硬编码优先，KV 补充）
  const merged = [...new Set([...BLOCKED_WORDS, ...kvWords])];
  blockedWordsCache.data = merged;
  blockedWordsCache.ts = now;
  return merged;
}

/**
 * 检查文本是否包含屏蔽词
 * @param {string} text - 待检查文本
 * @param {string[]} words - 屏蔽词列表
 * @returns {{ hit: boolean, word: string|null }}
 */
function containsBlockedWord(text, words) {
  if (!text || !words || words.length === 0) return { hit: false, word: null };
  const lower = text.toLowerCase();
  for (const w of words) {
    if (w && lower.includes(w.toLowerCase())) {
      return { hit: true, word: w };
    }
  }
  return { hit: false, word: null };
}

// --- 辅助工具函数 ---

// 结构化日志系统
const Logger = {
  /**
   * 记录信息级别日志
   * @param {string} action - 操作名称
   * @param {object} data - 附加数据
   */
  info(action, data = {}) {
    const log = {
      timestamp: new Date().toISOString(),
      level: 'INFO',
      action,
      ...data
    };
    console.log(JSON.stringify(log));
  },

  /**
   * 记录警告级别日志
   * @param {string} action - 操作名称
   * @param {object} data - 附加数据
   */
  warn(action, data = {}) {
    const log = {
      timestamp: new Date().toISOString(),
      level: 'WARN',
      action,
      ...data
    };
    console.warn(JSON.stringify(log));
  },

  /**
   * 记录错误级别日志
   * @param {string} action - 操作名称
   * @param {Error|string} error - 错误对象或消息
   * @param {object} data - 附加数据
   */
  error(action, error, data = {}) {
    const log = {
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      action,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      ...data
    };
    console.error(JSON.stringify(log));
  },

  /**
   * 记录调试级别日志
   * @param {string} action - 操作名称
   * @param {object} data - 附加数据
   */
  debug(action, data = {}) {
    const log = {
      timestamp: new Date().toISOString(),
      level: 'DEBUG',
      action,
      ...data
    };
    console.log(JSON.stringify(log));
  }
};

// 加密安全的随机数生成
function secureRandomInt(min, max) {
  const range = max - min;
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return min + (bytes[0] % range);
}

function secureRandomId(length = 12) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

// 安全的 JSON 获取
async function safeGetJSON(env, key, defaultValue = null) {
  try {
    const data = await env.TOPIC_MAP.get(key, { type: "json" });
    if (data === null || data === undefined) {
      return defaultValue;
    }
    if (typeof data !== 'object') {
      Logger.warn('kv_invalid_type', { key, type: typeof data });
      return defaultValue;
    }
    return data;
  } catch (e) {
    Logger.error('kv_parse_failed', e, { key });
    return defaultValue;
  }
}

function normalizeTgDescription(description) {
  return (description || "").toString().toLowerCase();
}

function isTopicMissingOrDeleted(description) {
  const desc = normalizeTgDescription(description);
  return desc.includes("thread not found") ||
    desc.includes("topic not found") ||
    desc.includes("message thread not found") ||
    desc.includes("topic deleted") ||
    desc.includes("thread deleted") ||
    desc.includes("forum topic not found") ||
    desc.includes("topic closed permanently");
}

function isTestMessageInvalid(description) {
  const desc = normalizeTgDescription(description);
  return desc.includes("message text is empty") ||
    desc.includes("bad request: message text is empty");
}

async function getOrCreateUserTopicRec(from, key, env, userId) {
  const existing = await safeGetJSON(env, key, null);
  if (existing && existing.thread_id) return existing;

  const inflight = topicCreateInFlight.get(String(userId));
  if (inflight) return await inflight;

  const p = (async () => {
    // 并发下二次确认，避免已被其他请求创建却读到旧值
    const again = await safeGetJSON(env, key, null);
    if (again && again.thread_id) return again;
    return await createTopic(from, key, env, userId);
  })();

  topicCreateInFlight.set(String(userId), p);
  try {
    return await p;
  } finally {
    if (topicCreateInFlight.get(String(userId)) === p) {
      topicCreateInFlight.delete(String(userId));
    }
  }
}

function withMessageThreadId(body, threadId) {
  if (threadId === undefined || threadId === null) return body;
  return { ...body, message_thread_id: threadId };
}

async function probeForumThread(env, expectedThreadId, { userId, reason, doubleCheckOnMissingThreadId = true } = {}) {
  const attemptOnce = async () => {
    const res = await tgCall(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: expectedThreadId,
      text: "🔎"
    });

    const actualThreadId = res.result?.message_thread_id;
    const probeMessageId = res.result?.message_id;

    // 尽可能清理探测消息（无论落到哪个话题/General）
    if (res.ok && probeMessageId) {
      try {
        await tgCall(env, "deleteMessage", {
          chat_id: env.SUPERGROUP_ID,
          message_id: probeMessageId
        });
      } catch (e) {
        // 删除失败不影响主流程
      }
    }

    if (!res.ok) {
      if (isTopicMissingOrDeleted(res.description)) {
        return { status: "missing", description: res.description };
      }
      if (isTestMessageInvalid(res.description)) {
        return { status: "probe_invalid", description: res.description };
      }
      return { status: "unknown_error", description: res.description };
    }

    // 关键：有些情况下 Telegram 会返回 ok 但不带 message_thread_id（常见于 General）
    if (actualThreadId === undefined || actualThreadId === null) {
      return { status: "missing_thread_id" };
    }

    if (Number(actualThreadId) !== Number(expectedThreadId)) {
      return { status: "redirected", actualThreadId };
    }

    return { status: "ok" };
  };

  const first = await attemptOnce();
  if (first.status !== "missing_thread_id" || !doubleCheckOnMissingThreadId) return first;

  // 二次探测：避免偶发字段缺失导致误判并触发重建
  const second = await attemptOnce();
  if (second.status === "missing_thread_id") {
    Logger.warn('thread_probe_missing_thread_id', { userId, expectedThreadId, reason });
  }
  return second;
}

async function resetUserVerificationAndRequireReverify(env, { userId, userKey, oldThreadId, pendingMsgId, reason }) {
  // 清理旧映射与验证状态：用户需要重新做人机验证
  await env.TOPIC_MAP.delete(`verified:${userId}`);
  await env.TOPIC_MAP.put(`needs_verify:${userId}`, "1", { expirationTtl: CONFIG.NEEDS_REVERIFY_TTL_SECONDS });
  await env.TOPIC_MAP.delete(`retry:${userId}`);

  if (userKey) {
    await env.TOPIC_MAP.delete(userKey);
  }

  if (oldThreadId !== undefined && oldThreadId !== null) {
    await env.TOPIC_MAP.delete(`thread:${oldThreadId}`);
    await env.TOPIC_MAP.delete(`thread_ok:${oldThreadId}`);
    threadHealthCache.delete(oldThreadId);
  }

  Logger.info('verification_reset_due_to_topic_loss', {
    userId,
    oldThreadId,
    pendingMsgId,
    reason
  });

  await sendVerificationChallenge(userId, env, pendingMsgId || null);
}

function parseAdminIdAllowlist(env) {
  const raw = (env.ADMIN_IDS || "").toString().trim();
  if (!raw) return null;
  const ids = raw.split(/[,;\s]+/g).map(s => s.trim()).filter(Boolean);
  const set = new Set();
  for (const id of ids) {
    const n = Number(id);
    if (!Number.isFinite(n)) continue;
    set.add(String(n));
  }
  return set.size > 0 ? set : null;
}

async function isAdminUser(env, userId) {
  const allowlist = parseAdminIdAllowlist(env);
  if (allowlist && allowlist.has(String(userId))) return true;

  const cacheKey = String(userId);
  const now = Date.now();
  const cached = adminStatusCache.get(cacheKey);
  if (cached && (now - cached.ts < CONFIG.ADMIN_CACHE_TTL_SECONDS * 1000)) {
    return cached.isAdmin;
  }

  const kvKey = `admin:${userId}`;
  const kvVal = await env.TOPIC_MAP.get(kvKey);
  if (kvVal === "1" || kvVal === "0") {
    const isAdmin = kvVal === "1";
    adminStatusCache.set(cacheKey, { ts: now, isAdmin });
    return isAdmin;
  }

  try {
    const res = await tgCall(env, "getChatMember", {
      chat_id: env.SUPERGROUP_ID,
      user_id: userId
    });

    const status = res.result?.status;
    const isAdmin = res.ok && (status === "creator" || status === "administrator");
    await env.TOPIC_MAP.put(kvKey, isAdmin ? "1" : "0", { expirationTtl: CONFIG.ADMIN_CACHE_TTL_SECONDS });
    adminStatusCache.set(cacheKey, { ts: now, isAdmin });
    return isAdmin;
  } catch (e) {
    Logger.warn('admin_check_failed', { userId });
    return false;
  }
}

// 获取所有 KV keys（处理分页）
async function getAllKeys(env, prefix) {
  const allKeys = [];
  let cursor = undefined;

  do {
    const result = await env.TOPIC_MAP.list({ prefix, cursor });
    allKeys.push(...result.keys);
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  return allKeys;
}

// Fisher-Yates 洗牌算法
function shuffleArray(arr) {
  const array = [...arr];
  for (let i = array.length - 1; i > 0; i--) {
    const j = secureRandomInt(0, i + 1);
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// 速率限制检查
async function checkRateLimit(userId, env, action = 'message', limit = 20, window = 60) {
  const key = `ratelimit:${action}:${userId}`;
  const countStr = await env.TOPIC_MAP.get(key);
  const count = parseInt(countStr || "0");

  if (count >= limit) {
    return { allowed: false, remaining: 0 };
  }

  await env.TOPIC_MAP.put(key, String(count + 1), { expirationTtl: window });
  return { allowed: true, remaining: limit - count - 1 };
}

// --- PR #12: Turnstile 人机验证模块 ---

/**
 * 调用 Cloudflare Turnstile API 验证 token
 * @param {string} token - Turnstile 前端生成的 token
 * @param {string} secretKey - Turnstile secret key
 * @param {string} remoteIp - 用户 IP（可选）
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function verifyTurnstileToken(token, secretKey, remoteIp) {
  const formData = new URLSearchParams();
  formData.append('secret', secretKey);
  formData.append('response', token);
  if (remoteIp) {
    formData.append('remoteip', remoteIp);
  }

  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString()
    });
    const result = await resp.json();
    return { success: result.success === true, error: result['error-codes']?.join(', ') };
  } catch (e) {
    Logger.error('turnstile_verify_error', e);
    return { success: false, error: e.message };
  }
}

/**
 * 生成安全的验证 code（用于 Turnstile 回调）
 * @returns {string} 随机验证码
 */
function generateVerifyCode() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// --- PR #12: 垃圾内容检测模块 ---

/**
 * 加载/解析垃圾关键词列表
 * @param {object} env - 环境变量
 * @returns {string[]} 关键词数组
 */
function getSpamKeywords(env) {
  if (spamKeywordsCache) return spamKeywordsCache;

  const raw = (env.SPAM_KEYWORDS || '').toString().trim();
  if (!raw) {
    spamKeywordsCache = [];
    return spamKeywordsCache;
  }

  spamKeywordsCache = raw.split(/[,;，；\n]+/g)
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length > 0);

  if (spamKeywordsCache.length > 0) {
    Logger.info('spam_keywords_loaded', { count: spamKeywordsCache.length });
  }
  return spamKeywordsCache;
}

/**
 * 检测消息文本中是否包含 URL/链接
 * @param {string} text - 消息文本
 * @returns {boolean}
 */
function containsLink(text) {
  if (!text) return false;
  const patterns = [
    /https?:\/\/\S+/i,
    /[a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z]{2,}(\/\S*)?/,
    /t\.me\/\S+/i,
    /telegram\.me\/\S+/i,
  ];
  return patterns.some(p => p.test(text));
}

/**
 * 检测消息是否包含垃圾关键词
 * @param {string} text - 消息文本
 * @param {string[]} keywords - 关键词列表
 * @returns {{isSpam: boolean, matchedWord: string|null}}
 */
function detectSpamKeywords(text, keywords) {
  if (!text || keywords.length === 0) {
    return { isSpam: false, matchedWord: null };
  }
  const lower = text.toLowerCase();
  for (const word of keywords) {
    if (lower.includes(word)) {
      return { isSpam: true, matchedWord: word };
    }
  }
  return { isSpam: false, matchedWord: null };
}

/**
 * 计算消息内容的简单哈希（用于重复检测）
 * @param {object} msg - Telegram message object
 * @returns {string|null} 哈希字符串，无法计算时返回 null
 */
function computeMessageHash(msg) {
  const text = (msg.text || msg.caption || '').trim().toLowerCase();
  if (!text) return null;

  // 简单 SHA-like：用 text 长度 + 前100字符 + 后20字符 组成 fingerprint
  const fingerprint = `${text.length}|${text.substring(0, 100)}|${text.substring(Math.max(0, text.length - 20))}`;
  return fingerprint;
}

/**
 * 检测用户是否在短时间内重复发送相同内容
 * @param {number} userId - 用户 ID
 * @param {object} msg - Telegram message object
 * @returns {Promise<{isRepeat: boolean, count: number}>}
 */
async function detectRepeatMessage(userId, msg) {
  const hash = computeMessageHash(msg);
  if (!hash) return { isRepeat: false, count: 0 };

  const cacheKey = `msghash:${userId}:${hash}`;
  const cached = messageHashCache.get(cacheKey);
  const count = (cached?.count || 0) + 1;

  messageHashCache.set(cacheKey, { count, ts: Date.now() });

  if (count >= CONFIG.SPAM_REPEAT_MESSAGE_LIMIT) {
    return { isRepeat: true, count };
  }
  return { isRepeat: false, count };
}

/**
 * 综合垃圾检测（关键词 + 链接 + 重复）
 * @param {object} msg - Telegram message object
 * @param {number} userId - 用户 ID
 * @param {object} env - 环境变量
 * @returns {Promise<{isSpam: boolean, reasons: string[], details: object}>}
 */
async function spamCheck(msg, userId, env) {
  const reasons = [];
  const details = {};
  const text = (msg.text || msg.caption || '').trim();

  // 1. 关键词检测
  const keywords = getSpamKeywords(env);
  const keywordResult = detectSpamKeywords(text, keywords);
  if (keywordResult.isSpam) {
    reasons.push('keyword');
    details.keyword = keywordResult.matchedWord;
  }

  // 2. 链接检测（新用户限制）
  if (containsLink(text)) {
    // 检查用户验证时间：如果在 24 小时内验证的，拦截链接
    const verifyTs = await env.TOPIC_MAP.get(`verified_ts:${userId}`);
    if (verifyTs) {
      const elapsed = (Date.now() - parseInt(verifyTs)) / 1000;
      if (elapsed < CONFIG.NEW_USER_LINK_BLOCK_SECONDS) {
        const remainingHours = Math.ceil((CONFIG.NEW_USER_LINK_BLOCK_SECONDS - elapsed) / 3600);
        reasons.push('new_user_link');
        details.linkBlockRemainingHours = remainingHours;
      }
    }
  }

  // 3. 重复消息检测
  const repeatResult = await detectRepeatMessage(userId, msg);
  if (repeatResult.isRepeat) {
    reasons.push('repeat_message');
    details.repeatCount = repeatResult.count;
  }

  return {
    isSpam: reasons.length > 0,
    reasons,
    details
  };
}

/**
 * 处理垃圾消息（通知管理员或静默丢弃）
 * @param {object} env - 环境变量
 * @param {number} userId - 用户 ID
 * @param {object} msg - 消息对象
 * @param {object} spamResult - spamCheck 返回的结果
 * @param {number} threadId - 可选，话题 ID
 */
async function handleSpamMessage(env, userId, msg, spamResult, threadId) {
  Logger.warn('spam_detected', {
    userId,
    reasons: spamResult.reasons,
    details: spamResult.details,
    textPreview: (msg.text || msg.caption || '').substring(0, 100)
  });

  if (CONFIG.SPAM_NOTIFY_ADMIN && !CONFIG.SPAM_SILENCE_MODE) {
    const reasonText = spamResult.reasons.map(r => {
      switch (r) {
        case 'keyword': return `🔑 关键词: \`${spamResult.details.keyword}\``;
        case 'new_user_link': return `🔗 新用户链接 (剩余 ${spamResult.details.linkBlockRemainingHours}h)`;
        case 'repeat_message': return `🔄 重复消息 (${spamResult.details.repeatCount}次)`;
        default: return r;
      }
    }).join('\n');

    const body = threadId ? { message_thread_id: threadId } : {};

    await tgCall(env, 'sendMessage', {
      chat_id: env.SUPERGROUP_ID,
      text: `⚠️ **检测到疑似骚扰消息**\n\n👤 用户: \`${userId}\`\n${reasonText}\n\n📝 消息已拦截。使用 /ban 封禁该用户。`,
      parse_mode: 'Markdown',
      ...body
    });
  }
}

// --- PR #12: Turnstile 验证页面 HTML 模板 ---
// 由 Worker 的 GET /verify 端点渲染，用户点击 bot 按钮后跳转到此页面
// 模板变量：{{SITE_KEY}} {{CODE}} {{USER_ID}} {{WORKER_URL}}
const VERIFY_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>人机验证</title>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f0f2f5;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:20px}
.card{background:#fff;border-radius:16px;padding:32px 24px;max-width:400px;width:100%;text-align:center;box-shadow:0 2px 16px rgba(0,0,0,0.08)}
.icon{font-size:48px;margin-bottom:12px}
h2{color:#1a1a1a;margin-bottom:8px;font-size:20px}
p.desc{color:#666;font-size:14px;margin-bottom:24px;line-height:1.6}
.turnstile-container{display:flex;justify-content:center;margin-bottom:20px;min-height:65px}
#status{font-size:13px;color:#999;margin-top:12px;min-height:20px}
.success{color:#22c55e}
.error{color:#ef4444}
.footer{margin-top:20px;font-size:11px;color:#bbb}
.footer span{font-family:monospace;color:#999}
</style>
</head>
<body>
<div class="card">
  <div class="icon">🛡️</div>
  <h2>人机验证</h2>
  <p class="desc">请完成下方验证以确认您不是机器人。<br>验证通过后您的消息将自动送达。</p>
  <div class="turnstile-container">
    <div class="cf-turnstile" data-sitekey="{{SITE_KEY}}" data-callback="onTurnstileSuccess" data-error-callback="onTurnstileError" data-theme="light"></div>
  </div>
  <div id="status">正在加载验证组件...</div>
  <a id="back-btn" href="tg://resolve" style="display:none;margin-top:16px;background:#0088cc;color:#fff;border:none;padding:12px 24px;border-radius:8px;font-size:16px;text-decoration:none;">📱 返回 Telegram</a>
  <div class="footer">
    User: <span>{{USER_ID}}</span> · Code: <span>{{CODE}}</span>
  </div>
</div>
<script>
var submitted = false;
function showStatus(msg, cls) {
  var el = document.getElementById('status');
  el.textContent = msg;
  el.className = cls || '';
}
function onTurnstileSuccess(token) {
  if (submitted) return;
  submitted = true;
  showStatus('✅ 验证通过！正在通知机器人...', 'success');
  fetch('{{WORKER_URL}}/verify-callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: token, code: '{{CODE}}', userId: '{{USER_ID}}' })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.success) {
      var msg = '✅ 验证成功！机器人已收到您的消息。';
      if (data.pendingCount > 0) {
        msg += '（' + data.pendingCount + ' 条消息将于数秒内送达）';
      }
      showStatus(msg, 'success');
      document.querySelector('.desc').textContent = '请返回 Telegram，机器人已向您发送了验证通过通知。';
      // 显示返回 Telegram 按钮
      var btn = document.getElementById('back-btn');
      if (btn) {
        btn.style.display = 'inline-block';
      }
    } else {
      var errMap = {
        'turnstile_failed': '人机验证未通过，请刷新页面重试',
        'code_invalid_or_expired': '验证链接已过期（有效期10分钟），请返回 Telegram 重新发送消息获取新的验证链接',
        'server_not_configured': '服务器未完成配置，请联系管理员'
      };
      var errMsg = errMap[data.error] || ('验证失败: ' + (data.detail || data.error || '未知错误'));
      showStatus(errMsg, 'error');
      submitted = false;
      if (window.turnstile) {
        window.turnstile.reset();
      }
    }
  })
  .catch(function(e) {
    showStatus('❌ 网络连接失败，请检查网络后刷新页面重试', 'error');
    submitted = false;
    if (window.turnstile) {
      window.turnstile.reset();
    }
  });
}
function onTurnstileError() {
  showStatus('⚠️ 验证组件加载失败，请刷新页面重试', 'error');
}
</script>
</body>
</html>`;

export default {
  async fetch(request, env, ctx) {
    // 环境自检
    if (!env.TOPIC_MAP) return new Response("Error: KV 'TOPIC_MAP' not bound.");
    if (!env.BOT_TOKEN) return new Response("Error: BOT_TOKEN not set.");
    if (!env.SUPERGROUP_ID) return new Response("Error: SUPERGROUP_ID not set.");

    // 规范化环境变量，统一为字符串类型
    const normalizedEnv = {
      ...env,
      SUPERGROUP_ID: String(env.SUPERGROUP_ID),
      BOT_TOKEN: String(env.BOT_TOKEN)
    };

    // 验证 SUPERGROUP_ID 格式
    if (!normalizedEnv.SUPERGROUP_ID.startsWith("-100")) {
      return new Response("Error: SUPERGROUP_ID must start with -100");
    }

    const url = new URL(request.url);

    // --- PR #12: GET 请求处理 ---

    if (request.method === "GET") {
      // 健康检查
      if (url.pathname === "/" || url.pathname === "/health") {
        return new Response("OK");
      }

      // Turnstile 验证页面（用户点击 bot 按钮后跳转到的页面）
      if (url.pathname === "/verify" || url.pathname.endsWith("/verify")) {
        const code = url.searchParams.get('code');
        const userId = url.searchParams.get('uid');
        const siteKey = (env.TURNSTILE_SITE_KEY || '').toString().trim();

        if (!code || !userId || !siteKey) {
          return new Response(
            '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h2>❌ 参数无效</h2><p>缺少验证信息或系统未配置 Turnstile。</p></body></html>',
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          );
        }

        const workerUrl = url.origin;

        return new Response(VERIFY_PAGE_HTML
          .replace(/{{SITE_KEY}}/g, siteKey)
          .replace(/{{CODE}}/g, code)
          .replace(/{{USER_ID}}/g, userId)
          .replace(/{{WORKER_URL}}/g, workerUrl),
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }

      return new Response("Not Found", { status: 404 });
    }

    // --- POST 请求处理（Telegram webhook + Turnstile token 验证） ---

    // PR #12: Turnstile token 验证端点（由前端页面 JS fetch 调用）
    if ((url.pathname === "/verify-callback" || url.pathname.endsWith("/verify-callback")) && request.method === "POST") {
      try {
        const body = await request.json();
        const { token, code, userId } = body || {};

        if (!token || !code || !userId) {
          return new Response(JSON.stringify({ success: false, error: 'missing_params' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // 验证 Turnstile token
        const turnstileSecret = (env.TURNSTILE_SECRET_KEY || '').toString().trim();
        if (!turnstileSecret) {
          return new Response(JSON.stringify({ success: false, error: 'server_not_configured' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const verifyResult = await verifyTurnstileToken(token, turnstileSecret);
        if (!verifyResult.success) {
          Logger.warn('turnstile_token_invalid', { userId, error: verifyResult.error });
          return new Response(JSON.stringify({ success: false, error: 'turnstile_failed', detail: verifyResult.error }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // 从 KV 验证 code 是否匹配
        const storedUserId = await env.TOPIC_MAP.get(`turnstile_code:${code}`);
        if (!storedUserId || storedUserId !== String(userId)) {
          return new Response(JSON.stringify({ success: false, error: 'code_invalid_or_expired' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Turnstile token 有效 + code 匹配 → 标记验证通过
        await env.TOPIC_MAP.put(`verified:${userId}`, "1", { expirationTtl: CONFIG.VERIFIED_EXPIRE_SECONDS });
        await env.TOPIC_MAP.put(`verified_ts:${userId}`, String(Date.now()), { expirationTtl: CONFIG.VERIFIED_EXPIRE_SECONDS });
        await env.TOPIC_MAP.delete(`needs_verify:${userId}`);
        await env.TOPIC_MAP.delete(`turnstile_code:${code}`);
        await env.TOPIC_MAP.delete(`user_challenge:${userId}`);

        Logger.info('turnstile_verification_success', { userId });

        // 删除验证消息（去掉带按钮的验证卡片）
        const verifyMsgId = await env.TOPIC_MAP.get(`turnstile_msg:${code}`);
        ctx.waitUntil((async () => {
          if (verifyMsgId) {
            try {
              await tgCall(normalizedEnv, "deleteMessage", {
                chat_id: Number(userId),
                message_id: parseInt(verifyMsgId)
              });
            } catch (e) {
              // 消息可能已被删除，忽略
            }
            await env.TOPIC_MAP.delete(`turnstile_msg:${code}`);
          }
          await tgCall(normalizedEnv, "sendMessage", {
            chat_id: Number(userId),
            text: "✦ 验证通过\n\n有什么可以帮你的？直接发消息就好。",
            parse_mode: "Markdown"
          });
        })());

        // 返回 pending 消息列表供前端页面显示，由 worker 在后台转发
        const pendingKey = `pending_turnstile:${userId}`;
        const pendingIdsStr = await env.TOPIC_MAP.get(pendingKey);
        let pendingCount = 0;
        if (pendingIdsStr) {
          try {
            const pendingIds = JSON.parse(pendingIdsStr);
            if (Array.isArray(pendingIds) && pendingIds.length > 0) {
              pendingCount = Math.min(pendingIds.length, CONFIG.PENDING_MAX_MESSAGES);
              ctx.waitUntil((async () => {
                let forwardedCount = 0;
                const limited = pendingIds.slice(0, CONFIG.PENDING_MAX_MESSAGES);
                for (const pendingId of limited) {
                  if (!pendingId) continue;
                  const fakeMsg = {
                    message_id: pendingId,
                    chat: { id: Number(userId), type: "private" },
                    from: { id: Number(userId) },
                  };
                  try {
                    await forwardToTopic(fakeMsg, userId, `user:${userId}`, normalizedEnv, ctx);
                    forwardedCount++;
                  } catch (e) {
                    Logger.error('pending_turnstile_forward_failed', e, { userId, messageId: pendingId });
                  }
                }
                if (forwardedCount > 0) {
                  await tgCall(normalizedEnv, "sendMessage", {
                    chat_id: Number(userId),
                    text: `📩 刚才的 ${forwardedCount} 条消息已帮您送达。`
                  });
                }
                await env.TOPIC_MAP.delete(pendingKey);
              })());
            }
          } catch (e) {
            Logger.error('pending_turnstile_parse_failed', e, { userId });
          }
        }

        return new Response(JSON.stringify({ success: true, pendingCount }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (e) {
        Logger.error('verify_callback_error', e);
        return new Response(JSON.stringify({ success: false, error: 'server_error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // 验证 Content-Type
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      Logger.warn('invalid_content_type', { contentType });
      return new Response("OK");
    }

    let update;
    try {
      update = await request.json();

      // 验证基本结构
      if (!update || typeof update !== 'object') {
        Logger.warn('invalid_json_structure', { update: typeof update });
        return new Response("OK");
      }
    } catch (e) {
      Logger.error('json_parse_failed', e);
      return new Response("OK");
    }

    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, normalizedEnv, ctx);
      return new Response("OK");
    }

    const msg = update.message;
    if (!msg) return new Response("OK");

    ctx.waitUntil(flushExpiredMediaGroups(normalizedEnv, Date.now()));

    if (msg.chat && msg.chat.type === "private") {
      try {
        await handlePrivateMessage(msg, normalizedEnv, ctx);
      } catch (e) {
        // 不向用户泄露技术细节
        const errText = `⚠️ 系统繁忙，请稍后再试。`;
        await tgCall(normalizedEnv, "sendMessage", { chat_id: msg.chat.id, text: errText });
        Logger.error('private_message_failed', e, { userId: msg.chat.id });
      }
      return new Response("OK");
    }

    // 使用字符串比较
    if (msg.chat && String(msg.chat.id) === normalizedEnv.SUPERGROUP_ID) {
      if (msg.forum_topic_closed && msg.message_thread_id) {
        await updateThreadStatus(msg.message_thread_id, true, normalizedEnv);
        return new Response("OK");
      }
      if (msg.forum_topic_reopened && msg.message_thread_id) {
        await updateThreadStatus(msg.message_thread_id, false, normalizedEnv);
        return new Response("OK");
      }
      // 支持 General 话题和普通话题
      // General 话题的 message_thread_id 可能不存在，或者等于 1
      const text = (msg.text || "").trim();
      const isCommand = !!text && text.startsWith("/");
      if (msg.message_thread_id || isCommand) {
        await handleAdminReply(msg, normalizedEnv, ctx);
        return new Response("OK");
      }
    }

    return new Response("OK");
  },
};

// ---------------- 核心业务逻辑 ----------------

async function handlePrivateMessage(msg, env, ctx) {
  const userId = msg.chat.id;
  const key = `user:${userId}`;

  // 速率限制检查
  const rateLimit = await checkRateLimit(userId, env, 'message', CONFIG.RATE_LIMIT_MESSAGE, CONFIG.RATE_LIMIT_WINDOW);
  if (!rateLimit.allowed) {
    await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: "⚠️ 发送过于频繁，请稍后再试。"
    });
    return;
  }

  // 拦截普通用户发送的指令
  if (msg.text && msg.text.startsWith("/") && msg.text.trim() !== "/start") {
    return;
  }

  const isBanned = await env.TOPIC_MAP.get(`banned:${userId}`);
  if (isBanned) return;

  // PR #11: 屏蔽词检查（在验证之前检查，避免带屏蔽词的消息被暂存并转发）
  const blockedWords = await getBlockedWords(env);
  const textToCheck = [msg.text, msg.caption].filter(Boolean).join(" ");
  const blockResult = containsBlockedWord(textToCheck, blockedWords);
  if (blockResult.hit) {
    Logger.info('message_blocked_by_word', { userId, word: blockResult.word });
    await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: "🚫 您的消息包含违规内容，已被拦截，请修改后重新发送。"
    });
    return;
  }

  // PR #12: 垃圾内容检测（在验证之前检查）
  const spamResult = await spamCheck(msg, userId, env);
  if (spamResult.isSpam) {
    await handleSpamMessage(env, userId, msg, spamResult);
    return;
  }

  const verified = await env.TOPIC_MAP.get(`verified:${userId}`);

  if (!verified) {
    const isStart = msg.text && msg.text.trim() === "/start";
    const pendingMsgId = isStart ? null : msg.message_id;
    await sendVerificationChallenge(userId, env, pendingMsgId);
    return;
  }

  await forwardToTopic(msg, userId, key, env, ctx);
}

async function forwardToTopic(msg, userId, key, env, ctx) {
  // 并发兜底：如果已被标记为需要重新验证，直接发起验证并暂停转发/建话题
  const needsVerify = await env.TOPIC_MAP.get(`needs_verify:${userId}`);
  if (needsVerify) {
    await sendVerificationChallenge(userId, env, msg.message_id || null);
    return;
  }

  // 使用安全的 JSON 解析
  let rec = await safeGetJSON(env, key, null);

  if (rec && rec.closed) {
    await tgCall(env, "sendMessage", { chat_id: userId, text: "🚫 当前对话已被管理员关闭。" });
    return;
  }

  // 重试计数器，防止无限循环
  const retryKey = `retry:${userId}`;
  let retryCount = parseInt(await env.TOPIC_MAP.get(retryKey) || "0");

  if (retryCount > CONFIG.MAX_RETRY_ATTEMPTS) {
    await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: "❌ 系统繁忙，请稍后再试。"
    });
    await env.TOPIC_MAP.delete(retryKey);
    return;
  }

  if (!rec || !rec.thread_id) {
    rec = await getOrCreateUserTopicRec(msg.from, key, env, userId);
    if (!rec || !rec.thread_id) {
      throw new Error("创建话题失败");
    }
  }

  // 补建 thread->user 映射（兼容旧数据）
  if (rec && rec.thread_id) {
    const mappedUser = await env.TOPIC_MAP.get(`thread:${rec.thread_id}`);
    if (!mappedUser) {
      await env.TOPIC_MAP.put(`thread:${rec.thread_id}`, String(userId));
    }
  }

  // 验证话题是否仍然存在（带缓存，降低探测频率）
  // 当话题被删除后，KV中的thread_id仍然存在，但实际话题已不可用
  if (rec && rec.thread_id) {
    const cacheKey = rec.thread_id;
    const now = Date.now();
    const cached = threadHealthCache.get(cacheKey);
    const withinTTL = cached && (now - cached.ts < CONFIG.THREAD_HEALTH_TTL_MS);

    if (!withinTTL) {
      // 跨节点缓存：避免由于 Workers 多 PoP 导致每次都做健康探测
      const kvHealthKey = `thread_ok:${rec.thread_id}`;
      const kvHealthOk = await env.TOPIC_MAP.get(kvHealthKey);
      if (kvHealthOk === "1") {
        threadHealthCache.set(cacheKey, { ts: now, ok: true });
      } else {
        const probe = await probeForumThread(env, rec.thread_id, { userId, reason: "health_check" });

        if (probe.status === "redirected" || probe.status === "missing" || probe.status === "missing_thread_id") {
          await resetUserVerificationAndRequireReverify(env, {
            userId,
            userKey: key,
            oldThreadId: rec.thread_id,
            pendingMsgId: msg.message_id,
            reason: `health_check:${probe.status}`
          });
          return;
        } else if (probe.status === "probe_invalid") {
          Logger.warn('topic_health_probe_invalid_message', {
            userId,
            threadId: rec.thread_id,
            errorDescription: probe.description
          });

          // 仍然设置短 TTL，避免每条消息都探测（并误触发重建）
          threadHealthCache.set(cacheKey, { ts: now, ok: true });
          await env.TOPIC_MAP.put(kvHealthKey, "1", { expirationTtl: Math.ceil(CONFIG.THREAD_HEALTH_TTL_MS / 1000) });
        } else if (probe.status === "unknown_error") {
          Logger.warn('topic_test_failed_unknown', {
            userId,
            threadId: rec.thread_id,
            errorDescription: probe.description
          });
        } else {
          await env.TOPIC_MAP.delete(retryKey);
          threadHealthCache.set(cacheKey, { ts: now, ok: true });
          await env.TOPIC_MAP.put(kvHealthKey, "1", { expirationTtl: Math.ceil(CONFIG.THREAD_HEALTH_TTL_MS / 1000) });
        }
      }
    }
  }

  // --- PR #11: 屏蔽词检查（文本 + caption 均检查） ---
  const blockedWords = await getBlockedWords(env);
  const textToCheck = [msg.text, msg.caption].filter(Boolean).join(" ");
  const blockResult = containsBlockedWord(textToCheck, blockedWords);
  if (blockResult.hit) {
    Logger.info('message_blocked_by_word', { userId, word: blockResult.word });
    await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: "🚫 您的消息包含违规内容，已被拦截，请修改后重新发送。"
    });
    return;
  }

  // PR #12: 垃圾内容检测（转发前二次检查）
  const spamResult = await spamCheck(msg, userId, env);
  if (spamResult.isSpam) {
    await handleSpamMessage(env, userId, msg, spamResult, rec.thread_id);
    return;
  }

  if (msg.media_group_id) {
    // 媒体组也需要检查 caption（上面已检查，此处冗余保险）
    if (blockResult.hit) return;
    await handleMediaGroup(msg, env, ctx, {
      direction: "p2t",
      targetChat: env.SUPERGROUP_ID,
      threadId: rec.thread_id
    });
    return;
  }

  const res = await tgCall(env, "forwardMessage", {
    chat_id: env.SUPERGROUP_ID,
    from_chat_id: userId,
    message_id: msg.message_id,
    message_thread_id: rec.thread_id,
  });

  // 检测 Telegram 静默重定向到 General 的情况
  const resThreadId = res.result?.message_thread_id;
  if (res.ok && resThreadId !== undefined && resThreadId !== null && Number(resThreadId) !== Number(rec.thread_id)) {
    Logger.warn('forward_redirected_to_general', {
      userId,
      expectedThreadId: rec.thread_id,
      actualThreadId: resThreadId
    });

    // 删除误投到 General 的消息
    if (res.result?.message_id) {
      try {
        await tgCall(env, "deleteMessage", {
          chat_id: env.SUPERGROUP_ID,
          message_id: res.result.message_id
        });
      } catch (e) {
        // 删除失败不影响重发
      }
    }
    await resetUserVerificationAndRequireReverify(env, {
      userId,
      userKey: key,
      oldThreadId: rec.thread_id,
      pendingMsgId: msg.message_id,
      reason: "forward_redirected_to_general"
    });
    return;
  }

  // 兜底：部分情况下 Telegram 返回 ok 但不带 message_thread_id（可能已落入 General）
  if (res.ok && (resThreadId === undefined || resThreadId === null)) {
    const probe = await probeForumThread(env, rec.thread_id, { userId, reason: "forward_result_missing_thread_id" });
    if (probe.status !== "ok") {
      Logger.warn('forward_suspected_redirect_or_missing', {
        userId,
        expectedThreadId: rec.thread_id,
        probeStatus: probe.status,
        probeDescription: probe.description
      });

      // 尽量删除误投消息（通常在 General）
      if (res.result?.message_id) {
        try {
          await tgCall(env, "deleteMessage", {
            chat_id: env.SUPERGROUP_ID,
            message_id: res.result.message_id
          });
        } catch (e) {
          // 删除失败不影响重发
        }
      }
      await resetUserVerificationAndRequireReverify(env, {
        userId,
        userKey: key,
        oldThreadId: rec.thread_id,
        pendingMsgId: msg.message_id,
        reason: `forward_missing_thread_id:${probe.status}`
      });
      return;
    }
  }

  // 增强错误处理，双重保险
  // 如果上面的测试没有捕获到，这里再次检测
  if (!res.ok) {
    const desc = normalizeTgDescription(res.description);
    if (isTopicMissingOrDeleted(desc)) {
      Logger.warn('forward_failed_topic_missing', {
        userId,
        threadId: rec.thread_id,
        errorDescription: res.description
      });
      await resetUserVerificationAndRequireReverify(env, {
        userId,
        userKey: key,
        oldThreadId: rec.thread_id,
        pendingMsgId: msg.message_id,
        reason: "forward_failed_topic_missing"
      });
      return;
    }

    if (desc.includes("chat not found")) throw new Error(`群组ID错误: ${env.SUPERGROUP_ID}`);
    if (desc.includes("not enough rights")) throw new Error("机器人权限不足 (需 Manage Topics)");

    // 如果forwardMessage失败，尝试使用copyMessage作为降级方案
    await tgCall(env, "copyMessage", {
      chat_id: env.SUPERGROUP_ID,
      from_chat_id: userId,
      message_id: msg.message_id,
      message_thread_id: rec.thread_id
    });
  }
}

/**
 * 移除命令中的 @botname 后缀
 * 例如：/listwords@callcosr_bot -> /listwords
 * @param {string} text - 原始命令文本
 * @returns {string} 清理后的命令文本
 */
function removeCommandBotSuffix(text) {
  if (!text || !text.startsWith("/")) return text;
  // 匹配 /command@botname 格式，移除 @botname 部分
  return text.replace(/^\/([a-zA-Z0-9_]+)@[a-zA-Z0-9_]+/, '/$1');
}

async function handleAdminReply(msg, env, ctx) {
  const threadId = msg.message_thread_id;
  const rawText = (msg.text || "").trim();
  const text = removeCommandBotSuffix(rawText); // 移除 @botname 后缀
  const senderId = msg.from?.id;

  // 仅允许管理员在群内操作与回信，防止任意群成员向用户私聊注入消息
  if (!senderId || !(await isAdminUser(env, senderId))) {
    return;
  }

  // 允许在任何话题执行 /cleanup 命令
  if (text === "/cleanup") {
    // /cleanup 可能处理较久，使用 waitUntil 防止 webhook 请求超时导致"卡住"
    ctx.waitUntil(handleCleanupCommand(threadId, env));
    return;
  }

  // --- 全局命令（不依赖 userId，可在 General 话题执行） ---

  // PR #12: /help 指令
  if (text === "/help") {
    const helpText = `📋 **指令列表**

**用户指令：**
/start - 开始对话（触发验证）
/help - 显示此帮助信息

**管理员指令（话题内）：**
/close - 关闭对话
/open - 恢复对话
/reset - 重置用户验证
/trust - 设置永久信任
/ban - 封禁用户
/unban - 解封用户
/info - 查看用户信息
/cleanup - 清理无效话题

**屏蔽词管理：**
/addword 词 - 添加屏蔽词
/delword 词 - 删除屏蔽词
/listwords - 查看屏蔽词列表

**关于：**
• 私聊机器人发送消息，管理员在话题内回复
• 支持文本、图片、视频、文档等多种消息类型
• 内置人机验证和垃圾内容过滤`;

    await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: helpText, parse_mode: "Markdown" });
    return;
  }

  // --- PR #11: 屏蔽词管理命令 ---

  // /addword 词 — 添加屏蔽词到 KV 动态词库
  if (text.startsWith("/addword ")) {
    const word = text.slice(9).trim();
    if (!word) {
      await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "⚠️ 用法: `/addword 屏蔽词`", parse_mode: "Markdown" });
      return;
    }
    let kvWords = [];
    try {
      const raw = await env.TOPIC_MAP.get("blocked_words_kv");
      if (raw) kvWords = JSON.parse(raw);
    } catch (e) { /* 忽略解析错误，从空数组开始 */ }
    if (!Array.isArray(kvWords)) kvWords = [];

    // 检查是否已存在（合并硬编码一起判断）
    const allWords = [...new Set([...BLOCKED_WORDS, ...kvWords])];
    if (allWords.map(w => w.toLowerCase()).includes(word.toLowerCase())) {
      await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: `⚠️ 屏蔽词「${word}」已存在。`, parse_mode: "Markdown" });
      return;
    }

    kvWords.push(word);
    await env.TOPIC_MAP.put("blocked_words_kv", JSON.stringify(kvWords));
    // 强制刷新缓存
    blockedWordsCache.data = null;
    Logger.info('blocked_word_added', { word, by: senderId });
    await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: `✅ 已添加屏蔽词「${word}」\n当前动态词库共 ${kvWords.length} 个词`, parse_mode: "Markdown" });
    return;
  }

  // /delword 词 — 从 KV 动态词库删除屏蔽词（硬编码词无法通过此命令删除，需修改代码）
  if (text.startsWith("/delword ")) {
    const word = text.slice(9).trim();
    if (!word) {
      await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "⚠️ 用法: `/delword 屏蔽词`", parse_mode: "Markdown" });
      return;
    }

    // 检查是否为硬编码词
    if (BLOCKED_WORDS.map(w => w.toLowerCase()).includes(word.toLowerCase())) {
      await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: `⚠️「${word}」是硬编码屏蔽词，无法通过命令删除，请直接修改代码中的 BLOCKED_WORDS 数组。`, parse_mode: "Markdown" });
      return;
    }

    let kvWords = [];
    try {
      const raw = await env.TOPIC_MAP.get("blocked_words_kv");
      if (raw) kvWords = JSON.parse(raw);
    } catch (e) { /* 忽略 */ }
    if (!Array.isArray(kvWords)) kvWords = [];

    const before = kvWords.length;
    kvWords = kvWords.filter(w => w.toLowerCase() !== word.toLowerCase());

    if (kvWords.length === before) {
      await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: `⚠️ 屏蔽词「${word}」不存在于动态词库中。`, parse_mode: "Markdown" });
      return;
    }

    await env.TOPIC_MAP.put("blocked_words_kv", JSON.stringify(kvWords));
    blockedWordsCache.data = null; // 强制刷新缓存
    Logger.info('blocked_word_removed', { word, by: senderId });
    await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: `✅ 已删除屏蔽词「${word}」\n当前动态词库共 ${kvWords.length} 个词`, parse_mode: "Markdown" });
    return;
  }

  // /listwords — 列出所有屏蔽词（硬编码 + 动态）
  if (text === "/listwords") {
    const allWords = await getBlockedWords(env, true); // 强制刷新
    let kvWords = [];
    try {
      const raw = await env.TOPIC_MAP.get("blocked_words_kv");
      if (raw) kvWords = JSON.parse(raw);
    } catch (e) { /* 忽略 */ }
    if (!Array.isArray(kvWords)) kvWords = [];

    const hardcoded = BLOCKED_WORDS;
    const dynamic = kvWords.filter(w => !BLOCKED_WORDS.map(h => h.toLowerCase()).includes(w.toLowerCase()));

    let reply = `📝 **屏蔽词列表** (共 ${allWords.length} 个)\n\n`;
    reply += `🔧 **硬编码词** (${hardcoded.length} 个，修改需改代码):\n`;
    reply += hardcoded.length > 0 ? hardcoded.map(w => `  • ${w}`).join("\n") : "  (无)";
    reply += `\n\n💾 **动态词** (${dynamic.length} 个，可通过 /addword /delword 管理):\n`;
    reply += dynamic.length > 0 ? dynamic.map(w => `  • ${w}`).join("\n") : "  (无)";

    await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: reply, parse_mode: "Markdown" });
    return;
  }

  // 优先通过 thread 映射快速反查用户，缺失时再降级全量扫描
  let userId = null;
  const mappedUser = await env.TOPIC_MAP.get(`thread:${threadId}`);
  if (mappedUser) {
    userId = Number(mappedUser);
  } else {
    const allKeys = await getAllKeys(env, "user:");
    for (const { name } of allKeys) {
      const rec = await safeGetJSON(env, name, null);
      if (rec && Number(rec.thread_id) === Number(threadId)) {
        userId = Number(name.slice(5));
        break;
      }
    }
  }

  // 如果找不到用户，说明可能是在普通话题，或者数据丢失，直接返回
  if (!userId) return;

  // --- 指令区域 ---

  if (text === "/close") {
    const key = `user:${userId}`;
    let rec = await safeGetJSON(env, key, null);
    if (rec) {
      rec.closed = true;
      await env.TOPIC_MAP.put(key, JSON.stringify(rec));
      await tgCall(env, "closeForumTopic", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId });
      await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "🚫 **对话已强制关闭**", parse_mode: "Markdown" });
    }
    return;
  }

  if (text === "/open") {
    const key = `user:${userId}`;
    let rec = await safeGetJSON(env, key, null);
    if (rec) {
      rec.closed = false;
      await env.TOPIC_MAP.put(key, JSON.stringify(rec));
      await tgCall(env, "reopenForumTopic", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId });
      await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "✅ **对话已恢复**", parse_mode: "Markdown" });
    }
    return;
  }

  if (text === "/reset") {
    await env.TOPIC_MAP.delete(`verified:${userId}`);
    await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "🔄 **验证重置**", parse_mode: "Markdown" });
    return;
  }

  if (text === "/trust") {
    await env.TOPIC_MAP.put(`verified:${userId}`, "trusted");
    await env.TOPIC_MAP.delete(`needs_verify:${userId}`);
    await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "🌟 **已设置永久信任**", parse_mode: "Markdown" });
    return;
  }

  if (text === "/ban") {
    await env.TOPIC_MAP.put(`banned:${userId}`, "1");
    await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "🚫 **用户已封禁**", parse_mode: "Markdown" });
    return;
  }

  if (text === "/unban") {
    await env.TOPIC_MAP.delete(`banned:${userId}`);
    await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "✅ **用户已解封**", parse_mode: "Markdown" });
    return;
  }

  if (text === "/info") {
    const userKey = `user:${userId}`;
    const userRec = await safeGetJSON(env, userKey, null);
    const verifyStatus = await env.TOPIC_MAP.get(`verified:${userId}`);
    const banStatus = await env.TOPIC_MAP.get(`banned:${userId}`);

    const info = `👤 **用户信息**\nUID: \`${userId}\`\nTopic ID: \`${threadId}\`\n话题标题: ${userRec?.title || "未知"}\n验证状态: ${verifyStatus ? (verifyStatus === 'trusted' ? '🌟 永久信任' : '✅ 已验证') : '❌ 未验证'}\n封禁状态: ${banStatus ? '🚫 已封禁' : '✅ 正常'}\nLink: [点击私聊](tg://user?id=${userId})`;
    await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: info, parse_mode: "Markdown" });
    return;
  }

  // 转发管理员消息给用户
  if (msg.media_group_id) {
    await handleMediaGroup(msg, env, ctx, { direction: "t2p", targetChat: userId, threadId: undefined });
    return;
  }
  await tgCall(env, "copyMessage", { chat_id: userId, from_chat_id: env.SUPERGROUP_ID, message_id: msg.message_id });
}

// ---------------- 验证模块 (纯本地) ----------------

async function sendVerificationChallenge(userId, env, pendingMsgId) {
  // 检查是否已有进行中的验证
  const existingChallenge = await env.TOPIC_MAP.get(`user_challenge:${userId}`);
  if (existingChallenge) {
    // 有正在进行的验证：仅将新消息加入待发送队列，避免重复下发题目/触发验证限速
    const chalKey = `chal:${existingChallenge}`;
    const state = await safeGetJSON(env, chalKey, null);

    // KV 可能存在不一致/过期：自愈清理后重新下发
    if (!state || state.userId !== userId) {
      await env.TOPIC_MAP.delete(`user_challenge:${userId}`);
    } else {
      if (pendingMsgId) {
        let pendingIds = [];
        if (Array.isArray(state.pending_ids)) {
          pendingIds = state.pending_ids.slice();
        } else if (state.pending) {
          pendingIds = [state.pending];
        }

        if (!pendingIds.includes(pendingMsgId)) {
          pendingIds.push(pendingMsgId);
          if (pendingIds.length > CONFIG.PENDING_MAX_MESSAGES) {
            pendingIds = pendingIds.slice(pendingIds.length - CONFIG.PENDING_MAX_MESSAGES);
          }
          state.pending_ids = pendingIds;
          delete state.pending;
          await env.TOPIC_MAP.put(chalKey, JSON.stringify(state), { expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS });
        }
      }
      Logger.debug('verification_duplicate_skipped', { userId, verifyId: existingChallenge, hasPending: !!pendingMsgId });
      return;
    }
  }

  // 验证请求速率限制：仅在需要创建新挑战时检查
  const verifyLimit = await checkRateLimit(userId, env, 'verify', CONFIG.RATE_LIMIT_VERIFY, 300);
  if (!verifyLimit.allowed) {
    await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: "⚠️ 验证请求过于频繁，请5分钟后再试。"
    });
    return;
  }

  // PR #12: 检查是否配置了 Turnstile
  const hasTurnstile = !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY && env.VERIFICATION_PAGE_URL);

  if (hasTurnstile) {
    // 使用 Turnstile 验证
    const verifyCode = generateVerifyCode();
    const verifyUrl = `${env.VERIFICATION_PAGE_URL}/verify?code=${verifyCode}&uid=${userId}`;

    // 存储验证 code
    await env.TOPIC_MAP.put(`turnstile_code:${verifyCode}`, String(userId), { expirationTtl: CONFIG.TURNSTILE_VERIFY_TTL });

    // 存储待转发消息
    if (pendingMsgId) {
      const pendingKey = `pending_turnstile:${userId}`;
      let pendingIds = [];
      try {
        const raw = await env.TOPIC_MAP.get(pendingKey);
        if (raw) pendingIds = JSON.parse(raw);
      } catch (e) { /* 忽略 */ }
      if (!Array.isArray(pendingIds)) pendingIds = [];
      if (!pendingIds.includes(pendingMsgId)) {
        pendingIds.push(pendingMsgId);
        if (pendingIds.length > CONFIG.PENDING_MAX_MESSAGES) {
          pendingIds = pendingIds.slice(pendingIds.length - CONFIG.PENDING_MAX_MESSAGES);
        }
        await env.TOPIC_MAP.put(pendingKey, JSON.stringify(pendingIds), { expirationTtl: CONFIG.TURNSTILE_VERIFY_TTL });
      }
    }

    // 标记用户正在验证中
    await env.TOPIC_MAP.put(`user_challenge:${userId}`, `turnstile:${verifyCode}`, { expirationTtl: CONFIG.TURNSTILE_VERIFY_TTL });

    Logger.info('turnstile_verification_sent', { userId, verifyCode });

    // 发送验证按钮
    const verifyMsg = await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: `🛡️ **人机验证**\n\n请点击下方按钮完成验证，验证通过后您的消息将自动送达。`,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "🔐 点击验证", url: verifyUrl }
        ]]
      }
    });

    // 存储验证消息 ID（验证成功后删除）
    if (verifyMsg.ok && verifyMsg.result?.message_id) {
      await env.TOPIC_MAP.put(`turnstile_msg:${verifyCode}`, String(verifyMsg.result.message_id), { expirationTtl: CONFIG.TURNSTILE_VERIFY_TTL });
    }
  } else {
    // 降级到本地题库验证
    const q = LOCAL_QUESTIONS[secureRandomInt(0, LOCAL_QUESTIONS.length)];
    const challenge = {
      question: q.question,
      correct: q.correct_answer,
      options: shuffleArray([...q.incorrect_answers, q.correct_answer])
    };

    const verifyId = secureRandomId(CONFIG.VERIFY_ID_LENGTH);
    const answerIndex = challenge.options.indexOf(challenge.correct);

    const state = {
      answerIndex: answerIndex,
      options: challenge.options,
      pending_ids: pendingMsgId ? [pendingMsgId] : [],
      userId: userId
    };

    await env.TOPIC_MAP.put(`chal:${verifyId}`, JSON.stringify(state), { expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS });
    await env.TOPIC_MAP.put(`user_challenge:${userId}`, verifyId, { expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS });

    Logger.info('verification_sent', {
      userId,
      verifyId,
      question: q.question,
      pendingCount: state.pending_ids.length
    });

    const buttons = challenge.options.map((opt, idx) => ({
      text: opt,
      callback_data: `verify:${verifyId}:${idx}`
    }));

    const keyboard = [];
    for (let i = 0; i < buttons.length; i += CONFIG.BUTTON_COLUMNS) {
      keyboard.push(buttons.slice(i, i + CONFIG.BUTTON_COLUMNS));
    }

    await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: `🛡️ **人机验证**\n\n${challenge.question}\n\n请点击下方按钮回答 (回答正确后将自动发送您刚才的消息)。`,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard }
    });
  }
}

async function handleCallbackQuery(query, env, ctx) {
  try {
    const data = query.data;
    if (!data.startsWith("verify:")) return;

    const parts = data.split(":");
    if (parts.length !== 3) return;

    const verifyId = parts[1];
    const selectedIndex = parseInt(parts[2]);
    const userId = query.from.id;

    const stateStr = await env.TOPIC_MAP.get(`chal:${verifyId}`);
    if (!stateStr) {
      await tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: "❌ 验证已过期，请重发消息",
        show_alert: true
      });
      return;
    }

    let state;
    try {
      state = JSON.parse(stateStr);
    } catch(e) {
      await tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: "❌ 数据错误",
        show_alert: true
      });
      return;
    }

    // 验证用户ID匹配
    if (state.userId && state.userId !== userId) {
      await tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: "❌ 无效的验证",
        show_alert: true
      });
      return;
    }

    // 验证索引有效性
    if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= state.options.length) {
      await tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: "❌ 无效选项",
        show_alert: true
      });
      return;
    }

    if (selectedIndex === state.answerIndex) {
      await tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: "✅ 验证通过"
      });

      Logger.info('verification_passed', {
        userId,
        verifyId,
        selectedOption: state.options[selectedIndex]
      });

      // 30天有效期
      await env.TOPIC_MAP.put(`verified:${userId}`, "1", { expirationTtl: CONFIG.VERIFIED_EXPIRE_SECONDS });
      await env.TOPIC_MAP.put(`verified_ts:${userId}`, String(Date.now()), { expirationTtl: CONFIG.VERIFIED_EXPIRE_SECONDS });
      await env.TOPIC_MAP.delete(`needs_verify:${userId}`);

      // 清理所有相关挑战
      await env.TOPIC_MAP.delete(`chal:${verifyId}`);
      await env.TOPIC_MAP.delete(`user_challenge:${userId}`);

      await tgCall(env, "editMessageText", {
        chat_id: userId,
        message_id: query.message.message_id,
        text: "✅ **验证成功**\n\n您现在可以自由对话了。",
        parse_mode: "Markdown"
      });

      const hasPending = (Array.isArray(state.pending_ids) && state.pending_ids.length > 0) || !!state.pending;
      if (hasPending) {
        try {
          let pendingIds = [];
          if (Array.isArray(state.pending_ids)) {
            pendingIds = state.pending_ids.slice();
          } else if (state.pending) {
            pendingIds = [state.pending];
          }

          // 限制一次性转发量，避免用户恶意堆积导致执行超时
          if (pendingIds.length > CONFIG.PENDING_MAX_MESSAGES) {
            pendingIds = pendingIds.slice(pendingIds.length - CONFIG.PENDING_MAX_MESSAGES);
          }

          let forwardedCount = 0;
          for (const pendingId of pendingIds) {
            if (!pendingId) continue;
            const forwardedKey = `forwarded:${userId}:${pendingId}`;
            const alreadyForwarded = await env.TOPIC_MAP.get(forwardedKey);
            if (alreadyForwarded) {
              Logger.info('message_forward_duplicate_skipped', { userId, messageId: pendingId });
              continue;
            }

            const fakeMsg = {
              message_id: pendingId,
              chat: { id: userId, type: "private" },
              from: query.from,
            };

            await forwardToTopic(fakeMsg, userId, `user:${userId}`, env, ctx);
            await env.TOPIC_MAP.put(forwardedKey, "1", { expirationTtl: 3600 });
            forwardedCount++;
          }

          if (forwardedCount > 0) {
            await tgCall(env, "sendMessage", {
              chat_id: userId,
              text: `📩 刚才的 ${forwardedCount} 条消息已帮您送达。`
            });
          }
        } catch (e) {
          Logger.error('pending_message_forward_failed', e, { userId });
          await tgCall(env, "sendMessage", {
            chat_id: userId,
            text: "⚠️ 自动发送失败，请重新发送您的消息。"
          });
        }
      }
    } else {
      Logger.info('verification_failed', {
        userId,
        verifyId,
        selectedIndex,
        correctIndex: state.answerIndex
      });

      await tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: "❌ 答案错误",
        show_alert: true
      });
    }
  } catch (e) {
    Logger.error('callback_query_error', e, {
      userId: query.from?.id,
      callbackData: query.data
    });
    await tgCall(env, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: `⚠️ 系统错误，请重试`,
      show_alert: true
    });
  }
}

// ---------------- 辅助函数 ----------------

/**
 * 批量清理命令处理函数（优化并发性能）
 *
 * 功能说明：
 * 1. 检查所有用户的话题记录
 * 2. 找出话题ID已不存在（被删除）的用户
 * 3. 删除这些用户的KV存储记录和验证状态
 * 4. 让他们下次发消息时重新验证并创建新话题
 *
 * 使用场景：
 * - 管理员手动删除了多个用户话题后
 * - 需要批量重置这些用户的状态
 *
 * @param {number} threadId - 当前话题ID（通常在General话题中调用）
 * @param {object} env - 环境变量对象
 */
async function handleCleanupCommand(threadId, env) {
  const lockKey = "cleanup:lock";
  const locked = await env.TOPIC_MAP.get(lockKey);
  if (locked) {
    await tgCall(env, "sendMessage", withMessageThreadId({
      chat_id: env.SUPERGROUP_ID,
      text: "⏳ **已有清理任务正在运行，请稍后再试。**",
      parse_mode: "Markdown"
    }, threadId));
    return;
  }

  await env.TOPIC_MAP.put(lockKey, "1", { expirationTtl: CONFIG.CLEANUP_LOCK_TTL_SECONDS });

  // 发送处理中的消息
  await tgCall(env, "sendMessage", withMessageThreadId({
    chat_id: env.SUPERGROUP_ID,
    text: "🔄 **正在扫描需要清理的用户...**",
    parse_mode: "Markdown"
  }, threadId));

  let cleanedCount = 0;
  let errorCount = 0;
  const cleanedUsers = [];
  let scannedCount = 0;

  try {
    // 逐页扫描，避免一次性拉取全部 keys 导致超时/内存膨胀
    let cursor = undefined;
    do {
      const result = await env.TOPIC_MAP.list({ prefix: "user:", cursor });
      const names = (result.keys || []).map(k => k.name);
      scannedCount += names.length;

      // 批量并发处理（限制并发数）
      for (let i = 0; i < names.length; i += CONFIG.CLEANUP_BATCH_SIZE) {
        const batch = names.slice(i, i + CONFIG.CLEANUP_BATCH_SIZE);

        const results = await Promise.allSettled(
          batch.map(async (name) => {
            const rec = await safeGetJSON(env, name, null);
            if (!rec || !rec.thread_id) return null;

            const userId = name.slice(5);
            const topicThreadId = rec.thread_id;

            // 检测话题是否存在：尝试向话题发送测试消息
            const probe = await probeForumThread(env, topicThreadId, {
              userId,
              reason: "cleanup_check",
              doubleCheckOnMissingThreadId: false
            });

            // cleanup 要求更保守：仅在明确缺失/重定向时清理，避免误删有效记录
            if (probe.status === "redirected" || probe.status === "missing") {
              await env.TOPIC_MAP.delete(name);
              await env.TOPIC_MAP.delete(`verified:${userId}`);
              await env.TOPIC_MAP.delete(`thread:${topicThreadId}`);

              return {
                userId,
                threadId: topicThreadId,
                title: rec.title || "未知"
              };
            } else if (probe.status === "probe_invalid") {
              Logger.warn('cleanup_probe_invalid_message', {
                userId,
                threadId: topicThreadId,
                errorDescription: probe.description
              });
            } else if (probe.status === "unknown_error") {
              Logger.warn('cleanup_probe_failed_unknown', {
                userId,
                threadId: topicThreadId,
                errorDescription: probe.description
              });
            } else if (probe.status === "missing_thread_id") {
              Logger.warn('cleanup_probe_missing_thread_id', { userId, threadId: topicThreadId });
            }

            return null;
          })
        );

        // 处理结果
        results.forEach(result => {
          if (result.status === 'fulfilled' && result.value) {
            cleanedCount++;
            cleanedUsers.push(result.value);
            Logger.info('cleanup_user', {
              userId: result.value.userId,
              threadId: result.value.threadId
            });
          } else if (result.status === 'rejected') {
            errorCount++;
            Logger.error('cleanup_batch_error', result.reason);
          }
        });

        // 防止速率限制
        if (i + CONFIG.CLEANUP_BATCH_SIZE < names.length) {
          await new Promise(r => setTimeout(r, 600));
        }
      }

      cursor = result.list_complete ? undefined : result.cursor;

      // 在分页之间让出时间片，降低单次执行压力
      if (cursor) {
        await new Promise(r => setTimeout(r, 200));
      }
    } while (cursor);

    // 生成并发送清理报告
    let reportText = `✅ **清理完成**\n\n`;
    reportText += `📊 **统计信息**\n`;
    reportText += `- 扫描用户数: ${scannedCount}\n`;
    reportText += `- 已清理用户数: ${cleanedCount}\n`;
    reportText += `- 错误数: ${errorCount}\n\n`;

    if (cleanedCount > 0) {
      reportText += `🗑️ **已清理的用户** (话题已删除):\n`;
      for (const user of cleanedUsers.slice(0, CONFIG.MAX_CLEANUP_DISPLAY)) {
        reportText += `- UID: \`${user.userId}\` | 话题: ${user.title}\n`;
      }
      if (cleanedUsers.length > CONFIG.MAX_CLEANUP_DISPLAY) {
        reportText += `\n...(还有 ${cleanedUsers.length - CONFIG.MAX_CLEANUP_DISPLAY} 个用户)\n`;
      }
      reportText += `\n💡 这些用户下次发消息时将重新进行人机验证并创建新话题。`;
    } else {
      reportText += `✨ 没有发现需要清理的用户记录。`;
    }

    Logger.info('cleanup_completed', {
      cleanedCount,
      errorCount,
      totalUsers: scannedCount
    });

    await tgCall(env, "sendMessage", withMessageThreadId({
      chat_id: env.SUPERGROUP_ID,
      text: reportText,
      parse_mode: "Markdown"
    }, threadId));

  } catch (e) {
    Logger.error('cleanup_failed', e, { threadId });
    await tgCall(env, "sendMessage", withMessageThreadId({
      chat_id: env.SUPERGROUP_ID,
      text: `❌ **清理过程出错**\n\n错误信息: \`${e.message}\``,
      parse_mode: "Markdown"
    }, threadId));
  } finally {
    await env.TOPIC_MAP.delete(lockKey);
  }
}

// ---------------- 其他辅助函数 ----------------

// 为话题建立 thread->user 映射，避免管理员命令时全量 KV 反查
async function createTopic(from, key, env, userId) {
  const title = buildTopicTitle(from);
  if (!env.SUPERGROUP_ID.toString().startsWith("-100")) throw new Error("SUPERGROUP_ID必须以-100开头");
  const res = await tgCall(env, "createForumTopic", { chat_id: env.SUPERGROUP_ID, name: title });
  if (!res.ok) throw new Error(`创建话题失败: ${res.description}`);
  const rec = { thread_id: res.result.message_thread_id, title, closed: false };
  await env.TOPIC_MAP.put(key, JSON.stringify(rec));
  if (userId) {
    await env.TOPIC_MAP.put(`thread:${rec.thread_id}`, String(userId));
  }
  return rec;
}

// 更新话题状态
async function updateThreadStatus(threadId, isClosed, env) {
  try {
    const mappedUser = await env.TOPIC_MAP.get(`thread:${threadId}`);
    if (mappedUser) {
      const userKey = `user:${mappedUser}`;
      const rec = await safeGetJSON(env, userKey, null);
      if (rec && Number(rec.thread_id) === Number(threadId)) {
        rec.closed = isClosed;
        await env.TOPIC_MAP.put(userKey, JSON.stringify(rec));
        Logger.info('thread_status_updated', { threadId, isClosed, updatedCount: 1 });
        return;
      }

      // 映射失效：清理后降级全量扫描
      await env.TOPIC_MAP.delete(`thread:${threadId}`);
    }

    const allKeys = await getAllKeys(env, "user:");
    const updates = [];

    for (const { name } of allKeys) {
      const rec = await safeGetJSON(env, name, null);
      if (rec && Number(rec.thread_id) === Number(threadId)) {
        rec.closed = isClosed;
        updates.push(env.TOPIC_MAP.put(name, JSON.stringify(rec)));
      }
    }

    await Promise.all(updates);
    Logger.info('thread_status_updated', { threadId, isClosed, updatedCount: updates.length });
  } catch (e) {
    Logger.error('thread_status_update_failed', e, { threadId, isClosed });
    throw e;
  }
}

// 改进的话题标题构建（清理特殊字符）
function buildTopicTitle(from) {
  const firstName = (from.first_name || "").trim().substring(0, CONFIG.MAX_NAME_LENGTH);
  const lastName = (from.last_name || "").trim().substring(0, CONFIG.MAX_NAME_LENGTH);

  // 清理 username
  let username = "";
  if (from.username) {
    username = from.username
      .replace(/[^\w]/g, '') // 只保留字母数字下划线
      .substring(0, 20);
  }

  // 移除控制字符和换行符
  const cleanName = (firstName + " " + lastName)
    .replace(/[ --]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const name = cleanName || "User";
  const usernameStr = username ? ` @${username}` : "";

  // Telegram 话题标题最大长度为 128 字符
  const title = (name + usernameStr).substring(0, CONFIG.MAX_TITLE_LENGTH);

  return title;
}

// 改进的 Telegram API 调用（添加超时和 HTTPS 强制）
async function tgCall(env, method, body, timeout = CONFIG.API_TIMEOUT_MS) {
  let base = env.API_BASE || "https://api.telegram.org";

  // 强制 HTTPS
  if (base.startsWith("http://")) {
    Logger.warn('api_http_upgraded', { originalBase: base });
    base = base.replace("http://", "https://");
  }

  // 验证 URL 格式
  try {
    new URL(`${base}/test`);
  } catch (e) {
    Logger.error('api_base_invalid', e, { base });
    base = "https://api.telegram.org";
  }

  // 添加超时控制
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch(`${base}/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!resp.ok && resp.status >= 500) {
      Logger.warn('telegram_api_server_error', {
        method,
        status: resp.status
      });
    }

    const result = await resp.json();

    // 记录速率限制
    if (!result.ok && result.description && result.description.includes('Too Many Requests')) {
      const retryAfter = result.parameters?.retry_after || 5;
      Logger.warn('telegram_api_rate_limit', {
        method,
        retryAfter
      });
    }

    return result;
  } catch (e) {
    clearTimeout(timeoutId);

    if (e.name === 'AbortError') {
      Logger.error('telegram_api_timeout', e, { method, timeout });
      return { ok: false, description: 'Request timeout' };
    }

    Logger.error('telegram_api_failed', e, { method });
    throw e;
  }
}

async function handleMediaGroup(msg, env, ctx, { direction, targetChat, threadId }) {
  const groupId = msg.media_group_id;
  const key = `mg:${direction}:${groupId}`;
  const item = extractMedia(msg);
  if (!item) {
    await tgCall(env, "copyMessage", withMessageThreadId({
      chat_id: targetChat,
      from_chat_id: msg.chat.id,
      message_id: msg.message_id
    }, threadId));
    return;
  }
  let rec = await safeGetJSON(env, key, null);
  if (!rec) rec = { direction, targetChat, threadId: (threadId === null ? undefined : threadId), items: [], last_ts: Date.now() };
  rec.items.push({ ...item, msg_id: msg.message_id });
  rec.last_ts = Date.now();
  await env.TOPIC_MAP.put(key, JSON.stringify(rec), { expirationTtl: CONFIG.MEDIA_GROUP_EXPIRE_SECONDS });
  ctx.waitUntil(delaySend(env, key, rec.last_ts));
}

// 改进的媒体提取（支持更多类型，不修改原数组）
function extractMedia(msg) {
  // 图片
  if (msg.photo && msg.photo.length > 0) {
    const highestResolution = msg.photo[msg.photo.length - 1]; // 不使用 pop()
    return {
      type: "photo",
      id: highestResolution.file_id,
      cap: msg.caption || ""
    };
  }

  // 视频
  if (msg.video) {
    return {
      type: "video",
      id: msg.video.file_id,
      cap: msg.caption || ""
    };
  }

  // 文档
  if (msg.document) {
    return {
      type: "document",
      id: msg.document.file_id,
      cap: msg.caption || ""
    };
  }

  // 音频
  if (msg.audio) {
    return {
      type: "audio",
      id: msg.audio.file_id,
      cap: msg.caption || ""
    };
  }

  // 动图
  if (msg.animation) {
    return {
      type: "animation",
      id: msg.animation.file_id,
      cap: msg.caption || ""
    };
  }

  // 语音和视频消息不支持 media group
  return null;
}

// 实现媒体组清理
async function flushExpiredMediaGroups(env, now) {
  try {
    const prefix = "mg:";
    const allKeys = await getAllKeys(env, prefix);
    let deletedCount = 0;

    for (const { name } of allKeys) {
      const rec = await safeGetJSON(env, name, null);
      if (rec && rec.last_ts && (now - rec.last_ts > 300000)) { // 超过 5 分钟
        await env.TOPIC_MAP.delete(name);
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      Logger.info('media_groups_cleaned', { deletedCount });
    }
  } catch (e) {
    Logger.error('media_group_cleanup_failed', e);
  }
}

// 改进媒体组延迟发送
async function delaySend(env, key, ts) {
  await new Promise(r => setTimeout(r, CONFIG.MEDIA_GROUP_DELAY_MS));

  const rec = await safeGetJSON(env, key, null);

  if (rec && rec.last_ts === ts) {
    // 验证媒体数组
    if (!rec.items || rec.items.length === 0) {
      Logger.warn('media_group_empty', { key });
      await env.TOPIC_MAP.delete(key);
      return;
    }

    const media = rec.items.map((it, i) => {
      if (!it.type || !it.id) {
        Logger.warn('media_group_invalid_item', { key, item: it });
        return null;
      }
      // 限制 caption 长度
      const caption = i === 0 ? (it.cap || "").substring(0, 1024) : "";
      return {
        type: it.type,
        media: it.id,
        caption
      };
    }).filter(Boolean); // 过滤掉无效项

    if (media.length > 0) {
      try {
        const result = await tgCall(env, "sendMediaGroup", withMessageThreadId({
          chat_id: rec.targetChat,
          media
        }, rec.threadId));

        if (!result.ok) {
          Logger.error('media_group_send_failed', result.description, {
            key,
            mediaCount: media.length
          });
        } else {
          Logger.info('media_group_sent', {
            key,
            mediaCount: media.length,
            targetChat: rec.targetChat
          });
        }
      } catch (e) {
        Logger.error('media_group_send_exception', e, { key });
      }
    }

    await env.TOPIC_MAP.delete(key);
  }
}
