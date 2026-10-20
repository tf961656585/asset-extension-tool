/**
 * 内置生图协议描述符（v3.9，spec model-access-architecture-v1 §4）。
 *
 * 协议是不可变的执行契约：鉴权头、相对端点、请求/响应形态与参数 schema 均由代码版本提供，
 * 用户不能新增、修改或覆盖。渲染层只读本文件渲染参数面板；执行层按协议 id 选择请求构建器。
 */

import { validateSize } from './generation';

export type ProtocolId = 'openai-images-v1' | 'gemini-image-v1';

/** 血缘中的协议族标识（v3.8 保留，旧资产可缺失并按 openai-image 兜底）。 */
export type LegacyProvider = 'openai-image' | 'google-image';

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * 协议尺寸参数形态：
 * - preset：固定档位 + 可选自定义（OpenAI Images）
 * - ratio-size：比例 × 清晰度双维度，提交时归一为 `<ratio>@<size>`（Gemini Image）
 */
export type ProtocolSizeSpec =
  | { kind: 'preset'; options: SelectOption[]; allowCustom: boolean }
  | { kind: 'ratio-size'; ratios: string[]; imageSizes: string[] };

export interface ProtocolDescriptor {
  id: ProtocolId;
  label: string;
  provider: LegacyProvider;
  auth: { headerName: string; prefix: string };
  params: {
    size: ProtocolSizeSpec;
    quality: SelectOption[];
    maxN: number;
    maxRefs: number;
    defaultSize: string;
    defaultQuality: string;
    defaultN: number;
  };
}

/** OpenAI Images 固定尺寸档位（7 个 WxH + auto，规格以 image-generation-api.md §4.3 为准）。 */
const OPENAI_SIZE_OPTIONS: SelectOption[] = [
  { value: '1024x1024', label: '1024x1024' },
  { value: '1536x1024', label: '1536x1024' },
  { value: '1024x1536', label: '1024x1536' },
  { value: '2048x2048', label: '2048x2048' },
  { value: '2048x1152', label: '2048x1152' },
  { value: '3840x2160', label: '3840x2160' },
  { value: '2160x3840', label: '2160x3840' },
  { value: 'auto', label: 'auto' }
];

const OPENAI_QUALITY_OPTIONS: SelectOption[] = [
  { value: 'auto', label: 'auto' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' }
];

/** Gemini aspectRatio 枚举（14 档，Google REST 原生字段值）。 */
const GEMINI_RATIOS: string[] = [
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
  '1:4',
  '4:1',
  '1:8',
  '8:1'
];

/** Gemini imageSize 枚举（4 档清晰度）。 */
const GEMINI_IMAGE_SIZES: string[] = ['512', '1K', '2K', '4K'];

export const PROTOCOLS: ProtocolDescriptor[] = [
  {
    id: 'openai-images-v1',
    label: 'OpenAI Images',
    provider: 'openai-image',
    auth: { headerName: 'Authorization', prefix: 'Bearer ' },
    params: {
      size: { kind: 'preset', options: OPENAI_SIZE_OPTIONS, allowCustom: true },
      quality: OPENAI_QUALITY_OPTIONS,
      maxN: 10,
      maxRefs: 16,
      defaultSize: 'auto',
      defaultQuality: 'auto',
      defaultN: 1
    }
  },
  {
    id: 'gemini-image-v1',
    label: 'Gemini Image',
    provider: 'google-image',
    auth: { headerName: 'x-goog-api-key', prefix: '' },
    params: {
      size: { kind: 'ratio-size', ratios: GEMINI_RATIOS, imageSizes: GEMINI_IMAGE_SIZES },
      quality: [],
      maxN: 1,
      maxRefs: 3,
      defaultSize: '1:1@1K',
      defaultQuality: '',
      defaultN: 1
    }
  }
];

const PROTOCOLS_BY_ID: Record<string, ProtocolDescriptor> = PROTOCOLS.reduce(
  (acc, protocol) => {
    acc[protocol.id] = protocol;
    return acc;
  },
  {} as Record<string, ProtocolDescriptor>
);

/** 按协议 id 取描述符；未命中返回 undefined（不兜底到默认协议）。 */
export function getProtocol(id: string | undefined | null): ProtocolDescriptor | undefined {
  if (!id) {
    return undefined;
  }
  return PROTOCOLS_BY_ID[id];
}

/** 内置协议清单（副本，避免调用方改写模块常量）。 */
export function listProtocols(): ProtocolDescriptor[] {
  return PROTOCOLS.slice();
}

export function isProtocolId(id: string): id is ProtocolId {
  return Object.prototype.hasOwnProperty.call(PROTOCOLS_BY_ID, id);
}

/**
 * 解析 `<ratio>@<size>` 尺寸串（ratio-size 协议的归一格式）。
 * 仅做严格格式校验：比例必须为 `数字:数字`，清晰度必须为非空字母数字段；失败返回 null。
 * 比例 / 清晰度是否在协议枚举内由 validateSizeForProtocol 判定（枚举属于具体协议描述符）。
 */
export function parseRatioSize(size: string): { aspectRatio: string; imageSize: string } | null {
  const match = /^(\d+:\d+)@([A-Za-z0-9]+)$/.exec(size);
  if (!match) {
    return null;
  }
  return { aspectRatio: match[1], imageSize: match[2] };
}

function validateRatioSize(size: string): boolean {
  const parsed = parseRatioSize(size);
  if (!parsed) {
    return false;
  }
  const spec = getProtocol('gemini-image-v1')?.params.size;
  if (!spec || spec.kind !== 'ratio-size') {
    return false;
  }
  return spec.ratios.includes(parsed.aspectRatio) && spec.imageSizes.includes(parsed.imageSize);
}

/**
 * 校验尺寸是否符合指定协议语法。
 * - openai-images-v1：固定档位 / `auto` / 满足四条约束的自定义 `WxH`（复用 §4.3 原规则）
 * - gemini-image-v1：`<ratio>@<size>` 且 ratio 与清晰度均在枚举内
 */
export function validateSizeForProtocol(protocolId: ProtocolId, size: string): boolean {
  if (protocolId === 'openai-images-v1') {
    return validateSize(size).valid;
  }
  if (protocolId === 'gemini-image-v1') {
    return validateRatioSize(size);
  }
  return false;
}

/**
 * 按协议维度与模型能力生成参数默认值。
 * `n` 不超过模型声明上限（模型记录 maxN 必须 ≤ 协议上限）。
 */
export function defaultParams(
  protocol: ProtocolDescriptor,
  caps: { maxN: number }
): { size: string; quality: string; n: number } {
  const cap = Number.isFinite(caps.maxN) ? Math.floor(caps.maxN) : 1;
  return {
    size: protocol.params.defaultSize,
    quality: protocol.params.defaultQuality,
    n: Math.min(protocol.params.defaultN, Math.max(1, cap))
  };
}
