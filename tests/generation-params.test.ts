import { describe, expect, it } from 'vitest';

import {
  PROTOCOLS,
  defaultParams,
  getProtocol,
  listProtocols,
  parseRatioSize,
  validateSizeForProtocol,
  type ProtocolId
} from '../src/shared/protocols';

const OPENAI = 'openai-images-v1' as ProtocolId;
const GEMINI = 'gemini-image-v1' as ProtocolId;

describe('内置协议描述符（v3.9 冻结 API）', () => {
  it('提供且仅提供两套内置协议', () => {
    const ids = listProtocols().map((protocol) => protocol.id);
    expect(ids).toEqual([OPENAI, GEMINI]);
    expect(PROTOCOLS).toHaveLength(2);
  });

  it('getProtocol 命中返回描述符，未知 id 返回 undefined', () => {
    expect(getProtocol(OPENAI)?.id).toBe(OPENAI);
    expect(getProtocol(GEMINI)?.id).toBe(GEMINI);
    expect(getProtocol('bogus')).toBeUndefined();
    expect(getProtocol(undefined)).toBeUndefined();
    expect(getProtocol(null)).toBeUndefined();
  });

  it('协议上限固定：OpenAI maxRefs=16/maxN=10，Gemini maxRefs=3/maxN=1', () => {
    const openai = getProtocol(OPENAI);
    const gemini = getProtocol(GEMINI);
    expect(openai?.params.maxRefs).toBe(16);
    expect(openai?.params.maxN).toBe(10);
    expect(gemini?.params.maxRefs).toBe(3);
    expect(gemini?.params.maxN).toBe(1);
  });

  it('OpenAI size 为预设 + 自定义；Gemini 为比例 × 清晰度', () => {
    const openaiSize = getProtocol(OPENAI)?.params.size;
    const geminiSize = getProtocol(GEMINI)?.params.size;
    expect(openaiSize?.kind).toBe('preset');
    expect(geminiSize?.kind).toBe('ratio-size');

    if (openaiSize?.kind === 'preset') {
      const values = openaiSize.options.map((option) => option.value);
      expect(values).toContain('1024x1024');
      expect(values).toContain('auto');
      expect(openaiSize.allowCustom).toBe(true);
    }
    if (geminiSize?.kind === 'ratio-size') {
      expect(geminiSize.ratios).toContain('1:1');
      expect(geminiSize.ratios).toContain('16:9');
      expect(geminiSize.imageSizes).toEqual(['512', '1K', '2K', '4K']);
    }
  });

  it('画质枚举：OpenAI 四档，Gemini 无画质', () => {
    const openaiQuality = getProtocol(OPENAI)?.params.quality.map((option) => option.value);
    expect([...(openaiQuality ?? [])].sort()).toEqual(['auto', 'high', 'low', 'medium']);
    expect(getProtocol(GEMINI)?.params.quality).toEqual([]);
  });
});

describe('defaultParams：协议默认参数', () => {
  it('OpenAI 默认 { size:auto, quality:auto, n:1 }', () => {
    const protocol = getProtocol(OPENAI);
    expect(protocol).toBeDefined();
    expect(defaultParams(protocol!, { maxN: 10 })).toEqual({
      size: 'auto',
      quality: 'auto',
      n: 1
    });
  });

  it('Gemini 默认 { size:1:1@1K, quality:"", n:1 } 且 n 按 maxN 钳制', () => {
    const protocol = getProtocol(GEMINI);
    expect(protocol).toBeDefined();
    expect(defaultParams(protocol!, { maxN: 1 })).toEqual({
      size: '1:1@1K',
      quality: '',
      n: 1
    });
    // 默认 n 恒为 1，模型 maxN 更小时也不会越界。
    expect(defaultParams(protocol!, { maxN: 1 }).n).toBe(1);
  });

  it('每个协议的默认 size 都能通过自身校验', () => {
    for (const protocol of listProtocols()) {
      const params = defaultParams(protocol, { maxN: protocol.params.maxN });
      expect(validateSizeForProtocol(protocol.id, params.size)).toBe(true);
    }
  });
});

describe('validateSizeForProtocol：尺寸语法与约束', () => {
  it('OpenAI：8 档预设、auto 与合法自定义 WxH 通过', () => {
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
      expect(validateSizeForProtocol(OPENAI, size)).toBe(true);
    }
    // 自定义：16 倍数、边长 ≤ 3840、比 ≤ 3:1、像素在范围内。
    expect(validateSizeForProtocol(OPENAI, '1536x864')).toBe(true);
  });

  it('OpenAI：非法自定义尺寸拒绝', () => {
    expect(validateSizeForProtocol(OPENAI, '1920x1080')).toBe(false); // 高不是 16 的倍数
    expect(validateSizeForProtocol(OPENAI, '9999x9999')).toBe(false); // 超边长
    expect(validateSizeForProtocol(OPENAI, '100x100')).toBe(false); // 像素不足
    expect(validateSizeForProtocol(OPENAI, 'not-a-size')).toBe(false);
    expect(validateSizeForProtocol(OPENAI, '')).toBe(false);
  });

  it('Gemini：<ratio>@<size> 且比例/清晰度在枚举内', () => {
    expect(validateSizeForProtocol(GEMINI, '1:1@1K')).toBe(true);
    expect(validateSizeForProtocol(GEMINI, '16:9@4K')).toBe(true);
    expect(validateSizeForProtocol(GEMINI, '2:3@512')).toBe(true);
    expect(validateSizeForProtocol(GEMINI, '1:1@5K')).toBe(false);
    expect(validateSizeForProtocol(GEMINI, '17:9@1K')).toBe(false);
    expect(validateSizeForProtocol(GEMINI, '1:1')).toBe(false);
    expect(validateSizeForProtocol(GEMINI, '1024x1024')).toBe(false);
  });

  it('跨协议语法不互通（OpenAI 尺寸不通过 Gemini 校验，反之亦然）', () => {
    expect(validateSizeForProtocol(GEMINI, '1024x1024')).toBe(false);
    expect(validateSizeForProtocol(OPENAI, '1:1@1K')).toBe(false);
  });
});

describe('parseRatioSize：ratio@size 解析', () => {
  it('合法值拆为 aspectRatio + imageSize', () => {
    expect(parseRatioSize('16:9@2K')).toEqual({ aspectRatio: '16:9', imageSize: '2K' });
    expect(parseRatioSize('1:1@1K')).toEqual({ aspectRatio: '1:1', imageSize: '1K' });
    expect(parseRatioSize('4:1@512')).toEqual({ aspectRatio: '4:1', imageSize: '512' });
  });

  it('parseRatioSize 只负责拆解语法；比例/清晰度枚举由 validateSizeForProtocol 把关', () => {
    expect(parseRatioSize('17:9@1K')).toEqual({ aspectRatio: '17:9', imageSize: '1K' });
    expect(validateSizeForProtocol(GEMINI, '17:9@1K')).toBe(false);
    expect(parseRatioSize('1:1@5K')).toEqual({ aspectRatio: '1:1', imageSize: '5K' });
    expect(validateSizeForProtocol(GEMINI, '1:1@5K')).toBe(false);
  });

  it('格式不完整返回 null（不返回默认值）', () => {
    expect(parseRatioSize('1:1')).toBeNull();
    expect(parseRatioSize('1:1@')).toBeNull();
    expect(parseRatioSize('1:1@ 1K')).toBeNull();
    expect(parseRatioSize('1024x1024')).toBeNull();
    expect(parseRatioSize('')).toBeNull();
  });
});
