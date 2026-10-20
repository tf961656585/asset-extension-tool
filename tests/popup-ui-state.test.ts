import { describe, expect, it } from 'vitest';

import { createInitialPopupUIState, popupUIReducer } from '../src/popup/ui-state';

describe('popup ui state', () => {
  it('默认视图为资产管理页', () => {
    const initial = createInitialPopupUIState();
    expect(initial.view).toBe('assets');
    expect(initial.editingAssetId).toBeNull();
  });

  it('切换设置页后返回，筛选状态保持不变', () => {
    let state = createInitialPopupUIState();
    state = popupUIReducer(state, { type: 'set-site-keyword', value: 'dribbble' });
    state = popupUIReducer(state, { type: 'set-folder-filter', value: 'folder_001' });
    state = popupUIReducer(state, { type: 'set-tag-filter', value: 'hero,banner' });

    const switched = popupUIReducer(state, { type: 'switch-view', view: 'settings' });
    expect(switched.view).toBe('settings');
    expect(switched.filters.siteKeyword).toBe('dribbble');
    expect(switched.filters.folderFilter).toBe('folder_001');
    expect(switched.filters.tagFilter).toBe('hero,banner');

    const back = popupUIReducer(switched, { type: 'switch-view', view: 'assets' });
    expect(back.view).toBe('assets');
    expect(back.filters).toEqual(switched.filters);
  });

  it('进入整页编辑视图后 editingAssetId 标识当前资产', () => {
    let state = createInitialPopupUIState();
    state = popupUIReducer(state, { type: 'enter-asset-edit', assetId: 'asset_1' });
    expect(state.view).toBe('edit');
    expect(state.editingAssetId).toBe('asset_1');

    state = popupUIReducer(state, { type: 'enter-asset-edit', assetId: 'asset_2' });
    expect(state.view).toBe('edit');
    expect(state.editingAssetId).toBe('asset_2');

    state = popupUIReducer(state, { type: 'leave-asset-edit' });
    expect(state.view).toBe('assets');
    expect(state.editingAssetId).toBeNull();
  });

  it('从编辑视图切换到设置页时自动退出编辑并保持筛选状态', () => {
    let state = createInitialPopupUIState();
    state = popupUIReducer(state, { type: 'set-site-keyword', value: 'behance' });
    state = popupUIReducer(state, { type: 'enter-asset-edit', assetId: 'asset_1' });
    expect(state.view).toBe('edit');
    expect(state.editingAssetId).toBe('asset_1');

    state = popupUIReducer(state, { type: 'switch-view', view: 'settings' });
    expect(state.view).toBe('settings');
    expect(state.editingAssetId).toBeNull();
    expect(state.filters.siteKeyword).toBe('behance');
  });

  it('切换到使用帮助视图后清空编辑态并保持筛选状态', () => {
    let state = createInitialPopupUIState();
    state = popupUIReducer(state, { type: 'set-site-keyword', value: 'dribbble' });
    state = popupUIReducer(state, { type: 'enter-asset-edit', assetId: 'asset_1' });

    const switched = popupUIReducer(state, { type: 'switch-view', view: 'help' });
    expect(switched.view).toBe('help');
    expect(switched.editingAssetId).toBeNull();
    expect(switched.filters.siteKeyword).toBe('dribbble');

    const back = popupUIReducer(switched, { type: 'switch-view', view: 'assets' });
    expect(back.view).toBe('assets');
    expect(back.filters).toEqual(switched.filters);
  });
});
