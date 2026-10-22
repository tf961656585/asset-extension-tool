import type { AssetRecord } from './model';
import type {
  CollectBlockReason,
  CollectTarget,
  GenerationReference,
  GenerationReferencePayload
} from './generation';

export const MESSAGE_TYPES = {
  SAVE_IMAGE: 'SAVE_IMAGE',
  SAVE_FEEDBACK: 'SAVE_FEEDBACK',
  GENERATION_SUBMIT: 'GENERATION_SUBMIT',
  GENERATION_CREATE_TASK: 'GENERATION_CREATE_TASK',
  GENERATION_CANCEL_TASK: 'GENERATION_CANCEL_TASK',
  GENERATION_FEEDBACK: 'GENERATION_FEEDBACK',
  /** 页面 → background：把网页图加入侧边栏当前聚焦任务。v3.10 */
  GENERATION_COLLECT_REFERENCE: 'GENERATION_COLLECT_REFERENCE',
  /** 页面 → background：查询当前是否有可加入的任务（决定是否先弹选择浮层）。v3.10 */
  GENERATION_COLLECT_TARGET_QUERY: 'GENERATION_COLLECT_TARGET_QUERY',
  /** background → sidepanel：查询当前聚焦任务的可加入状态。v3.10 */
  GENERATION_COLLECT_TARGET_REQUEST: 'GENERATION_COLLECT_TARGET_REQUEST',
  /** background → sidepanel：请求把网页图加入当前聚焦任务。v3.10 */
  GENERATION_COLLECT_REQUEST: 'GENERATION_COLLECT_REQUEST',
  /** sidepanel → background：中继回执（kind 区分 target / result）。v3.10 */
  GENERATION_COLLECT_REPLY: 'GENERATION_COLLECT_REPLY',
  /** background → 页面：右键菜单发起的收集结果回执（content script 据此弹 toast）。v3.10 */
  GENERATION_COLLECT_FEEDBACK: 'GENERATION_COLLECT_FEEDBACK'
} as const;

export interface SaveImagePayload {
  imageUrl: string;
  sourcePageUrl: string;
  sourceDomain?: string;
}

export interface SaveImageMessage {
  type: typeof MESSAGE_TYPES.SAVE_IMAGE;
  payload: SaveImagePayload;
}

export interface SaveFeedbackMessage {
  type: typeof MESSAGE_TYPES.SAVE_FEEDBACK;
  payload: {
    ok: boolean;
    message: string;
  };
}

/** sidepanel → background：携带完整参数（含参考图载荷 + taskId），background 据此做无状态请求。
 * references 为载荷态（GenerationReferencePayload，spec FR-16 第 6 条 v3.5）：
 * local 来源用 base64 字符串传递字节，web/asset 来源只携带 URL 由 background 回拉。
 * v3.9：只携带 modelRecordId，不携带 Base URL / Key / 协议 id / 远端型号（执行依据由 background 解析）。 */
export interface GenerationSubmitPayload {
  taskId: string;
  /** 模型记录 id（必填，spec §7.1）。background 据此解析连接、Key、协议与远端型号。 */
  modelRecordId: string;
  prompt: string;
  size: string;
  /** 用户选的画质（low/medium/high/auto；gemini 模型为空串，spec FR-17 v3.4）。 */
  quality: string;
  n: number;
  references: GenerationReferencePayload[];
}

export interface GenerationSubmitMessage {
  type: typeof MESSAGE_TYPES.GENERATION_SUBMIT;
  payload: GenerationSubmitPayload;
}

/**
 * 任意入口 → background：创建一个生图任务（每次入口均创建新任务，不追加、不合并）。
 * reference-first 携带首张参考图（进入 collecting），intent-first 携带空数组（idle 输入态）。
 */
export interface GenerationCreateTaskPayload {
  taskId: string;
  mode: 'reference-first' | 'intent-first';
  references: GenerationReference[];
}

export interface GenerationCreateTaskMessage {
  type: typeof MESSAGE_TYPES.GENERATION_CREATE_TASK;
  payload: GenerationCreateTaskPayload;
}

/** 任意入口 → background：取消某任务（若在飞，background 中止其 fetch）。 */
export interface GenerationCancelTaskPayload {
  taskId: string;
}

export interface GenerationCancelTaskMessage {
  type: typeof MESSAGE_TYPES.GENERATION_CANCEL_TASK;
  payload: GenerationCancelTaskPayload;
}

/**
 * 生图执行失败原因码（与 background resolveInvocation 的 InvocationErrorCode 对齐）。
 * 渲染层可用于稳定映射文案；message 始终携带可直接展示的中文文案。
 */
export type GenerationFailureReason =
  | 'model_not_found'
  | 'connection_not_found'
  | 'key_missing'
  | 'protocol_unsupported'
  | 'invalid_base_url'
  | 'invalid_params';

/** background → sidepanel：反馈气泡（提交 info / 完成 success / 失败 error），按 taskId 分发。
 * 「可重试态」由侧边栏将任务置回 collecting（保留 refs+prompt）表达，统一用 level: 'error' 携带可重试文案，不引入 retriable。 */
export interface GenerationFeedbackPayload {
  taskId: string;
  level: 'info' | 'success' | 'error';
  message: string;
  count?: number;
  /** 执行解析失败时的稳定原因码（仅 error 且由 resolveInvocation 拒绝时携带）。 */
  reason?: GenerationFailureReason;
}

