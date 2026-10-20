import { describe, expect, it } from 'vitest';

import appSource from '../src/popup/App.tsx?raw';

describe('asset grid masonry (v2.0)', () => {
  it('资产网格采用 masonry 容器与卡片，取代固定等高网格', () => {
    // DOM 结构：masonry 容器 + 卡片（break-inside avoid 由 CSS 承载）
    expect(appSource).toContain('className="media-masonry asset-masonry"');
    expect(appSource).toContain('className="media-card masonry-card"');
  });

  it('卡片视觉区使用 masonry-visual（自适应高度），而非 compact-visual 固定高度', () => {
    expect(appSource).toContain('className="media-visual masonry-visual"');
  });

  it('不保留旧版固定等高 grid + compact-card 结构', () => {
    expect(appSource).not.toContain('className="media-grid asset-grid"');
    expect(appSource).not.toContain('className="media-card compact-card"');
    expect(appSource).not.toContain('className="media-visual compact-visual"');
  });
});
