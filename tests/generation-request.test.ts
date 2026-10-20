import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildOpenAIGenerationFetchInit,
  buildOpenAIGenerationUrl,
  executeGenerationRequest,
  resolveReferenceBlobs
} from '../src/background/generation-request';
import { putGeneratedBlob } from '../src/shared/idb-asset-store';
import type { GenerationReference } from '../src/shared/generation';
import { STORAGE_KEY } from '../src/shared/model';

const API_KEY = 'secret-key';
const BASE_URL = 'https://api.example.com/v1';
const REMOTE_MODEL = 'custom-image-model';

describe('buildOpenAIGenerationUrl', () => {
  it('请求地址 = Base URL + 协议相对端点（参考图空 → generations）', () => {
    expect(buildOpenAIGenerationUrl(BASE_URL, [])).toBe(
      'https://api.example.com/v1/images/generations'
    );
  });

  it('参考图非空 → edits（不在软件侧补版本段）', () => {
    const refs: GenerationReference[] = [{ kind: 'web', imageUrl: 'https://x.com/a.png' }];
    expect(buildOpenAIGenerationUrl('https://gateway.example.com/openai', refs)).toBe(
      'https://gateway.example.com/openai/images/edits'
    );
  });
});

describe('buildOpenAIGenerationFetchInit', () => {
  it('文生图：JSON body + Bearer 头 + application/json，model 为远端型号', () => {
    const init = buildOpenAIGenerationFetchInit({
      baseUrl: BASE_URL,
      remoteModelId: REMOTE_MODEL,
      apiKey: API_KEY,
      params: { prompt: '猫', size: '1024x1024', n: 1, model: 'stale-model' },
      refs: []
    });

    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers.Accept).toBe('application/json');
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(REMOTE_MODEL);
    expect(body.prompt).toBe('猫');
    expect(body.n).toBe(1);
    expect(body.size).toBe('1024x1024');
    expect(body.quality).toBe('auto');
    // Key 只在 header，不进 body
    expect(JSON.stringify(body)).not.toContain(API_KEY);
  });

  it('图生图：multipart FormData + image 文件 part，model 为远端型号', () => {
    const refs: GenerationReference[] = [
      { kind: 'web', imageUrl: 'https://x.com/a.png', blob: new Blob(['a']) },
      { kind: 'local', filename: 'b.png', blob: new Blob(['b']) }
    ];
    const init = buildOpenAIGenerationFetchInit({
      baseUrl: BASE_URL,
      remoteModelId: REMOTE_MODEL,
      apiKey: API_KEY,
      params: { prompt: '合并', size: '1024x1536', n: 2, quality: 'high' },
      refs
    });

    expect(init.body).toBeInstanceOf(FormData);
    const fd = init.body as FormData;
    expect(fd.getAll('image')).toHaveLength(2);
    expect(fd.get('image')).toBeInstanceOf(Blob);
    expect(fd.get('prompt')).toBe('合并');
    expect(fd.get('model')).toBe(REMOTE_MODEL);
    expect(fd.get('n')).toBe('2');
    expect(fd.get('size')).toBe('1024x1536');
    expect(fd.get('quality')).toBe('high');
    // Authorization 仅在 header，不得进入 multipart body
    expect(fd.get('Authorization')).toBeNull();
  });

  it('图生图 image part 携带带扩展名的 filename（缺扩展名服务端报 Invalid image file or mode）', () => {
    const refs: GenerationReference[] = [
      { kind: 'web', imageUrl: 'https://x.com/a', blob: new Blob(['a'], { type: 'image/png' }) },
      { kind: 'local', filename: 'b.webp', blob: new Blob(['b'], { type: 'image/webp' }) }
    ];
    const init = buildOpenAIGenerationFetchInit({
      baseUrl: BASE_URL,
      remoteModelId: REMOTE_MODEL,
      apiKey: API_KEY,
      params: { prompt: 'x', size: 'auto', n: 1 },
      refs
    });
    const fd = init.body as FormData;
    const images = fd.getAll('image') as File[];
    // FormData.append 第三参数写入 part 的 filename；FormData 解析时以 File 形式返回，带 name。
    expect(images[0].name).toBe('ref-0.png');
    expect(images[1].name).toBe('b.webp');
  });
});

