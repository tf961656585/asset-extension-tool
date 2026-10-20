import { describe, expect, it } from 'vitest';
import appSource from '../src/popup/App.tsx?raw';

describe('asset filter chips layout (v2.0)', () => {
  it('资产页筛选区采用“搜索栏 + 筛选 chips 行”结构', () => {
    // 搜索栏：网站/域名搜索 + 新建文件夹图标
    expect(appSource).toContain('className="asset-search-bar"');
    expect(appSource).toContain('className="asset-search-input"');
    expect(appSource).toContain('className="asset-search-new-folder"');
    // chips 行：全部 / 文件夹 chip / 标签 chip / 清空全部
    expect(appSource).toContain('className="filter-chips-row"');
    expect(appSource).toContain('filter-chip-all');
    expect(appSource).toContain('filter-chip-all-active');
    expect(appSource).toContain('清空全部');
  });

  it('筛选能力顺序：网站搜索 → 文件夹 chip → 标签 chip', () => {
    const searchIndex = appSource.indexOf('className="asset-search-input"');
    const folderChipIndex = appSource.indexOf('label={folderChipLabel}');
    const tagChipIndex = appSource.indexOf('label={tagChipLabel}');

    expect(searchIndex).toBeGreaterThan(-1);
    expect(folderChipIndex).toBeGreaterThan(searchIndex);
    expect(tagChipIndex).toBeGreaterThan(folderChipIndex);
  });

  it('文件夹与标签 chip 复用 FilterChip 组件，且各自带下拉浮层', () => {
    expect(appSource).toContain('<FilterChip');
    expect(appSource).toContain('<FilterPopover');
    // 文件夹 chip 激活态由 folderFilterActive 驱动，标签 chip 由 tagFilterActive 驱动
    expect(appSource).toContain('active={folderFilterActive}');
    expect(appSource).toContain('active={tagFilterActive}');
  });

  it('不保留旧版双列 toolbar 与新建文件夹行结构', () => {
    expect(appSource).not.toContain('className="asset-filter-panel"');
    expect(appSource).not.toContain('className="toolbar asset-filter-toolbar"');
    expect(appSource).not.toContain('className="folder-creator asset-filter-folder-creator"');
    expect(appSource).not.toContain('className="asset-filter-folder"');
    expect(appSource).not.toContain('className="asset-filter-tag"');
  });

  it('顶栏含「生图」入口按钮（intent-first）', () => {
    expect(appSource).toContain('打开生图侧边栏');
    expect(appSource).toContain('popup-head-gen');
  });
});
