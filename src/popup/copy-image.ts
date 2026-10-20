import type { NoticeState } from './view-contract';

type ClipboardWithWriteText = Pick<Clipboard, 'writeText'> & Partial<Pick<Clipboard, 'write'>>;

type ClipboardItemConstructor = new (items: Record<string, Blob>) => ClipboardItem;

export type CopyImageFallbackReason =
  | 'clipboard-image-write-unavailable'
  | 'clipboard-item-unsupported'
  | 'network-error'
  | 'response-not-image'
  | 'clipboard-image-write-failed';

export type CopyImageResult =
  | {
      mode: 'image';
      mimeType: string;
      convertedFromMimeType?: string;
    }
  | {
      mode: 'url';
      reason: CopyImageFallbackReason;
      detail?: string;
    };

const COPY_IMAGE_FALLBACK_REASON_TEXT: Record<CopyImageFallbackReason, string> = {
  'clipboard-image-write-unavailable': '当前浏览器不支持图片剪贴板写入（clipboard.write 不可用）',
  'clipboard-item-unsupported': '当前浏览器不支持 ClipboardItem',
  'network-error': '下载图片失败（可能是跨域、防盗链、网络异常或资源失效）',
  'response-not-image': '图片地址返回的内容不是图片',
  'clipboard-image-write-failed': '浏览器拒绝写入图片到剪贴板（可能缺少权限）'
};

interface BitmapLike {
  width: number;
  height: number;
  close?: () => void;
}

function getClipboard(): ClipboardWithWriteText | null {
  if (!globalThis.navigator?.clipboard) {
    return null;
  }
  return globalThis.navigator.clipboard as ClipboardWithWriteText;
}

function getErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  return undefined;
}

function withDetail(baseReason: string, detail?: string): string {
  if (!detail) {
    return baseReason;
  }
  return `${baseReason}（${detail}）`;
}

function isUnsupportedImageTypeError(error: unknown): boolean {
  const message = getErrorMessage(error)?.toLowerCase() ?? '';
  return (
    message.includes('not supported on write') ||
    message.includes('type image/') ||
    message.includes('unsupported image')
  );
}

async function writeImageBlobToClipboard(
  blob: Blob,
  clipboard: ClipboardWithWriteText,
  ClipboardItemCtor: ClipboardItemConstructor
): Promise<void> {
  await clipboard.write?.([
    new ClipboardItemCtor({
      [blob.type]: blob
    })
  ]);
}

function assertCanvas2DContext(
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
): asserts context is OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D {
  if (!context) {
    throw new Error('无法创建 2D Canvas 上下文');
  }
}

async function convertBitmapToPngBlob(bitmap: BitmapLike): Promise<Blob> {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    assertCanvas2DContext(context);
    context.drawImage(bitmap as unknown as CanvasImageSource, 0, 0);
    return canvas.convertToBlob({ type: 'image/png' });
  }

  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    assertCanvas2DContext(context);
    context.drawImage(bitmap as unknown as CanvasImageSource, 0, 0);
    const pngBlob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((next) => resolve(next), 'image/png');
    });
    if (!pngBlob) {
      throw new Error('Canvas 导出 PNG 失败');
    }
    return pngBlob;
  }

  throw new Error('当前环境不支持图片转码（OffscreenCanvas/Canvas 不可用）');
}

async function convertImageBlobToPng(blob: Blob): Promise<Blob> {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('当前环境不支持 createImageBitmap，无法转码为 PNG');
  }

  const bitmap = await createImageBitmap(blob);
  try {
    return await convertBitmapToPngBlob(bitmap);
  } finally {
    bitmap.close?.();
  }
}

async function fallbackToUrl(
  imageUrl: string,
  clipboard: ClipboardWithWriteText,
  reason: CopyImageFallbackReason,
  detail?: string
): Promise<CopyImageResult> {
  try {
    await clipboard.writeText(imageUrl);
    return { mode: 'url', reason, detail };
  } catch (fallbackError: unknown) {
    const fallbackDetail = getErrorMessage(fallbackError);
    const reasonText = withDetail(COPY_IMAGE_FALLBACK_REASON_TEXT[reason], detail);
    throw new Error(`${reasonText}；${withDetail('回退复制 URL 也失败', fallbackDetail)}`);
  }
}

export async function copyImageByUrl(imageUrl: string): Promise<CopyImageResult> {
  const clipboard = getClipboard();
  if (!clipboard || typeof clipboard.writeText !== 'function') {
    throw new Error('当前环境不支持剪贴板写入（clipboard.writeText 不可用）');
  }

  if (typeof clipboard.write !== 'function') {
    return fallbackToUrl(imageUrl, clipboard, 'clipboard-image-write-unavailable');
  }

  const ClipboardItemCtor = globalThis.ClipboardItem as ClipboardItemConstructor | undefined;
  if (!ClipboardItemCtor) {
    return fallbackToUrl(imageUrl, clipboard, 'clipboard-item-unsupported');
  }

  let blob: Blob;
  try {
    const response = await fetch(imageUrl);
    blob = await response.blob();
  } catch (error: unknown) {
    return fallbackToUrl(imageUrl, clipboard, 'network-error', getErrorMessage(error));
  }

  return writeBlobAsImage(blob, clipboard, ClipboardItemCtor, imageUrl);
}

