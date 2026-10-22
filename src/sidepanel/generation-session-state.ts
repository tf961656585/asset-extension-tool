import type { GenerationReference, GenerationReferencePayload } from '../shared/generation';
import type { ProtocolId } from '../shared/protocols';
import type { GenerationModelRecord } from '../shared/generation-config';

/** 任务状态集严格 4 态，与 FR-15 §5 一致；「可重试态」= 状态回到 collecting/idle 且 refs+prompt 保留。 */
export type GenerationTaskStatus = 'idle' | 'collecting' | 'generating' | 'done';

export type FeedbackLevel = 'info' | 'success' | 'error';

export interface SessionFeedback {
  level: FeedbackLevel;
  message: string;
  count?: number;
}

export interface HistoryItem {
  id: string;
  imageUrl: string;
  prompt: string;
  size: string;
  quality: string;
  n: number;
  createdAt: string;
  sourceRefsCount: number;
}

/** 协议参数默认值（FR-17：size / quality / n 由协议描述符提供）。 */
export interface GenerationParamsDefaults {
  size: string;
  quality: string;
  n: number;
}

/** 模型绑定：任务内部保存的协议/能力快照，用于参数重置、参考图配额与提交校验。 */
export interface TaskModelBinding {
  modelRecordId: string;
  protocolId: ProtocolId;
  maxRefs: number;
  maxN: number;
  supportsReferenceImage: boolean;
  defaults: GenerationParamsDefaults;
}

const EMPTY_DEFAULTS: GenerationParamsDefaults = {
  size: 'auto',
  quality: 'auto',
  n: 1
};

/**
 * 单任务：侧边栏独占持有（spec FR-15 第 6 条）。background 无状态，仅按 taskId 回传 feedback。
 * v3.9：执行依据只有 `modelRecordId`；协议 id 与能力字段只是渲染层快照，不进入提交载荷。
 */
export interface GenerationTask {
  taskId: string;
  status: GenerationTaskStatus;
  references: GenerationReference[];
  /** 模型记录 id（v3.9）。null = 尚未选择/没有可用模型；提交前必须非空。 */
  modelRecordId: string | null;
  /** 当前模型的协议 id（用于参数面板渲染与参数校验）；无模型为 null。 */
  protocolId: ProtocolId | null;
  /** 当前模型允许的参考图上限（模型记录 maxRefs）。无模型为 0。 */
  maxRefs: number;
  /** 当前模型允许的单次数量上限（模型记录 maxN）。无模型为 1。 */
  maxN: number;
  /** 当前模型是否支持参考图。无模型为 false。 */
  supportsReferenceImage: boolean;
  /** 当前模型的协议参数默认值；切换模型或复用参数回落时使用。 */
  defaults: GenerationParamsDefaults;
  prompt: string;
  size: string;
  quality: string;
  n: number;
  feedback: SessionFeedback | null;
  createdAt: number;
  /** 进入 generating 的毫秒时间戳（仅生成计时用，与 createdAt「任务创建时刻」语义不同）；非 generating 态为 null。 */
  startedAt: number | null;
  history: HistoryItem[];
}

export interface GenerationTasksState {
  tasks: Record<string, GenerationTask>;
  activeTaskId: string | null;
}

/** 创建任务时可选携带的模型绑定（弹窗入口在配置未加载时可缺省，加载后由侧边栏补齐）。 */
export type OptionalTaskModelBinding = Partial<Omit<TaskModelBinding, 'defaults'>> & {
  defaults?: Partial<GenerationParamsDefaults>;
};

