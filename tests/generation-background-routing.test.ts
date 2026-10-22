import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GENERATION_CONFIG_KEYS,
  type GenerationModelRecord,
  type ProviderConnection
} from '../src/shared/generation-config';
import type { GenerationSubmitPayload } from '../src/shared/messages';

/** chrome.storage.local 内存桩（background 启动与 resolveInvocation 共用）。 */
const store: Record<string, unknown> = {};

function installChromeStub(): void {
  const noop = (): void => undefined;
  const listener = (): void => undefined;
  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener: listener },
      onStartup: { addListener: listener },
      onConnect: { addListener: listener },
      onMessage: { addListener: listener },
      WINDOW_ID_CURRENT: 1,
      connect: () => ({ postMessage: noop, onMessage: { addListener: listener }, onDisconnect: { addListener: listener }, disconnect: noop }),
      sendMessage: vi.fn()
    },
    contextMenus: {
      removeAll: vi.fn(async () => undefined),
      create: noop,
      onClicked: { addListener: listener }
    },
    sidePanel: { open: vi.fn(async () => undefined) },
    windows: { WINDOW_ID_CURRENT: 1 },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items);
        }),
        remove: vi.fn(async () => undefined)
      },
      session: { get: vi.fn(), set: vi.fn() }
    },
    tabs: { sendMessage: vi.fn() },
    downloads: { download: vi.fn(async () => 1) }
  } as unknown as typeof chrome;
}

function makePort(): { port: chrome.runtime.Port; postMessage: ReturnType<typeof vi.fn> } {
  const postMessage = vi.fn();
  const port = { postMessage } as unknown as chrome.runtime.Port;
  return { port, postMessage };
}

function feedbacksOf(postMessage: ReturnType<typeof vi.fn>): Array<{ type: string; payload: Record<string, unknown> }> {
  return postMessage.mock.calls
    .map((call) => call[0] as { type: string; payload: Record<string, unknown> })
    .filter((msg) => msg.type === 'GENERATION_FEEDBACK');
}

vi.mock('../src/background/credentials', () => ({
  getConnectionKey: vi.fn(async () => 'test-key'),
  cleanupLegacyGenerationConfig: vi.fn(async () => undefined)
}));

vi.mock('../src/background/generation-persist', async () => {
  const actual = await vi.importActual<typeof import('../src/background/generation-persist')>('../src/background/generation-persist');
  return {
    ...actual,
    persistGenerationResult: vi.fn(async () => [{ id: 'asset_x' }])
  };
});

vi.mock('../src/background/generation-response', async () => {
  const actual = await vi.importActual<typeof import('../src/background/generation-response')>('../src/background/generation-response');
  return {
    ...actual,
    parseGenerationResponse: vi.fn(() => ({ images: [{ b64: 'x' }] })),
    isErrorResponse: vi.fn(() => false),
    extractErrorMessage: vi.fn(() => 'err')
  };
});

import { cleanupLegacyGenerationConfig, getConnectionKey } from '../src/background/credentials';
import { persistGenerationResult } from '../src/background/generation-persist';
import { parseGenerationResponse } from '../src/background/generation-response';

let bg: typeof import('../src/background/index');

interface SeedOptions {
  baseUrl?: string;
  protocolId?: 'openai-images-v1' | 'gemini-image-v1';
  remoteModelId?: string;
  maxRefs?: number;
  maxN?: number;
  supportsReferenceImage?: boolean;
}

function seedConfig(options: SeedOptions = {}): void {
  const connection: ProviderConnection = {
    id: 'conn_1',
    name: '我的服务',
    baseUrl: options.baseUrl ?? 'https://api.example.com/v1',
    hasKey: true,
    createdAt: 1,
    updatedAt: 1
  };
  const model: GenerationModelRecord = {
    id: 'model_1',
    connectionId: 'conn_1',
    protocolId: options.protocolId ?? 'openai-images-v1',
    remoteModelId: options.remoteModelId ?? 'gpt-image-2',
    displayName: '模型显示名',
    supportsReferenceImage: options.supportsReferenceImage ?? true,
    maxRefs: options.maxRefs ?? 16,
    maxN: options.maxN ?? 10,
    createdAt: 1
  };
  store[GENERATION_CONFIG_KEYS.connections] = [connection];
  store[GENERATION_CONFIG_KEYS.models] = [model];
  store[GENERATION_CONFIG_KEYS.lastModel] = model.id;
}

