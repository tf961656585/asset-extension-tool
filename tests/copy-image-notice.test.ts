import { describe, expect, it } from 'vitest';

import {
  buildCopyImageNotice,
  describeCopyImageFallback,
  type CopyImageFallbackReason
} from '../src/popup/copy-image';

const ALL_FALLBACK_REASONS: CopyImageFallbackReason[] = [
  'clipboard-image-write-unavailable',
  'clipboard-item-unsupported',
  'network-error',
  'response-not-image',
  'clipboard-image-write-failed'
];

describe('copy image notice', () => {
  it('图片复制成功时展示 success 文案与 mime 类型', () => {
    const notice = buildCopyImageNotice({
      mode: 'image',
      mimeType: 'image/png'
    });

    expect(notice.type).toBe('success');
    expect(notice.message).toContain('图片已复制到剪贴板');
    expect(notice.message).toContain('image/png');
  });

  it('图片复制成功且发生转码时展示转码说明', () => {
    const notice = buildCopyImageNotice({
      mode: 'image',
      mimeType: 'image/png',
      convertedFromMimeType: 'image/jpeg'
    });

    expect(notice.type).toBe('success');
    expect(notice.message).toContain('自动转为 image/png');
    expect(notice.message).toContain('image/jpeg');
  });

  it('每种回退原因都能生成可解释文案', () => {
    for (const reason of ALL_FALLBACK_REASONS) {
      const notice = buildCopyImageNotice({
        mode: 'url',
        reason
      });

      expect(notice.type).toBe('info');
      expect(notice.message).toContain('已回退为复制 URL');
      expect(notice.message).toContain(describeCopyImageFallback(reason));
    }
  });

  it('回退原因支持附加 detail 细节', () => {
    const reasonText = describeCopyImageFallback('network-error', 'Failed to fetch');
    const notice = buildCopyImageNotice({
      mode: 'url',
      reason: 'network-error',
      detail: 'Failed to fetch'
    });

    expect(reasonText).toBe('下载图片失败（可能是跨域、防盗链、网络异常或资源失效）（Failed to fetch）');
    expect(notice.message).toContain(reasonText);
  });
});
