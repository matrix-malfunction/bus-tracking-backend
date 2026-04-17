class InMemoryLocationAdapter {
  constructor() {
    this.store = new Map();
  }

  get(key) {
    return this.store.get(key);
  }

  set(key, value) {
    this.store.set(key, value);
  }

  delete(key) {
    this.store.delete(key);
  }

  values() {
    return Array.from(this.store.values());
  }
}

class RedisLikeLocationAdapter {
  constructor(redisClient) {
    this.redisClient = redisClient;
  }

  get(_key) {
    return undefined;
  }

  set(_key, _value) {}

  delete(_key) {}

  values() {
    return [];
  }
}

class LocationCache {
  constructor(adapter = new InMemoryLocationAdapter()) {
    this.adapter = adapter;
  }

  get(busId) {
    return this.adapter.get(busId);
  }

  set(busId, payload) {
    const normalized = {
      ...payload,
      updatedAt: payload?.updatedAt || payload?.timestamp || new Date().toISOString(),
    };
    this.adapter.set(busId, normalized);
    return normalized;
  }

  getAll() {
    return this.adapter.values();
  }

  delete(busId) {
    this.adapter.delete(busId);
  }

  deleteStale(maxAgeMs) {
    const now = Date.now();
    for (const item of this.getAll()) {
      const ts = new Date(item?.updatedAt || item?.timestamp || 0).getTime();
      if (!Number.isFinite(ts) || now - ts > maxAgeMs) {
        this.delete(item.busId);
      }
    }
  }
}

const defaultCache = new LocationCache();

function createLocationCache(options = {}) {
  if (options.redisClient) {
    return new LocationCache(new RedisLikeLocationAdapter(options.redisClient));
  }
  return new LocationCache(new InMemoryLocationAdapter());
}

module.exports = {
  LocationCache,
  createLocationCache,
  defaultCache,
};
