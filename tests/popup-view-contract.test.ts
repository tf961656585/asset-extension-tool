import { describe, expect, it } from 'vitest';

import {
  MESSAGE_BUBBLE_AUTO_DISMISS_MS,
  POPUP_SAVE_ENTRY_POINTS,
  createInitialNotice,
  getAssetsEmptyStateText,
  shouldRenderNotice
} from '../src/popup/view-contract';

describe('popup view contract', () => {
  it('首屏默认不展示准备就绪提示', () => {
    expect(createInitialNotice()).toBeNull();
  });

  it('保存入口仅保留右键菜单与右下角按钮', () => {
    expect(POPUP_SAVE_ENTRY_POINTS).toEqual(['context-menu', 'quick-button']);
  });

  it('空状态文案应指向右键与右下角按钮', () => {
    expect(getAssetsEmptyStateText()).toBe(
      '暂无资产。请在网页图片上右键“保存为资产”或使用右下角按钮。'
    );
  });

  it('notice 渲染规则只允许非空文案显示', () => {
    expect(shouldRenderNotice(null)).toBe(false);
    expect(shouldRenderNotice(undefined)).toBe(false);
    expect(shouldRenderNotice({ type: 'info', message: '   ' })).toBe(false);
    expect(shouldRenderNotice({ type: 'success', message: '保存成功' })).toBe(true);
  });

  it('消息气泡默认自动消失时长为 4000ms', () => {
    expect(MESSAGE_BUBBLE_AUTO_DISMISS_MS).toBe(4000);
  });
});
