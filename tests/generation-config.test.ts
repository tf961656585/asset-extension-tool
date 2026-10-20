import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GENERATION_CONFIG_KEYS,
  createConnection,
  createModel,
  deleteConnection,
  deleteModel,
  findConnection,
  findModel,
  groupModelsByConnection,
  loadGenerationConfig,
  normalizeBaseUrl,
  replaceConnectionKey,
  setLastModel,
  updateConnection,
  updateModel
} from '../src/shared/generation-config';
import type { ProtocolId } from '../src/shared/protocols';

/** chrome.storage.local 内存桩：get 每次只取单键（与生产调用一致）。 */
const store: Record<string, unknown> = {};
let setMock: ReturnType<typeof vi.fn>;

function installChrome(options: { failKeyWrite?: boolean } = {}): void {
  setMock = vi.fn(async (items: Record<string, unknown>) => {
    if (options.failKeyWrite && GENERATION_CONFIG_KEYS.keys in items) {
      throw new Error('quota exceeded');
    }
    Object.assign(store, items);
  });
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: setMock,
        remove: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const key of list) {
            delete store[key];
          }
        })
      }
    }
  });
}

async function seedConnection(
  overrides: Partial<Parameters<typeof createConnection>[0]> = {}
): Promise<Awaited<ReturnType<typeof createConnection>>> {
  return createConnection({
    name: '我的服务',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'secret-key',
    ...overrides
  });
}

