import { MESSAGE_TYPES, type RuntimeMessage, type SaveImageResponse } from '../shared/messages';
import { createSavePayload } from '../shared/save';
import { createTaskId } from '../shared/generation';
import { getImageUrl, isSavableImage, resolveImageTargetFromProbe } from './quick-save-policy';

const BUTTON_GROUP_ID = 'wyjh-quick-button-group';
const SAVE_BUTTON_ID = 'wyjh-quick-save-button';
const GENERATE_BUTTON_ID = 'wyjh-quick-generate-button';
const TOOLTIP_ID = 'wyjh-quick-tooltip';
const TOAST_ID = 'wyjh-quick-toast';
const STYLE_ID = 'wyjh-quick-style';

// 角标形态契约：36px 圆形纯图标徽章，半透明轻量视觉。
// 文字提示走 hover tooltip，避免遮盖图像主体（与 Pinterest / Fatkun 等竞品主流量一致）。
// 角标为按钮组：保存 + AI 生成并列，两按钮共享同一套显示契约（不引入第二套规则）。
const BADGE_SIZE = 36;
const BADGE_GAP = 6;
const GROUP_MARGIN = 6;
const SHOW_DELAY_MS = 120;
const HIDE_DELAY_MS = 160;

const DOWNLOAD_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>';

const CHECK_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

const SPARKLE_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.6 4.8L18 8.4l-4.4 1.6L12 15l-1.6-5L6 8.4l4.4-1.6zM18 14l.9 2.6L21 17.5l-2.1.9L18 21l-.9-2.6L15 17.5l2.1-.9z"/></svg>';

declare global {
  interface Window {
    __wyjhQuickSaveInitialized__?: boolean;
  }
}

type ToastType = 'success' | 'error' | 'info';

function asHtmlImageElement(node: unknown): HTMLImageElement | null {
  if (!(node instanceof Element)) {
    return null;
  }
  return node.tagName.toLowerCase() === 'img' ? (node as HTMLImageElement) : null;
}

function createToast(): HTMLDivElement {
  const toast = document.createElement('div');
  toast.id = TOAST_ID;
  toast.className = 'wyjh-toast wyjh-toast-hidden';
  toast.setAttribute('role', 'status');
  document.documentElement.append(toast);
  return toast;
}