function payload(overrides: Partial<GenerationSubmitPayload> = {}): GenerationSubmitPayload {
  return {
    taskId: 'task_1',
    modelRecordId: 'model_1',
    prompt: '一只猫',
    size: 'auto',
    quality: 'auto',
    n: 1,
    references: [],
    ...overrides
  };
}

function successfulFetch(json: unknown = { data: [{ b64_json: 'x' }] }): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({ json: async () => json }));
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

beforeAll(async () => {
  installChromeStub();
  bg = await import('../src/background/index');
});

beforeEach(() => {
  for (const key of Object.keys(store)) {
    delete store[key];
  }
  vi.mocked(getConnectionKey).mockResolvedValue('test-key');
  vi.mocked(persistGenerationResult).mockResolvedValue([{ id: 'asset_x' } as never]);
  vi.mocked(parseGenerationResponse).mockReturnValue({ images: [{ b64: 'x' }] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('background generation routing (v3.9 modelRecordId)', () => {
  it('启动时清理旧版生图配置键（幂等）', () => {
    expect(cleanupLegacyGenerationConfig).toHaveBeenCalled();
  });

  it('OpenAI 文生图：resolveInvocation → /images/generations JSON → 解析 → 血缘落库', async () => {
    seedConfig();
    const fetchMock = successfulFetch();
    const { port, postMessage } = makePort();
    bg.setSidePanelPort(port);

    await bg.handleGenerationSubmit(payload());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/images/generations');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    expect(JSON.parse(init.body as string).model).toBe('gpt-image-2');

    expect(parseGenerationResponse).toHaveBeenCalledWith(expect.anything(), 'openai-images-v1');
    expect(persistGenerationResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Array),
      expect.objectContaining({ prompt: '一只猫', size: 'auto', n: 1 }),
      {
        model: 'gpt-image-2',
        modelName: '模型显示名',
        provider: 'openai-image',
        connectionName: '我的服务',
        baseUrlHost: 'api.example.com'
      }
    );

    const feedbacks = feedbacksOf(postMessage);
    expect(feedbacks.some((feedback) => feedback.payload.level === 'info')).toBe(true);
    const success = feedbacks.find((feedback) => feedback.payload.level === 'success');
    expect(success?.payload.taskId).toBe('task_1');
    expect(String(success?.payload.message)).toContain('1 张已存入资产库');
  });

  it('OpenAI 图生图：有参考图走 /images/edits multipart', async () => {
    seedConfig();
    const fetchMock = successfulFetch();
    const { port } = makePort();
    bg.setSidePanelPort(port);

    await bg.handleGenerationSubmit(
      payload({
        references: [
          { kind: 'local', filename: 'a.png', base64: 'YQ==', mimeType: 'image/png' }
        ]
      })
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/images/edits');
    expect(init.body).toBeInstanceOf(FormData);
    const formData = init.body as FormData;
    expect(formData.getAll('image')).toHaveLength(1);
    expect(formData.get('model')).toBe('gpt-image-2');
    expect(formData.get('prompt')).toBe('一只猫');
  });

  it('Gemini：固定 generateContent 端点 + x-goog-api-key，无 Authorization', async () => {
    seedConfig({
      baseUrl: 'https://api.example.com/v1beta',
      protocolId: 'gemini-image-v1',
      remoteModelId: 'gemini-3.1-flash-image',
      maxRefs: 3,
      maxN: 1
    });
    const fetchMock = successfulFetch({ candidates: [] });
    const { port, postMessage } = makePort();
    bg.setSidePanelPort(port);

    await bg.handleGenerationSubmit(
      payload({ prompt: '一只柴犬', size: '1:1@1K', quality: '', n: 1 })
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.example.com/v1beta/models/gemini-3.1-flash-image:generateContent'
    );
    const headers = init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('test-key');
    expect(headers.Authorization).toBeUndefined();
    expect(parseGenerationResponse).toHaveBeenCalledWith(expect.anything(), 'gemini-image-v1');
    expect(persistGenerationResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Array),
      expect.anything(),
      expect.objectContaining({ provider: 'google-image' })
    );
    expect(feedbacksOf(postMessage).some((feedback) => feedback.payload.level === 'success')).toBe(
      true
    );
  });

  it('模型不存在：不发请求，反馈可读原因（model_not_found）', async () => {
    seedConfig();
    const fetchMock = successfulFetch();
    const { port, postMessage } = makePort();
    bg.setSidePanelPort(port);

    await bg.handleGenerationSubmit(payload({ modelRecordId: 'missing-model' }));

    expect(fetchMock).not.toHaveBeenCalled();
    const error = feedbacksOf(postMessage).find((feedback) => feedback.payload.level === 'error');
    expect(String(error?.payload.message)).toContain('找不到所选模型');
    expect(error?.payload.reason).toBe('model_not_found');
  });

  it('Key 缺失：不发请求，反馈可读原因（key_missing）', async () => {
    seedConfig();
    vi.mocked(getConnectionKey).mockResolvedValue('');
    const fetchMock = successfulFetch();
    const { port, postMessage } = makePort();
    bg.setSidePanelPort(port);

    await bg.handleGenerationSubmit(payload());

    expect(fetchMock).not.toHaveBeenCalled();
    const error = feedbacksOf(postMessage).find((feedback) => feedback.payload.level === 'error');
    expect(String(error?.payload.message)).toContain('未配置 API Key');
    expect(error?.payload.reason).toBe('key_missing');
  });

  it('参数越界：不发请求，反馈可读原因（invalid_params）', async () => {
    seedConfig();
    const fetchMock = successfulFetch();
    const { port, postMessage } = makePort();
    bg.setSidePanelPort(port);

    await bg.handleGenerationSubmit(payload({ n: 99 }));

    expect(fetchMock).not.toHaveBeenCalled();
    const error = feedbacksOf(postMessage).find((feedback) => feedback.payload.level === 'error');
    expect(String(error?.payload.message)).toContain('生成数量');
    expect(error?.payload.reason).toBe('invalid_params');
  });

  it('响应非 JSON：反馈用户可读文案，不透传原始解析错误', async () => {
    seedConfig();
    const fetchMock = vi.fn(async () => ({
      json: async () => {
        throw new SyntaxError("Unexpected token '<', \"<!doctype \"... is not valid JSON");
      }
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const { port, postMessage } = makePort();
    bg.setSidePanelPort(port);

    await bg.handleGenerationSubmit(payload());

    const error = feedbacksOf(postMessage).find((feedback) => feedback.payload.level === 'error');
    expect(String(error?.payload.message)).toBe('生图失败，请检查服务地址、Key 与网络后重试。');
    expect(String(error?.payload.message)).not.toContain('Unexpected token');
  });

  it('僵尸兜底：10 分钟后发 level:error 可重试文案（迟到的成功响应被丢弃）', async () => {
    vi.useFakeTimers();
    seedConfig();
    const { port, postMessage } = makePort();
    bg.setSidePanelPort(port);

    let resolveFetch!: (value: unknown) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve as (value: unknown) => void;
        })
    );
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const promise = bg.handleGenerationSubmit(payload({ taskId: 'task_3' }));

    // 让微任务推进到「僵尸计时器已登记、fetch 仍 pending」的状态，再推进假定时器。
    for (let i = 0; i < 30; i += 1) {
      await Promise.resolve();
    }

    vi.advanceTimersByTime(10 * 60 * 1000 + 100);

    const zombie = feedbacksOf(postMessage).find((f) => f.payload.level === 'error');
    expect(zombie).toBeDefined();
    expect(String(zombie?.payload.message)).toBe('生成超时，请重试。');

    // 迟到的成功响应：应被丢弃，不再产生第二条 success。
    resolveFetch({ json: async () => ({ data: [{ b64_json: 'x' }] }) });
    await promise;

    const successes = feedbacksOf(postMessage).filter((f) => f.payload.level === 'success');
    expect(successes).toHaveLength(0);
  });

  it('被动断连（fetch 抛网络错误）：归为 level:error 可重试文案，不使用超时文案', async () => {
    seedConfig();
    const { port, postMessage } = makePort();
    bg.setSidePanelPort(port);

    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await bg.handleGenerationSubmit(payload({ taskId: 'task_4' }));

    const error = feedbacksOf(postMessage).find((f) => f.payload.level === 'error');
    expect(error).toBeDefined();
    expect(String(error?.payload.message)).not.toContain('超时');
    expect(error?.payload.taskId).toBe('task_4');
  });
});
