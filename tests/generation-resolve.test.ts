import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GENERATION_CONFIG_KEYS,
  type GenerationModelRecord,
  type ProviderConnection
} from '../src/shared/generation-config';
import type { ProtocolId } from '../src/shared/protocols';
import { InvocationError, resolveInvocation } from '../src/background/resolve-invocation';
import { getConnectionKey } from '../src/background/credentials';

vi.mock('../src/background/credentials', () => ({
  getConnectionKey: vi.fn(async () => 'secret-key'),
  cleanupLegacyGenerationConfig: vi.fn(async () => undefined)
}));

const store: Record<string, unknown> = {};

function installChrome(): void {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items);
        }),
        remove: vi.fn(async () => undefined)
      }
    }
  });
}

const connection: ProviderConnection = {
  id: 'conn_1',
  name: '我的服务',
  baseUrl: 'https://api.example.com/v1',
  hasKey: true,
  createdAt: 1,
  updatedAt: 1
};

const openaiModel: GenerationModelRecord = {
  id: 'model_openai',
  connectionId: 'conn_1',
  protocolId: 'openai-images-v1',
  remoteModelId: 'gpt-image-2',
  displayName: 'GPT Image 2',
  supportsReferenceImage: true,
  maxRefs: 4,
  maxN: 5,
  createdAt: 1
};

const geminiModel: GenerationModelRecord = {
  id: 'model_gemini',
  connectionId: 'conn_1',
  protocolId: 'gemini-image-v1',
  remoteModelId: 'gemini-3.1-flash-image',
  displayName: 'Gemini Image',
  supportsReferenceImage: true,
  maxRefs: 2,
  maxN: 1,
  createdAt: 1
};

function seed(config: {
  connection?: ProviderConnection | null;
  models?: GenerationModelRecord[];
}): void {
  store[GENERATION_CONFIG_KEYS.connections] = config.connection ? [config.connection] : [];
  store[GENERATION_CONFIG_KEYS.models] = config.models ?? [];
  store[GENERATION_CONFIG_KEYS.lastModel] = null;
}

function input(overrides: Partial<Parameters<typeof resolveInvocation>[0]> = {}) {
  return {
    modelRecordId: 'model_openai',
    prompt: '一只猫',
    size: '1024x1024',
    quality: 'auto',
    n: 1,
    referenceCount: 0,
    ...overrides
  };
}

async function expectCode(
  promise: Promise<unknown>,
  code: string
): Promise<InvocationError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(InvocationError);
    const invocationError = error as InvocationError;
    expect(invocationError.code).toBe(code);
    expect(invocationError.userMessage.length).toBeGreaterThan(0);
    expect(invocationError.userMessage).not.toContain('secret-key');
    return invocationError;
  }
  throw new Error(`expected rejection with ${code}`);
}

