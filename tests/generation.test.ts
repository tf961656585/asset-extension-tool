import { describe, expect, it } from 'vitest';

import {
  buildGenerationRequestBody,
  GenerationReference,
  needsTranscode,
  resolveGenerationEndpoint,
  toSourceRefs,
  validateSize
} from '../src/shared/generation';

describe('端点自动选择', () => {
  it('参考图为空 → 文生图 generations', () => {
    expect(resolveGenerationEndpoint([])).toBe('generations');
  });

  it('参考图非空 → 图生图 edits', () => {
    const refs: GenerationReference[] = [{ kind: 'web', imageUrl: 'https://x.com/a.png' }];
    expect(resolveGenerationEndpoint(refs)).toBe('edits');
  });
});

describe('needsTranscode 格式判定', () => {
  it('AVIF / WebP 需转码（API 服务端 Pillow 默认不支持）', () => {
    expect(needsTranscode({ kind: 'web', blob: new Blob(['a'], { type: 'image/avif' }) })).toBe(true);
    expect(needsTranscode({ kind: 'web', blob: new Blob(['a'], { type: 'image/webp' }) })).toBe(true);
  });

  it('PNG / JPEG / GIF 无需转码（API 白名单内）', () => {
    expect(needsTranscode({ kind: 'local', blob: new Blob(['a'], { type: 'image/png' }) })).toBe(false);
    expect(needsTranscode({ kind: 'local', blob: new Blob(['a'], { type: 'image/jpeg' }) })).toBe(false);
    expect(needsTranscode({ kind: 'local', blob: new Blob(['a'], { type: 'image/gif' }) })).toBe(false);
  });

  it('无 MIME 或空 blob 不转码（无法判定，留给 fetch 实际 Content-Type）', () => {
    expect(needsTranscode({ kind: 'web', blob: new Blob(['a']) })).toBe(false);
  });
});

describe('请求体构建', () => {
  it('文生图产出 JSON body 且字段完整', () => {
    const refs: GenerationReference[] = [];
    const body = buildGenerationRequestBody(refs, {
      model: 'gpt-image-2',
      prompt: '一只猫',
      size: '1024x1024',
      n: 1
    });

    expect(body.endpoint).toBe('generations');
    if (body.endpoint !== 'generations') {
      throw new Error('expected generations');
    }
    expect(body.json).toEqual({
      model: 'gpt-image-2',
      prompt: '一只猫',
      n: 1,
      size: '1024x1024',
      quality: 'auto',
      moderation: 'auto'
    });
  });

  it('图生图产出 multipart 字段：每个参考图一个 image part + prompt/model/n/size', () => {
    const refs: GenerationReference[] = [
      { kind: 'web', imageUrl: 'https://x.com/a.png', blob: new Blob(['a']) },
      { kind: 'local', filename: 'b.png', blob: new Blob(['b']) }
    ];
    const body = buildGenerationRequestBody(refs, {
      model: 'gpt-image-2',
      prompt: '合并',
      size: '1024x1536',
      n: 2
    });

    expect(body.endpoint).toBe('edits');
    if (body.endpoint !== 'edits') {
      throw new Error('expected edits');
    }

    const imageParts = body.parts.filter((p) => p.name === 'image');
    expect(imageParts).toHaveLength(2);
    expect(imageParts[0].value).toBeInstanceOf(Blob);
    expect(imageParts[1].value).toBeInstanceOf(Blob);

    const scalar = Object.fromEntries(body.parts.filter((p) => p.name !== 'image').map((p) => [p.name, p.value]));
    expect(scalar).toEqual({
      prompt: '合并',
      model: 'gpt-image-2',
      n: '2',
      size: '1024x1536',
      quality: 'auto'
    });
  });

  it('图生图 image part 的 filename 以实际 blob.type 为准（转码后一律 API 支持格式）', () => {
    // 真实调用链：resolveReferenceBlobs（含转码）→ buildGenerationRequestBody。
    // 到达 build 时 blob.type 已是 API 支持格式（png/jpeg/gif），filename 据此推断。
    const refs: GenerationReference[] = [
      { kind: 'web', imageUrl: 'https://x.com/a', blob: new Blob(['a'], { type: 'image/png' }) },
      { kind: 'local', filename: 'cat.webp', blob: new Blob(['b'], { type: 'image/png' }) },
      { kind: 'web', imageUrl: 'https://x.com/c', blob: new Blob(['c'], { type: 'image/jpeg' }) },
      { kind: 'web', imageUrl: 'https://x.com/d', blob: new Blob(['d']) }
    ];
    const body = buildGenerationRequestBody(refs, {
      model: 'gpt-image-2',
      prompt: 'x',
      size: 'auto',
      n: 1
    });
    if (body.endpoint !== 'edits') {
      throw new Error('expected edits');
    }

    const imageParts = body.parts.filter((p) => p.name === 'image');
    // web 来源无原名 → ref-<index>.<ext>
    expect(imageParts[0].filename).toBe('ref-0.png');
    // local 来源有原名但扩展名须与实际字节一致（cat.webp → cat.png，避免按旧扩展名路由错误解码器）
    expect(imageParts[1].filename).toBe('cat.png');
    expect(imageParts[2].filename).toBe('ref-2.jpg');
    // 无 MIME 兜底 .png
    expect(imageParts[3].filename).toBe('ref-3.png');
  });

  it('quality 显式传递：文生图与图生图均携带用户选择值（v3.4）', () => {
    const refs: GenerationReference[] = [
      { kind: 'web', imageUrl: 'https://x.com/a.png', blob: new Blob(['a']) }
    ];
    const editsBody = buildGenerationRequestBody(refs, {
      model: 'gpt-image-2',
      prompt: '高画质图生图',
      size: '1024x1024',
      n: 1,
      quality: 'high'
    });
    if (editsBody.endpoint !== 'edits') {
      throw new Error('expected edits');
    }
    expect(editsBody.parts.find((p) => p.name === 'quality')?.value).toBe('high');

    const generationsBody = buildGenerationRequestBody([], {
      model: 'gpt-image-2',
      prompt: '高画质文生图',
      size: '1024x1024',
      n: 1,
      quality: 'high'
    });
    if (generationsBody.endpoint !== 'generations') {
      throw new Error('expected generations');
    }
    expect(generationsBody.json.quality).toBe('high');
  });

  it('显式携带远端型号', () => {
    const body = buildGenerationRequestBody([], {
      prompt: 'x',
      size: 'auto',
      n: 1,
      model: 'gpt-image-1'
    });
    if (body.endpoint !== 'generations') {
      throw new Error('expected generations');
    }
    expect(body.json.model).toBe('gpt-image-1');
  });

  it('缺少远端型号时拒绝构造请求（不得回退默认模型）', () => {
    expect(() =>
      buildGenerationRequestBody([], {
        prompt: 'x',
        size: 'auto',
        n: 1
      })
    ).toThrow(/远端模型/);
  });
});

