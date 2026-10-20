import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupLegacyGenerationConfig, getConnectionKey } from '../src/background/credentials';
import { GENERATION_CONFIG_KEYS } from '../src/shared/generation-config';

const store: Record<string, unknown> = {};
let removeMock: ReturnType<typeof vi.fn>;

function installChrome(): void {
  removeMock = vi.fn(async (keys: string | string[]) => {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) {
      delete store[key];
    }
  });
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items);
        }),
        remove: removeMock
      }
    }
  });
}

beforeEach(() => {
  for (const key of Object.keys(store)) {
    delete store[key];
  }
  installChrome();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getConnectionKey（仅 background 读取）', () => {
  it('按连接 id 返回 Key；缺失返回空串', async () => {
    store[GENERATION_CONFIG_KEYS.keys] = { conn_1: 'key-a', conn_2: 'key-b' };

    expect(await getConnectionKey('conn_1')).toBe('key-a');
    expect(await getConnectionKey('conn_2')).toBe('key-b');
    expect(await getConnectionKey('missing')).toBe('');
  });

  it('凭证键缺失或值非字符串时返回空串', async () => {
    expect(await getConnectionKey('conn_1')).toBe('');

    store[GENERATION_CONFIG_KEYS.keys] = { conn_1: 123 };
    expect(await getConnectionKey('conn_1')).toBe('');
  });
});

describe('cleanupLegacyGenerationConfig', () => {
  it('删除旧三键，且不触碰新四键', async () => {
    store.generation_api_key = 'legacy-key';
    store.generation_api_key_mode = 'per-model';
    store.generation_api_keys = { 'gpt-image-2': 'legacy-per-model' };
    store[GENERATION_CONFIG_KEYS.connections] = [{ id: 'conn_1' }];
    store[GENERATION_CONFIG_KEYS.models] = [{ id: 'model_1' }];
    store[GENERATION_CONFIG_KEYS.keys] = { conn_1: 'new-key' };
    store[GENERATION_CONFIG_KEYS.lastModel] = 'model_1';

    await cleanupLegacyGenerationConfig();

    expect(store.generation_api_key).toBeUndefined();
    expect(store.generation_api_key_mode).toBeUndefined();
    expect(store.generation_api_keys).toBeUndefined();
    expect(store[GENERATION_CONFIG_KEYS.connections]).toEqual([{ id: 'conn_1' }]);
    expect(store[GENERATION_CONFIG_KEYS.models]).toEqual([{ id: 'model_1' }]);
    expect(store[GENERATION_CONFIG_KEYS.keys]).toEqual({ conn_1: 'new-key' });
    expect(store[GENERATION_CONFIG_KEYS.lastModel]).toBe('model_1');
  });

  it('幂等：重复调用不抛错，旧键已不存在时也正常完成', async () => {
    await cleanupLegacyGenerationConfig();
    await expect(cleanupLegacyGenerationConfig()).resolves.toBeUndefined();
    expect(removeMock).toHaveBeenCalledTimes(2);
  });
});