beforeEach(() => {
  for (const key of Object.keys(store)) {
    delete store[key];
  }
  installChrome();
  vi.mocked(getConnectionKey).mockReset();
  vi.mocked(getConnectionKey).mockResolvedValue('secret-key');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('resolveInvocation 成功路径', () => {
  it('OpenAI 协议：返回模型记录、连接、协议与 Key', async () => {
    seed({ connection, models: [openaiModel] });
    const resolved = await resolveInvocation(
      input({ prompt: '合并', size: '1536x1024', quality: 'high', n: 5, referenceCount: 4 })
    );

    expect(resolved.record.id).toBe('model_openai');
    expect(resolved.connection.id).toBe('conn_1');
    expect(resolved.protocol.id).toBe('openai-images-v1');
    expect(resolved.protocol.auth).toEqual({
      headerName: 'Authorization',
      prefix: 'Bearer '
    });
    expect(resolved.apiKey).toBe('secret-key');
  });

  it('Gemini 协议：quality 为空串、n=1、size 为 ratio@size', async () => {
    seed({ connection: { ...connection, baseUrl: 'https://api.example.com/v1beta' }, models: [geminiModel] });
    const resolved = await resolveInvocation(
      input({
        modelRecordId: 'model_gemini',
        size: '16:9@2K',
        quality: '',
        n: 1,
        referenceCount: 2
      })
    );

    expect(resolved.protocol.id).toBe('gemini-image-v1');
    expect(resolved.record.remoteModelId).toBe('gemini-3.1-flash-image');
  });

  it('Key 首尾空白被 trim 后返回', async () => {
    seed({ connection, models: [openaiModel] });
    vi.mocked(getConnectionKey).mockResolvedValue('  secret-key  ');
    const resolved = await resolveInvocation(input());
    expect(resolved.apiKey).toBe('secret-key');
  });

  it('Base URL 复验通过后返回规范化地址（去尾部斜杠，供请求拼接）', async () => {
    seed({
      connection: { ...connection, baseUrl: 'https://api.example.com/v1//' },
      models: [openaiModel]
    });
    const resolved = await resolveInvocation(input());
    expect(resolved.connection.baseUrl).toBe('https://api.example.com/v1');
    expect(resolved.connection.id).toBe('conn_1');
    expect(resolved.connection.hasKey).toBe(true);
  });
});

describe('resolveInvocation 六类原因码与校验顺序', () => {
  it('model_not_found', async () => {
    seed({ connection, models: [openaiModel] });
    await expectCode(
      resolveInvocation(input({ modelRecordId: 'missing' })),
      'model_not_found'
    );
    expect(getConnectionKey).not.toHaveBeenCalled();
  });

  it('connection_not_found', async () => {
    seed({ connection: null, models: [openaiModel] });
    await expectCode(
      resolveInvocation(input()),
      'connection_not_found'
    );
    expect(getConnectionKey).not.toHaveBeenCalled();
  });

  it('key_missing（先于协议与 Base URL 校验）', async () => {
    seed({
      connection: { ...connection, baseUrl: 'http://bad.example.com' },
      models: [{ ...openaiModel, protocolId: 'unknown' as ProtocolId }]
    });
    vi.mocked(getConnectionKey).mockResolvedValue('   ');
    await expectCode(resolveInvocation(input()), 'key_missing');
  });

  it('protocol_unsupported（先于 Base URL 校验）', async () => {
    seed({
      connection: { ...connection, baseUrl: 'http://bad.example.com' },
      models: [{ ...openaiModel, protocolId: 'unknown' as ProtocolId }]
    });
    await expectCode(resolveInvocation(input()), 'protocol_unsupported');
  });

  it('invalid_base_url（先于参数校验）', async () => {
    seed({
      connection: { ...connection, baseUrl: 'http://bad.example.com' },
      models: [openaiModel]
    });
    await expectCode(
      resolveInvocation(input({ prompt: '', n: 99 })),
      'invalid_base_url'
    );
  });

  it('invalid_params：prompt 为空', async () => {
    seed({ connection, models: [openaiModel] });
    await expectCode(resolveInvocation(input({ prompt: '   ' })), 'invalid_params');
  });

  it('invalid_params：size 不符合协议', async () => {
    seed({ connection, models: [openaiModel] });
    await expectCode(
      resolveInvocation(input({ size: '1:1@1K' })),
      'invalid_params'
    );

    seed({ connection, models: [geminiModel] });
    await expectCode(
      resolveInvocation(
        input({ modelRecordId: 'model_gemini', size: '1:1@8K', quality: '', n: 1 })
      ),
      'invalid_params'
    );
  });

  it('invalid_params：quality 必须命中协议枚举；无画质协议只接受空串', async () => {
    seed({ connection, models: [openaiModel] });
    await expectCode(
      resolveInvocation(input({ quality: 'ultra' })),
      'invalid_params'
    );

    seed({ connection, models: [geminiModel] });
    await expectCode(
      resolveInvocation(
        input({ modelRecordId: 'model_gemini', size: '1:1@1K', quality: 'auto', n: 1 })
      ),
      'invalid_params'
    );
  });

  it('invalid_params：n 必须为整数且 1 ≤ n ≤ min(model.maxN, protocol.maxN)', async () => {
    seed({ connection, models: [openaiModel] });
    for (const n of [0, 6, 1.5, Number.NaN]) {
      await expectCode(resolveInvocation(input({ n })), 'invalid_params');
    }
    // model.maxN=5 小于协议上限 10，n=5 合法
    const resolved = await resolveInvocation(input({ n: 5 }));
    expect(resolved.record.id).toBe('model_openai');
  });

  it('invalid_params：参考图数量 0 ≤ count ≤ maxRefs，且不支持参考图时必须为 0', async () => {
    seed({ connection, models: [openaiModel] });
    await expectCode(resolveInvocation(input({ referenceCount: 5 })), 'invalid_params');
    await expectCode(resolveInvocation(input({ referenceCount: -1 })), 'invalid_params');
    await expectCode(resolveInvocation(input({ referenceCount: 1.5 })), 'invalid_params');

    seed({
      connection,
      models: [{ ...openaiModel, supportsReferenceImage: false, maxRefs: 0 }]
    });
    const error = await expectCode(
      resolveInvocation(input({ referenceCount: 1 })),
      'invalid_params'
    );
    expect(error.userMessage).toContain('不支持参考图');
  });
});
