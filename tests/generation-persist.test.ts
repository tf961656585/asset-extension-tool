import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  persistGenerationResult,
  type GenerationLineageSnapshot
} from '../src/background/generation-persist';
import { getGeneratedBlob } from '../src/shared/idb-asset-store';
import type { GenerationReference } from '../src/shared/generation';
import type { AssetRecord } from '../src/shared/model';

const store: Record<string, unknown> = {};

const LINEAGE: GenerationLineageSnapshot = {
  model: 'gpt-image-2',
  modelName: 'GPT Image 2',
  provider: 'openai-image',
  connectionName: '我的服务',
  baseUrlHost: 'api.example.com'
};

function setupChrome(downloadId: number): { downloadMock: ReturnType<typeof vi.fn> } {
  let callCount = 0;
  const downloadMock = vi.fn(async () => downloadId + callCount++);
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items);
        })
      }
    },
    downloads: { download: downloadMock }
  });
  return { downloadMock };
}

describe('persistGenerationResult', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const key of Object.keys(store)) {
      delete store[key];
    }
    globalThis.indexedDB = new IDBFactory();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.indexedDB = new IDBFactory();
  });

  it('图生图：base64→落盘→血缘写入资产库（含源参考图、剥离 blob）', async () => {
    const { downloadMock } = setupChrome(999);

    const result = {
      images: [{ b64: 'aGVsbG8=' }],
      outputFormat: 'png'
    };
    const refs: GenerationReference[] = [
      { kind: 'web', imageUrl: 'https://x.com/a.png', blob: new Blob(['x']) }
    ];
    const created = await persistGenerationResult(
      result,
      refs,
      {
        prompt: '合并',
        size: '1024x1536',
        n: 1,
        quality: 'high'
      },
      LINEAGE
    );

    expect(created).toHaveLength(1);
    expect(created[0].generatedFrom?.mode).toBe('image-to-image');
    expect(created[0].generatedFrom?.sourceRefs).toEqual([{ kind: 'web', imageUrl: 'https://x.com/a.png' }]);
    expect(created[0].generatedFrom?.quality).toBe('high');
    expect(created[0].sourceDomain).toBe('ai-generated');

    expect(downloadMock).toHaveBeenCalledTimes(1);
    expect(downloadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: expect.stringContaining('WYJHExtension/ai-generated/')
      })
    );

    const saved = store['asset_manager_v1'] as { assets: AssetRecord[] };
    expect(saved.assets).toHaveLength(1);
  });

  it('v3.9：血缘写入 model（远端型号）/ modelName / provider / connectionName / baseUrlHost 快照', async () => {
    setupChrome(10);

    const created = await persistGenerationResult(
      { images: [{ b64: 'aGVsbG8=' }], outputFormat: 'png' },
      [],
      { prompt: '一只猫', size: 'auto', n: 1, quality: 'auto' },
      LINEAGE
    );

    const lineage = created[0].generatedFrom;
    expect(lineage?.model).toBe('gpt-image-2');
    expect(lineage?.modelName).toBe('GPT Image 2');
    expect(lineage?.provider).toBe('openai-image');
    expect(lineage?.connectionName).toBe('我的服务');
    expect(lineage?.baseUrlHost).toBe('api.example.com');
    expect(lineage?.quality).toBe('auto');
  });

  it('v3.9：不再硬编码来源页 wyjh.top，生成图 sourcePageUrl 留空', async () => {
    setupChrome(11);

    const created = await persistGenerationResult(
      { images: [{ b64: 'aGVsbG8=' }], outputFormat: 'png' },
      [],
      { prompt: 'x', size: 'auto', n: 1, quality: 'auto' },
      LINEAGE
    );

    expect(created[0].sourcePageUrl).toBe('');
    expect(created[0].sourcePageUrl).not.toContain('wyjh.top');
    // 卡片展示依赖 sourceDomain，留空来源页也必须保持 ai-generated 伪域名
    expect(created[0].sourceDomain).toBe('ai-generated');
  });

  it('v3.7：imageUrl 为字节句柄（资产 id），不再是 data: URL；字节写入 IndexedDB', async () => {
    setupChrome(999);

    const result = {
      images: [{ b64: 'aGVsbG8=' }],
      outputFormat: 'png'
    };
    const created = await persistGenerationResult(
      result,
      [],
      { prompt: 'x', size: '1024x1024', n: 1, quality: 'auto' },
      LINEAGE
    );

    const asset = created[0];
    // imageUrl 为字节句柄（= 资产 id），不得为 data: URL
    expect(asset.imageUrl).toBe(asset.id);
    expect(asset.imageUrl).not.toMatch(/^data:/);

    // 字节写入 IndexedDB，键为资产 id
    const blob = await getGeneratedBlob(asset.id);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob?.type).toBe('image/png');
    // aGVsbG8= 解码为 "hello"
    const text = await (blob as Blob).text();
    expect(text).toBe('hello');
  });

  it('v3.7：多图各自独立写入 IndexedDB（以各自资产 id 为键）', async () => {
    setupChrome(7);

    const result = {
      images: [{ b64: 'YQ==' }, { b64: 'Yg==' }],
      outputFormat: 'png'
    };
    const created = await persistGenerationResult(
      result,
      [],
      { prompt: 'x', size: '1024x1024', n: 2, quality: 'auto' },
      LINEAGE
    );

    expect(created).toHaveLength(2);
    const blob0 = await getGeneratedBlob(created[0].id);
    const blob1 = await getGeneratedBlob(created[1].id);
    expect(await (blob0 as Blob).text()).toBe('a');
    expect(await (blob1 as Blob).text()).toBe('b');
  });

  it('文生图：无参考图 → mode text-to-image、空 sourceRefs', async () => {
    setupChrome(123);

    const result = {
      images: [{ b64: 'aGVsbG8=' }],
      outputFormat: 'jpeg'
    };
    const created = await persistGenerationResult(
      result,
      [],
      { prompt: '一只猫', size: 'auto', n: 1 },
      { ...LINEAGE, provider: 'google-image', model: 'gemini-3.1-flash-image' }
    );

    expect(created[0].generatedFrom?.mode).toBe('text-to-image');
    expect(created[0].generatedFrom?.sourceRefs).toEqual([]);
    expect(created[0].generatedFrom?.provider).toBe('google-image');
    // 未提供 quality（Gemini 协议无该参数）记录为空串
    expect(created[0].generatedFrom?.quality).toBe('');
  });

  it('多图结果逐张落盘', async () => {
    const { downloadMock } = setupChrome(7);

    const result = {
      images: [
        { b64: 'YQ==' },
        { b64: 'Yg==' }
      ],
      outputFormat: 'png'
    };
    const created = await persistGenerationResult(
      result,
      [],
      { prompt: 'x', size: '1024x1024', n: 2, quality: 'auto' },
      LINEAGE
    );

    expect(created).toHaveLength(2);
    expect(downloadMock).toHaveBeenCalledTimes(2);
    const saved = store['asset_manager_v1'] as { assets: unknown[] };
    expect(saved.assets).toHaveLength(2);
  });
});