export interface GenerationFeedbackMessage {
  type: typeof MESSAGE_TYPES.GENERATION_FEEDBACK;
  payload: GenerationFeedbackPayload;
}

/**
 * 页面 → background：把网页图加入侧边栏当前聚焦任务（v3.10）。
 * 与「生图入口」区别——入口每次新建任务，收集动作只往既有任务追加。
 * background 经 sidepanel port 中继，结果由 sendResponse 返回给页面侧（不经第二条回执消息）。
 */
export interface GenerationCollectReferencePayload {
  requestId: string;
  imageUrl: string;
  sourcePageUrl: string;
}

export interface GenerationCollectReferenceMessage {
  type: typeof MESSAGE_TYPES.GENERATION_COLLECT_REFERENCE;
  payload: GenerationCollectReferencePayload;
}

/** 页面 → background：查询当前是否有可加入的任务（角标点击时决定是否先弹选择浮层）。 */
export type GenerationCollectTargetQueryMessage = {
  type: typeof MESSAGE_TYPES.GENERATION_COLLECT_TARGET_QUERY;
};

/** background → sidepanel：请求把网页图加入当前聚焦任务。 */
export interface GenerationCollectRequestPayload {
  requestId: string;
  imageUrl: string;
  sourcePageUrl: string;
}

export interface GenerationCollectRequestMessage {
  type: typeof MESSAGE_TYPES.GENERATION_COLLECT_REQUEST;
  payload: GenerationCollectRequestPayload;
}

/** background → sidepanel：查询当前聚焦任务的可加入状态。 */
export interface GenerationCollectTargetRequestPayload {
  requestId: string;
}

export interface GenerationCollectTargetRequestMessage {
  type: typeof MESSAGE_TYPES.GENERATION_COLLECT_TARGET_REQUEST;
  payload: GenerationCollectTargetRequestPayload;
}

/**
 * sidepanel → background：中继回执（两种查询共用一条消息，按 kind 区分）。
 * background 收到后按 requestId 找到挂起的页面侧请求并 sendResponse，不缓存任务状态。
 */
export interface GenerationCollectReplyPayload {
  requestId: string;
  kind: 'target' | 'result';
  /** kind=target 时携带可加入状态。 */
  target?: CollectTarget;
  /** kind=result 时携带加入结果。 */
  result?: CollectResult;
}

export interface GenerationCollectReplyMessage {
  type: typeof MESSAGE_TYPES.GENERATION_COLLECT_REPLY;
  payload: GenerationCollectReplyPayload;
}

/**
 * 加入结果。`outcome` 区分四种可展示结果，避免页面侧从文案反推状态：
 * added（已加入）/ duplicate（已存在）/ fellBackToNewTask（无可加任务，已新建并加入）/ blocked（明确拒绝）。
 */
export interface CollectResult {
  outcome: 'added' | 'duplicate' | 'fellBackToNewTask' | 'blocked';
  /** 可直接展示的中文文案，由侧边栏按自身状态生成。 */
  message: string;
  taskLabel?: string;
  refCount?: number;
  maxRefs?: number;
  blockReason?: CollectBlockReason;
}

/** background → 页面：右键菜单发起的收集结果回执（content script 据此弹 toast）。 */
export interface GenerationCollectFeedbackMessage {
  type: typeof MESSAGE_TYPES.GENERATION_COLLECT_FEEDBACK;
  payload: {
    ok: boolean;
    message: string;
  };
}

export type RuntimeMessage =
  | SaveImageMessage
  | SaveFeedbackMessage
  | GenerationSubmitMessage
  | GenerationCreateTaskMessage
  | GenerationCancelTaskMessage
  | GenerationFeedbackMessage
  | GenerationCollectReferenceMessage
  | GenerationCollectTargetQueryMessage
  | GenerationCollectTargetRequestMessage
  | GenerationCollectRequestMessage
  | GenerationCollectReplyMessage
  | GenerationCollectFeedbackMessage;

function isGenerationReferencePayload(value: unknown): value is GenerationReferencePayload {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const ref = value as Record<string, unknown>;
  if (ref.kind !== 'asset' && ref.kind !== 'web' && ref.kind !== 'local') {
    return false;
  }
  return ['imageUrl', 'assetId', 'filename', 'base64', 'mimeType'].every(
    (field) => ref[field] === undefined || typeof ref[field] === 'string'
  );
}

/**
 * GENERATION_SUBMIT 载荷运行时校验（消息来自渲染层，TypeScript 类型不构成运行时保证）。
 * 只校验结构与类型；prompt / size / quality / n / 参考图上限的业务校验归 resolveInvocation。
 */
export function isGenerationSubmitPayload(value: unknown): value is GenerationSubmitPayload {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const payload = value as Record<string, unknown>;
  return (
    typeof payload.taskId === 'string' &&
    payload.taskId.trim().length > 0 &&
    typeof payload.modelRecordId === 'string' &&
    payload.modelRecordId.trim().length > 0 &&
    typeof payload.prompt === 'string' &&
    typeof payload.size === 'string' &&
    typeof payload.quality === 'string' &&
    typeof payload.n === 'number' &&
    Array.isArray(payload.references) &&
    payload.references.every(isGenerationReferencePayload)
  );
}

export type SaveImageResponse =
  | {
      ok: true;
      asset: AssetRecord;
    }
  | {
      ok: false;
      error: string;
    };
