import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { copyImageByUrl } from '../src/popup/copy-image';

const IMAGE_URL = 'https://cdn.site.com/hero.png';

class FakeClipboardItem {
  public readonly items: Record<string, Blob>;

  constructor(items: Record<string, Blob>) {
    this.items = items;
  }
}

class FakeOffscreenCanvas {
  public readonly width: number;
  public readonly height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  getContext(_contextId: string): { drawImage: () => void } {
    void _contextId;
    return {
      drawImage: () => undefined
    };
  }

  async convertToBlob(_options: { type: string }): Promise<Blob> {
    void _options;
    return new Blob(['png-binary'], { type: 'image/png' });
  }
}

function mockNavigatorClipboard(clipboard: Partial<Clipboard>): void {
  vi.stubGlobal('navigator', { clipboard } as unknown as Navigator);
}

function mockFetchWithBlob(blob: Blob): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    blob: async () => blob
  }));
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function readClipboardMimeType(writeCall: unknown): string {
  const clipboardItems = writeCall as FakeClipboardItem[];
  return Object.keys(clipboardItems[0].items)[0];
}

describe('copy image by url', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('支持复制图片二进制到剪贴板', async () => {
    const write = vi.fn(async () => undefined);
    const writeText = vi.fn(async () => undefined);
    mockNavigatorClipboard({ write, writeText });
    vi.stubGlobal('ClipboardItem', FakeClipboardItem as unknown as typeof ClipboardItem);

    const fetchMock = mockFetchWithBlob(new Blob(['image-binary'], { type: 'image/png' }));

    const result = await copyImageByUrl(IMAGE_URL);

    expect(result).toEqual({
      mode: 'image',
      mimeType: 'image/png'
    });
    expect(fetchMock).toHaveBeenCalledWith(IMAGE_URL);
    expect(write).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();

    const writeCalls = write.mock.calls as unknown[][];
    expect(readClipboardMimeType(writeCalls[0][0])).toBe('image/png');
  });

  it('当 clipboard.write 不可用时回退为复制 URL', async () => {
    const writeText = vi.fn(async () => undefined);
    mockNavigatorClipboard({ writeText });
    vi.stubGlobal('ClipboardItem', FakeClipboardItem as unknown as typeof ClipboardItem);
    const fetchMock = vi.fn(async () => ({}));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const result = await copyImageByUrl(IMAGE_URL);

    expect(result).toEqual({
      mode: 'url',
      reason: 'clipboard-image-write-unavailable'
    });
    expect(writeText).toHaveBeenCalledWith(IMAGE_URL);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('当 ClipboardItem 不可用时回退为复制 URL', async () => {
    const write = vi.fn(async () => undefined);
    const writeText = vi.fn(async () => undefined);
    mockNavigatorClipboard({ write, writeText });
    vi.stubGlobal('ClipboardItem', undefined as unknown as typeof ClipboardItem);
    const fetchMock = vi.fn(async () => ({}));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const result = await copyImageByUrl(IMAGE_URL);

    expect(result).toEqual({
      mode: 'url',
      reason: 'clipboard-item-unsupported'
    });
    expect(write).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith(IMAGE_URL);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('当 fetch 失败时回退为复制 URL 并带上错误细节', async () => {
    const write = vi.fn(async () => undefined);
    const writeText = vi.fn(async () => undefined);
    mockNavigatorClipboard({ write, writeText });
    vi.stubGlobal('ClipboardItem', FakeClipboardItem as unknown as typeof ClipboardItem);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Failed to fetch');
      }) as unknown as typeof fetch
    );

    const result = await copyImageByUrl(IMAGE_URL);

    expect(result).toEqual({
      mode: 'url',
      reason: 'network-error',
      detail: 'Failed to fetch'
    });
    expect(write).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith(IMAGE_URL);
  });

  it('当响应 MIME 非图片类型时回退为复制 URL', async () => {
    const write = vi.fn(async () => undefined);
    const writeText = vi.fn(async () => undefined);
    mockNavigatorClipboard({ write, writeText });
    vi.stubGlobal('ClipboardItem', FakeClipboardItem as unknown as typeof ClipboardItem);
    mockFetchWithBlob(new Blob(['text-response'], { type: 'text/html' }));

    const result = await copyImageByUrl(IMAGE_URL);

    expect(result).toEqual({
      mode: 'url',
      reason: 'response-not-image',
      detail: '实际类型 text/html'
    });
    expect(write).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith(IMAGE_URL);
  });

  it('当浏览器拒绝写入图片剪贴板时回退为复制 URL', async () => {
    const write = vi.fn(async () => {
      throw new Error('NotAllowedError');
    });
    const writeText = vi.fn(async () => undefined);
    mockNavigatorClipboard({ write, writeText });
    vi.stubGlobal('ClipboardItem', FakeClipboardItem as unknown as typeof ClipboardItem);
    mockFetchWithBlob(new Blob(['image-binary'], { type: 'image/webp' }));

    const result = await copyImageByUrl(IMAGE_URL);

    expect(result).toEqual({
      mode: 'url',
      reason: 'clipboard-image-write-failed',
      detail: 'NotAllowedError'
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(IMAGE_URL);
  });

  it('当 JPEG 写入不支持时会自动转码为 PNG 并重试复制', async () => {
    const write = vi.fn(async (items: unknown) => {
      if (readClipboardMimeType(items) === 'image/jpeg') {
        throw new Error("Failed to execute 'write' on 'Clipboard': Type image/jpeg not supported on write.");
      }
    });
    const writeText = vi.fn(async () => undefined);
    mockNavigatorClipboard({ write, writeText });
    vi.stubGlobal('ClipboardItem', FakeClipboardItem as unknown as typeof ClipboardItem);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 320, height: 180, close: () => undefined })));
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas as unknown as typeof OffscreenCanvas);
    mockFetchWithBlob(new Blob(['jpeg-binary'], { type: 'image/jpeg' }));

    const result = await copyImageByUrl(IMAGE_URL);

    expect(result).toEqual({
      mode: 'image',
      mimeType: 'image/png',
      convertedFromMimeType: 'image/jpeg'
    });
    expect(write).toHaveBeenCalledTimes(2);
    const firstCallMime = readClipboardMimeType((write.mock.calls as unknown[][])[0][0]);
    const secondCallMime = readClipboardMimeType((write.mock.calls as unknown[][])[1][0]);
    expect(firstCallMime).toBe('image/jpeg');
    expect(secondCallMime).toBe('image/png');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('当类型不支持且无法转码时回退为复制 URL', async () => {
    const write = vi.fn(async () => {
      throw new Error("Failed to execute 'write' on 'Clipboard': Type image/webp not supported on write.");
    });
    const writeText = vi.fn(async () => undefined);
    mockNavigatorClipboard({ write, writeText });
    vi.stubGlobal('ClipboardItem', FakeClipboardItem as unknown as typeof ClipboardItem);
    mockFetchWithBlob(new Blob(['webp-binary'], { type: 'image/webp' }));

    const result = await copyImageByUrl(IMAGE_URL);

    expect(result.mode).toBe('url');
    if (result.mode !== 'url') {
      throw new Error('expected url fallback result');
    }

    expect(result.reason).toBe('clipboard-image-write-failed');
    expect(result.detail).toContain('image/webp not supported on write');
    expect(result.detail).toContain('createImageBitmap');
    expect(writeText).toHaveBeenCalledWith(IMAGE_URL);
  });

  it('当 clipboard.writeText 不可用时直接抛错', async () => {
    const write = vi.fn(async () => undefined);
    mockNavigatorClipboard({ write });

    await expect(copyImageByUrl(IMAGE_URL)).rejects.toThrow(
      '当前环境不支持剪贴板写入（clipboard.writeText 不可用）'
    );
  });

  it('当回退复制 URL 也失败时抛出组合错误', async () => {
    const write = vi.fn(async () => undefined);
    const writeText = vi.fn(async () => {
      throw new Error('WriteTextDenied');
    });
    mockNavigatorClipboard({ write, writeText });
    vi.stubGlobal('ClipboardItem', FakeClipboardItem as unknown as typeof ClipboardItem);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('NetworkBlocked');
      }) as unknown as typeof fetch
    );

    await expect(copyImageByUrl(IMAGE_URL)).rejects.toThrow('回退复制 URL 也失败');
  });
});
