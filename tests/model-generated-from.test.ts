import { describe, expect, it } from 'vitest';

import {
  createGeneratedAssetRecord,
  GeneratedFrom,
  upsertAsset,
  createDefaultData,
  createAssetRecord
} from '../src/shared/model';

function makeLineage(overrides: Partial<GeneratedFrom> = {}): GeneratedFrom {
  return {
    mode: 'image-to-image',
    sourceRefs: [{ kind: 'web', imageUrl: 'https://x.com/a.png' }],
    prompt: '合并两张图',
    model: 'gpt-image-2',
    modelName: 'GPT Image 2',
    provider: 'openai-image',
    connectionName: '我的服务',
    baseUrlHost: 'api.example.com',
    size: '1024x1536',
    quality: 'auto',
    n: 1,
    generatedAt: '2026-07-13T00:00:00.000Z',
    ...overrides
  };
}

describe('createGeneratedAssetRecord 血缘', () => {
  it('文生图：sourceRefs 为空', () => {
    const record = createGeneratedAssetRecord({
      imageUrl: 'blob:a',
      sourcePageUrl: 'https://wyjh.top',
      downloadId: 100,
      filename: 'gen.png',
      generatedFrom: makeLineage({ mode: 'text-to-image', sourceRefs: [] })
    });

    expect(record.generatedFrom?.mode).toBe('text-to-image');
    expect(record.generatedFrom?.sourceRefs).toEqual([]);
  });

  it('图生图：携带源参考图与全部参数', () => {
    const lineage = makeLineage();
    const record = createGeneratedAssetRecord({
      imageUrl: 'blob:b',
      sourcePageUrl: 'https://wyjh.top',
      downloadId: 101,
      filename: 'gen2.png',
      generatedFrom: lineage
    });

    expect(record.generatedFrom).toEqual(lineage);
    expect(record.generatedFrom?.sourceRefs).toHaveLength(1);
  });

  it('v3.9：model 为远端型号，modelName / provider / connectionName / baseUrlHost 为追溯快照', () => {
    const record = createGeneratedAssetRecord({
      imageUrl: 'blob:lineage',
      sourcePageUrl: '',
      downloadId: 104,
      filename: 'gen-lineage.png',
      generatedFrom: makeLineage({
        model: 'gemini-3.1-flash-image',
        modelName: 'Gemini Image',
        provider: 'google-image',
        connectionName: 'Gemini 服务',
        baseUrlHost: 'generativelanguage.googleapis.com'
      })
    });

    expect(record.generatedFrom?.model).toBe('gemini-3.1-flash-image');
    expect(record.generatedFrom?.modelName).toBe('Gemini Image');
    expect(record.generatedFrom?.provider).toBe('google-image');
    expect(record.generatedFrom?.connectionName).toBe('Gemini 服务');
    expect(record.generatedFrom?.baseUrlHost).toBe('generativelanguage.googleapis.com');
    // 生成图来源页可留空，sourceDomain 兜底为伪域名
    expect(record.sourcePageUrl).toBe('');
    expect(record.sourceDomain).toBe('ai-generated');
  });

  it('旧资产缺少 v3.9 快照字段时读取不报错（可选字段）', () => {
    const legacy: GeneratedFrom = {
      mode: 'text-to-image',
      sourceRefs: [],
      prompt: '旧资产',
      model: 'gpt-image-2',
      size: 'auto',
      quality: 'auto',
      n: 1,
      generatedAt: '2026-07-13T00:00:00.000Z'
    };
    const record = createGeneratedAssetRecord({
      imageUrl: 'blob:legacy',
      sourcePageUrl: 'https://wyjh.top',
      downloadId: 105,
      filename: 'legacy.png',
      generatedFrom: legacy
    });
    expect(record.generatedFrom?.modelName).toBeUndefined();
    expect(record.generatedFrom?.connectionName).toBeUndefined();
    expect(record.generatedFrom?.baseUrlHost).toBeUndefined();
    expect(record.generatedFrom?.provider).toBeUndefined();
  });

  it('sourceDomain 默认为伪域名 ai-generated', () => {
    const record = createGeneratedAssetRecord({
      imageUrl: 'blob:c',
      sourcePageUrl: 'https://wyjh.top',
      downloadId: 102,
      filename: 'gen3.png',
      generatedFrom: makeLineage()
    });
    expect(record.sourceDomain).toBe('ai-generated');
  });

  it('folderId 默认未分类、tags 为空', () => {
    const record = createGeneratedAssetRecord({
      imageUrl: 'blob:d',
      sourcePageUrl: 'https://wyjh.top',
      downloadId: 103,
      filename: 'gen4.png',
      generatedFrom: makeLineage()
    });
    expect(record.folderId).toBe('unassigned');
    expect(record.tags).toEqual([]);
  });
});

describe('存量资产兼容（无 generatedFrom）', () => {
  it('批量 upsert 含生成图与采集图，链路上不报错', () => {
    let data = createDefaultData();

    data = upsertAsset(
      data,
      createAssetRecord({
        imageUrl: 'https://cdn.com/a.png',
        sourcePageUrl: 'https://site.com/p',
        downloadId: 1,
        filename: 'a.png'
      })
    );

    data = upsertAsset(
      data,
      createGeneratedAssetRecord({
        imageUrl: 'blob:e',
        sourcePageUrl: 'https://wyjh.top',
        downloadId: 2,
        filename: 'b.png',
        generatedFrom: makeLineage()
      })
    );

    expect(data.assets).toHaveLength(2);
    const collected = data.assets.find((a) => a.downloadId === 1);
    const generated = data.assets.find((a) => a.downloadId === 2);
    expect(collected?.generatedFrom).toBeUndefined();
    expect(generated?.generatedFrom?.mode).toBe('image-to-image');
  });

  it('采集资产无 generatedFrom 字段时读取不报错', () => {
    const record = createAssetRecord({
      imageUrl: 'https://cdn.com/a.png',
      sourcePageUrl: 'https://site.com/p',
      downloadId: 3,
      filename: 'a.png'
    });
    expect('generatedFrom' in record).toBe(false);
  });
});