/**
 * 直接复制 Blob 到剪贴板（spec FR-21 第 6 条）。
 * 供生成图复制使用——生成图字节在 IndexedDB，不再经 fetch 取 URL，直接对 Blob 走写入链路。
 * 写入失败时回退为复制 URL 文本（生成图传入 fallbackUrl 时）；无 fallbackUrl 则抛错
 * （生成图句柄对用户无意义，不回退写句柄文本，spec FR-21 第 6 条）。
 */
export async function copyImageBlob(blob: Blob, fallbackUrl?: string): Promise<CopyImageResult> {
  const clipboard = getClipboard();
  if (!clipboard || typeof clipboard.writeText !== 'function') {
    throw new Error('当前环境不支持剪贴板写入（clipboard.writeText 不可用）');
  }

  if (typeof clipboard.write !== 'function') {
    if (fallbackUrl) return fallbackToUrl(fallbackUrl, clipboard, 'clipboard-image-write-unavailable');
    throw new Error('当前浏览器不支持图片剪贴板写入（clipboard.write 不可用）');
  }

  const ClipboardItemCtor = globalThis.ClipboardItem as ClipboardItemConstructor | undefined;
  if (!ClipboardItemCtor) {
    if (fallbackUrl) return fallbackToUrl(fallbackUrl, clipboard, 'clipboard-item-unsupported');
    throw new Error('当前浏览器不支持 ClipboardItem');
  }

  return writeBlobAsImage(blob, clipboard, ClipboardItemCtor, fallbackUrl);
}

/**
 * 把已就绪的图片 Blob 写入剪贴板（带 PNG 转码重试），复用既有写入 + 转码链路。
 * fallbackUrl 为空时（生成图无 URL 可回退），写入失败抛错而非回退写文本（spec FR-21 第 6 条）。
 */
async function writeBlobAsImage(
  blob: Blob,
  clipboard: ClipboardWithWriteText,
  ClipboardItemCtor: ClipboardItemConstructor,
  fallbackUrl?: string
): Promise<CopyImageResult> {
  if (!blob.type.startsWith('image/')) {
    if (fallbackUrl) {
      const mimeDetail = blob.type ? `实际类型 ${blob.type}` : '响应缺少 MIME 类型';
      return fallbackToUrl(fallbackUrl, clipboard, 'response-not-image', mimeDetail);
    }
    throw new Error('复制的内容不是图片');
  }

  try {
    await writeImageBlobToClipboard(blob, clipboard, ClipboardItemCtor);
    return { mode: 'image', mimeType: blob.type };
  } catch (error: unknown) {
    if (blob.type !== 'image/png' && isUnsupportedImageTypeError(error)) {
      try {
        const pngBlob = await convertImageBlobToPng(blob);
        await writeImageBlobToClipboard(pngBlob, clipboard, ClipboardItemCtor);
        return { mode: 'image', mimeType: 'image/png', convertedFromMimeType: blob.type };
      } catch (convertError: unknown) {
        if (fallbackUrl) {
          const convertDetail = getErrorMessage(convertError);
          const writeDetail = getErrorMessage(error);
          const detail = [writeDetail, convertDetail].filter(Boolean).join('；');
          return fallbackToUrl(fallbackUrl, clipboard, 'clipboard-image-write-failed', detail);
        }
        throw new Error(`图片转码并写入剪贴板失败：${getErrorMessage(convertError) ?? '未知错误'}`);
      }
    }
    if (fallbackUrl) {
      return fallbackToUrl(fallbackUrl, clipboard, 'clipboard-image-write-failed', getErrorMessage(error));
    }
    throw new Error(`写入图片到剪贴板失败：${getErrorMessage(error) ?? '未知错误'}`);
  }
}

export function describeCopyImageFallback(reason: CopyImageFallbackReason, detail?: string): string {
  return withDetail(COPY_IMAGE_FALLBACK_REASON_TEXT[reason], detail);
}

export function buildCopyImageNotice(result: CopyImageResult): NoticeState {
  if (result.mode === 'image') {
    if (result.convertedFromMimeType && result.convertedFromMimeType !== result.mimeType) {
      return {
        type: 'success',
        message: `图片已复制到剪贴板（已从 ${result.convertedFromMimeType} 自动转为 ${result.mimeType}）。`
      };
    }

    return {
      type: 'success',
      message: `图片已复制到剪贴板（${result.mimeType}）。`
    };
  }

  return {
    type: 'info',
    message: `未成功复制图片内容，已回退为复制 URL。原因：${describeCopyImageFallback(
      result.reason,
      result.detail
    )}。`
  };
}