describe('toSourceRefs 剥离 blob', () => {
  it('映射三种来源并丢弃 blob', () => {
    const refs: GenerationReference[] = [
      { kind: 'asset', assetId: 'asset_1', blob: new Blob(['a']) },
      { kind: 'web', imageUrl: 'https://x.com/a.png', blob: new Blob(['b']) },
      { kind: 'local', filename: 'c.png', blob: new Blob(['c']) }
    ];

    const sourceRefs = toSourceRefs(refs);
    expect(sourceRefs).toEqual([
      { kind: 'asset', assetId: 'asset_1' },
      { kind: 'web', imageUrl: 'https://x.com/a.png' },
      { kind: 'local', filename: 'c.png' }
    ]);
  });
});

describe('validateSize §4.3 四规则', () => {
  it('固定档位与 auto 视为合法', () => {
    for (const s of ['1024x1024', '1536x1024', '1024x1536', '2048x2048', '2048x1152', '3840x2160', '2160x3840', 'auto']) {
      expect(validateSize(s).valid).toBe(true);
    }
  });

  it('格式非法', () => {
    expect(validateSize('1024').valid).toBe(false);
    expect(validateSize('axb').valid).toBe(false);
  });

  it('最长边超过 3840 不合法', () => {
    const r = validateSize('4000x2000');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('3840');
  });

  it('宽高非 16 倍数不合法', () => {
    const r = validateSize('1000x1000');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('16');
  });

  it('长宽比超过 3:1 不合法', () => {
    const r = validateSize('3840x1152');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('3:1');
  });

  it('总像素超出范围不合法（过小 / 过大）', () => {
    expect(validateSize('1024x512').reason).toContain('像素');
    expect(validateSize('3840x2304').reason).toContain('像素');
  });

  it('满足四规则的自定义尺寸合法', () => {
    expect(validateSize('1024x640').valid).toBe(true);
    expect(validateSize('1920x1088').valid).toBe(true);
  });
});
