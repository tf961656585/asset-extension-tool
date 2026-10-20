import { describe, expect, it } from 'vitest';

import { MIN_IMAGE_EDGE, getImageUrl, isSavableImage, resolveImageTargetFromProbe } from '../src/content/quick-save-policy';

function createImageNode(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    tagName: 'IMG',
    src: 'https://cdn.site.com/a.png',
    currentSrc: '',
    naturalWidth: MIN_IMAGE_EDGE,
    naturalHeight: MIN_IMAGE_EDGE,
    width: MIN_IMAGE_EDGE,
    height: MIN_IMAGE_EDGE,
    ...overrides
  };
}

describe('quick save policy', () => {
  it('会从 composedPath 中优先命中图片节点', () => {
    const image = createImageNode();
    const probe = {
      target: { tagName: 'DIV' },
      composedPath: () => [{ tagName: 'SPAN' }, image]
    };

    expect(resolveImageTargetFromProbe(probe)).toBe(image);
  });

  it('会通过 closest(img) 在路径节点中回溯图片', () => {
    const image = createImageNode();
    const pathNode = {
      tagName: 'BUTTON',
      closest: (selector: string) => (selector === 'img' ? image : null)
    };
    const probe = {
      target: { tagName: 'DIV' },
      composedPath: () => [pathNode]
    };

    expect(resolveImageTargetFromProbe(probe)).toBe(image);
  });

  it('composedPath 不可用时会回退到 target 检测', () => {
    const image = createImageNode();
    const target = {
      tagName: 'SPAN',
      closest: (selector: string) => (selector === 'img' ? image : null)
    };

    expect(resolveImageTargetFromProbe({ target })).toBe(image);
  });

  it('无图片节点时返回 null', () => {
    const probe = {
      target: { tagName: 'DIV' },
      composedPath: () => [{ tagName: 'SECTION' }, { tagName: 'ARTICLE' }]
    };

    expect(resolveImageTargetFromProbe(probe)).toBeNull();
  });

  it('可保存判定会过滤 data URL 与尺寸不足图片', () => {
    expect(isSavableImage(createImageNode())).toBe(true);
    expect(
      isSavableImage(
        createImageNode({
          src: 'data:image/png;base64,xyz',
          currentSrc: 'data:image/png;base64,xyz'
        })
      )
    ).toBe(false);
    expect(
      isSavableImage(
        createImageNode({
          naturalWidth: MIN_IMAGE_EDGE - 1
        })
      )
    ).toBe(false);
  });

  it('图片 URL 读取优先 currentSrc', () => {
    const image = createImageNode({
      src: 'https://cdn.site.com/fallback.png',
      currentSrc: 'https://cdn.site.com/current.webp'
    });

    expect(getImageUrl(image)).toBe('https://cdn.site.com/current.webp');
  });
});
