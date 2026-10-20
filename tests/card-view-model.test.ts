import { describe, expect, it } from 'vitest';

import {
  buildAssetCardViewModel,
  formatRelativeTime,
  shortenText
} from '../src/popup/card-view-model';
import type { AssetRecord } from '../src/shared/model';

describe('card view model', () => {
  it('资产卡片完整信息包含来源 URL、文件夹与标签（detail 承载，hover summary 不含文件夹）', () => {
    const asset: AssetRecord = {
      id: 'asset_1',
      imageUrl: 'https://cdn.site.com/images/a.png',
      sourcePageUrl: 'https://site.com/post/1',
      sourceDomain: 'site.com',
      savedAt: '2026-02-20T01:02:03.000Z',
      downloadId: 1,
      filename: 'Workspace/WYJHExtension/site.com/a.png',
      folderId: 'folder_1',
      tags: ['hero', 'banner']
    };

    const view = buildAssetCardViewModel(asset, '首页灵感');
    // hover summary 仅域名 + 相对时间，文件夹不在 summary
    expect(view.summary.primary).toBe('site.com');
    expect(typeof view.summary.relativeTime).toBe('string');
    expect(view.summary.relativeTime.length).toBeGreaterThan(0);
    expect(view.detail.sourcePageUrl).toBe(asset.sourcePageUrl);
    expect(view.detail.folderName).toBe('首页灵感');
    expect(view.detail.tags).toBe('hero, banner');
  });

  it('摘要文本会在超长时截断', () => {
    const text = 'https://example.com/very/long/path/that/should/be/truncated/by-summary';
    const shortened = shortenText(text, 24);
    expect(shortened).toHaveLength(24);
    expect(shortened).toMatch(/\.\.\.$/);
    expect(shortened.startsWith('https://example.com')).toBe(true);
  });
});

describe('generation badge (v3.0 微标签)', () => {
  it('图生图 → ✨ 生成 · 源 N 张', () => {
    const asset: AssetRecord = {
      id: 'asset_2',
      imageUrl: 'blob:a',
      sourcePageUrl: 'https://www.wyjh.top/',
      sourceDomain: 'ai-generated',
      savedAt: '2026-02-20T01:02:03.000Z',
      downloadId: 2,
      filename: 'WYJHExtension/ai-generated/a.png',
      folderId: 'unassigned',
      tags: [],
      generatedFrom: {
        mode: 'image-to-image',
        sourceRefs: [
          { kind: 'web', imageUrl: 'https://x.com/a.png' },
          { kind: 'asset', assetId: 'asset_1' }
        ],
        prompt: '合并',
        model: 'gpt-image-2',
        size: '1024x1536',
        quality: 'auto',
        n: 1,
        generatedAt: '2026-02-20T01:02:03.000Z'
      }
    };

    const view = buildAssetCardViewModel(asset, '未分类');
    expect(view.summary.generationBadge?.text).toBe('✨ 生成 · 源 2 张');
  });

  it('文生图 → ✨ 文生图', () => {
    const asset: AssetRecord = {
      id: 'asset_3',
      imageUrl: 'blob:b',
      sourcePageUrl: 'https://www.wyjh.top/',
      sourceDomain: 'ai-generated',
      savedAt: '2026-02-20T01:02:03.000Z',
      downloadId: 3,
      filename: 'WYJHExtension/ai-generated/b.png',
      folderId: 'unassigned',
      tags: [],
      generatedFrom: {
        mode: 'text-to-image',
        sourceRefs: [],
        prompt: '一只猫',
        model: 'gpt-image-2',
        size: 'auto',
        quality: 'auto',
        n: 1,
        generatedAt: '2026-02-20T01:02:03.000Z'
      }
    };

    const view = buildAssetCardViewModel(asset, '未分类');
    expect(view.summary.generationBadge?.text).toBe('✨ 文生图');
  });

  it('采集图无 generatedFrom → 无微标签', () => {
    const asset: AssetRecord = {
      id: 'asset_4',
      imageUrl: 'https://cdn.site.com/a.png',
      sourcePageUrl: 'https://site.com/post/1',
      sourceDomain: 'site.com',
      savedAt: '2026-02-20T01:02:03.000Z',
      downloadId: 4,
      filename: 'Workspace/WYJHExtension/site.com/a.png',
      folderId: 'folder_1',
      tags: []
    };

    const view = buildAssetCardViewModel(asset, '首页灵感');
    expect(view.summary.generationBadge).toBeUndefined();
  });
});

describe('formatRelativeTime', () => {
  // 固定 now 基准，使边界可复现。基准取 2026-07-11 04:04:10。
  const now = new Date('2026-07-11T04:04:10.000Z');

  it('< 60 秒 → 刚刚', () => {
    expect(formatRelativeTime('2026-07-11T04:03:50.000Z', now)).toBe('刚刚');
  });

  it('< 1 小时 → X 分钟前', () => {
    expect(formatRelativeTime('2026-07-11T04:02:10.000Z', now)).toBe('2 分钟前');
  });

  it('< 24 小时 → X 小时前', () => {
    expect(formatRelativeTime('2026-07-11T02:04:10.000Z', now)).toBe('2 小时前');
  });

  it('< 7 天 → X 天前', () => {
    expect(formatRelativeTime('2026-07-09T04:04:10.000Z', now)).toBe('2 天前');
  });

  it('≥ 7 天且同年 → MM-DD', () => {
    expect(formatRelativeTime('2026-07-01T04:04:10.000Z', now)).toBe('07-01');
  });

  it('≥ 7 天且跨年 → YYYY-MM-DD', () => {
    expect(formatRelativeTime('2025-06-01T04:04:10.000Z', now)).toBe('2025-06-01');
  });

  it('未来时间（异常）→ 原样返回', () => {
    expect(formatRelativeTime('2026-12-31T00:00:00.000Z', now)).toBe('2026-12-31T00:00:00.000Z');
  });

  it('非法时间戳 → 原样返回', () => {
    expect(formatRelativeTime('not-a-time', now)).toBe('not-a-time');
  });
});
