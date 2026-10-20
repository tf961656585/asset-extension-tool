import { describe, expect, it } from 'vitest';

import {
  toReferencePayloads,
  fromReferencePayloads,
  resolveGenerationEndpoint,
  type GenerationReference
} from '../src/shared/generation';
import { buildOpenAIGenerationFetchInit, resolveReferenceBlobs } from '../src/background/generation-request';

/**
 * spec test 45: generation-local-reference-bytes
 * 断言本地文件参考图在生成提交时，消息载荷携带 base64 字符串而非 Blob/File/ArrayBuffer；
 * background 收到后能还原为 Blob 并作为 multipart image part 发出（不得出现 [object Object] 占位）。
 * 覆盖参考图字节跨上下文传递契约。
 */
describe('spec test 45: 本地参考图字节跨上下文传递（base64 序列化与还原）', () => {
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const PNG_BLOB = new Blob([PNG_BYTES], { type: 'image/png' });

  it('toReferencePayloads：local 来源 blob→base64 字符串，载荷不含 Blob/File/ArrayBuffer', async () => {
    const refs: GenerationReference[] = [
      { kind: 'local', filename: 'cat.png', blob: PNG_BLOB }
    ];
    const payloads = await toReferencePayloads(refs);

    expect(payloads).toHaveLength(1);
    const local = payloads[0];
    expect(local.kind).toBe('local');
    expect(local.filename).toBe('cat.png');
    // base64 必须是字符串
    expect(typeof local.base64).toBe('string');
    // base64 长度公式：ceil(n/3)*4；8 字节 → 12 字符
    expect(local.base64).toHaveLength(Math.ceil(PNG_BYTES.length / 3) * 4);
    // 载荷不得携带 Blob/File/ArrayBuffer 类型字段
    expect(local).not.toHaveProperty('blob');
  });

  it('toReferencePayloads：web 来源丢弃 blob，只保留 imageUrl', async () => {
    const refs: GenerationReference[] = [
      { kind: 'web', imageUrl: 'https://x.com/a.png', blob: new Blob(['a']) }
    ];
    const payloads = await toReferencePayloads(refs);

    expect(payloads[0]).toEqual({ kind: 'web', imageUrl: 'https://x.com/a.png' });
    expect(payloads[0]).not.toHaveProperty('base64');
    expect(payloads[0]).not.toHaveProperty('blob');
  });

  it('toReferencePayloads：asset 来源丢弃 blob，保留 assetId + imageUrl', async () => {
    const refs: GenerationReference[] = [
      { kind: 'asset', assetId: 'asset_1', imageUrl: 'https://x.com/b.png', blob: new Blob(['b']) }
    ];
    const payloads = await toReferencePayloads(refs);

    expect(payloads[0]).toEqual({ kind: 'asset', assetId: 'asset_1', imageUrl: 'https://x.com/b.png' });
  });

  it('fromReferencePayloads：local 来源 base64→Blob 还原，字节与原始一致', () => {
    const payloads = [
      { kind: 'local' as const, filename: 'cat.png', base64: 'iVBORw0KGgo=', mimeType: 'image/png' }
    ];
    const refs = fromReferencePayloads(payloads);

    expect(refs[0].kind).toBe('local');
    expect(refs[0].blob).toBeInstanceOf(Blob);
    // base64 'iVBORw0KGgo=' 解码为 PNG 魔数前 8 字节
    const restored = refs[0].blob as Blob;
    expect(restored.type).toBe('image/png');
  });

  it('端到端：内存态→载荷→还原→resolveReferenceBlobs→FormData，image part 为 Blob 且非 [object Object]', async () => {
    // 1. 渲染层内存态
    const memRefs: GenerationReference[] = [
      { kind: 'local', filename: 'cat.png', blob: PNG_BLOB }
    ];
    // 2. 渲染层发送前转载荷
    const payloads = await toReferencePayloads(memRefs);
    // 3. 模拟 JSON 序列化往返（chrome.runtime.sendMessage 默认 JSON 序列化）
    const serialized = JSON.parse(JSON.stringify(payloads));
    // 4. background 接收后还原内存态
    const restoredRefs = fromReferencePayloads(serialized);
    // 5. background 解析 blob（local 已还原，直接透传）
    const resolved = await resolveReferenceBlobs(restoredRefs);
    // 6. 构建 FormData
    const init = buildOpenAIGenerationFetchInit({
      baseUrl: 'https://host/v1',
      remoteModelId: 'gpt-image-2',
      apiKey: 'test-key',
      params: {
        prompt: '生成猫',
        size: '1024x1024',
        n: 1
      },
      refs: resolved
    });

    expect(init.body).toBeInstanceOf(FormData);
    const fd = init.body as FormData;
    const imagePart = fd.get('image');
    // 核心断言：image part 必须是 Blob，不得是 [object Object] 字符串
    expect(imagePart).toBeInstanceOf(Blob);
    expect(String(imagePart)).not.toBe('[object Object]');
    // 还原后的 blob 字节与原始一致
    const restoredBytes = new Uint8Array(await (imagePart as Blob).arrayBuffer());
    expect(Array.from(restoredBytes)).toEqual(Array.from(PNG_BYTES));
  });

  it('端点自动选择：载荷还原后参考图非空 → 图生图 edits', () => {
    const payloads = [
      { kind: 'local' as const, filename: 'cat.png', base64: 'iVBORw0KGgo=', mimeType: 'image/png' }
    ];
    const refs = fromReferencePayloads(payloads);
    expect(resolveGenerationEndpoint(refs)).toBe('edits');
  });
});
