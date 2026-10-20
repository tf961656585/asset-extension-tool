export type PopupView = 'assets' | 'settings' | 'edit' | 'help';

export interface PopupFilterState {
  siteKeyword: string;
  folderFilter: string;
  tagFilter: string;
}

export interface PopupUIState {
  view: PopupView;
  filters: PopupFilterState;
  editingAssetId: string | null;
}

export type PopupUIAction =
  | { type: 'switch-view'; view: PopupView }
  | { type: 'set-site-keyword'; value: string }
  | { type: 'set-folder-filter'; value: string }
  | { type: 'set-tag-filter'; value: string }
  | { type: 'enter-asset-edit'; assetId: string }
  | { type: 'leave-asset-edit' };

export function createInitialPopupUIState(): PopupUIState {
  return {
    view: 'assets',
    filters: {
      siteKeyword: '',
      folderFilter: 'all',
      tagFilter: ''
    },
    editingAssetId: null
  };
}

export function popupUIReducer(state: PopupUIState, action: PopupUIAction): PopupUIState {
  switch (action.type) {
    case 'switch-view':
      // 切换到非编辑视图时，编辑态随之作废；切到 'edit' 必须经 enter-asset-edit（携带 assetId）。
      if (action.view === 'edit') {
        return state;
      }
      return {
        ...state,
        view: action.view,
        editingAssetId: null
      };
    case 'set-site-keyword':
      return {
        ...state,
        filters: {
          ...state.filters,
          siteKeyword: action.value
        }
      };
    case 'set-folder-filter':
      return {
        ...state,
        filters: {
          ...state.filters,
          folderFilter: action.value
        }
      };
    case 'set-tag-filter':
      return {
        ...state,
        filters: {
          ...state.filters,
          tagFilter: action.value
        }
      };
    case 'enter-asset-edit':
      return {
        ...state,
        view: 'edit',
        editingAssetId: action.assetId
      };
    case 'leave-asset-edit':
      return {
        ...state,
        view: 'assets',
        editingAssetId: null
      };
    default:
      return state;
  }
}
