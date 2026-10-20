import { describe, expect, it } from 'vitest';

import {
  extractErrorMessage,
  isErrorResponse,
  parseGenerationResponse
} from '../src/background/generation-response';

const SUCCESS = {
  created: 1783588475,
  data: [
    { b64_json: 'AAA', sha256: 'deadbeef' },
    { b64_json: 'BBB' }
  ],
  output_format: 'png',
  size: '1152x2048',
  usage: { total_tokens: 1529 }
};

describe('parseGenerationResponse', () => {
  it('提取 b64 数组与字段', () => {
    const parsed = parseGenerationResponse(SUCCESS);
    expect(parsed.images).toHaveLength(2);
    expect(parsed.images[0]).toEqual({ b64: 'AAA', sha256: 'deadbeef' });
    expect(parsed.images[1].sha256).toBeUndefined();
    expect(parsed.outputFormat).toBe('png');
    expect(parsed.usage).toEqual({ total_tokens: 1529 });
  });

  it('data 缺失时返回空数组（可容错）', () => {
    expect(parseGenerationResponse({}).images).toEqual([]);
  });
});

describe('isErrorResponse §7.2', () => {
  it('无 error 字段视为成功', () => {
    expect(isErrorResponse(SUCCESS)).toBe(false);
    expect(isErrorResponse({})).toBe(false);
  });

  it('error.code / message / type 任一非空即失败', () => {
    expect(isErrorResponse({ error: { code: '401' } })).toBe(true);
    expect(isErrorResponse({ error: { message: 'invalid key' } })).toBe(true);
    expect(isErrorResponse({ error: { type: 'auth' } })).toBe(true);
  });
});

describe('extractErrorMessage 脱敏', () => {
  it('优先 message，回退 code / type', () => {
    expect(extractErrorMessage({ error: { message: 'Key 无效' } })).toBe('Key 无效');
    expect(extractErrorMessage({ error: { code: '429' } })).toBe('429');
    expect(extractErrorMessage({ error: { type: 'rate' } })).toBe('rate');
    expect(extractErrorMessage({})).toBe('生图失败，未知错误');
  });

  it('不回显 API Key', () => {
    const msg = extractErrorMessage({ error: { message: 'something wrong' } });
    expect(msg).not.toContain('sk-');
  });
});

describe('parseGenerationResponse (gemini-image-v1 协议)', () => {
  const GEMINI_SUCCESS = {
    candidates: [
      {
        content: {
          parts: [
            { text: '生成的图片如下' },
            { inlineData: { mimeType: 'image/png', data: 'GEMINI_AAA' } },
            { inlineData: { mimeType: 'image/png', data: 'GEMINI_BBB' } }
          ]
        }
      }
    ],
    usageMetadata: { totalTokenCount: 500 }
  };

  it('从 candidates[].parts[].inlineData 提取图片 base64', () => {
    const parsed = parseGenerationResponse(GEMINI_SUCCESS, 'gemini-image-v1');
    expect(parsed.images).toHaveLength(2);
    expect(parsed.images[0]).toEqual({ b64: 'GEMINI_AAA' });
    expect(parsed.images[1]).toEqual({ b64: 'GEMINI_BBB' });
    expect(parsed.outputFormat).toBe('png');
    expect(parsed.usage).toEqual({ totalTokenCount: 500 });
  });

  it('合并多个 candidate 的 inlineData', () => {
    const multi = {
      candidates: [
        { content: { parts: [{ inlineData: { data: 'A' } }] } },
        { content: { parts: [{ text: 'x' }, { inlineData: { data: 'B' } }] } }
      ]
    };
    expect(parseGenerationResponse(multi, 'gemini-image-v1').images).toHaveLength(2);
  });

  it('thoughtSignature 与 inlineData 共存时仅提取 inlineData（Gemini 3 thinking 模型响应）', () => {
    // 用户报告的真实响应形态：图片 part 同时携带 thoughtSignature（与 inlineData 在同一 part 并列）
    const withThought = {
      candidates: [
        {
          content: {
            parts: [
              { thoughtSignature: 'EoLRQQr+0EEBEU0y...', thought: true, text: 'Let me think...' },
              { inlineData: { mimeType: 'image/jpeg', data: '/9j/4AAQ...' }, thoughtSignature: 'sig-xyz' }
            ]
          }
        }
      ]
    };
    expect(parseGenerationResponse(withThought, 'gemini-image-v1').images).toEqual([{ b64: '/9j/4AAQ...' }]);
    expect(parseGenerationResponse(withThought, 'gemini-image-v1').outputFormat).toBe('jpeg');
  });

  it('candidates 缺失或无 inlineData 返回空数组', () => {
    expect(parseGenerationResponse({}, 'gemini-image-v1').images).toEqual([]);
    expect(parseGenerationResponse({ candidates: [{ content: { parts: [{ text: 'only text' }] } }] }, 'gemini-image-v1').images).toEqual([]);
  });

  it('响应字段为 snake_case inline_data 时返回空数组（锁定 camelCase-only 契约，防回归）', () => {
    // Google REST 实际返回 camelCase；若上游被错误转成 snake_case，解析器必须失败而非静默容忍
    const snakeCase = {
      candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: 'SNAKE' } }] } }]
    };
    expect(parseGenerationResponse(snakeCase, 'gemini-image-v1').images).toEqual([]);
  });

  it('默认协议 openai-images-v1 走 OpenAI 解析', () => {
    const parsed = parseGenerationResponse(SUCCESS);
    expect(parsed.images).toHaveLength(2);
  });
});

describe('isErrorResponse / extractErrorMessage (gemini status 字段)', () => {
  it('error.status 非空即失败（Google 原生错误格式）', () => {
    expect(isErrorResponse({ error: { status: 'INVALID_ARGUMENT' } })).toBe(true);
  });

  it('extractErrorMessage 回退 status', () => {
    expect(extractErrorMessage({ error: { status: 'PERMISSION_DENIED' } })).toBe('PERMISSION_DENIED');
  });
});
