import { describe, expect, it } from 'vitest';
import appSource from '../src/popup/App.tsx?raw';

describe('asset card layout', () => {
  it('资产卡片默认仅图像，通过 hover/focus 展示浮层式叠加信息（scrim + 右上角浮按钮）', () => {
    expect(appSource).toContain('className="media-hover-scrim"');
    expect(appSource).toContain('className="media-hover-actions"');
    expect(appSource).toContain('tabIndex={0}');
    // 旧实底白板口径已废弃
    expect(appSource).not.toContain('className="media-hover-panel"');
    expect(appSource).not.toContain('className="media-summary');
  });

  it('hover scrim 只含单行摘要（域名·相对时间），操作浮右上角，编辑走整页视图（非 overlay 抽屉）', () => {
    expect(appSource).toContain('media-hover-text');
    expect(appSource).toContain('card.summary.primary');
    expect(appSource).toContain('card.summary.relativeTime');
    // 三段式旧摘要（secondary/tertiary/文件夹）已移出 hover
    expect(appSource).not.toContain('card.summary.secondary');
    expect(appSource).not.toContain('card.summary.tertiary');
    expect(appSource).not.toContain('className="card-editor"');
    expect(appSource).toContain('定位文件');
    expect(appSource).toContain('复制图像');
    expect(appSource).toContain('编辑分类');
    expect(appSource).toContain('AI 生成');
    expect(appSource).toContain('<SparkleIcon');
    expect(appSource).not.toContain('asset-editor-backdrop');
    expect(appSource).not.toContain('asset-editor-drawer');
    expect(appSource).not.toContain('aria-modal="true"');
    expect(appSource).toContain('asset-edit-view');
    expect(appSource).toContain('你有未保存的修改，确定要放弃吗？');
  });

  it('生成图摘要行按 generatedFrom 条件渲染微标签', () => {
    // 摘要行在卡片 hover text 内按 generatedFrom 渲染微标签（图生图/文生图/采集图无）。
    expect(appSource).toContain('card.summary.generationBadge');
    expect(appSource).toContain('summary-gen-badge');
    expect(appSource).toContain('openSidePanel()');
  });
});
