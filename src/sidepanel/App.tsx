import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement
} from 'react';

import {
  buildGenerationSubmitFields,
  canSubmitNew,
  countGenerating,
  createInitialGenerationTasks,
  generationTasksReducer,
  pickDefaultModelId,
  taskStatusText,
  validateTaskForSubmit,
  type GenerationTask,
  type HistoryItem,
  type SessionFeedback,
  type TaskModelBinding,
  type TaskSubmitValidation
} from './generation-session-state';
import {
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_TOTAL_REFERENCE_BYTES,
  createTaskId,
  toReferencePayloads,
  type GenerationReference
} from '../shared/generation';
import { MESSAGE_TYPES, type GenerationSubmitPayload, type RuntimeMessage } from '../shared/messages';
import { loadExtensionData } from '../shared/storage';
import { getGeneratedBlob } from '../shared/idb-asset-store';
import { useAssetImageSrc, useIdbBlobSrc } from '../shared/use-asset-image-src';
import type { AssetRecord } from '../shared/model';
import { SparkleIcon } from '../popup/Icons';
import { decideCollect, describeCollectTarget } from './collect-decision';
import {
  defaultParams,
  getProtocol,
  parseRatioSize,
  validateSizeForProtocol,
  type ProtocolDescriptor
} from '../shared/protocols';
import {
  groupModelsByConnection,
  loadGenerationConfig,
  setLastModel,
  type GenerationConfig,
  type GenerationModelRecord,
  type ProviderConnection
} from '../shared/generation-config';

const MAX_CONCURRENT = 5;

/** 提交失败原因码 → 可读文案（background 可能回传原因码，渲染层只做展示映射，不读 Key）。 */
const FEEDBACK_REASON_TEXT: Record<string, string> = {
  model_not_found: '模型不存在，请到设置页检查后重新选择。',
  connection_not_found: '模型所属服务商不存在，请到设置页检查。',
  key_missing: '服务商未配置 Key，请到设置页填写后再生成。',
  protocol_unsupported: '该模型的接口类型不受支持，请到设置页检查。',
  invalid_base_url: '服务商地址不合法，请到设置页检查。',
  invalid_params: '生成参数不合法，请检查后重试。'
};

function readableFeedback(message: string): string {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) {
    return '生成失败，请重试。';
  }
  if (FEEDBACK_REASON_TEXT[text]) {
    return FEEDBACK_REASON_TEXT[text];
  }
  const prefix = text.split(/[:：\s]/, 1)[0];
  return FEEDBACK_REASON_TEXT[prefix] ?? message;
}

function knownBytes(refs: GenerationReference[]): number {
  return refs.reduce((sum, ref) => sum + (ref.bytes ?? 0), 0);
}

