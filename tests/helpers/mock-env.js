/**
 * Mock 环境变量 — 创建用于测试的 env 对象
 */
import { createMockKV } from './mock-kv.js';

export function createMockEnv(overrides = {}) {
  const kv = createMockKV();

  return {
    BOT_TOKEN: '123456:TEST_TOKEN',
    SUPERGROUP_ID: '-1001234567890',
    TOPIC_MAP: kv,
    TURNSTILE_SITE_KEY: '',
    TURNSTILE_SECRET_KEY: '',
    VERIFICATION_PAGE_URL: '',
    SPAM_KEYWORDS: '',
    ADMIN_IDS: '123456789',
    ...overrides,
  };
}