describe('resolveReferenceBlobs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('已携带 blob 的参考图直接透传', async () => {
    const refs: GenerationReference[] = [{ kind: 'local', filename: 'a.png', blob: new Blob(['a']) }];
    const resolved = await resolveReferenceBlobs(refs);
    expect(resolved[0].blob).toBeInstanceOf(Blob);
  });

  it('缺失 blob 的 web 参考图按 imageUrl 拉取', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(['fetched'])
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const refs: GenerationReference[] = [{ kind: 'web', imageUrl: 'https://x.com/a.png' }];
    const resolved = await resolveReferenceBlobs(refs);

    // 带 referrerPolicy: 'no-referrer' 绕开图片 CDN 的 Referer 防盗链。
    expect(fetchMock).toHaveBeenCalledWith('https://x.com/a.png', {
      referrerPolicy: 'no-referrer'
    });
    expect(resolved[0].blob).toBeInstanceOf(Blob);
  });

  it('无 blob 且无 imageUrl 时抛出', async () => {
    const refs: GenerationReference[] = [{ kind: 'local', filename: 'a.png' }];
    await expect(resolveReferenceBlobs(refs)).rejects.toThrow();
  });

  it('AVIF blob 转码为 PNG（API 服务端 Pillow 默认不认 AVIF）', async () => {
    stubOffscreenCanvas();
    const avifBlob = new Blob([new Uint8Array([0, 0, 0, 28, 102, 116, 121, 112])], { type: 'image/avif' });
    const refs: GenerationReference[] = [{ kind: 'web', imageUrl: 'https://x.com/a.avif', blob: avifBlob }];
    const resolved = await resolveReferenceBlobs(refs);
    expect(resolved[0].blob?.type).toBe('image/png');
  });

  it('fetch 回拉得到 AVIF（CDN 内容协商）→ 转码为 PNG', async () => {
    stubOffscreenCanvas();
    const avifBlob = new Blob(['fake-avif'], { type: 'image/avif' });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      blob: async () => avifBlob
    })) as unknown as typeof fetch);

    const refs: GenerationReference[] = [{ kind: 'web', imageUrl: 'https://i1.hdslb.com/x.jpg.avif' }];
    const resolved = await resolveReferenceBlobs(refs);
    expect(resolved[0].blob?.type).toBe('image/png');
  });

  it('PNG blob 不触发转码（透传）', async () => {
    stubOffscreenCanvas();
    const pngBlob = new Blob(['png-bytes'], { type: 'image/png' });
    const refs: GenerationReference[] = [{ kind: 'local', filename: 'a.png', blob: pngBlob }];
    const resolved = await resolveReferenceBlobs(refs);
    expect(resolved[0].blob).toBe(pngBlob);
  });

  describe('v3.7 asset 参考图按源资产是否为生成图分流', () => {
    beforeEach(() => {
      globalThis.indexedDB = new IDBFactory();
    });
    afterEach(() => {
      globalThis.indexedDB = new IDBFactory();
      vi.unstubAllGlobals();
    });

    it('源资产为生成图（有 generatedFrom）→ 按 assetId 从 IndexedDB 直取，不 fetch', async () => {
      const assetId = 'asset_gen_1';
      // 预置：生成图字节已存 IndexedDB；资产库元数据带 generatedFrom
      const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
      await putGeneratedBlob(assetId, blob);
      vi.stubGlobal('chrome', {
        storage: {
          local: {
            get: vi.fn(async () => ({
              [STORAGE_KEY]: {
                assets: [
                  { id: assetId, imageUrl: assetId, generatedFrom: { mode: 'text-to-image' } }
                ]
              }
            }))
          }
        }
      });
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

      const refs: GenerationReference[] = [
        { kind: 'asset', assetId, imageUrl: assetId }
      ];
      const resolved = await resolveReferenceBlobs(refs);

      expect(resolved[0].blob).toBeInstanceOf(Blob);
      // 关键：不 fetch 句柄字符串
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('源资产为采集图（无 generatedFrom）→ fetch imageUrl 回拉（沿用既有路径）', async () => {
      const assetId = 'asset_collected_1';
      vi.stubGlobal('chrome', {
        storage: {
          local: {
            get: vi.fn(async () => ({
              [STORAGE_KEY]: {
                assets: [{ id: assetId, imageUrl: 'https://x.com/a.png' }]
              }
            }))
          }
        }
      });
      const fetchMock = vi.fn(async () => ({
        ok: true,
        blob: async () => new Blob(['fetched'])
      }));
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

      const refs: GenerationReference[] = [
        { kind: 'asset', assetId, imageUrl: 'https://x.com/a.png' }
      ];
      const resolved = await resolveReferenceBlobs(refs);

      expect(resolved[0].blob).toBeInstanceOf(Blob);
      expect(fetchMock).toHaveBeenCalledWith('https://x.com/a.png', { referrerPolicy: 'no-referrer' });
    });
  });
});

/**
 * stub createImageBitmap + OffscreenCanvas：模拟 SW 内 AVIF→PNG 转码。
 * node 测试环境无这些 API，注入最小桩使转码逻辑可观察（convertToBlob 返回固定 PNG blob）。
 */
function stubOffscreenCanvas(): void {
  const fakeCtx = {
    drawImage: vi.fn()
  };
  const fakeCanvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => fakeCtx),
    convertToBlob: vi.fn(async () => new Blob(['png'], { type: 'image/png' }))
  };
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 10, height: 10, close: vi.fn() })));
  vi.stubGlobal('OffscreenCanvas', vi.fn(() => fakeCanvas));
}

describe('executeGenerationRequest', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('返回解析后的 JSON', async () => {
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ ok: true })
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const json = await executeGenerationRequest('https://x.com', { method: 'POST' });
    expect(json).toEqual({ ok: true });
  });

  it('无主动超时：调用 fetch 且不传入 signal（慢请求会等待至完成，不 abort）', async () => {
    let capturedSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal;
      return new Promise<Response>((resolve) => {
        // 模拟慢请求（无主动超时），最终仍 resolve。
        setTimeout(() => resolve({ json: async () => ({ ok: true }) } as Response), 5);
      });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const json = await executeGenerationRequest('https://x.com', { method: 'POST' });
    expect(json).toEqual({ ok: true });
    // v3.2：不主动超时，fetch 不应携带 signal。
    expect(capturedSignal).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('https://x.com', { method: 'POST' });
  });
});
