import type { SourceRef } from './model';

/** 单张参考图字节上限（15MB，spec FR-16）。 */
export const MAX_REFERENCE_IMAGE_BYTES = 15 * 1024 * 1024;

/** 单个任务全部参考图合计字节上限（50MB，spec FR-16）。 */
export const MAX_TOTAL_REFERENCE_BYTES = 50 * 1024 * 1024;

/** 生图参考图来源。 */
export type GenerationReferenceKind = 'asset' | 'web' | 'local';

/**
 * 参考图内存态（侧边栏 / background 执行层内部使用）。
 * local 来源携带 blob（绑定当前上下文内存，离开上下文即失效）。
 * 用于发请求时拼装 multipart body（buildGenerationRequestBody 消费此类型）。
 */
export interface GenerationReference {
  kind: GenerationReferenceKind;
  /** 同任务内唯一的参考图 id（由状态机分配，便于按 id 增删；build/submit 时忽略不影响请求） */
  id?: string;
  /** web / asset 来源的图片 URL，background 可据此（重新）拉取字节 */
  imageUrl?: string;
  /** asset 来源的资产 id */
  assetId?: string;
  /** local 来源的文件名 */
  filename?: string;
  /** local 来源的内存二进制（同上下文内有效） */
  blob?: Blob;
  /**
   * 参考图字节大小（与 blob 解耦）：local 来源构造时直接取 file.size；
   * web/asset 来源由 sidepanel 异步 fetch imageUrl 回拉后回填（sidepanel 享有 host_permissions 干净 fetch）。
   * 配额统计（knownBytes）与单张/合计校验统一读此字段，使三类来源配额一致生效。
   */
  bytes?: number;
}

/**
 * 参考图消息载荷（跨上下文传递用，spec FR-16 第 6 条 v3.5）。
 * 与内存态分离——chrome.runtime.sendMessage 默认 JSON 序列化不保留 Blob/File/ArrayBuffer，
 * 因此 local 来源用 base64 字符串替代 blob；web/asset 来源只携带 URL，由 background fetch 回拉字节。
 * 载荷只允许标量与字符串类型，不得使用 Blob/File/ArrayBuffer。
 */
export interface GenerationReferencePayload {
  kind: GenerationReferenceKind;
  /** web / asset 来源的图片 URL（background 据此 fetch 回拉字节） */
  imageUrl?: string;
  /** asset 来源的资产 id */
  assetId?: string;
  /** local 来源的文件名 */
  filename?: string;
  /** local 来源的 base64 编码字节（无 URL 可回拉，由渲染层序列化、background 解码还原 Blob） */
  base64?: string;
  /** local 来源的 MIME 类型（解码还原 Blob 时需要，默认 image/png） */
  mimeType?: string;
}

/**
 * Blob → base64 字符串（渲染层发送前调用）。
 * 用 Blob.arrayBuffer() + btoa 实现，浏览器与 Node 18+ 均原生可用（不依赖 FileReader）。
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * base64 字符串 → Blob（background 接收后还原，用于拼装 multipart body）。
 * 在 Service Worker / Node 环境用 atob + Uint8Array 构造（不依赖 FileReader）。
 */
export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

/**
 * 内存态参考图 → 消息载荷（渲染层发送前调用）。
 * web/asset 来源丢弃 blob（background 会按 imageUrl 回拉），只保留 URL/assetId/filename。
 * local 来源把 blob 序列化为 base64 + mimeType（无 URL 可回拉，必须随载荷传递字节）。
 */
export async function toReferencePayloads(
  refs: GenerationReference[]
): Promise<GenerationReferencePayload[]> {
  const payloads: GenerationReferencePayload[] = [];
  for (const ref of refs) {
    if (ref.kind === 'local') {
      const blob = ref.blob;
      if (!blob) {
        throw new Error('本地参考图缺少 blob 字节');
      }
      const base64 = await blobToBase64(blob);
      payloads.push({
        kind: 'local',
        filename: ref.filename,
        base64,
        mimeType: blob.type || 'image/png'
      });
    } else if (ref.kind === 'web') {
      payloads.push({ kind: 'web', imageUrl: ref.imageUrl });
    } else {
      payloads.push({ kind: 'asset', assetId: ref.assetId, imageUrl: ref.imageUrl });
    }
  }
  return payloads;
}