export type GenerationTasksAction =
  | ({
      type: 'create-task';
      taskId: string;
      references: GenerationReference[];
      mode: 'reference-first' | 'intent-first';
    } & OptionalTaskModelBinding)
  | { type: 'add-reference'; taskId: string; reference: GenerationReference }
  | { type: 'remove-reference'; taskId: string; refId: string }
  | { type: 'set-reference-bytes'; taskId: string; refId: string; bytes: number }
  | { type: 'set-params'; taskId: string; params: { prompt?: string; size?: string; quality?: string; n?: number } }
  /**
   * 切换任务生图模型（v3.9）：设置 modelRecordId 并按新协议/能力重置
   * size / quality / n（取 defaults，n 再按 maxN 钳制）；
   * `supportsReferenceImage=false` 时清空参考图，否则超 maxRefs 截断。
   */
  | ({
      type: 'set-model';
      taskId: string;
    } & TaskModelBinding)
  | { type: 'start-generating'; taskId: string }
  | { type: 'finish-generating'; taskId: string }
  | { type: 'fail-task'; taskId: string }
  | { type: 'set-feedback'; taskId: string; feedback: SessionFeedback | null }
  | { type: 'clear-task'; taskId: string }
  | { type: 'set-active'; taskId: string | null };

let referenceSeq = 0;
function nextReferenceId(): string {
  referenceSeq += 1;
  return `ref_${referenceSeq}_${Date.now().toString(36)}`;
}

export function createInitialGenerationTasks(): GenerationTasksState {
  return {
    tasks: {},
    activeTaskId: null
  };
}

function withReferenceIds(refs: GenerationReference[]): GenerationReference[] {
  return refs.map((ref) => (ref.id ? ref : { ...ref, id: nextReferenceId() }));
}

/** 钳制数量：整数且落在 [1, maxN]；非法值回落到 1。 */
function clampN(value: number, maxN: number): number {
  const upper = Number.isFinite(maxN) && maxN >= 1 ? Math.floor(maxN) : 1;
  if (!Number.isInteger(value)) {
    return 1;
  }
  return Math.min(Math.max(value, 1), upper);
}

function resolveDefaults(
  defaults: Partial<GenerationParamsDefaults> | undefined,
  maxN: number
): GenerationParamsDefaults {
  const source = defaults ?? EMPTY_DEFAULTS;
  return {
    size: typeof source.size === 'string' ? source.size : EMPTY_DEFAULTS.size,
    quality: typeof source.quality === 'string' ? source.quality : EMPTY_DEFAULTS.quality,
    n: clampN(source.n ?? EMPTY_DEFAULTS.n, maxN)
  };
}

/** 按模型能力裁剪参考图：不支持参考图 → 清空；超 maxRefs → 截断。 */
function applyReferenceCapability(
  references: GenerationReference[],
  supportsReferenceImage: boolean,
  maxRefs: number
): GenerationReference[] {
  if (!supportsReferenceImage) {
    return [];
  }
  const cap = Number.isFinite(maxRefs) && maxRefs >= 0 ? Math.floor(maxRefs) : 0;
  return references.length > cap ? references.slice(0, cap) : references;
}

/**
 * 多任务状态机：侧边栏独占。背景为无状态执行方，按 taskId 路由 feedback。
 * 状态转换：
 * - create-task：references 非空 → collecting（图生图态）、空 → idle（文生图输入态）
 * - add-reference → collecting；remove-reference 清空 → idle
 * - set-reference-bytes：异步回拉字节后回填单张参考图 bytes（供配额统计）
 * - start-generating → generating（写 startedAt 计时起点）；finish-generating → done（保留 refs+prompt，清 startedAt）
 * - fail-task → 参考图为空回 idle、否则回 collecting（保留 refs+prompt，可重试；清 startedAt）
 * - clear-task：从 Map 删除该任务
 * 状态集严格 4 态，不引入第 5 态或 retriable level（可重试由 idle/collecting + refs/prompt 保留表达）。
 */
