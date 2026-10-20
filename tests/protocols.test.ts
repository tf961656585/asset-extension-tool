import { describe, expect, it } from 'vitest';

import {
  PROTOCOLS,
  defaultParams,
  getProtocol,
  isProtocolId,
  listProtocols,
  parseRatioSize,
  validateSizeForProtocol
} from '../src/shared/protocols';

describe('内置协议描述符', () => {
  it('恰好内置两个协议，id 与显示名固定', () => {
    expect(PROTOCOLS).toHaveLength(2);
    expect(PROTOCOLS.map((protocol) => protocol.id)).toEqual([
      'openai-images-v1',
      'gemini-image-v1'
    ]);
    expect(getProtocol('openai-images-v1')?.label).toBe('OpenAI Images');
    expect(getProtocol('gemini-image-v1')?.label).toBe('Gemini Image');
  });

  it('openai-images-v1：Bearer 鉴权、8 档预设 + 自定义、4 档画质、协议上限', () => {
    const protocol = getProtocol('openai-images-v1');
    expect(protocol).toBeDefined();
    expect(protocol?.provider).toBe('openai-image');
    expect(protocol?.auth).toEqual({ headerName: 'Authorization', prefix: 'Bearer ' });

    const size = protocol?.params.size;
    expect(size?.kind).toBe('preset');
    if (size?.kind !== 'preset') {
      throw new Error('expected preset size');
    }
    expect(size.allowCustom).toBe(true);
    expect(size.options.map((option) => option.value)).toEqual([
      '1024x1024',
      '1536x1024',
      '1024x1536',
      '2048x2048',
      '2048x1152',
      '3840x2160',
      '2160x3840',
      'auto'
    ]);
    expect(protocol?.params.quality.map((option) => option.value)).toEqual([
      'auto',
      'low',
      'medium',
      'high'
    ]);
    expect(protocol?.params.maxN).toBe(10);
    expect(protocol?.params.maxRefs).toBe(16);
    expect(protocol?.params.defaultSize).toBe('auto');
    expect(protocol?.params.defaultQuality).toBe('auto');
    expect(protocol?.params.defaultN).toBe(1);
  });

  it('gemini-image-v1：x-goog-api-key、14 比例 × 4 清晰度、无画质、上限 3/1', () => {
    const protocol = getProtocol('gemini-image-v1');
    expect(protocol).toBeDefined();
    expect(protocol?.provider).toBe('google-image');
    expect(protocol?.auth).toEqual({ headerName: 'x-goog-api-key', prefix: '' });

    const size = protocol?.params.size;
    expect(size?.kind).toBe('ratio-size');
    if (size?.kind !== 'ratio-size') {
      throw new Error('expected ratio-size size');
    }
    expect(size.ratios).toHaveLength(14);
    expect(size.ratios).toContain('21:9');
    expect(size.imageSizes).toEqual(['512', '1K', '2K', '4K']);
    expect(protocol?.params.quality).toEqual([]);
    expect(protocol?.params.maxN).toBe(1);
    expect(protocol?.params.maxRefs).toBe(3);
    expect(protocol?.params.defaultSize).toBe('1:1@1K');
    expect(protocol?.params.defaultQuality).toBe('');
    expect(protocol?.params.defaultN).toBe(1);
  });

  it('getProtocol 未命中返回 undefined（不兜底默认协议）', () => {
    expect(getProtocol(undefined)).toBeUndefined();
    expect(getProtocol(null)).toBeUndefined();
    expect(getProtocol('')).toBeUndefined();
    expect(getProtocol('openai-image')).toBeUndefined();
    expect(getProtocol('gemini-image-v1')?.id).toBe('gemini-image-v1');
  });

  it('listProtocols 返回副本，调用方改写不影响内置清单', () => {
    const listed = listProtocols();
    expect(listed).toHaveLength(2);
    listed.pop();
    expect(listProtocols()).toHaveLength(2);
    expect(PROTOCOLS).toHaveLength(2);
  });

  it('isProtocolId 只识别内置协议 id', () => {
    expect(isProtocolId('openai-images-v1')).toBe(true);
    expect(isProtocolId('gemini-image-v1')).toBe(true);
    expect(isProtocolId('openai-image')).toBe(false);
    expect(isProtocolId('gemini-image-v2')).toBe(false);
    expect(isProtocolId('')).toBe(false);
  });
});

