/**
 * Mock KV 实现 — 用于单元测试中替代 Cloudflare KV
 * 提供与 env.TOPIC_MAP 兼容的接口
 */

export function createMockKV(initialData = new Map()) {
  const store = new Map(initialData);

  return {
    async get(key, options) {
      const val = store.get(key);
      if (val === undefined) return null;
      if (options?.type === 'json' && typeof val === 'string') {
        try { return JSON.parse(val); } catch { return null; }
      }
      return val;
    },

    async put(key, value) {
      store.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    },

    async delete(key) {
      store.delete(key);
    },

    async list({ prefix, cursor } = {}) {
      const keys = [...store.keys()]
        .filter(k => !prefix || k.startsWith(prefix))
        .map(name => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },

    // 测试断言辅助方法
    _store: store,
    _getRaw(key) { return store.get(key); },
    _has(key) { return store.has(key); },
    _size() { return store.size; },
  };
}
