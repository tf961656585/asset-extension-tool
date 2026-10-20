import { describe, expect, it } from 'vitest';

import type { AssetRecord } from '../src/shared/model';
import { resolveAssetImageKind } from '../src/shared/use-asset-image-src';

/**
 * 资产图片来源分流纯函数测试。
 * 唯一分流判据：imageUrl 是否 data: 前缀 / 资产是否带 generatedFrom。
 * hook 的生命周期（createObjectURL/revokeObjectURL）由类型保证，不在此单测。
 */

function makeAsset(
  overrides: Partial<Pick<AssetRecord, 'imageUrl' | 'generatedFrom'>>
): Pick<AssetRecord, 'id' | 'imageUrl' | 'generatedFrom'> {
  return {
    id: 'asset_x',
    imageUrl: 'https://example.com/a.png',
    ...overrides
  };
}

describe('resolveAssetImageKind 资产图片来源分流', () => {
  it('采集图（无 generatedFrom）→ direct', () => {
    expect(resolveAssetImageKind(makeAsset({ generatedFrom: undefined }))).toBe('direct');
  });

  it('生成图（有 generatedFrom、imageUrl 为句柄）→ indexed-db', () => {
    expect(
      resolveAssetImageKind(
        makeAsset({
          imageUrl: 'asset_gen_1',
          generatedFrom: {
            mode: 'image-to-image',
            sourceRefs: [],
            prompt: 'test',
            model: 'gpt-image-2',
            size: '1024x1024',
            quality: 'auto',
            n: 1,
            generatedAt: '2026-07-14T00:00:00.000Z'
          }
        })
      )
    ).toBe('indexed-db');
  });

  it('存量 data: URL 生成图 → direct（兼容态，不走 IDB）', () => {
    expect(
      resolveAssetImageKind(
        makeAsset({
          imageUrl: 'data:image/png;base64,iVBORw0KGgo=',
          generatedFrom: {
            mode: 'text-to-image',
            sourceRefs: [],
            prompt: 't',
            model: 'gpt-image-2',
            size: '1024x1024',
            quality: 'auto',
            n: 1,
            generatedAt: '2026-07-14T00:00:00.000Z'
          }
        })
      )
    ).toBe('direct');
  });

  it('文生图生成图（有 generatedFrom mode=text-to-image、句柄）→ indexed-db', () => {
    expect(
      resolveAssetImageKind(
        makeAsset({
          imageUrl: 'asset_t2i_1',
          generatedFrom: {
            mode: 'text-to-image',
            sourceRefs: [],
            prompt: '文生图',
            model: 'gpt-image-2',
            size: '1024x1024',
            quality: 'auto',
            n: 1,
            generatedAt: '2026-07-14T00:00:00.000Z'
          }
        })
      )
    ).toBe('indexed-db');
  });
});