function formatHistoryTime(isoTime: string): string {
  const time = new Date(isoTime);
  if (Number.isNaN(time.getTime())) {
    return isoTime;
  }
  const mm = String(time.getMonth() + 1).padStart(2, '0');
  const dd = String(time.getDate()).padStart(2, '0');
  const hh = String(time.getHours()).padStart(2, '0');
  const mi = String(time.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

/** 任务列表：每行状态徽标 + 参考图数 + 任务模型上限 + 点击聚焦。 */
function TaskList(props: {
  tasks: GenerationTask[];
  activeTaskId: string | null;
  onSelect: (taskId: string) => void;
  onClear: (taskId: string) => void;
}): ReactElement {
  const { tasks, activeTaskId, onSelect, onClear } = props;
  if (tasks.length === 0) {
    return <p className="sp-hint">暂无生图任务。从网页图片、资产卡片、「生图」按钮或点击「+ 新任务」创建新任务。</p>;
  }
  return (
    <ul className="sp-task-list">
      {tasks.map((task, index) => (
        <li
          key={task.taskId}
          className={`sp-task-row${task.taskId === activeTaskId ? ' sp-task-row-active' : ''}`}
          onClick={() => onSelect(task.taskId)}
        >
          <span className="sp-status-dot" data-status={task.status} />
          <span className="sp-task-meta">
            <span className="sp-task-title">任务 {index + 1}</span>
            <span className="sp-task-sub">
              {taskStatusText(task)} · {task.references.length}/
              {task.modelRecordId ? task.maxRefs : '—'} 张
            </span>
          </span>
          <button
            type="button"
            className="sp-task-clear"
            aria-label="清空任务"
            onClick={(event) => {
              event.stopPropagation();
              onClear(task.taskId);
            }}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * 判断参考图 imageUrl 是否为 IndexedDB 字节句柄（非 http/data 协议头即句柄，spec FR-21 第 2 条）。
 * 采集图型 asset ref 与 web ref 的 imageUrl 均为 http(s) URL，直透；生成图型 asset ref 的 imageUrl 为资产 id（无协议头）。
 */
function isHandleUrl(imageUrl: string): boolean {
  return !imageUrl.startsWith('http') && !imageUrl.startsWith('data:');
}

/** 参考图缩略图：web/采集图型 asset 直透 URL；生成图型 asset（句柄）/存量 data 之外的本地无图占位。 */
function RefThumb({ reference }: { reference: GenerationReference }): ReactElement {
  const handle = reference.imageUrl && isHandleUrl(reference.imageUrl) ? reference.imageUrl : null;
  const idbState = useIdbBlobSrc(handle);
  const src = handle ? idbState.src : reference.imageUrl ?? null;

  if (!src) {
    return <span className="sp-ref-name">{reference.filename ?? '本地图'}</span>;
  }
  return <img src={src} alt="参考图" />;
}

/** 历史缩略图：历史项 100% 为生成图，imageUrl 即 IndexedDB 字节句柄。 */
function HistoryThumb({ imageUrl }: { imageUrl: string }): ReactElement {
  // 存量兼容：data: URL 直透（不写迁移，存量生成图仍以 data: 形态留存）
  const state = useIdbBlobSrc(imageUrl.startsWith('data:') ? null : imageUrl);
  if (imageUrl.startsWith('data:')) {
    return <img className="sp-history-thumb" src={imageUrl} alt="生成结果" />;
  }
  if (state.loading || !state.src) {
    return <div className="sp-history-thumb sp-thumb-placeholder" aria-label="加载中" />;
  }
  return <img className="sp-history-thumb" src={state.src} alt="生成结果" />;
}

/** 资产选择器缩略图：采集图直透网页 URL，生成图走 IndexedDB 字节句柄。 */
function PickerThumb({ asset }: { asset: AssetRecord }): ReactElement {
  const { src } = useAssetImageSrc(asset);
  if (!src) {
    return <div className="sp-thumb-placeholder" aria-label="加载中" />;
  }
  return <img src={src} alt={asset.sourceDomain} />;
}

function modelOptionLabel(model: GenerationModelRecord): string {
  return model.displayName === model.remoteModelId
    ? model.displayName
    : `${model.displayName}（${model.remoteModelId}）`;
}

function buildTaskModelBinding(
  model: GenerationModelRecord,
  protocol: ProtocolDescriptor
): TaskModelBinding {
  return {
    modelRecordId: model.id,
    protocolId: model.protocolId,
    maxRefs: model.maxRefs,
    maxN: model.maxN,
    supportsReferenceImage: model.supportsReferenceImage,
    defaults: defaultParams(protocol, { maxN: model.maxN })
  };
}

/** 默认模型：lastModelId 仍在列表则用它，否则列表第一条；无模型返回 null（FR-17）。 */
function resolveDefaultBinding(config: GenerationConfig): TaskModelBinding | null {
  const modelId = pickDefaultModelId(config.models, config.lastModelId);
  if (!modelId) {
    return null;
  }
  const model = config.models.find((item) => item.id === modelId);
  if (!model) {
    return null;
  }
  const protocol = getProtocol(model.protocolId);
  if (!protocol) {
    return null;
  }
  return buildTaskModelBinding(model, protocol);
}

function qualityValues(protocol: ProtocolDescriptor | undefined): string[] {
  return protocol ? protocol.params.quality.map((option) => option.value) : [];
}

function isPresetSize(protocol: ProtocolDescriptor | undefined, size: string): boolean {
  const spec = protocol?.params.size;
  return Boolean(spec && spec.kind === 'preset' && spec.options.some((option) => option.value === size));
}

interface TaskEvaluation {
  model: GenerationModelRecord | null;
  protocol: ProtocolDescriptor | undefined;
  connection: ProviderConnection | null;
  sizeValid: boolean;
  qualityValid: boolean;
  validation: TaskSubmitValidation;
}

/** 提交门禁的渲染层求值：协议 size/quality 由共享层校验，Key 只读 hasKey 布尔。 */
function evaluateTask(task: GenerationTask, config: GenerationConfig | null): TaskEvaluation {
  const model = task.modelRecordId
    ? config?.models.find((item) => item.id === task.modelRecordId) ?? null
    : null;
  const protocol = model ? getProtocol(model.protocolId) : undefined;
  const connection = model
    ? config?.connections.find((item) => item.id === model.connectionId) ?? null
    : null;
  const sizeValid = protocol ? validateSizeForProtocol(protocol.id, task.size) : false;
  const options = qualityValues(protocol);
  const qualityValid = protocol
    ? options.length === 0
      ? task.quality === ''
      : options.includes(task.quality)
    : false;

  const validation = validateTaskForSubmit(task, {
    modelExists: model !== null,
    connectionExists: connection !== null,
    hasKey: connection ? connection.hasKey : undefined,
    sizeValid,
    qualityValid
  });

  return { model, protocol, connection, sizeValid, qualityValid, validation };
}

function Notice(props: {
  tone: 'info' | 'warn' | 'error';
  children: ReactElement | string;
  actionLabel?: string;
  onAction?: () => void;
}): ReactElement {
  const { tone, children, actionLabel, onAction } = props;
  return (
    <div className={`sp-config-notice sp-config-notice-${tone}`} role="status">
      <p>{children}</p>
      {actionLabel && onAction ? (
        <button type="button" className="sp-settings-link" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

export default function App() {
  const [state, dispatch] = useReducer(generationTasksReducer, createInitialGenerationTasks());
  const { tasks, activeTaskId } = state;
  const tasksList = Object.values(tasks);
  const activeTask = activeTaskId ? tasks[activeTaskId] ?? null : null;
  const generatingCount = countGenerating(tasks);

  const [config, setConfig] = useState<GenerationConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const [customSizeTaskId, setCustomSizeTaskId] = useState<string | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [libAssets, setLibAssets] = useState<AssetRecord[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [localToast, setLocalToast] = useState<string | null>(null);
  // 生成计时 tick：仅当存在 generating 任务时每秒驱动一次重渲染（驱动 elapsed 重算）。
  const [nowTick, setNowTick] = useState<number>(Date.now());

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const toastTimer = useRef<number | null>(null);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const activeTaskIdRef = useRef(activeTaskId);
  activeTaskIdRef.current = activeTaskId;
  const configRef = useRef<GenerationConfig | null>(config);
  configRef.current = config;
  /**
   * 已受理但尚未反映到 tasksRef 的加入（taskId → imageUrl 集合）。
   * 端口回调是同步到达的，连续两拍可能在 React 重渲染前都读到同一份旧状态；
   * 没有这层在途记录，同一张图连点两次会绕过去重、占掉两个配额。
   */
  const inFlightAddsRef = useRef<Map<string, Set<string>>>(new Map());

  function showLocalToast(message: string): void {
    setLocalToast(message);
    if (toastTimer.current !== null) {
      window.clearTimeout(toastTimer.current);
    }
    toastTimer.current = window.setTimeout(() => setLocalToast(null), 2600);
  }

  /**
   * 当前聚焦任务及其在任务列表中的序号（0 起）。
   * 端口回调只挂载一次，必须从 ref 读最新状态，不能闭包捕获渲染期的 tasks。
   */
  function focusedTask(): { focused: GenerationTask | null; taskIndex: number } {
    const current = tasksRef.current;
    const activeId = activeTaskIdRef.current;
    const focused = activeId ? current[activeId] ?? null : null;
    const taskIndex = focused ? Object.keys(current).indexOf(focused.taskId) : 0;
    return { focused, taskIndex: Math.max(taskIndex, 0) };
  }

  /**
   * 取该任务的在途加入集合：先剔除已落进 tasks 的图（重渲染已完成），
   * 剩下的就是「已受理但状态里还没有」的那部分。返回的集合可直接原地追加。
   */
  function pruneInFlightAdds(task: GenerationTask): Set<string> {
    const existing = new Set(
      task.references.filter((ref) => ref.kind === 'web' && ref.imageUrl).map((ref) => ref.imageUrl!)
    );
    const pending = inFlightAddsRef.current.get(task.taskId) ?? new Set<string>();
    for (const url of pending) {
      if (existing.has(url)) {
        pending.delete(url);
      }
    }
    if (pending.size === 0) {
      inFlightAddsRef.current.delete(task.taskId);
    } else {
      inFlightAddsRef.current.set(task.taskId, pending);
    }
    return pending;
  }

  async function refreshConfig(): Promise<void> {
    try {
      const next = await loadGenerationConfig();
      setConfig(next);
      setConfigError(null);
    } catch {
      setConfigError('无法读取生图配置，请重试或去设置检查。');
    } finally {
      setConfigLoading(false);
    }
  }

  // 启动 + 聚焦时加载 config（设置页改完模型/Key 后回到侧边栏即可刷新）。
  useEffect(() => {
    void refreshConfig();
    const onFocus = (): void => {
      void refreshConfig();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        void refreshConfig();
      }
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // 仅挂载一次；refreshConfig 只依赖稳定的 setState。
  }, []);

  // SW keepalive + 接收 background 转发的入口消息与按 taskId 路由的反馈。
  useEffect(() => {
    const port = chrome.runtime.connect({ name: 'sidepanel' });
    port.onMessage.addListener((message: unknown) => {
      const msg = message as RuntimeMessage;
      if (msg.type === MESSAGE_TYPES.GENERATION_CREATE_TASK) {
        const cfg = configRef.current;
        const binding = cfg ? resolveDefaultBinding(cfg) : null;
        dispatch({
          type: 'create-task',
          taskId: msg.payload.taskId,
          references: msg.payload.references,
          mode: msg.payload.mode,
          ...(binding ?? {})
        });
      } else if (msg.type === MESSAGE_TYPES.GENERATION_FEEDBACK) {
        const { taskId, level, message: text, count } = msg.payload;
        const feedback: SessionFeedback = { level, message: readableFeedback(text), count };
        dispatch({ type: 'set-feedback', taskId, feedback });
        if (level === 'success') {
          dispatch({ type: 'finish-generating', taskId });
        } else if (level === 'error') {
          // 错误反馈统一收敛为可重试态：无参考图回 idle、有参考图回 collecting。
          dispatch({ type: 'fail-task', taskId });
        }
      } else if (msg.type === MESSAGE_TYPES.GENERATION_COLLECT_TARGET_REQUEST) {
        // 角标点击前的可加入查询：只读当前聚焦任务，不改状态。
        const { requestId } = msg.payload;
        const { focused, taskIndex } = focusedTask();
        chrome.runtime
          .sendMessage({
            type: MESSAGE_TYPES.GENERATION_COLLECT_REPLY,
            payload: {
              requestId,
              kind: 'target',
              target: describeCollectTarget(focused, taskIndex)
            }
          })
          .catch(() => undefined);
      } else if (msg.type === MESSAGE_TYPES.GENERATION_COLLECT_REQUEST) {
        const { requestId, imageUrl } = msg.payload;
        const current = tasksRef.current;
        const { focused, taskIndex } = focusedTask();
        const inFlight = focused ? pruneInFlightAdds(focused) : new Set<string>();
        // 在途图一并计入裁定：配额与去重都不能只看已落库的那份状态。
        const decision = decideCollect(focused, imageUrl, taskIndex, [...inFlight]);

        let result;
        if (decision.kind === 'added') {
          inFlight.add(imageUrl);
          dispatch({
            type: 'add-reference',
            taskId: focused!.taskId,
            reference: { kind: 'web', imageUrl }
          });
          dispatch({
            type: 'set-feedback',
            taskId: focused!.taskId,
            feedback: {
              level: 'info',
              message: `已加入网页参考图（${decision.refCount}/${decision.maxRefs} 张）`
            }
          });
          result = {
            outcome: 'added' as const,
            message: `已加入${decision.taskLabel}（${decision.refCount}/${decision.maxRefs} 张）。`,
            taskLabel: decision.taskLabel,
            refCount: decision.refCount,
            maxRefs: decision.maxRefs
          };
        } else if (decision.kind === 'duplicate') {
          result = {
            outcome: 'duplicate' as const,
            message: '这张图已在任务中。',
            taskLabel: decision.taskLabel
          };
        } else if (decision.kind === 'blocked') {
          result = {
            outcome: 'blocked' as const,
            message: decision.message,
            blockReason: decision.reason,
            maxRefs: decision.maxRefs
          };
        } else {
          // 没有可加入的任务：页面侧此刻的意图仍是「基于这张图生成」，按 reference-first 新建。
          const taskId = createTaskId();
          createTaskWithDefaults(taskId, [{ kind: 'web', imageUrl }], 'reference-first');
          const taskLabel = `任务 ${Object.keys(current.tasks).length + 1}`;
          result = {
            outcome: 'fellBackToNewTask' as const,
            message: `暂无生图任务，已新建${taskLabel}并加入。`,
            taskLabel,
            refCount: 1
          };
        }

        chrome.runtime
          .sendMessage({
            type: MESSAGE_TYPES.GENERATION_COLLECT_REPLY,
            payload: { requestId, kind: 'result', result }
          })
          .catch(() => undefined);
      }
    });
    port.onDisconnect.addListener(() => {
      // 被动断连：本地将 generating 任务标回可重试态，不依赖 background 回传。
      for (const task of Object.values(tasksRef.current)) {
        if (task.status === 'generating') {
          dispatch({ type: 'fail-task', taskId: task.taskId });
        }
      }
    });
    return () => port.disconnect();
    // 仅挂载一次；tasks/config 通过 ref 读取最新值。
  }, []);

  // 配置加载完成后：给尚未绑定模型的既有任务补默认模型（入口可先于配置加载到达）；
  // 若所选模型的能力在设置页被修改，则按新能力同步一次（截断/清空参考图，参数按新协议默认值重置）。
  useEffect(() => {
    if (!config) {
      return;
    }
    const defaultBinding = resolveDefaultBinding(config);
    for (const task of Object.values(tasksRef.current)) {
      if (task.modelRecordId === null) {
        if (defaultBinding) {
          dispatch({ type: 'set-model', taskId: task.taskId, ...defaultBinding });
        }
        continue;
      }
      const model = config.models.find((item) => item.id === task.modelRecordId);
      if (!model) {
        continue;
      }
      const protocol = getProtocol(model.protocolId);
      if (!protocol) {
        continue;
      }
      const binding = buildTaskModelBinding(model, protocol);
      const capabilitiesChanged =
        task.protocolId !== binding.protocolId ||
        task.maxRefs !== binding.maxRefs ||
        task.maxN !== binding.maxN ||
        task.supportsReferenceImage !== binding.supportsReferenceImage;
      if (capabilitiesChanged) {
        dispatch({ type: 'set-model', taskId: task.taskId, ...binding });
      }
    }
  }, [config]);

  // 切换任务/模型时退出自定义尺寸输入态。
  useEffect(() => {
    setCustomSizeTaskId(null);
    setAddMenuOpen(false);
  }, [activeTaskId, activeTask?.modelRecordId]);

  function createTaskWithDefaults(taskId: string, references: GenerationReference[], mode: 'reference-first' | 'intent-first'): void {
    const cfg = configRef.current;
    const binding = cfg ? resolveDefaultBinding(cfg) : null;
    dispatch({
      type: 'create-task',
      taskId,
      references,
      mode,
      ...(binding ?? {})
    });
  }

  function handleNewTask(): void {
    createTaskWithDefaults(createTaskId(), [], 'intent-first');
  }

  function goToSettings(): void {
    const actionApi = chrome.action;
    if (actionApi && typeof actionApi.openPopup === 'function') {
      try {
        void actionApi
          .openPopup()
          .then(() => showLocalToast('已打开弹窗，请点击右上角设置图标配置服务商与模型。'))
          .catch(() => showLocalToast('请点击浏览器工具栏中的扩展图标，再进入设置页配置。'));
        return;
      } catch {
        // 落到下方提示文案（不新增消息协议）。
      }
    }
    showLocalToast('请点击浏览器工具栏中的扩展图标，再进入设置页配置。');
  }

  /** 记住上次使用模型：本地 config 同步更新，保证紧接着的新任务也用同一默认模型。 */
  function rememberModel(modelId: string): void {
    setConfig((prev) => (prev ? { ...prev, lastModelId: modelId } : prev));
    void setLastModel(modelId).catch(() => undefined);
  }

  function handleModelChange(modelRecordId: string): void {
    if (!activeTask) {
      return;
    }
    const model = config?.models.find((item) => item.id === modelRecordId);
    if (!model) {
      return;
    }
    const protocol = getProtocol(model.protocolId);
    if (!protocol) {
      showLocalToast('该模型的接口类型不可用，请去设置检查。');
      return;
    }
    dispatch({
      type: 'set-model',
      taskId: activeTask.taskId,
      ...buildTaskModelBinding(model, protocol)
    });
    rememberModel(model.id);
  }

  function tryAddReference(ref: GenerationReference): void {
    if (!activeTask) {
      return;
    }
    if (!activeTask.modelRecordId) {
      showLocalToast('请先选择模型，再添加参考图。');
      return;
    }
    if (!activeTask.supportsReferenceImage) {
      showLocalToast('当前模型不支持参考图。');
      return;
    }
    if (activeTask.references.length >= activeTask.maxRefs) {
      showLocalToast(`参考图已达当前模型上限（${activeTask.maxRefs} 张）。`);
      return;
    }
    if (ref.bytes !== undefined && ref.bytes > MAX_REFERENCE_IMAGE_BYTES) {
      showLocalToast('单张参考图不能超过 15MB。');
      return;
    }
    if (knownBytes(activeTask.references) + (ref.bytes ?? 0) > MAX_TOTAL_REFERENCE_BYTES) {
      showLocalToast('参考图总大小不能超过 50MB。');
      return;
    }
    dispatch({ type: 'add-reference', taskId: activeTask.taskId, reference: ref });
  }

  // 资产库选择器：打开时只读加载资产库（不经 background，只读不写）。
  useEffect(() => {
    if (!pickerOpen) {
      return;
    }
    void loadExtensionData()
      .then((data) => setLibAssets(data.assets))
      .catch(() => setLibAssets([]));
  }, [pickerOpen]);

  // 资产库选择器：ESC 关闭（覆盖式抽屉，键盘可达）。
  useEffect(() => {
    if (!pickerOpen) {
      return;
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setPickerOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickerOpen]);

  // 生成历史：从资产库读 generatedFrom 资产，按时间倒序（全局，不绑定单任务）。
  const doneCount = tasksList.filter((task) => task.status === 'done').length;
  useEffect(() => {
    void loadExtensionData()
      .then((data) => {
        const items: HistoryItem[] = data.assets
          .filter((asset) => asset.generatedFrom)
          .map((asset) => ({
            id: asset.id,
            imageUrl: asset.imageUrl,
            prompt: asset.generatedFrom!.prompt,
            size: asset.generatedFrom!.size,
            quality: asset.generatedFrom!.quality,
            n: asset.generatedFrom!.n,
            createdAt: asset.savedAt,
            sourceRefsCount: asset.generatedFrom!.sourceRefs.length
          }))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setHistory(items);
      })
      .catch(() => undefined);
  }, [doneCount]);

  // 参考图字节回拉：web/asset 来源构造时无 bytes，由 sidepanel 异步回拉字节得到 size 后回填状态机，
  // 使三类来源配额统计一致生效。回拉失败的参考图 bytes 保持 undefined（不计入合计，不阻断主链、不报错）。
  // v3.7：asset 来源按源资产是否为生成图分流——生成图有 IndexedDB 条目，按 assetId 直取（不 fetch 句柄）；
  // 采集图无 IndexedDB 条目，回退 fetch imageUrl（sidepanel 享有 host_permissions 干净 fetch）。
  const fetchedByteRefs = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const task of tasksList) {
      for (const ref of task.references) {
        if (ref.bytes !== undefined) {
          continue;
        }
        if (!ref.id) {
          continue;
        }
        const key = `${task.taskId}:${ref.id}`;
        if (fetchedByteRefs.current.has(key)) {
          continue;
        }
        fetchedByteRefs.current.add(key);

        const reportBytes = (size: number): void => {
          dispatch({
            type: 'set-reference-bytes',
            taskId: task.taskId,
            refId: ref.id!,
            bytes: size
          });
        };

        if (ref.kind === 'asset' && ref.assetId) {
          // 生成图型 asset：IDB 有条目则直取 size；无条目（采集图）回退 fetch
          void getGeneratedBlob(ref.assetId)
            .then((blob) => {
              if (blob) {
                reportBytes(blob.size);
                return;
              }
              if (!ref.imageUrl) return;
              return fetch(ref.imageUrl, { referrerPolicy: 'no-referrer' })
                .then((res) => (res.ok ? res.blob() : Promise.reject(new Error('fetch failed'))))
                .then((b) => reportBytes(b.size));
            })
            .catch(() => undefined);
        } else if (ref.imageUrl) {
          // web 来源：fetch imageUrl（referrerPolicy 绕开图片 CDN 的 Referer 防盗链，
          // sidepanel 作为 chrome-extension:// 页，默认 Referer 会触发 hdslb.com 等 CDN 的 403）。
          void fetch(ref.imageUrl, { referrerPolicy: 'no-referrer' })
            .then((res) => (res.ok ? res.blob() : Promise.reject(new Error('fetch failed'))))
            .then((blob) => reportBytes(blob.size))
            .catch(() => undefined);
        }
      }
    }
  }, [tasksList]);

  // 生成计时 tick：任意任务处于 generating 时，每秒 setNowTick 触发重渲染，让 elapsed 重算。
  // generating 数为 0 时停止 tick（无活计时器），避免空转。
  useEffect(() => {
    if (generatingCount === 0) {
      return;
    }
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [generatingCount]);

  function handleFiles(event: ChangeEvent<HTMLInputElement>): void {
    const files = Array.from(event.target.files ?? []);
    for (const file of files) {
      tryAddReference({ kind: 'local', filename: file.name, blob: file, bytes: file.size });
    }
    event.target.value = '';
    setAddMenuOpen(false);
  }

  /** 复用参数：只恢复 prompt / size / quality / n，不恢复模型；按当前模型能力校验，非法回落默认值。 */
  function reuseParams(item: HistoryItem): void {
    if (!activeTask) {
      return;
    }
    const model = activeTask.modelRecordId
      ? config?.models.find((record) => record.id === activeTask.modelRecordId) ?? null
      : null;
    const protocol = model ? getProtocol(model.protocolId) : undefined;

    let size = item.size;
    let quality = item.quality;
    let n = item.n;
    if (protocol) {
      if (!validateSizeForProtocol(protocol.id, size)) {
        size = activeTask.defaults.size;
      }
      const options = qualityValues(protocol);
      if (options.length === 0) {
        quality = '';
      } else if (!options.includes(quality)) {
        quality = activeTask.defaults.quality;
      }
      const maxN = Math.max(1, Math.min(activeTask.maxN, protocol.params.maxN));
      n = Number.isInteger(n) && n >= 1 ? Math.min(n, maxN) : activeTask.defaults.n;
    }

    dispatch({
      type: 'set-params',
      taskId: activeTask.taskId,
      params: { prompt: item.prompt, size, quality, n }
    });
    setCustomSizeTaskId(isPresetSize(protocol, size) ? null : activeTask.taskId);
  }

  function clearTask(taskId: string): void {
    const task = tasks[taskId];
    if (task?.status === 'generating') {
      // 在飞任务先通知 background 中止 in-flight fetch，再本地删除，避免悬挂僵尸请求。
      void chrome.runtime
        .sendMessage({ type: MESSAGE_TYPES.GENERATION_CANCEL_TASK, payload: { taskId } })
        .catch(() => undefined);
    }
    dispatch({ type: 'clear-task', taskId });
  }

  function clearAllTasks(): void {
    for (const task of tasksList) {
      if (task.status === 'generating') {
        void chrome.runtime
          .sendMessage({ type: MESSAGE_TYPES.GENERATION_CANCEL_TASK, payload: { taskId: task.taskId } })
          .catch(() => undefined);
      }
      dispatch({ type: 'clear-task', taskId: task.taskId });
    }
  }

  async function submitGeneration(taskId: string): Promise<void> {
    const task = tasks[taskId];
    if (!task) {
      return;
    }
    // 并发门禁：在飞达上限（5）时禁用发起、不排队。
    if (!canSubmitNew(tasks)) {
      showLocalToast(`最多 ${MAX_CONCURRENT} 个任务同时进行。`);
      return;
    }
    const evaluation = evaluateTask(task, config);
    if (!evaluation.validation.ok) {
      showLocalToast(evaluation.validation.message);
      return;
    }
    if (!evaluation.model) {
      showLocalToast('请先选择模型。');
      return;
    }
    // 切换/提交时持久化上次使用模型；持久化失败不阻断生成。
    rememberModel(evaluation.model.id);

    dispatch({ type: 'start-generating', taskId });
    // 渲染层发送前把内存态参考图转为载荷态（spec FR-16 第 6 条 v3.5）：
    // local 来源 blob→base64 字符串（chrome.runtime.sendMessage 默认 JSON 序列化不保留 Blob），
    // web/asset 来源丢弃 blob（background 会按 imageUrl 回拉字节）。
    let references;
    try {
      references = await toReferencePayloads(task.references);
    } catch {
      dispatch({ type: 'fail-task', taskId });
      dispatch({
        type: 'set-feedback',
        taskId,
        feedback: { level: 'error', message: '参考图读取失败，请重新添加。' }
      });
      return;
    }
    const fields = buildGenerationSubmitFields(task, references);
    if (!fields) {
      dispatch({ type: 'fail-task', taskId });
      dispatch({
        type: 'set-feedback',
        taskId,
        feedback: { level: 'error', message: '未选择模型，无法提交。' }
      });
      return;
    }
    // v3.9：只携带 modelRecordId，不携带 model/provider/Base URL/Key。
    const payload: GenerationSubmitPayload = fields;
    try {
      await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.GENERATION_SUBMIT, payload });
    } catch {
      dispatch({ type: 'fail-task', taskId });
      dispatch({
        type: 'set-feedback',
        taskId,
        feedback: { level: 'error', message: '提交生图请求失败。' }
      });
    }
  }

  if (!activeTask) {
    return (
      <div className="sidepanel-root">
        <header className="sp-topbar">
          <div className="sp-status">
            <span className="sp-status-dot" data-status="idle" />
            <span className="sp-status-text">生图任务</span>
          </div>
          <button type="button" className="sp-clear" onClick={clearAllTasks} aria-label="清空全部任务">
            清空全部
          </button>
          <button type="button" className="sp-new-task" onClick={handleNewTask} aria-label="新建生图任务">
            <SparkleIcon />
            <span>新任务</span>
          </button>
        </header>
        <TaskList
          tasks={tasksList}
          activeTaskId={activeTaskId}
          onSelect={(id) => dispatch({ type: 'set-active', taskId: id })}
          onClear={clearTask}
        />
      </div>
    );
  }

  // v3.9：模型记录 / 协议描述符 / 连接状态决定参数面板、参考图能力与提交门禁。
  const evaluation = evaluateTask(activeTask, config);
  const { model: activeModel, protocol: activeProtocol, connection: activeConnection } = evaluation;
  const modelGroups = config ? groupModelsByConnection(config) : [];
  const groupedModelIds = new Set(modelGroups.flatMap((group) => group.models.map((item) => item.id)));
  const ungroupedModels = config ? config.models.filter((item) => !groupedModelIds.has(item.id)) : [];
  const models = config?.models ?? [];

  const effectiveMaxN = activeProtocol
    ? Math.max(1, Math.min(activeTask.maxN, activeProtocol.params.maxN))
    : activeTask.maxN;
  const qualityOptions = activeProtocol?.params.quality ?? [];
  const sizeSpec = activeProtocol?.params.size;
  const presetSpec = sizeSpec && sizeSpec.kind === 'preset' ? sizeSpec : null;
  const ratioSpec = sizeSpec && sizeSpec.kind === 'ratio-size' ? sizeSpec : null;
  const presetSizeValues = presetSpec ? presetSpec.options.map((option) => option.value) : [];
  // OpenAI 的 auto 永远可选（协议 options 通常已含，去重防重复 option）。
  const presetChoices = presetSpec
    ? [
        ...presetSpec.options,
        ...(presetSizeValues.includes('auto')
          ? []
          : [{ value: 'auto', label: 'auto' }])
      ]
    : [];
  const customSizeMode =
    Boolean(presetSpec?.allowCustom) &&
    (customSizeTaskId === activeTask.taskId || !presetSizeValues.includes(activeTask.size));
  const sizeSelectValue = customSizeMode ? 'custom' : activeTask.size;

  const parsedRatio = ratioSpec ? parseRatioSize(activeTask.size) : null;
  const ratioValue =
    ratioSpec && parsedRatio && ratioSpec.ratios.includes(parsedRatio.aspectRatio)
      ? parsedRatio.aspectRatio
      : ratioSpec?.ratios[0] ?? '';
  const imageSizeValue =
    ratioSpec && parsedRatio && ratioSpec.imageSizes.includes(parsedRatio.imageSize)
      ? parsedRatio.imageSize
      : ratioSpec?.imageSizes[0] ?? '';

  const hideAddEntry = Boolean(activeModel && !activeModel.supportsReferenceImage);
  const addDisabled =
    !activeModel ||
    !activeTask.modelRecordId ||
    activeTask.references.length >= activeTask.maxRefs;
  const atRefCap = activeTask.references.length >= activeTask.maxRefs;
  const nearLimit =
    activeTask.maxRefs > 0 &&
    (activeTask.references.length >= activeTask.maxRefs - 2 ||
      knownBytes(activeTask.references) >= MAX_TOTAL_REFERENCE_BYTES * 0.9);

  const validation = evaluation.validation;
  const submitDisabled =
    !validation.ok || activeTask.status === 'generating' || !canSubmitNew(tasks);

  // elapsed 从任务态的 startedAt 计算（下沉状态机后，切换任务不丢计时）。
  // nowTick 仅用于驱动重渲染（每秒 tick），不直接参与计算。
  const elapsed =
    activeTask.startedAt !== null
      ? Math.max(0, Math.round((nowTick - activeTask.startedAt) / 1000))
      : 0;
  const totalBytesMb = (knownBytes(activeTask.references) / (1024 * 1024)).toFixed(1);

  function renderConfigNotice(): ReactElement | null {
    if (!config && configLoading) {
      return <p className="sp-hint">正在读取模型配置…</p>;
    }
    if (configError && !config) {
      return (
        <Notice
          tone="error"
          actionLabel="重试"
          onAction={() => {
            setConfigLoading(true);
            void refreshConfig();
          }}
        >
          {configError}
        </Notice>
      );
    }
    if (config && config.models.length === 0) {
      return (
        <Notice tone="info" actionLabel="去设置" onAction={goToSettings}>
          尚未添加模型。软件不内置模型，请先在设置页添加服务商与模型。
        </Notice>
      );
    }
    if (activeTask?.modelRecordId) {
      if (!activeModel) {
        return (
          <Notice tone="error" actionLabel="去设置" onAction={goToSettings}>
            当前模型已不存在，请重新选择或到设置页检查。
          </Notice>
        );
      }
      if (!activeConnection) {
        return (
          <Notice tone="error" actionLabel="去设置" onAction={goToSettings}>
            模型所属服务商已不存在，请到设置页检查。
          </Notice>
        );
      }
      if (!activeConnection.hasKey) {
        return (
          <Notice tone="warn" actionLabel="去设置" onAction={goToSettings}>
            服务商未配置 Key，请到设置页填写后再生成。
          </Notice>
        );
      }
    } else if (config && config.models.length > 0) {
      return (
        <Notice tone="warn" actionLabel="去设置" onAction={goToSettings}>
          请选择一个模型后再生成。
        </Notice>
      );
    }
    return null;
  }

  const inlineBlockMessage =
    !validation.ok &&
    validation.reason !== 'prompt_empty' &&
    validation.reason !== 'size_invalid' &&
    validation.reason !== 'model_missing' &&
    validation.reason !== 'model_not_found' &&
    validation.reason !== 'connection_missing' &&
    validation.reason !== 'key_missing'
      ? validation.message
      : null;

  return (
    <div className="sidepanel-root">
      <header className="sp-topbar">
        <div className="sp-status">
          <span className="sp-status-dot" data-status={activeTask.status} />
          <span className="sp-status-text">{taskStatusText(activeTask)}</span>
        </div>
        <button type="button" className="sp-clear" onClick={clearAllTasks} aria-label="清空全部任务">
          清空全部
        </button>
        <button type="button" className="sp-new-task" onClick={handleNewTask} aria-label="新建生图任务">
          <SparkleIcon />
          <span>新任务</span>
        </button>
      </header>

      <section className="sp-task-section">
        <div className="sp-section-head">
          <h2>任务</h2>
          <span className="sp-quota">
            {tasksList.length} 个
            {generatingCount > 0 ? ` · 生成中 ${generatingCount}/${MAX_CONCURRENT}` : ''}
          </span>
        </div>
        <TaskList
          tasks={tasksList}
          activeTaskId={activeTaskId}
          onSelect={(id) => dispatch({ type: 'set-active', taskId: id })}
          onClear={clearTask}
        />
      </section>

      <section className="sp-references">
        <div className="sp-section-head">
          <h2>参考图</h2>
          <span className="sp-quota">
            {activeTask.references.length}/{activeTask.modelRecordId ? activeTask.maxRefs : '—'} 张 ·{' '}
            {totalBytesMb}MB/50MB
          </span>
        </div>

        <div className="sp-ref-grid">
          {activeTask.references.map((ref) => (
            <div className="sp-ref-thumb" key={ref.id}>
              <RefThumb reference={ref} />
              <button
                type="button"
                className="sp-ref-remove"
                aria-label="移除参考图"
                onClick={() =>
                  dispatch({ type: 'remove-reference', taskId: activeTask.taskId, refId: ref.id! })
                }
              >
                ×
              </button>
            </div>
          ))}

          {hideAddEntry ? null : (
            <div className="sp-ref-add">
              <button
                type="button"
                className="sp-ref-add-btn"
                onClick={() => setAddMenuOpen((prev) => !prev)}
                aria-expanded={addMenuOpen}
                disabled={addDisabled}
                title={
                  activeTask.modelRecordId
                    ? atRefCap
                      ? `参考图已达上限（${activeTask.maxRefs} 张）`
                      : undefined
                    : '请先选择模型'
                }
              >
                + 添加
              </button>
              {addMenuOpen && !addDisabled ? (
                <div className="sp-add-menu">
                  <button
                    type="button"
                    onClick={() => {
                      setPickerOpen(true);
                      setAddMenuOpen(false);
                    }}
                  >
                    资产库
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      fileInputRef.current?.click();
                      setAddMenuOpen(false);
                    }}
                  >
                    本地上传
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </div>

        {activeTask.references.length === 0 ? (
          <p className="sp-hint">
            {activeTask.modelRecordId ? '无参考图（文生图模式）。' : '选择模型后可添加参考图。'}
          </p>
        ) : null}
        {activeTask.supportsReferenceImage && activeTask.modelRecordId ? (
          <p className="sp-hint">也可在其他网页图片上右键选「加入当前生图任务」，把图收进这个任务。</p>
        ) : null}
        {activeModel && !activeModel.supportsReferenceImage ? (
          <p className="sp-hint">当前模型不支持参考图。</p>
        ) : null}
        {atRefCap && activeTask.modelRecordId ? (
          <p className="sp-hint sp-hint-warn">参考图已达当前模型上限（{activeTask.maxRefs} 张）。</p>
        ) : null}
        {nearLimit && !atRefCap ? (
          <p className="sp-hint sp-hint-warn">参考图接近上限，注意张数与总大小。</p>
        ) : null}
      </section>

      <section className="sp-params">
        <div className="sp-section-head">
          <h2>参数</h2>
        </div>

        {renderConfigNotice()}

        <label className="sp-field">
          <span>模型</span>
          <select
            className="sp-model-select"
            value={activeTask.modelRecordId ?? ''}
            aria-label="选择生图模型"
            disabled={!config || models.length === 0 || activeTask.status === 'generating'}
            onChange={(event) => handleModelChange(event.target.value)}
          >
            {activeTask.modelRecordId && !activeModel ? (
              <option value={activeTask.modelRecordId}>模型已不存在</option>
            ) : null}
            {activeTask.modelRecordId === null ? (
              <option value="">
                {models.length === 0
                  ? configError
                    ? '配置读取失败'
                    : '尚未添加模型'
                  : '请选择模型'}
              </option>
            ) : null}
            {modelGroups
              .filter((group) => group.models.length > 0)
              .map((group) => (
                <optgroup key={group.connection.id} label={group.connection.name}>
                  {group.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {modelOptionLabel(model)}
                    </option>
                  ))}
                </optgroup>
              ))}
            {ungroupedModels.length > 0 ? (
              <optgroup label="未分组">
                {ungroupedModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {modelOptionLabel(model)}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </label>

        <label className="sp-field">
          <span>提示词（必填）</span>
          <textarea
            className="sp-prompt"
            value={activeTask.prompt}
            placeholder="描述你想生成的画面…"
            onChange={(event) =>
              dispatch({ type: 'set-params', taskId: activeTask.taskId, params: { prompt: event.target.value } })
            }
          />
        </label>

        {activeProtocol && presetSpec ? (
          <label className="sp-field">
            <span>尺寸</span>
            <select
              value={sizeSelectValue}
              onChange={(event) => {
                const value = event.target.value;
                if (value === 'custom') {
                  setCustomSizeTaskId(activeTask.taskId);
                  return;
                }
                setCustomSizeTaskId(null);
                dispatch({ type: 'set-params', taskId: activeTask.taskId, params: { size: value } });
              }}
            >
              {presetChoices.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
              {presetSpec.allowCustom ? <option value="custom">自定义（WxH）</option> : null}
            </select>
            {customSizeMode ? (
              <input
                className="sp-size-custom"
                value={activeTask.size}
                placeholder="如 1920x1080"
                aria-invalid={!evaluation.sizeValid}
                onChange={(event) =>
                  dispatch({ type: 'set-params', taskId: activeTask.taskId, params: { size: event.target.value } })
                }
              />
            ) : null}
            {customSizeMode && !evaluation.sizeValid ? (
              <span className="sp-field-error">
                尺寸不合法（最长边 ≤3840、宽高为 16 的倍数、长宽比 ≤3:1、像素 655360~8294400）
              </span>
            ) : null}
          </label>
        ) : null}

        {activeProtocol && ratioSpec ? (
          <div className="sp-field sp-field-row">
            <label className="sp-field-inline">
              <span>比例</span>
              <select
                value={ratioValue}
                onChange={(event) =>
                  dispatch({
                    type: 'set-params',
                    taskId: activeTask.taskId,
                    params: { size: `${event.target.value}@${imageSizeValue}` }
                  })
                }
              >
                {ratioSpec.ratios.map((ratio) => (
                  <option key={ratio} value={ratio}>
                    {ratio}
                  </option>
                ))}
              </select>
            </label>
            <label className="sp-field-inline">
              <span>清晰度</span>
              <select
                value={imageSizeValue}
                onChange={(event) =>
                  dispatch({
                    type: 'set-params',
                    taskId: activeTask.taskId,
                    params: { size: `${ratioValue}@${event.target.value}` }
                  })
                }
              >
                {ratioSpec.imageSizes.map((imageSize) => (
                  <option key={imageSize} value={imageSize}>
                    {imageSize}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}

        {activeProtocol && qualityOptions.length > 0 ? (
          <label className="sp-field sp-field-inline">
            <span>画质</span>
            <select
              value={activeTask.quality}
              onChange={(event) =>
                dispatch({ type: 'set-params', taskId: activeTask.taskId, params: { quality: event.target.value } })
              }
            >
              {qualityOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {activeProtocol && activeProtocol.params.maxN > 1 ? (
          <label className="sp-field sp-field-inline">
            <span>数量（1-{effectiveMaxN}）</span>
            <input
              type="number"
              min={1}
              max={effectiveMaxN}
              value={activeTask.n}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                const nextN = Number.isFinite(parsed)
                  ? Math.min(Math.max(Math.floor(parsed), 1), effectiveMaxN)
                  : 1;
                dispatch({
                  type: 'set-params',
                  taskId: activeTask.taskId,
                  params: { n: nextN }
                });
              }}
            />
          </label>
        ) : null}

        <button
          type="button"
          className="sp-generate"
          disabled={submitDisabled}
          title={!validation.ok ? validation.message : undefined}
          onClick={() => void submitGeneration(activeTask.taskId)}
        >
          {activeTask.status === 'generating' ? '生成中…' : '生成'}
        </button>
        {inlineBlockMessage ? <p className="sp-hint sp-hint-warn">{inlineBlockMessage}</p> : null}
        {!canSubmitNew(tasks) && activeTask.status !== 'generating' ? (
          <p className="sp-hint sp-hint-warn">最多 {MAX_CONCURRENT} 个任务同时进行，请等待现有任务完成。</p>
        ) : null}
      </section>

      <section className="sp-progress">
        <div className="sp-section-head">
          <h2>进度</h2>
        </div>

        {activeTask.feedback ? (
          <div className={`sp-bubble sp-bubble-${activeTask.feedback.level}`} role="status">
            <span>{activeTask.feedback.message}</span>
          </div>
        ) : null}

        {activeTask.status === 'generating' ? (
          <p className="sp-progress-text">生成中… 已等待 {elapsed}s</p>
        ) : null}
        {activeTask.status === 'done' ? (
          <p className="sp-progress-text">
            已完成{activeTask.feedback?.count ? `，${activeTask.feedback.count} 张已存入资产库` : ''}。可在资产库查看。
          </p>
        ) : null}

        {history.length > 0 ? (
          <div className="sp-history">
            <div className="sp-section-head">
              <h2>历史</h2>
            </div>
            <ul className="sp-history-list">
              {history.map((item) => (
                <li key={item.id} className="sp-history-item">
                  <HistoryThumb imageUrl={item.imageUrl} />
                  <div className="sp-history-meta">
                    <p className="sp-history-prompt" title={item.prompt}>
                      {item.prompt}
                    </p>
                    <p className="sp-history-sub">
                      {item.sourceRefsCount > 0 ? `源 ${item.sourceRefsCount} 张 · ` : '文生图 · '}
                      {item.size} · {item.n} 张 · {formatHistoryTime(item.createdAt)}
                    </p>
                    <button type="button" className="sp-history-reuse" onClick={() => reuseParams(item)}>
                      复用参数
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {pickerOpen ? (
        <div className="sp-picker-scrim" onClick={() => setPickerOpen(false)}>
          <div
            className="sp-picker"
            role="dialog"
            aria-modal="true"
            aria-label="选择资产作为参考图"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sp-picker-grip" aria-hidden="true" />
            <div className="sp-picker-head">
              <h2>选择资产作为参考图</h2>
              <button type="button" onClick={() => setPickerOpen(false)} aria-label="关闭">
                关闭
              </button>
            </div>
            <div className="sp-picker-grid">
              {libAssets.map((asset) => (
                <button
                  type="button"
                  key={asset.id}
                  className="sp-picker-thumb"
                  title={asset.sourceDomain}
                  onClick={() => {
                    tryAddReference({ kind: 'asset', assetId: asset.id, imageUrl: asset.imageUrl });
                    setPickerOpen(false);
                  }}
                >
                  <PickerThumb asset={asset} />
                </button>
              ))}
              {libAssets.length === 0 ? <p className="sp-hint">资产库为空。</p> : null}
            </div>
          </div>
        </div>
      ) : null}

      <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={handleFiles} />

      {localToast ? <div className="sp-toast">{localToast}</div> : null}
    </div>
  );
}