function showToast(toast: HTMLDivElement, message: string, type: ToastType): void {
  toast.textContent = message;
  toast.className = `wyjh-toast wyjh-toast-${type}`;
  window.setTimeout(() => {
    toast.className = 'wyjh-toast wyjh-toast-hidden';
  }, 1800);
}

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${BUTTON_GROUP_ID} {
      position: fixed;
      z-index: 2147483646;
      display: none;
      gap: ${BADGE_GAP}px;
      align-items: center;
    }

    #${SAVE_BUTTON_ID},
    #${GENERATE_BUTTON_ID} {
      width: ${BADGE_SIZE}px;
      height: ${BADGE_SIZE}px;
      border: none;
      border-radius: 999px;
      padding: 0;
      background: rgba(15, 23, 42, 0.72);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      color: #ffffff;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 12px rgba(15, 23, 42, 0.32);
      cursor: pointer;
      transition: background 0.12s ease, transform 0.12s ease, opacity 0.12s ease;
      opacity: 1;
    }

    #${SAVE_BUTTON_ID} svg,
    #${GENERATE_BUTTON_ID} svg {
      width: 18px;
      height: 18px;
    }

    #${SAVE_BUTTON_ID}:not(:disabled):hover,
    #${GENERATE_BUTTON_ID}:not(:disabled):hover {
      background: rgba(15, 23, 42, 0.92);
      transform: scale(1.06);
    }

    #${SAVE_BUTTON_ID}:disabled,
    #${GENERATE_BUTTON_ID}:disabled {
      cursor: progress;
      opacity: 0.85;
    }

    #${SAVE_BUTTON_ID}.wyjh-state-success {
      background: rgba(16, 125, 83, 0.92);
    }

    #${SAVE_BUTTON_ID}.wyjh-state-error {
      background: rgba(185, 53, 53, 0.92);
    }

    #${TOOLTIP_ID} {
      position: fixed;
      z-index: 2147483646;
      max-width: 200px;
      padding: 4px 8px;
      border-radius: 6px;
      background: rgba(15, 23, 42, 0.92);
      color: #ffffff;
      font-size: 12px;
      line-height: 1.4;
      pointer-events: none;
      opacity: 0;
      transform: translateY(2px);
      transition: opacity 0.12s ease, transform 0.12s ease;
      white-space: nowrap;
    }

    #${TOOLTIP_ID}.wyjh-tooltip-visible {
      opacity: 1;
      transform: translateY(0);
    }

    .wyjh-toast {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483647;
      min-width: 180px;
      max-width: 320px;
      border-radius: 10px;
      padding: 8px 10px;
      color: #ffffff;
      font-size: 12px;
      line-height: 1.4;
      box-shadow: 0 8px 20px rgba(20, 33, 61, 0.22);
      transition: opacity 0.15s ease, transform 0.15s ease;
    }

    .wyjh-toast-success {
      background: rgba(16, 125, 83, 0.95);
      opacity: 1;
      transform: translateY(0);
    }

    .wyjh-toast-error {
      background: rgba(185, 53, 53, 0.95);
      opacity: 1;
      transform: translateY(0);
    }

    .wyjh-toast-info {
      background: rgba(40, 95, 168, 0.95);
      opacity: 1;
      transform: translateY(0);
    }

    .wyjh-toast-hidden {
      opacity: 0;
      transform: translateY(8px);
      pointer-events: none;
    }
  `;

  document.documentElement.append(style);
}

function initQuickButtonGroup(toast: HTMLDivElement): void {
  const group = document.createElement('div');
  group.id = BUTTON_GROUP_ID;
  document.documentElement.append(group);

  const saveButton = document.createElement('button');
  saveButton.id = SAVE_BUTTON_ID;
  saveButton.type = 'button';
  saveButton.setAttribute('aria-label', '保存为资产');
  saveButton.innerHTML = DOWNLOAD_ICON_SVG;

  const generateButton = document.createElement('button');
  generateButton.id = GENERATE_BUTTON_ID;
  generateButton.type = 'button';
  generateButton.setAttribute('aria-label', '用这张图 AI 生成');
  generateButton.innerHTML = SPARKLE_ICON_SVG;

  group.append(saveButton, generateButton);

  const tooltip = document.createElement('div');
  tooltip.id = TOOLTIP_ID;
  document.documentElement.append(tooltip);

  // 共享显示契约：activeImage / saving / show-hide 时序在容器层统一管理，
  // 两按钮同步显隐，不可保存图片时整个按钮组隐藏（不残留单按钮）。
  let activeImage: HTMLImageElement | null = null;
  let saving = false;
  let hideTimer: number | null = null;
  let showTimer: number | null = null;

  function clearHideTimer(): void {
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function clearShowTimer(): void {
    if (showTimer !== null) {
      window.clearTimeout(showTimer);
      showTimer = null;
    }
  }

  function resetSaveButtonVisualState(): void {
    saveButton.innerHTML = DOWNLOAD_ICON_SVG;
    saveButton.classList.remove('wyjh-state-success', 'wyjh-state-error');
  }

  function setTooltipText(text: string): void {
    tooltip.textContent = text;
  }

  function setTooltipVisible(visible: boolean): void {
    if (visible) {
      tooltip.classList.add('wyjh-tooltip-visible');
    } else {
      tooltip.classList.remove('wyjh-tooltip-visible');
    }
  }

  function placeTooltip(): void {
    const groupLeft = parseFloat(group.style.left) || 0;
    const groupTop = parseFloat(group.style.top) || 0;
    const tooltipWidth = tooltip.offsetWidth || 80;
    const tooltipHeight = tooltip.offsetHeight || 24;
    const tooltipLeft = groupLeft + (BADGE_SIZE + BADGE_GAP) / 2 - tooltipWidth / 2;
    const tooltipTop = groupTop - tooltipHeight - 8;
    tooltip.style.left = `${Math.round(tooltipLeft)}px`;
    tooltip.style.top = `${Math.round(Math.max(tooltipTop, 4))}px`;
  }

  function updateGroupPosition(): void {
    if (!activeImage) {
      return;
    }

    const rect = activeImage.getBoundingClientRect();
    const isOutOfView =
      rect.width === 0 ||
      rect.height === 0 ||
      rect.bottom < 0 ||
      rect.top > window.innerHeight;
    if (isOutOfView) {
      if (!saving) {
        group.style.display = 'none';
        setTooltipVisible(false);
      }
      return;
    }

    const groupWidth = BADGE_SIZE * 2 + BADGE_GAP;
    const nextLeft = Math.min(
      Math.max(rect.left + rect.width - groupWidth - GROUP_MARGIN, GROUP_MARGIN),
      window.innerWidth - groupWidth - GROUP_MARGIN
    );
    const nextTop = Math.min(
      Math.max(rect.top + rect.height - BADGE_SIZE - GROUP_MARGIN, GROUP_MARGIN),
      window.innerHeight - BADGE_SIZE - GROUP_MARGIN
    );

    group.style.left = `${Math.round(nextLeft)}px`;
    group.style.top = `${Math.round(nextTop)}px`;
    group.style.display = 'flex';
    placeTooltip();
  }

  function hideGroup(): void {
    if (saving) {
      return;
    }
    activeImage = null;
    group.style.display = 'none';
    setTooltipVisible(false);
  }

  function scheduleHideGroup(): void {
    clearHideTimer();
    hideTimer = window.setTimeout(() => hideGroup(), HIDE_DELAY_MS);
  }

  function setActiveImage(nextImage: HTMLImageElement): void {
    if (!isSavableImage(nextImage)) {
      scheduleHideGroup();
      return;
    }

    activeImage = nextImage;
    clearHideTimer();
    // 延迟显示：避免快速划过时徽章闪烁（竞品 Image Hover Save 主流量做法）。
    clearShowTimer();
    showTimer = window.setTimeout(() => {
      if (activeImage === nextImage) {
        updateGroupPosition();
      }
    }, SHOW_DELAY_MS);
  }

  async function saveActiveImage(): Promise<void> {
    if (!activeImage || saving) {
      return;
    }

    const imageUrl = getImageUrl(activeImage);
    if (!imageUrl) {
      showToast(toast, '当前图像地址不可用，无法保存。', 'error');
      return;
    }

    saving = true;
    saveButton.disabled = true;
    saveButton.classList.remove('wyjh-state-success', 'wyjh-state-error');
    saveButton.innerHTML = DOWNLOAD_ICON_SVG;
    setTooltipText('保存中…');
    setTooltipVisible(true);

    try {
      const response = (await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.SAVE_IMAGE,
        payload: createSavePayload(imageUrl, window.location.href)
      })) as SaveImageResponse;

      if (!response?.ok) {
        throw new Error(response?.error || '保存失败');
      }

      saveButton.classList.add('wyjh-state-success');
      saveButton.innerHTML = CHECK_ICON_SVG;
      setTooltipText('已保存到资产库');
      showToast(toast, '图片已保存到资产库。', 'success');
    } catch (error: unknown) {
      saveButton.classList.add('wyjh-state-error');
      saveButton.innerHTML = DOWNLOAD_ICON_SVG;
      setTooltipText(error instanceof Error ? error.message : '保存失败');
      showToast(toast, error instanceof Error ? error.message : '保存失败', 'error');
    } finally {
      window.setTimeout(() => {
        saving = false;
        saveButton.disabled = false;
        resetSaveButtonVisualState();
        setTooltipText('保存为资产');
        if (activeImage) {
          updateGroupPosition();
        } else {
          group.style.display = 'none';
          setTooltipVisible(false);
        }
      }, 1200);
    }
  }

  async function generateActiveImage(): Promise<void> {
    if (!activeImage) {
      return;
    }

    const imageUrl = getImageUrl(activeImage);
    if (!imageUrl) {
      showToast(toast, '当前图像地址不可用，无法生成。', 'error');
      return;
    }

    // AI 生成为长任务，点击只负责「创建新任务 + 打开侧边栏」，不等待结果。
    try {
      const taskId = createTaskId();
      await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.GENERATION_CREATE_TASK,
        payload: {
          taskId,
          mode: 'reference-first',
          references: [{ kind: 'web', imageUrl }]
        }
      });
      showToast(toast, '已创建生图任务，请在侧边栏查看。', 'info');
    } catch {
      showToast(toast, '创建生图任务失败。', 'error');
    }
  }

  // tooltip 默认文案，保存中/已保存/失败时由 saveActiveImage 临时改写后回归。
  setTooltipText('保存为资产');

  document.addEventListener(
    'mouseover',
    (event) => {
      const target = event.target as Element | null;
      if (!target) {
        scheduleHideGroup();
        return;
      }

      if (target === group || group.contains(target)) {
        clearHideTimer();
        return;
      }

      const image = asHtmlImageElement(resolveImageTargetFromProbe(event));
      if (image) {
        setActiveImage(image);
        return;
      }

      scheduleHideGroup();
    },
    true
  );

  saveButton.addEventListener('mouseenter', () => {
    clearHideTimer();
    if (!saving) {
      setTooltipText('保存为资产');
    }
    setTooltipVisible(true);
    placeTooltip();
  });
  saveButton.addEventListener('mouseleave', () => {
    setTooltipVisible(false);
    scheduleHideGroup();
  });
  saveButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void saveActiveImage();
  });

  generateButton.addEventListener('mouseenter', () => {
    clearHideTimer();
    setTooltipText('用这张图 AI 生成');
    setTooltipVisible(true);
    placeTooltip();
  });
  generateButton.addEventListener('mouseleave', () => {
    setTooltipVisible(false);
    scheduleHideGroup();
  });
  generateButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void generateActiveImage();
  });

  window.addEventListener('scroll', () => updateGroupPosition(), true);
  window.addEventListener('resize', () => updateGroupPosition());
}

function initializeContentOverlay(): HTMLDivElement {
  ensureStyles();
  const toast = createToast();
  initQuickButtonGroup(toast);
  return toast;
}

const toast = window.__wyjhQuickSaveInitialized__
  ? (document.getElementById(TOAST_ID) as HTMLDivElement | null)
  : initializeContentOverlay();
if (!window.__wyjhQuickSaveInitialized__) {
  window.__wyjhQuickSaveInitialized__ = true;
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage) => {
  if (message.type === MESSAGE_TYPES.SAVE_FEEDBACK && toast) {
    showToast(toast, message.payload.message, message.payload.ok ? 'success' : 'error');
  }

  return false;
});
