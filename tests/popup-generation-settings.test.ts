import { describe, expect, it } from 'vitest';

import {
  formatAbilitySummary,
  formatBaseUrlHost,
  protocolDefaultLimits,
  validateBaseUrl,
  validateConnectionDraft,
  validateConnectionName,
  validateModelDraft
} from '../src/popup/generation-settings-helpers';

describe('validateBaseUrl', () => {
  it('规范化：去首尾空白、去末尾所有斜杠并保留版本路径', () => {
    const result = validateBaseUrl('  https://api.example.com/v1beta//  ');
    expect(result).toEqual({
      ok: true,
      value: 'https://api.example.com/v1beta',
      host: 'api.example.com'
    });
  });

  it('根地址去掉末尾斜杠', () => {
    const result = validateBaseUrl('https://api.example.com/');
    expect(result).toEqual({ ok: true, value: 'https://api.example.com', host: 'api.example.com' });
  });

  it('拒绝非 HTTPS 地址', () => {
    const result = validateBaseUrl('http://api.example.com/v1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('https://');
    }
  });

  it('拒绝用户名 / 密码 / query / fragment', () => {
    for (const url of [
      'https://user:pass@api.example.com/v1',
      'https://api.example.com/v1?x=1',
      'https://api.example.com/v1#frag'
    ]) {
      expect(validateBaseUrl(url).ok).toBe(false);
    }
  });

  it('拒绝空值与无法解析的地址', () => {
    expect(validateBaseUrl('   ').ok).toBe(false);
    expect(validateBaseUrl('not a url').ok).toBe(false);
  });

  it('formatBaseUrlHost 取主机名（含端口），解析失败退回原值', () => {
    expect(formatBaseUrlHost('https://gw.example.com:8443/v1')).toBe('gw.example.com:8443');
    expect(formatBaseUrlHost('broken')).toBe('broken');
  });
});

describe('validateConnectionDraft', () => {
  it('名称留空合法，交给共享层按主机名生成', () => {
    const result = validateConnectionDraft({
      name: '   ',
      baseUrl: 'https://api.example.com/v1',
      apiKey: '  sk-test  '
    });

    expect(result).toEqual({
      ok: true,
      value: {
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test'
      }
    });
  });

  it('填写名称时去除首尾空白', () => {
    const result = validateConnectionDraft({
      name: '  我的中转站  ',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test'
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('我的中转站');
    }
  });

  it('名称超过 40 字符、地址非法、Key 为空时逐字段报错', () => {
    const result = validateConnectionDraft({
      name: 'a'.repeat(41),
      baseUrl: 'http://api.example.com/v1',
      apiKey: '   '
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.name).toContain('40');
      expect(result.errors.baseUrl).toContain('https://');
      expect(result.errors.apiKey).toContain('API Key');
    }
  });

  it('validateConnectionName 允许留空', () => {
    expect(validateConnectionName('')).toBeNull();
    expect(validateConnectionName('x'.repeat(40))).toBeNull();
    expect(validateConnectionName('x'.repeat(41))).not.toBeNull();
  });
});

describe('模型能力与表单校验', () => {
  const capabilities = { maxRefs: 16, maxN: 10 };

  it('能力摘要区分支持参考图与仅文生图', () => {
    expect(
      formatAbilitySummary({ supportsReferenceImage: true, maxRefs: 16, maxN: 10 })
    ).toBe('参考图≤16 · 单次≤10');
    expect(
      formatAbilitySummary({ supportsReferenceImage: false, maxRefs: 0, maxN: 1 })
    ).toBe('仅文生图 · 单次≤1');
  });

  it('切换接口类型时按协议上限重置能力字段', () => {
    expect(protocolDefaultLimits({ maxRefs: 3, maxN: 1 })).toEqual({ maxRefs: '3', maxN: '1' });
  });

  it('接口类型与远端模型 ID 必填', () => {
    const result = validateModelDraft(
      {
        protocolId: '',
        remoteModelId: '   ',
        displayName: '',
        supportsReferenceImage: true,
        maxRefs: '16',
        maxN: '10'
      },
      null
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.protocolId).toContain('接口类型');
      expect(result.errors.remoteModelId).toContain('远端模型 ID');
    }
  });

  it('显示名可留空，填写时最多 60 字符', () => {
    const blank = validateModelDraft(
      {
        protocolId: 'openai-images-v1',
        remoteModelId: 'gpt-image-2',
        displayName: '  ',
        supportsReferenceImage: true,
        maxRefs: '16',
        maxN: '10'
      },
      capabilities
    );
    expect(blank.ok).toBe(true);
    if (blank.ok) {
      expect(blank.value.displayName).toBeUndefined();
    }

    const tooLong = validateModelDraft(
      {
        protocolId: 'openai-images-v1',
        remoteModelId: 'gpt-image-2',
        displayName: 'x'.repeat(61),
        supportsReferenceImage: true,
        maxRefs: '16',
        maxN: '10'
      },
      capabilities
    );
    expect(tooLong.ok).toBe(false);
  });

  it('参考图上限与数量上限必须落在协议范围内', () => {
    const result = validateModelDraft(
      {
        protocolId: 'openai-images-v1',
        remoteModelId: 'gpt-image-2',
        displayName: '',
        supportsReferenceImage: true,
        maxRefs: '17',
        maxN: '0'
      },
      capabilities
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.maxRefs).toContain('0–16');
      expect(result.errors.maxN).toContain('1–10');
    }
  });

  it('不支持参考图时忽略输入并把 maxRefs 归零', () => {
    const result = validateModelDraft(
      {
        protocolId: 'gemini-image-v1',
        remoteModelId: 'gemini-3-pro-image',
        displayName: '',
        supportsReferenceImage: false,
        maxRefs: 'not-a-number',
        maxN: '1'
      },
      { maxRefs: 3, maxN: 1 }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.maxRefs).toBe(0);
      expect(result.value.supportsReferenceImage).toBe(false);
    }
  });

  it('合法输入返回规范化字段', () => {
    const result = validateModelDraft(
      {
        protocolId: ' gemini-image-v1 ',
        remoteModelId: '  gemini-3-pro-image  ',
        displayName: ' Gemini 图 ',
        supportsReferenceImage: true,
        maxRefs: '2',
        maxN: '1'
      },
      { maxRefs: 3, maxN: 1 }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        protocolId: 'gemini-image-v1',
        remoteModelId: 'gemini-3-pro-image',
        displayName: 'Gemini 图',
        supportsReferenceImage: true,
        maxRefs: 2,
        maxN: 1
      });
    }
  });
});
