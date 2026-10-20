/**
 * 设置页「服务商与模型」的纯校验 / 格式化函数（可单测，不依赖 DOM 或共享存储）。
 *
 * 校验口径：
 * - Base URL 必须是 HTTPS 绝对地址，不含用户名/密码、query、fragment，去掉末尾 `/` 且保留版本路径；
 * - 连接名称添加时可留空（由存储层按主机名生成），填写时 1–40 字符；
 * - 模型远端型号 1–128 字符，显示名可留空（默认取远端型号），能力上限不得超过协议上限；
 * - `supportsReferenceImage=false` 时参考图上限固定为 0。
 */

/** 协议声明的模型能力上限。 */
export interface ProtocolCapabilities {
  maxRefs: number;
  maxN: number;
}

export interface ConnectionDraft {
  name: string;
  baseUrl: string;
  apiKey: string;
}

export interface ConnectionFieldErrors {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  /** 共享层写入失败时的中文错误。 */
  form?: string;
}

export interface ValidatedConnection {
  /** `undefined` 表示留空，由共享层按主机名生成名称。 */
  name?: string;
  baseUrl: string;
  apiKey: string;
}

export type ConnectionValidationResult =
  | { ok: true; value: ValidatedConnection }
  | { ok: false; errors: ConnectionFieldErrors };

export interface BaseUrlValidationResult {
  ok: true;
  /** 规范化后的地址（去首尾空白、去末尾 `/`、保留 path）。 */
  value: string;
  host: string;
}

export type BaseUrlValidation =
  | BaseUrlValidationResult
  | { ok: false; error: string };

export interface ModelDraft {
  protocolId: string;
  remoteModelId: string;
  displayName: string;
  supportsReferenceImage: boolean;
  /** 表单输入原值，允许空串。 */
  maxRefs: string;
  maxN: string;
}

export interface ModelFieldErrors {
  protocolId?: string;
  remoteModelId?: string;
  displayName?: string;
  maxRefs?: string;
  maxN?: string;
  /** 共享层写入失败时的中文错误。 */
  form?: string;
}

export interface ValidatedModel {
  protocolId: string;
  remoteModelId: string;
  /** `undefined` 表示留空，由共享层默认取远端型号。 */
  displayName?: string;
  supportsReferenceImage: boolean;
  maxRefs: number;
  maxN: number;
}

export type ModelValidationResult =
  | { ok: true; value: ValidatedModel }
  | { ok: false; errors: ModelFieldErrors };

/** 规范化并校验 Base URL（spec §5.2）。 */
export function validateBaseUrl(raw: string): BaseUrlValidation {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: '请填写 Base URL。' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Base URL 不是有效的网址，请检查格式。' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Base URL 必须以 https:// 开头。' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Base URL 不能包含用户名或密码。' };
  }
  if (parsed.search) {
    return { ok: false, error: 'Base URL 不能包含查询参数（? 后的内容）。' };
  }
  if (parsed.hash) {
    return { ok: false, error: 'Base URL 不能包含锚点（# 后的内容）。' };
  }

  const value = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  return { ok: true, value, host: parsed.host };
}

/** 从 Base URL 取主机名用于列表展示；解析失败时退回原字符串。 */
export function formatBaseUrlHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.trim();
  }
}

/** 校验连接名称；留空合法（添加时由主机名生成），填写时 1–40 字符。 */
export function validateConnectionName(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length > 40) {
    return '名称最多 40 个字符。';
  }
  return null;
}

/** 添加服务商表单校验。 */
export function validateConnectionDraft(draft: ConnectionDraft): ConnectionValidationResult {
  const errors: ConnectionFieldErrors = {};

  const nameError = validateConnectionName(draft.name);
  if (nameError) {
    errors.name = nameError;
  }

  const baseUrl = validateBaseUrl(draft.baseUrl);
  if (!baseUrl.ok) {
    errors.baseUrl = baseUrl.error;
  }

  const apiKey = draft.apiKey.trim();
  if (!apiKey) {
    errors.apiKey = '请填写 API Key。';
  }

  if (Object.keys(errors).length > 0 || !baseUrl.ok) {
    return { ok: false, errors };
  }

  const name = draft.name.trim();
  return {
    ok: true,
    value: {
      ...(name ? { name } : {}),
      baseUrl: baseUrl.value,
      apiKey
    }
  };
}

/** 模型能力摘要（模型表列）。 */
export function formatAbilitySummary(model: {
  supportsReferenceImage: boolean;
  maxRefs: number;
  maxN: number;
}): string {
  const nPart = `单次≤${model.maxN}`;
  if (!model.supportsReferenceImage) {
    return `仅文生图 · ${nPart}`;
  }
  return `参考图≤${model.maxRefs} · ${nPart}`;
}

/** 按协议上限生成添加模型表单的默认值。 */
export function protocolDefaultLimits(capabilities: ProtocolCapabilities): {
  maxRefs: string;
  maxN: string;
} {
  return {
    maxRefs: String(capabilities.maxRefs),
    maxN: String(capabilities.maxN)
  };
}

function parseIntegerInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/** 添加 / 编辑模型表单校验；`capabilities` 为当前接口协议的上限。 */
export function validateModelDraft(
  draft: ModelDraft,
  capabilities: ProtocolCapabilities | null
): ModelValidationResult {
  const errors: ModelFieldErrors = {};

  const protocolId = draft.protocolId.trim();
  if (!protocolId) {
    errors.protocolId = '请选择接口类型。';
  } else if (!capabilities) {
    errors.protocolId = '接口类型无效，请重新选择。';
  }

  const remoteModelId = draft.remoteModelId.trim();
  if (!remoteModelId) {
    errors.remoteModelId = '请填写远端模型 ID。';
  } else if (remoteModelId.length > 128) {
    errors.remoteModelId = '远端模型 ID 最多 128 个字符。';
  }

  const displayName = draft.displayName.trim();
  if (displayName.length > 60) {
    errors.displayName = '显示名最多 60 个字符。';
  }

  let maxRefs = 0;
  if (draft.supportsReferenceImage && capabilities) {
    const parsed = parseIntegerInput(draft.maxRefs);
    if (parsed === null || parsed < 0 || parsed > capabilities.maxRefs) {
      errors.maxRefs = `参考图上限需为 0–${capabilities.maxRefs} 的整数。`;
    } else {
      maxRefs = parsed;
    }
  }

  let maxN = 0;
  if (capabilities) {
    const parsed = parseIntegerInput(draft.maxN);
    if (parsed === null || parsed < 1 || parsed > capabilities.maxN) {
      errors.maxN = `单次数量上限需为 1–${capabilities.maxN} 的整数。`;
    } else {
      maxN = parsed;
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      protocolId,
      remoteModelId,
      ...(displayName ? { displayName } : {}),
      supportsReferenceImage: draft.supportsReferenceImage,
      maxRefs: draft.supportsReferenceImage ? maxRefs : 0,
      maxN
    }
  };
}