describe('validateSizeForProtocol', () => {
  it('openai：固定档位（含 auto）合法', () => {
    for (const size of [
      '1024x1024',
      '1536x1024',
      '1024x1536',
      '2048x2048',
      '2048x1152',
      '3840x2160',
      '2160x3840',
      'auto'
    ]) {
      expect(validateSizeForProtocol('openai-images-v1', size)).toBe(true);
    }
  });

  it('openai：满足四条约束的自定义 WxH 合法，违反任一条则非法', () => {
    expect(validateSizeForProtocol('openai-images-v1', '1024x640')).toBe(true);
    expect(validateSizeForProtocol('openai-images-v1', '1920x1088')).toBe(true);
    // 最大边 > 3840
    expect(validateSizeForProtocol('openai-images-v1', '4000x2000')).toBe(false);
    // 非 16 倍数
    expect(validateSizeForProtocol('openai-images-v1', '1000x1000')).toBe(false);
    // 长宽比 > 3:1
    expect(validateSizeForProtocol('openai-images-v1', '3840x1152')).toBe(false);
    // 总像素越界
    expect(validateSizeForProtocol('openai-images-v1', '1024x512')).toBe(false);
    // 非 WxH 格式
    expect(validateSizeForProtocol('openai-images-v1', '1:1@1K')).toBe(false);
  });

  it('gemini：14 比例 × 4 清晰度合法', () => {
    expect(validateSizeForProtocol('gemini-image-v1', '1:1@1K')).toBe(true);
    expect(validateSizeForProtocol('gemini-image-v1', '21:9@4K')).toBe(true);
    expect(validateSizeForProtocol('gemini-image-v1', '8:1@512')).toBe(true);
  });

  it('gemini：比例 / 清晰度不在枚举内或格式错误均非法', () => {
    expect(validateSizeForProtocol('gemini-image-v1', '7:3@1K')).toBe(false);
    expect(validateSizeForProtocol('gemini-image-v1', '1:1@8K')).toBe(false);
    expect(validateSizeForProtocol('gemini-image-v1', '1:1')).toBe(false);
    expect(validateSizeForProtocol('gemini-image-v1', '1024x1024')).toBe(false);
    expect(validateSizeForProtocol('gemini-image-v1', '1:1@1K ')).toBe(false);
  });
});

describe('parseRatioSize 严格格式解析', () => {
  it('合法格式拆分比例与清晰度', () => {
    expect(parseRatioSize('1:1@1K')).toEqual({ aspectRatio: '1:1', imageSize: '1K' });
    expect(parseRatioSize('9:16@2K')).toEqual({ aspectRatio: '9:16', imageSize: '2K' });
    expect(parseRatioSize('21:9@512')).toEqual({ aspectRatio: '21:9', imageSize: '512' });
  });

  it('只校验格式：清晰度不在协议枚举内仍可拆分，由 validateSizeForProtocol 拒绝', () => {
    expect(parseRatioSize('1:1@8K')).toEqual({ aspectRatio: '1:1', imageSize: '8K' });
    expect(validateSizeForProtocol('gemini-image-v1', '1:1@8K')).toBe(false);
  });

  it('非法格式返回 null（不兜底）', () => {
    expect(parseRatioSize('bogus')).toBeNull();
    expect(parseRatioSize('1024x1024')).toBeNull();
    expect(parseRatioSize('1:1')).toBeNull();
    expect(parseRatioSize('1:1@')).toBeNull();
    expect(parseRatioSize('@1K')).toBeNull();
    expect(parseRatioSize('1@1K')).toBeNull();
    expect(parseRatioSize('1:1@1K@2K')).toBeNull();
    expect(parseRatioSize(' 1:1@1K')).toBeNull();
  });
});

describe('defaultParams', () => {
  it('按协议默认值与模型 maxN 上限生成', () => {
    const openai = getProtocol('openai-images-v1');
    const gemini = getProtocol('gemini-image-v1');
    if (!openai || !gemini) {
      throw new Error('protocols missing');
    }

    expect(defaultParams(openai, { maxN: 5 })).toEqual({
      size: 'auto',
      quality: 'auto',
      n: 1
    });
    expect(defaultParams(gemini, { maxN: 1 })).toEqual({
      size: '1:1@1K',
      quality: '',
      n: 1
    });
  });

  it('协议 defaultN 高于模型 maxN 时下调', () => {
    const openai = getProtocol('openai-images-v1');
    if (!openai) {
      throw new Error('protocol missing');
    }
    const custom = {
      ...openai,
      params: { ...openai.params, defaultN: 8 }
    };
    expect(defaultParams(custom, { maxN: 3 }).n).toBe(3);
  });
});
