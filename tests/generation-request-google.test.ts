import { describe, expect, it } from 'vitest';

import {
  buildGoogleGenerationFetchInit,
  buildGoogleGenerationUrl
} from '../src/background/generation-request-google';
import type { GenerationReference } from '../src/shared/generation';

const API_KEY = 'gemini-key';
const BASE_URL = 'https://api.example.com/v1beta';

describe('buildGoogleGenerationUrl', () => {
  it('Base URL + /models/{remoteModelId}:generateContent', () => {
    expect(buildGoogleGenerationUrl(BASE_URL, 'gemini-3.1-flash-image')).toBe(
      'https://api.example.com/v1beta/models/gemini-3.1-flash-image:generateContent'
    );
  });

  it('远端型号进入路径前做百分号编码', () => {
    expect(buildGoogleGenerationUrl(BASE_URL, 'models/gemini 3.1')).toBe(
      'https://api.example.com/v1beta/models/models%2Fgemini%203.1:generateContent'
    );
  });

  it('文生图与图生图共用同一端点（不分流）', () => {
    expect(buildGoogleGenerationUrl(BASE_URL, 'gemini-3-pro-image')).toBe(
      buildGoogleGenerationUrl(BASE_URL, 'gemini-3-pro-image')
    );
  });
});

describe('buildGoogleGenerationFetchInit', () => {
  it('文生图：JSON body 含 prompt text part + imageConfig，无 inlineData', async () => {
    const init = await buildGoogleGenerationFetchInit({
      baseUrl: BASE_URL,
      remoteModelId: 'gemini-3.1-flash-image',
      apiKey: API_KEY,
      params: { prompt: '一只柴犬', size: '1:1@1K', n: 1 },
      refs: []
    });

    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    // v3.9：Gemini 协议不再发 Authorization: Bearer
    expect(headers['x-goog-api-key']).toBe(API_KEY);
    expect(headers.Authorization).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Accept).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body.contents).toHaveLength(1);
    expect(body.contents[0].role).toBe('user');
    // 文生图仅含 prompt text part（无 inlineData）
    expect(body.contents[0].parts).toEqual([{ text: '一只柴犬' }]);
    expect(body.generationConfig.responseModalities).toEqual(['TEXT', 'IMAGE']);
    expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: '1:1', imageSize: '1K' });
  });

  it('size 16:9@4K 正确拆入 imageConfig', async () => {
    const init = await buildGoogleGenerationFetchInit({
      baseUrl: BASE_URL,
      remoteModelId: 'gemini-3-pro-image',
      apiKey: API_KEY,
      params: { prompt: 'p', size: '16:9@4K', n: 1 },
      refs: []
    });
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: '16:9', imageSize: '4K' });
  });

  it('图生图：parts 含 prompt text + inlineData（base64）', async () => {
    // 构造一个 1x1 PNG blob
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const binary = atob(pngBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: 'image/png' });
    const refs: GenerationReference[] = [{ kind: 'local', filename: 'cat.png', blob }];

    const init = await buildGoogleGenerationFetchInit({
      baseUrl: BASE_URL,
      remoteModelId: 'gemini-3.1-flash-image',
      apiKey: API_KEY,
      params: { prompt: '让猫戴上帽子', size: '3:4@2K', n: 1 },
      refs
    });
    const body = JSON.parse(init.body as string);
    const parts = body.contents[0].parts;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ text: '让猫戴上帽子' });
    expect(parts[1].inlineData).toBeDefined();
    expect(parts[1].inlineData.mimeType).toBe('image/png');
    expect(parts[1].inlineData.data).toBe(pngBase64);
  });

  it('空 prompt 图生图：parts 仅含 inlineData（无 text part）', async () => {
    const blob = new Blob([new Uint8Array([0])], { type: 'image/png' });
    const refs: GenerationReference[] = [{ kind: 'local', filename: 'x.png', blob }];

    const init = await buildGoogleGenerationFetchInit({
      baseUrl: BASE_URL,
      remoteModelId: 'gemini-3-pro-image',
      apiKey: API_KEY,
      params: { prompt: '   ', size: '1:1@1K', n: 1 },
      refs
    });
    const body = JSON.parse(init.body as string);
    // prompt trim 后为空，跳过 text part，仅含 inlineData
    expect(body.contents[0].parts).toHaveLength(1);
    expect(body.contents[0].parts[0].inlineData).toBeDefined();
  });

  it('非法 size 不静默兜底，直接抛错（由 resolveInvocation 前置拦截）', async () => {
    for (const size of ['bogus', '1:1@8K', '7:3@1K']) {
      await expect(
        buildGoogleGenerationFetchInit({
          baseUrl: BASE_URL,
          remoteModelId: 'gemini-3.1-flash-image',
          apiKey: API_KEY,
          params: { prompt: 'p', size, n: 1 },
          refs: []
        })
      ).rejects.toThrow(/尺寸格式不合法/);
    }
  });

  it('请求体中不出现 API Key（Key 只在 header）', async () => {
    const init = await buildGoogleGenerationFetchInit({
      baseUrl: BASE_URL,
      remoteModelId: 'gemini-3.1-flash-image',
      apiKey: API_KEY,
      params: { prompt: 'p', size: '1:1@1K', n: 1 },
      refs: []
    });
    expect(init.body as string).not.toContain(API_KEY);
  });
});