/**
 * 消息载荷 → 内存态参考图（background 接收后调用，供 buildGenerationRequestBody 消费）。
 * web/asset 来源保留 URL，blob 留空（由 resolveReferenceBlobs 按 imageUrl 回拉填充）。
 * local 来源从 base64 还原 blob。
 */
export function fromReferencePayloads(
  payloads: GenerationReferencePayload[]
): GenerationReference[] {
  return payloads.map((payload) => {
    if (payload.kind === 'local') {
      return {
        kind: 'local',
        filename: payload.filename,
        blob: payload.base64
          ? base64ToBlob(payload.base64, payload.mimeType ?? 'image/png')
          : undefined
      };
    }
    if (payload.kind === 'web') {
      return { kind: 'web', imageUrl: payload.imageUrl };
    }
    return { kind: 'asset', assetId: payload.assetId, imageUrl: payload.imageUrl };
  });
}

export type GenerationEndpoint = 'generations' | 'edits';

/** 每任务唯一 taskId 生成契约，供入口（popup/content）与测试复用。 */
export function createTaskId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `task_${crypto.randomUUID()}`;
  }
  return `task_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
}

/** 端点自动选择：参考图为空→文生图 generations，非空→图生图 edits（spec §2）。 */
export function resolveGenerationEndpoint(refs: GenerationReference[]): GenerationEndpoint {
  return refs.length === 0 ? 'generations' : 'edits';
}

export interface GenerationParams {
  prompt: string;
  size: string;
  n: number;
  /** 画质 low/medium/high/auto，缺省回退 auto（spec FR-17 v3.4）。 */
  quality?: string;
  model?: string;
}

export type BuiltGenerationBody =
  | { endpoint: 'generations'; json: Record<string, unknown> }
  | {
      endpoint: 'edits';
      parts: Array<{ name: string; value: string | Blob; filename?: string }>;
    };

/**
 * API 服务端（基于 Pillow）可识别的图片 MIME 白名单。
 * 不在此集合的 MIME（如 AVIF / WebP）需要先转码为 PNG，否则服务端解码失败报
 * `Invalid image file or mode`。AVIF 由 bilibili 等图床内容协商大量使用，WebP 同理预防。
 */
const API_SUPPORTED_IMAGE_MIMES = new Set<string>(['image/png', 'image/jpeg', 'image/jpg', 'image/gif']);

/**
 * blob.type（MIME）→ 文件扩展名映射，用于 multipart image part 的 filename（API spec §8 curl
 * 样本每张图均带扩展名）。从实际字节 MIME 推断，比从 URL 解析更可靠——网页图常发生内容协商
 * （URL 以 ..jpg 结尾但 CDN 实际返回 webp/avif 字节）。未识别 MIME 兜底 .png。
 */
const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

/**
 * 判断参考图字节是否需要转码：MIME 不在 API 白名单内即需转码为 PNG。
 * 纯函数，可单测；转码执行（createImageBitmap + OffscreenCanvas）在 background 执行层。
 */
export function needsTranscode(ref: GenerationReference): boolean {
  const type = ref.blob?.type ?? '';
  return type.length > 0 && !API_SUPPORTED_IMAGE_MIMES.has(type);
}

/**
 * 为 image part 构造带扩展名的 filename。
 * 以实际 blob.type（转码后为 image/png）推断扩展名——不信任原始 ref.filename 的扩展名，
 * 因为 local 来源的 webp/avif 文件经转码后字节已变为 PNG，filename 扩展名须与实际字节一致，
 * 否则服务端按扩展名路由到错误解码器仍会失败。未识别 MIME 兜底 .png。
 */
function buildImageFilename(ref: GenerationReference, index: number): string {
  const ext = MIME_TO_EXT[ref.blob?.type ?? ''] ?? 'png';
  return ref.filename && ref.filename.trim().length > 0
    ? replaceExt(ref.filename, ext)
    : `ref-${index}.${ext}`;
}

/** 替换文件名扩展名为指定扩展名（保留主名，确保 filename 与转码后实际字节一致）。 */
function replaceExt(filename: string, ext: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? `${filename.slice(0, dot)}.${ext}` : `${filename}.${ext}`;
}

/**
 * 构建生图请求体描述（不直接产 FormData，留给 background 转换）。
 * - generations：JSON body，含 model/prompt/n/size/quality/moderation。
 * - edits：multipart 字段映射，image 为文件 part（可重复，带扩展名 filename）+ prompt/model/n/size/quality。
 * 两模式均显式携带用户选的 quality（spec FR-17 v3.4，图生图此前不带 quality，本次补齐）。
 */
export function buildGenerationRequestBody(
  refs: GenerationReference[],
  params: GenerationParams
): BuiltGenerationBody {
  const model = params.model;
  if (!model) {
    throw new Error('缺少远端模型 ID，无法构造生图请求');
  }
  const quality = params.quality ?? 'auto';
  const endpoint = resolveGenerationEndpoint(refs);

  if (endpoint === 'generations') {
    return {
      endpoint,
      json: {
        model,
        prompt: params.prompt,
        n: params.n,
        size: params.size,
        quality,
        moderation: 'auto'
      }
    };
  }

  const parts: Array<{ name: string; value: string | Blob; filename?: string }> = refs.map(
    (ref, index) => ({
      name: 'image',
      value: ref.blob as Blob,
      filename: buildImageFilename(ref, index)
    })
  );
  parts.push({ name: 'prompt', value: params.prompt });
  parts.push({ name: 'model', value: model });
  parts.push({ name: 'n', value: String(params.n) });
  parts.push({ name: 'size', value: params.size });
  parts.push({ name: 'quality', value: quality });

  return { endpoint, parts };
}

/** 剥离 blob，保留 assetId/imageUrl/filename，用于血缘记录（SourceRef 定义在 model.ts）。 */
export function toSourceRefs(refs: GenerationReference[]): SourceRef[] {
  return refs.map((ref) => {
    switch (ref.kind) {
      case 'asset':
        return { kind: 'asset', assetId: ref.assetId as string };
      case 'web':
        return { kind: 'web', imageUrl: ref.imageUrl as string };
      case 'local':
      default:
        return { kind: 'local', filename: ref.filename as string };
    }
  });
}

export interface SizeValidationResult {
  valid: boolean;
  reason?: string;
}

const FIXED_SIZE_PRESETS = new Set<string>([
  '1024x1024',
  '1536x1024',
  '1024x1536',
  '2048x2048',
  '2048x1152',
  '3840x2160',
  '2160x3840',
  'auto'
]);

/**
 * 校验 §4.3 自定义尺寸四规则（固定档位与 auto 视为合法）：
 * 1. 最大边长 ≤ 3840px
 * 2. 宽高两边像素均为 16 的倍数
 * 3. 长边 / 短边 ≤ 3:1
 * 4. 总像素范围：最小 655360 ～ 最大 8294400
 */
export function validateSize(size: string): SizeValidationResult {
  if (FIXED_SIZE_PRESETS.has(size)) {
    return { valid: true };
  }

  const match = /^(\d+)x(\d+)$/.exec(size.trim());
  if (!match) {
    return { valid: false, reason: '尺寸格式应为 WxH（如 1024x1024）' };
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const pixels = width * height;

  if (longEdge > 3840) {
    return { valid: false, reason: '最长边不能超过 3840px' };
  }
  if (width % 16 !== 0 || height % 16 !== 0) {
    return { valid: false, reason: '宽高必须是 16 的倍数' };
  }
  if (longEdge / shortEdge > 3) {
    return { valid: false, reason: '长宽比不能超过 3:1' };
  }
  if (pixels < 655360 || pixels > 8294400) {
    return { valid: false, reason: '总像素需在 655360 ~ 8294400 之间' };
  }

  return { valid: true };
}