export function generationTasksReducer(
  state: GenerationTasksState,
  action: GenerationTasksAction
): GenerationTasksState {
  switch (action.type) {
    case 'create-task': {
      const hasModel = typeof action.modelRecordId === 'string' && action.modelRecordId.length > 0;
      const supportsReferenceImage = hasModel ? action.supportsReferenceImage === true : false;
      const maxRefs = hasModel && typeof action.maxRefs === 'number' ? action.maxRefs : 0;
      const maxN = hasModel && typeof action.maxN === 'number' ? action.maxN : 1;
      const defaults = resolveDefaults(action.defaults, maxN);
      const initialReferences = withReferenceIds(action.references);
      // 显式携带模型能力时按能力裁剪；未携带（配置尚未加载）时保留入口带来的参考图，
      // 等配置加载后由 set-model 统一裁剪，避免 reference-first 入口丢图。
      const references =
        hasModel && action.supportsReferenceImage !== undefined
          ? applyReferenceCapability(initialReferences, supportsReferenceImage, maxRefs)
          : initialReferences;
      const newTask: GenerationTask = {
        taskId: action.taskId,
        status: references.length === 0 ? 'idle' : 'collecting',
        references,
        modelRecordId: hasModel ? action.modelRecordId! : null,
        protocolId: hasModel && action.protocolId ? action.protocolId : null,
        maxRefs: hasModel ? maxRefs : 0,
        maxN,
        supportsReferenceImage,
        defaults,
        prompt: '',
        size: defaults.size,
        quality: defaults.quality,
        n: defaults.n,
        feedback: null,
        createdAt: Date.now(),
        startedAt: null,
        history: []
      };
      return {
        ...state,
        tasks: { ...state.tasks, [action.taskId]: newTask },
        activeTaskId: action.taskId
      };
    }

    case 'add-reference': {
      const task = state.tasks[action.taskId];
      if (!task) {
        return state;
      }
      // 能力门禁：无模型 / 不支持参考图 / 已达模型 maxRefs 时拒绝加入（UI 同时置灰入口）。
      if (!task.modelRecordId || !task.supportsReferenceImage) {
        return state;
      }
      if (task.references.length >= task.maxRefs) {
        return state;
      }
      const references = [...task.references, { ...action.reference, id: nextReferenceId() }];
      const status = task.status === 'generating' ? 'generating' : 'collecting';
      return {
        ...state,
        tasks: { ...state.tasks, [action.taskId]: { ...task, references, status } }
      };
    }

    case 'remove-reference': {
      const task = state.tasks[action.taskId];
      if (!task) {
        return state;
      }
      const references = task.references.filter((ref) => ref.id !== action.refId);
      const status =
        task.status === 'generating'
          ? 'generating'
          : references.length === 0
            ? 'idle'
            : 'collecting';
      return {
        ...state,
        tasks: { ...state.tasks, [action.taskId]: { ...task, references, status } }
      };
    }

    case 'set-reference-bytes': {
      const task = state.tasks[action.taskId];
      if (!task) {
        return state;
      }
      // 异步回拉字节后回填：只更新匹配 refId 的参考图，不触碰其余状态。
      const references = task.references.map((ref) =>
        ref.id === action.refId ? { ...ref, bytes: action.bytes } : ref
      );
      return {
        ...state,
        tasks: { ...state.tasks, [action.taskId]: { ...task, references } }
      };
    }

    case 'set-params': {
      const task = state.tasks[action.taskId];
      if (!task) {
        return state;
      }
      return {
        ...state,
        tasks: {
          ...state.tasks,
          [action.taskId]: {
            ...task,
            prompt: action.params.prompt ?? task.prompt,
            size: action.params.size ?? task.size,
            quality: action.params.quality ?? task.quality,
            n: action.params.n ?? task.n
          }
        }
      };
    }

    case 'set-model': {
      const task = state.tasks[action.taskId];
      if (!task) {
        return state;
      }
      const defaults = resolveDefaults(action.defaults, action.maxN);
      const supportsReferenceImage = action.supportsReferenceImage === true;
      const references = applyReferenceCapability(
        task.references,
        supportsReferenceImage,
        action.maxRefs
      );
      // 截断/清空后参考图为空 → idle；generating 态保持（不应在生成中切模型，保守不破坏）。
      const status =
        task.status === 'generating'
          ? 'generating'
          : references.length === 0
            ? 'idle'
            : 'collecting';
      return {
        ...state,
        tasks: {
          ...state.tasks,
          [action.taskId]: {
            ...task,
            modelRecordId: action.modelRecordId,
            protocolId: action.protocolId,
            maxRefs: Math.max(0, Math.floor(action.maxRefs)),
            maxN: Math.max(1, Math.floor(action.maxN)),
            supportsReferenceImage,
            defaults,
            size: defaults.size,
            quality: defaults.quality,
            n: defaults.n,
            references,
            status
          }
        }
      };
    }

    case 'start-generating': {
      const task = state.tasks[action.taskId];
      if (!task) {
        return state;
      }
      return {
        ...state,
        tasks: {
          ...state.tasks,
          [action.taskId]: {
            ...task,
            status: 'generating',
            startedAt: Date.now(),
            feedback: { level: 'info', message: '生成中…' }
          }
        }
      };
    }

    case 'finish-generating': {
      const task = state.tasks[action.taskId];
      if (!task) {
        return state;
      }
      return {
        ...state,
        tasks: { ...state.tasks, [action.taskId]: { ...task, status: 'done', startedAt: null } }
      };
    }

    case 'fail-task': {
      const task = state.tasks[action.taskId];
      if (!task) {
        return state;
      }
      // 回可重试态：无参考图回 idle（文生图），有参考图回 collecting；清出生成计时。
      return {
        ...state,
        tasks: {
          ...state.tasks,
          [action.taskId]: {
            ...task,
            status: task.references.length === 0 ? 'idle' : 'collecting',
            startedAt: null
          }
        }
      };
    }

    case 'set-feedback': {
      const task = state.tasks[action.taskId];
      if (!task) {
        return state;
      }
      return {
        ...state,
        tasks: { ...state.tasks, [action.taskId]: { ...task, feedback: action.feedback } }
      };
    }

    case 'clear-task': {
      const tasks = { ...state.tasks };
      delete tasks[action.taskId];
      const activeTaskId =
        state.activeTaskId === action.taskId
          ? (Object.keys(tasks)[0] ?? null)
          : state.activeTaskId;
      return { ...state, tasks, activeTaskId };
    }

    case 'set-active':
      return { ...state, activeTaskId: action.taskId };

    default:
      return state;
  }
}

