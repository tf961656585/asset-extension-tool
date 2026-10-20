import type { ProtocolId } from '../shared/protocols';

export interface ParsedGenerationImage {
  b64: string;
  sha256?: string;
}

export interface ParsedGenerationResponse {
  images: ParsedGenerationImage[];
  outputFormat?: string;
  usage?: unknown;
}

interface RawError {
  code?: string;
  message?: string;
  type?: string;
  /** Gemini 错误用 status 字段表达错误类别（如 'INVALID_ARGUMENT'）。 */
  status?: string;
}

function readError(json: unknown): RawError | undefined {
  if (!json || typeof json !== 'object') {
    return undefined;
  }
  const error = (json as { error?: unknown }).error;
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  return error as RawError;
}

/**
 * 失败判定：error.code / error.message / error.type / error.status 任一非空即失败。
 * 覆盖两种格式：OpenAI 兼容（code/message/type）与 Google 原生（code/message/status）。不依赖 HTTP 状态码。
 */
export function isErrorResponse(json: unknown): boolean {
  const error = readError(json);
  if (!error) {
    return false;
  }
  return Boolean(error.code || error.message || error.type || error.status);
}

/** 脱敏提取错误信息（不回显 API Key）。 */
export function extractErrorMessage(json: unknown): string {
  const error = readError(json);
  if (!error) {
    return '生图失败，未知错误';
  }
  return String(error.message ?? error.code ?? error.status ?? error.type ?? '未知错误');
}

/**
 * 解析生图响应，按协议分流（spec §4.1）。
 *
 * - openai-images-v1：从 `data[].b64_json` 提取图片数组 + output_format + usage。
 * - gemini-image-v1：从 `candidates[].content.parts[]` 提取 inlineData.data（base64）+ mimeType，
 *   合并所有 candidate 的图片 part（Gemini 单次响应可能含多个 inlineData）。
 *
 * 调用方需保证协议与实际请求一致（由 background handleGenerationSubmit 按 resolveInvocation 传入）。
 */
export function parseGenerationResponse(
  json: unknown,
  protocolId: ProtocolId = 'openai-images-v1'
): ParsedGenerationResponse {
  if (protocolId === 'gemini-image-v1') {
    return parseGoogleResponse(json);
  }
  return parseOpenAIResponse(json);
}

/** OpenAI 兼容格式解析：data[].b64_json。 */
function parseOpenAIResponse(json: unknown): ParsedGenerationResponse {
  const data = ((json as { data?: unknown[] })?.data ?? []) as Array<{
    b64_json?: unknown;
    sha256?: unknown;
  }>;
  const images: ParsedGenerationImage[] = data
    .filter((item) => typeof item?.b64_json === 'string')
    .map((item) => ({
      b64: item.b64_json as string,
      sha256: item.sha256 as string | undefined
    }));

  return {
    images,
    outputFormat: (json as { output_format?: unknown }).output_format as string | undefined,
    usage: (json as { usage?: unknown }).usage
  };
}

/**
 * Google Gemini 格式解析：candidates[].content.parts[].inlineData。
 *
 * 字段命名为 Google REST 原生 camelCase（`inlineData`/`mimeType`/`thoughtSignature`），
 * 非 Python SDK 风格的 snake_case（`inline_data`/`mime_type`）。扩展直接 fetch REST 端点，
 * 响应未经任何命名转换。schema 参考 https://ai.google.dev/api/caching#Part。
 *
 * 响应结构（REST wire format）：
 * ```
 * {
 *   candidates: [{
 *     content: {
 *       parts: [
 *         { text: "..." },                                          // 文本 part，跳过
 *         { thoughtSignature: "...", thought: true, text: "..." },  // 思考签名 part，跳过
 *         { inlineData: { mimeType, data } }                        // 图片 part，提取 data（base64）
 *       ]
 *     }
 *   }]
 * }
 * ```
 * 按 inlineData 字段存在性提取图片 part，text / thoughtSignature / thought 等非图片 part
 * 因不含 inlineData 字段被天然跳过，无需显式类型过滤。
 * usageMetadata 为 Gemini 的用量字段，透传供后续统计。
 */
function parseGoogleResponse(json: unknown): ParsedGenerationResponse {
  const candidates = (json as { candidates?: unknown[] })?.candidates ?? [];
  const images: ParsedGenerationImage[] = [];
  let outputFormat: string | undefined;

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }
    const parts = ((candidate as { content?: { parts?: unknown[] } }).content?.parts) ?? [];
    for (const part of parts) {
      if (!part || typeof part !== 'object') {
        continue;
      }
      const inlineData = (part as { inlineData?: { data?: unknown; mimeType?: unknown } }).inlineData;
      if (inlineData && typeof inlineData.data === 'string') {
        images.push({ b64: inlineData.data });
        // 保留上游返回的图片 MIME（决定落盘扩展名与 Blob 类型）；多图不一致时取第一张。
        if (!outputFormat && typeof inlineData.mimeType === 'string') {
          const subtype = inlineData.mimeType.split('/')[1];
          if (subtype) {
            outputFormat = subtype === 'jpg' ? 'jpeg' : subtype;
          }
        }
      }
    }
  }

  return {
    images,
    outputFormat,
    usage: (json as { usageMetadata?: unknown }).usageMetadata
  };
}
