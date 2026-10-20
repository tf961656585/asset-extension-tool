import { describe, expect, it } from 'vitest';

import { collectAllTags, countTags } from '../src/popup/use-all-tags';
import type { AssetRecord } from '../src/shared/model';

function makeAsset(overrides: Partial<AssetRecord> = {}): AssetRecord {
  return {
    id: 'asset_x',
    imageUrl: 'https://example.com/x.png',
    sourcePageUrl: 'https://example.com',
    sourceDomain: 'example.com',
    savedAt: '2026-07-06T00:00:00.000Z',
    downloadId: 1,
    filename: 'example/asset_x.png',
    folderId: 'unassigned',
    tags: [],
    ...overrides
  };
}

describe('collectAllTags', () => {
  it('聚合多个资产的标签并去重', () => {
    const assets = [
      makeAsset({ tags: ['hero', 'banner'] }),
      makeAsset({ tags: ['hero', 'UI'] }),
      makeAsset({ tags: ['logo'] })
    ];

    expect(collectAllTags(assets)).toEqual(['banner', 'hero', 'logo', 'ui']);
  });

  it('大小写与空白归一化后去重', () => {
    const assets = [
      makeAsset({ tags: ['  Hero  ', 'HERO'] }),
      makeAsset({ tags: ['hero'] })
    ];

    expect(collectAllTags(assets)).toEqual(['hero']);
  });

  it('空标签字符串被忽略', () => {
    const assets = [makeAsset({ tags: ['', '   ', 'hero'] })];

    expect(collectAllTags(assets)).toEqual(['hero']);
  });

  it('空资产集合返回空数组', () => {
    expect(collectAllTags([])).toEqual([]);
  });

  it('结果按字母序稳定排序', () => {
    const assets = [makeAsset({ tags: ['zebra', 'apple', 'mango'] })];

    expect(collectAllTags(assets)).toEqual(['apple', 'mango', 'zebra']);
  });
});

describe('countTags', () => {
  it('统计每个标签出现次数（归一化后）', () => {
    const assets = [
      makeAsset({ tags: ['hero', 'banner'] }),
      makeAsset({ tags: ['HERO'] }),
      makeAsset({ tags: ['hero', 'ui'] })
    ];

    expect(countTags(assets).get('hero')).toBe(3);
    expect(countTags(assets).get('banner')).toBe(1);
    expect(countTags(assets).get('ui')).toBe(1);
  });

  it('空标签不计入', () => {
    const assets = [makeAsset({ tags: ['', '  ', 'hero'] })];

    expect(countTags(assets).get('hero')).toBe(1);
    expect(countTags(assets).has('')).toBe(false);
  });
});