/** 阶段词：状态位只回答「到哪一步了」，idle 与 collecting 同为待生成。 */
export type TaskStageLabel = '待生成' | '生成中' | '已完成';

export function taskStageLabel(status: GenerationTaskStatus): TaskStageLabel {
  switch (status) {
    case 'generating':
      return '生成中';
    case 'done':
      return '已完成';
    default:
      return '待生成';
  }
}

/** 模式词：一级状态之后的二级信息，参考图为空即文生图。 */
export function taskModeLabel(referenceCount: number): '文生图' | '图生图' {
  return referenceCount > 0 ? '图生图' : '文生图';
}

/** 状态位文案：阶段在前、模式在后（如「待生成 · 图生图」）。 */
export function taskStatusText(task: Pick<GenerationTask, 'status' | 'references'>): string {
  return `${taskStageLabel(task.status)} · ${taskModeLabel(task.references.length)}`;
}

/** 在飞（generating）任务数，用于并发计数。 */
export function countGenerating(tasks: Record<string, GenerationTask>): number {
  return Object.values(tasks).filter((task) => task.status === 'generating').length;
}

/** 是否可发起新生成：在飞数 < 5（并发上限，超出禁用发起、不排队）。 */
export function canSubmitNew(tasks: Record<string, GenerationTask>): boolean {
  return countGenerating(tasks) < 5;
}

/**
 * 纯函数：新任务的默认模型选择（FR-17）。
 * `lastModelId` 存在且仍在模型列表 → 用它；否则模型列表第一条；列表为空 → null。
 */
export function pickDefaultModelId(
  models: readonly Pick<GenerationModelRecord, 'id'>[],
  lastModelId: string | null | undefined
): string | null {
  if (models.length === 0) {
    return null;
  }
  if (lastModelId && models.some((model) => model.id === lastModelId)) {
    return lastModelId;
  }
  return models[0].id;
}

export type SubmitBlockReason =
  | 'model_missing'
  | 'model_not_found'
  | 'connection_missing'
  | 'key_missing'
  | 'prompt_empty'
  | 'size_invalid'
  | 'quality_invalid'
  | 'n_invalid'
  | 'references_unsupported'
  | 'references_exceeded';