async function seedModel(
  connectionId: string,
  overrides: Partial<Parameters<typeof createModel>[0]> = {}
): Promise<Awaited<ReturnType<typeof createModel>>> {
  return createModel({
    connectionId,
    protocolId: 'openai-images-v1',
    remoteModelId: 'gpt-image-2',
    ...overrides
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

describe('normalizeBaseUrl', () => {
  it('trim、去尾部斜杠、保留 path 与端口', () => {
    expect(normalizeBaseUrl('  https://api.example.com/v1/  ')).toBe(
      'https://api.example.com/v1'
    );
    expect(normalizeBaseUrl('https://api.example.com/v1///')).toBe(
      'https://api.example.com/v1'
    );
    expect(normalizeBaseUrl('https://api.example.com/')).toBe('https://api.example.com');
    expect(normalizeBaseUrl('https://api.example.com:8443/openai/v1')).toBe(
      'https://api.example.com:8443/openai/v1'
    );
  });

  it('非 https / 非绝对地址 / 用户名密码 / query / fragment / 空串均抛中文错误', () => {
    expect(() => normalizeBaseUrl('http://api.example.com/v1')).toThrow(/HTTPS/);
    expect(() => normalizeBaseUrl('api.example.com/v1')).toThrow(/绝对地址/);
    expect(() => normalizeBaseUrl('https://user:pass@api.example.com/v1')).toThrow(
      /用户名或密码/
    );
    expect(() => normalizeBaseUrl('https://api.example.com/v1?token=1')).toThrow(/查询参数/);
    expect(() => normalizeBaseUrl('https://api.example.com/v1#frag')).toThrow(/片段/);
    expect(() => normalizeBaseUrl('   ')).toThrow(/不能为空/);
  });
});

describe('createConnection', () => {
  it('先写连接元数据（hasKey=false），再写 Key 并同步 hasKey=true', async () => {
    const connection = await seedConnection();

    expect(connection.hasKey).toBe(true);
    expect(setMock.mock.calls).toHaveLength(3);

    const firstWrite = setMock.mock.calls[0][0] as Record<string, unknown>;
    const firstConnections = firstWrite[GENERATION_CONFIG_KEYS.connections] as Array<{
      hasKey: boolean;
    }>;
    expect(firstConnections[0].hasKey).toBe(false);

    const keyWrite = setMock.mock.calls[1][0] as Record<string, unknown>;
    expect(keyWrite[GENERATION_CONFIG_KEYS.keys]).toEqual({
      [connection.id]: 'secret-key'
    });

    const finalWrite = setMock.mock.calls[2][0] as Record<string, unknown>;
    const finalConnections = finalWrite[GENERATION_CONFIG_KEYS.connections] as Array<{
      hasKey: boolean;
    }>;
    expect(finalConnections[0].hasKey).toBe(true);

    const config = await loadGenerationConfig();
    expect(config.connections).toHaveLength(1);
    expect(config.connections[0].hasKey).toBe(true);
    expect(config.connections[0].baseUrl).toBe('https://api.example.com/v1');
  });

  it('Key 写失败时保留连接（hasKey=false）并抛错', async () => {
    installChrome({ failKeyWrite: true });

    await expect(seedConnection()).rejects.toThrow(/API Key 保存失败/);

    const connections = store[GENERATION_CONFIG_KEYS.connections] as Array<{
      hasKey: boolean;
    }>;
    expect(connections).toHaveLength(1);
    expect(connections[0].hasKey).toBe(false);
    expect(store[GENERATION_CONFIG_KEYS.keys]).toBeUndefined();
  });

  it('名称为空时按主机名生成；名称重复（不区分大小写）被拒绝', async () => {
    const connection = await seedConnection({ name: '   ', baseUrl: 'https://cdn.example.com/v1' });
    expect(connection.name).toBe('cdn.example.com');

    await expect(seedConnection({ name: 'CDN.EXAMPLE.COM', baseUrl: 'https://other.com/v1' })).rejects.toThrow(
      /名称已存在/
    );
  });

  it('API Key 为空被拒绝', async () => {
    await expect(seedConnection({ apiKey: '   ' })).rejects.toThrow(/API Key 不能为空/);
  });

  it('名称超过 40 字符被拒绝', async () => {
    await expect(seedConnection({ name: 'x'.repeat(41) })).rejects.toThrow(/1–40/);
  });
});

describe('updateConnection / replaceConnectionKey', () => {
  it('更新名称与 Base URL，只影响之后的数据', async () => {
    const connection = await seedConnection();
    await updateConnection(connection.id, {
      name: '新名字',
      baseUrl: 'https://new.example.com/v2/'
    });

    const config = await loadGenerationConfig();
    expect(config.connections[0].name).toBe('新名字');
    expect(config.connections[0].baseUrl).toBe('https://new.example.com/v2');
  });

  it('名称重复与连接不存在被拒绝', async () => {
    const first = await seedConnection({ name: 'A' });
    await seedConnection({ name: 'B', baseUrl: 'https://b.example.com/v1' });

    await expect(updateConnection(first.id, { name: 'b' })).rejects.toThrow(/名称已存在/);
    await expect(updateConnection('missing', { name: 'C' })).rejects.toThrow(/连接不存在/);
  });

  it('更换 Key 同步 hasKey=true，旧 Key 被替换', async () => {
    const connection = await seedConnection();
    await replaceConnectionKey(connection.id, 'new-key');

    expect(store[GENERATION_CONFIG_KEYS.keys]).toEqual({ [connection.id]: 'new-key' });
    const config = await loadGenerationConfig();
    expect(config.connections[0].hasKey).toBe(true);
  });
});

describe('createModel', () => {
  it('显示名留空取远端型号；能力默认取协议上限', async () => {
    const connection = await seedConnection();
    const model = await seedModel(connection.id);

    expect(model.displayName).toBe('gpt-image-2');
    expect(model.supportsReferenceImage).toBe(true);
    expect(model.maxRefs).toBe(16);
    expect(model.maxN).toBe(10);
    expect(model.protocolId).toBe('openai-images-v1');
  });

  it('displayName 唯一（不区分大小写），不同连接下相同 remoteModelId 允许', async () => {
    const first = await seedConnection({ name: 'A' });
    const second = await seedConnection({ name: 'B', baseUrl: 'https://b.example.com/v1' });

    await seedModel(first.id, { remoteModelId: 'gpt-image-2', displayName: 'Main' });
    await seedModel(second.id, { remoteModelId: 'gpt-image-2', displayName: 'Main 2' });

    await expect(
      seedModel(second.id, { remoteModelId: 'gpt-image-2-c', displayName: 'main' })
    ).rejects.toThrow(/显示名已存在/);
  });

  it('supportsReferenceImage=false 时 maxRefs 强制为 0', async () => {
    const connection = await seedConnection();
    const model = await seedModel(connection.id, {
      supportsReferenceImage: false,
      maxRefs: 5
    });
    expect(model.supportsReferenceImage).toBe(false);
    expect(model.maxRefs).toBe(0);
  });

  it('maxRefs / maxN 超过协议上限、远端型号超长、协议/连接不存在均被拒绝', async () => {
    const connection = await seedConnection();

    await expect(seedModel(connection.id, { maxRefs: 17 })).rejects.toThrow(/参考图上限/);
    await expect(seedModel(connection.id, { maxN: 11 })).rejects.toThrow(/数量上限/);
    await expect(seedModel(connection.id, { remoteModelId: 'x'.repeat(129) })).rejects.toThrow(
      /1–128/
    );
    await expect(
      seedModel(connection.id, { protocolId: 'unknown-v1' as ProtocolId })
    ).rejects.toThrow(/接口协议不存在/);
    await expect(seedModel('missing-connection')).rejects.toThrow(/连接不存在/);
  });

  it('gemini 协议默认能力：maxRefs=3、maxN=1', async () => {
    const connection = await seedConnection();
    const model = await seedModel(connection.id, {
      protocolId: 'gemini-image-v1',
      remoteModelId: 'gemini-3.1-flash-image',
      displayName: 'Gemini Image'
    });
    expect(model.maxRefs).toBe(3);
    expect(model.maxN).toBe(1);
  });
});

describe('updateModel', () => {
  it('显示名留空时取更新后的远端型号', async () => {
    const connection = await seedConnection();
    const model = await seedModel(connection.id, { displayName: '旧名' });

    await updateModel(model.id, { remoteModelId: 'gpt-image-3', displayName: '  ' });
    const config = await loadGenerationConfig();
    const updated = findModel(config, model.id);
    expect(updated?.remoteModelId).toBe('gpt-image-3');
    expect(updated?.displayName).toBe('gpt-image-3');
  });

  it('关闭参考图能力时 maxRefs 置 0；maxN 越界被拒绝', async () => {
    const connection = await seedConnection();
    const model = await seedModel(connection.id, { displayName: 'M' });

    await updateModel(model.id, { supportsReferenceImage: false });
    expect(findModel(await loadGenerationConfig(), model.id)?.maxRefs).toBe(0);

    await expect(updateModel(model.id, { maxN: 11 })).rejects.toThrow(/数量上限/);
    await expect(updateModel('missing', { displayName: 'x' })).rejects.toThrow(/模型记录不存在/);
  });

  it('显示名重复被拒绝（排除自身）', async () => {
    const connection = await seedConnection();
    const first = await seedModel(connection.id, { remoteModelId: 'a', displayName: 'A' });
    const second = await seedModel(connection.id, { remoteModelId: 'b', displayName: 'B' });

    await expect(updateModel(second.id, { displayName: 'a' })).rejects.toThrow(/显示名已存在/);
    await updateModel(first.id, { displayName: 'A' });
  });
});

describe('删除与指针清理', () => {
  it('deleteConnection 级联删除模型、Key 与 lastModel 指针', async () => {
    const first = await seedConnection({ name: 'A' });
    const second = await seedConnection({ name: 'B', baseUrl: 'https://b.example.com/v1' });
    const modelA = await seedModel(first.id, { remoteModelId: 'a', displayName: 'A Model' });
    await seedModel(first.id, { remoteModelId: 'b', displayName: 'A Model 2' });
    const modelB = await seedModel(second.id, { remoteModelId: 'c', displayName: 'B Model' });
    await setLastModel(modelA.id);

    await deleteConnection(first.id);

    const config = await loadGenerationConfig();
    expect(config.connections.map((connection) => connection.id)).toEqual([second.id]);
    expect(config.models.map((model) => model.id)).toEqual([modelB.id]);
    expect(config.lastModelId).toBeNull();
    expect(store[GENERATION_CONFIG_KEYS.keys]).toEqual({ [second.id]: 'secret-key' });
  });

  it('deleteConnection 不影响其他连接的 lastModel 指针', async () => {
    const first = await seedConnection({ name: 'A' });
    const second = await seedConnection({ name: 'B', baseUrl: 'https://b.example.com/v1' });
    const modelA = await seedModel(first.id, { remoteModelId: 'a', displayName: 'A Model' });
    const modelB = await seedModel(second.id, { remoteModelId: 'b', displayName: 'B Model' });
    await setLastModel(modelB.id);

    await deleteConnection(first.id);

    expect((await loadGenerationConfig()).lastModelId).toBe(modelB.id);
    expect(findModel(await loadGenerationConfig(), modelA.id)).toBeUndefined();
  });

  it('deleteModel 清理指向它的 lastModel 指针', async () => {
    const connection = await seedConnection();
    const first = await seedModel(connection.id, { remoteModelId: 'a', displayName: 'A' });
    const second = await seedModel(connection.id, { remoteModelId: 'b', displayName: 'B' });

    await setLastModel(first.id);
    await deleteModel(second.id);
    expect((await loadGenerationConfig()).lastModelId).toBe(first.id);

    await deleteModel(first.id);
    expect((await loadGenerationConfig()).lastModelId).toBeNull();
  });

  it('setLastModel 拒绝不存在的模型', async () => {
    await expect(setLastModel('missing')).rejects.toThrow(/模型记录不存在/);
  });
});

describe('loadGenerationConfig', () => {
  it('不读取 Key 键', async () => {
    const connection = await seedConnection();
    await seedModel(connection.id);

    const getMock = (chrome.storage.local.get as unknown) as ReturnType<typeof vi.fn>;
    getMock.mockClear();
    await loadGenerationConfig();

    const requestedKeys = getMock.mock.calls.flat();
    expect(requestedKeys).not.toContain(GENERATION_CONFIG_KEYS.keys);
    expect(requestedKeys).toEqual(
      expect.arrayContaining([
        GENERATION_CONFIG_KEYS.connections,
        GENERATION_CONFIG_KEYS.models,
        GENERATION_CONFIG_KEYS.lastModel
      ])
    );
  });

  it('lastModel 指向不存在的模型时返回 null，且不自动改盘', async () => {
    store[GENERATION_CONFIG_KEYS.lastModel] = 'missing-model';
    setMock.mockClear();

    const config = await loadGenerationConfig();
    expect(config.lastModelId).toBeNull();
    expect(setMock).not.toHaveBeenCalled();
    expect(store[GENERATION_CONFIG_KEYS.lastModel]).toBe('missing-model');
  });

  it('缺失数据时返回零连接、零模型、null 指针', async () => {
    expect(await loadGenerationConfig()).toEqual({
      connections: [],
      models: [],
      lastModelId: null
    });
  });

  it('groupModelsByConnection 保留无模型连接；findModel / findConnection 命中', async () => {
    const first = await seedConnection({ name: 'A' });
    const second = await seedConnection({ name: 'B', baseUrl: 'https://b.example.com/v1' });
    const model = await seedModel(first.id);

    const config = await loadGenerationConfig();
    const grouped = groupModelsByConnection(config);
    expect(grouped).toHaveLength(2);
    expect(grouped[0].connection.id).toBe(first.id);
    expect(grouped[0].models.map((item) => item.id)).toEqual([model.id]);
    expect(grouped[1].connection.id).toBe(second.id);
    expect(grouped[1].models).toEqual([]);
    expect(findModel(config, model.id)?.id).toBe(model.id);
    expect(findConnection(config, second.id)?.id).toBe(second.id);
    expect(findModel(config, 'missing')).toBeUndefined();
  });
});
