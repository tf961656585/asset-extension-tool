export const POPUP_SAVE_ENTRY_POINTS = ['context-menu', 'quick-button'] as const;
export const MESSAGE_BUBBLE_AUTO_DISMISS_MS = 4000;

export type PopupSaveEntryPoint = (typeof POPUP_SAVE_ENTRY_POINTS)[number];

export interface NoticeState {
  type: 'success' | 'error' | 'info';
  message: string;
}

export function createInitialNotice(): NoticeState | null {
  return null;
}

export function shouldRenderNotice(notice: NoticeState | null | undefined): notice is NoticeState {
  if (!notice) {
    return false;
  }

  return notice.message.trim().length > 0;
}

export function getAssetsEmptyStateText(): string {
  return '暂无资产。请在网页图片上右键“保存为资产”或使用右下角按钮。';
}