export interface TaskSubmitContext {
  /** 模型记录是否仍存在（避免把已删除模型当可用）。 */
  modelExists?: boolean;
  /** 模型所属连接是否存在。 */
  connectionExists?: boolean;
  /** 连接是否有 Key（渲染层只读 hasKey 布尔，不读 Key 本身）。 */
  hasKey?: boolean;
  /** size 是否符合协议语法（由共享层 validateSizeForProtocol 计算）。 */
  sizeValid?: boolean;
  /** quality 是否命中协议枚举（Gemini 无画质时为 true）。 */
  qualityValid?: boolean;
}

export type TaskSubmitValidation =
  | { ok: true }
  | { ok: false; reason: SubmitBlockReason; message: string };

const SUBMIT_REASON_MESSAGES: Record<SubmitBlockReason, string> = {
  model_missing: '请先选择模型。若尚未添加模型，请到设置页添加服务商与模型。',
  model_not_found: '当前模型已不存在，请重新选择或到设置页检查。',
  connection_missing: '模型所属服务商已不存在，请到设置页检查。',
  key_missing: '服务商未配置 Key，请到设置页填写后再生成。',
  prompt_empty: '请填写提示词。',
  size_invalid: '尺寸不符合当前协议要求。',
  quality_invalid: '画质不在当前协议的可选范围内。',
  n_invalid: '生成数量必须是 1 到模型上限之间的整数。',
  references_unsupported: '当前模型不支持参考图。',
  references_exceeded: '参考图数量超过当前模型上限。'
};

/**
 * 纯函数：提交前门禁（FR-17 第 7 条）。协议相关的 size/quality 校验结果由调用方通过
 * `TaskSubmitContext` 传入，避免侧边栏复制共享层协议实现；Key 只传 hasKey 布尔。
 */
export function validateTaskForSubmit(
  task: GenerationTask,
  context: TaskSubmitContext = {}
): TaskSubmitValidation {
  const block = (reason: SubmitBlockReason): TaskSubmitValidation => ({
    ok: false,
    reason,
    message: SUBMIT_REASON_MESSAGES[reason]
  });

  if (!task.modelRecordId) {
    return block('model_missing');
  }
  if (context.modelExists === false) {
    return block('model_not_found');
  }
  if (context.connectionExists === false) {
    return block('connection_missing');
  }
  if (context.hasKey === false) {
    return block('key_missing');
  }
  if (task.prompt.trim().length === 0) {
    return block('prompt_empty');
  }
  if (context.sizeValid === false) {
    return block('size_invalid');
  }
  if (context.qualityValid === false) {
    return block('quality_invalid');
  }
  if (!Number.isInteger(task.n) || task.n < 1 || task.n > task.maxN) {
    return block('n_invalid');
  }
  if (!task.supportsReferenceImage && task.references.length > 0) {
    return block('references_unsupported');
  }
  if (task.references.length > task.maxRefs) {
    return block('references_exceeded');
  }

  return { ok: true };
}

/** 提交门禁文案查找（供渲染层/测试复用；未命中原因码时回退原文）。 */
export function submitBlockMessage(reason: SubmitBlockReason): string {
  return SUBMIT_REASON_MESSAGES[reason];
}

/** 提交消息载荷字段（v3.9）：只携带 modelRecordId，不携带 model/provider/Base URL/Key。 */
export interface GenerationSubmitFields {
  taskId: string;
  modelRecordId: string;
  prompt: string;
  size: string;
  quality: string;
  n: number;
  references: GenerationReferencePayload[];
}

/**
 * 纯函数：由任务态构造提交载荷字段。未选模型返回 null（提交前门禁应已拦截）。
 * 参考图已转为载荷态（local → base64，web/asset → URL），由调用方异步序列化后传入。
 */
export function buildGenerationSubmitFields(
  task: GenerationTask,
  references: GenerationReferencePayload[]
): GenerationSubmitFields | null {
  if (!task.modelRecordId) {
    return null;
  }
  return {
    taskId: task.taskId,
    modelRecordId: task.modelRecordId,
    prompt: task.prompt.trim(),
    size: task.size,
    quality: task.quality,
    n: task.n,
    references
  };
}
