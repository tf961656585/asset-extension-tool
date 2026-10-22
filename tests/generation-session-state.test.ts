import { describe, expect, it } from 'vitest';

import {
  buildGenerationSubmitFields,
  canSubmitNew,
  countGenerating,
  createInitialGenerationTasks,
  generationTasksReducer,
  pickDefaultModelId,
  taskModeLabel,
  taskStageLabel,
  taskStatusText,
  validateTaskForSubmit,
  type GenerationTask,
  type TaskModelBinding
} from '../src/sidepanel/generation-session-state';
import type { ProtocolId } from '../src/shared/protocols';
import type { GenerationReference } from '../src/shared/generation';

const WEB_REF: GenerationReference = { kind: 'web', imageUrl: 'https://x.com/a.png' };
const ASSET_REF: GenerationReference = { kind: 'asset', assetId: 'asset_1', imageUrl: 'blob:b' };

const OPENAI_BINDING: TaskModelBinding = {
  modelRecordId: 'model-openai',
  protocolId: 'openai-images-v1' as ProtocolId,
  maxRefs: 16,
  maxN: 10,
  supportsReferenceImage: true,
  defaults: { size: 'auto', quality: 'auto', n: 1 }
};

const GEMINI_BINDING: TaskModelBinding = {
  modelRecordId: 'model-gemini',
  protocolId: 'gemini-image-v1' as ProtocolId,
  maxRefs: 3,
  maxN: 1,
  supportsReferenceImage: true,
  defaults: { size: '1:1@1K', quality: '', n: 1 }
};

const TEXT_ONLY_BINDING: TaskModelBinding = {
  modelRecordId: 'model-text-only',
  protocolId: 'openai-images-v1' as ProtocolId,
  maxRefs: 0,
  maxN: 4,
  supportsReferenceImage: false,
  defaults: { size: '1024x1024', quality: 'auto', n: 2 }
};

function taskOf(state: ReturnType<typeof createInitialGenerationTasks>, taskId: string): GenerationTask {
  const task = state.tasks[taskId];
  if (!task) {
    throw new Error(`task ${taskId} not found`);
  }
  return task;
}

function createTask(
  overrides: Partial<TaskModelBinding> & { references?: GenerationReference[]; taskId?: string } = {},
  base = createInitialGenerationTasks()
) {
  const { references = [], taskId = 't1', ...binding } = overrides;
  return generationTasksReducer(base, {
    type: 'create-task',
    taskId,
    references,
    mode: references.length === 0 ? 'intent-first' : 'reference-first',
    ...binding
  });
}

function setModel(state: ReturnType<typeof createInitialGenerationTasks>, taskId: string, binding: TaskModelBinding) {
  return generationTasksReducer(state, { type: 'set-model', taskId, ...binding });
}

describe('generation tasks state machine (multi-task, 4 态)', () => {
  it('初始为空 Map、activeTaskId 为 null', () => {
    const state = createInitialGenerationTasks();
    expect(state.tasks).toEqual({});
    expect(state.activeTaskId).toBeNull();
  });

  it('create-task：references 非空 → collecting，且置为 active', () => {
    const state = createTask({ references: [WEB_REF] });
    expect(state.activeTaskId).toBe('t1');
    expect(taskOf(state, 't1').status).toBe('collecting');
    expect(taskOf(state, 't1').references).toHaveLength(1);
  });

  it('create-task：references 为空 → idle（文生图输入态）', () => {
    const state = createTask();
    expect(taskOf(state, 't1').status).toBe('idle');
    expect(taskOf(state, 't1').quality).toBe('auto');
    expect(taskOf(state, 't1').modelRecordId).toBeNull();
  });

  it('create-task 可携带模型绑定与默认参数', () => {
    const state = createTask({ ...GEMINI_BINDING, defaults: { size: '1:1@1K', quality: '', n: 1 } });
    const task = taskOf(state, 't1');
    expect(task.modelRecordId).toBe('model-gemini');
    expect(task.protocolId).toBe('gemini-image-v1');
    expect(task.size).toBe('1:1@1K');
    expect(task.quality).toBe('');
    expect(task.n).toBe(1);
    expect(task.maxRefs).toBe(3);
  });

  it('set-params 可更新 quality（v3.4）', () => {
    let state = createTask({ ...OPENAI_BINDING });
    state = generationTasksReducer(state, { type: 'set-params', taskId: 't1', params: { quality: 'high' } });
    expect(taskOf(state, 't1').quality).toBe('high');
    state = generationTasksReducer(state, { type: 'set-params', taskId: 't1', params: { prompt: 'p' } });
    expect(taskOf(state, 't1').quality).toBe('high');
    expect(taskOf(state, 't1').prompt).toBe('p');
  });

  it('每任务独立：新建两个任务后，修改其一不影响另一', () => {
    let state = createTask();
    state = createTask({ taskId: 't2' }, state);
    state = generationTasksReducer(state, { type: 'set-params', taskId: 't1', params: { prompt: 'only t1' } });

    expect(taskOf(state, 't1').prompt).toBe('only t1');
    expect(taskOf(state, 't2').prompt).toBe('');
    expect(Object.keys(state.tasks)).toEqual(['t1', 't2']);
  });

  it('add-reference → collecting；remove-reference 清空 → 回 idle', () => {
    let state = createTask({ ...OPENAI_BINDING });
    state = generationTasksReducer(state, { type: 'add-reference', taskId: 't1', reference: ASSET_REF });
    expect(taskOf(state, 't1').status).toBe('collecting');
    const refId = taskOf(state, 't1').references[0].id;
    expect(refId).toBeDefined();
    state = generationTasksReducer(state, { type: 'remove-reference', taskId: 't1', refId: refId! });
    expect(taskOf(state, 't1').status).toBe('idle');
    expect(taskOf(state, 't1').references).toEqual([]);
  });

  it('add-reference：无模型 / 不支持参考图 / 达 maxRefs 时拒绝加入', () => {
    let noModel = createTask();
    noModel = generationTasksReducer(noModel, { type: 'add-reference', taskId: 't1', reference: WEB_REF });
    expect(taskOf(noModel, 't1').references).toHaveLength(0);

    let textOnly = createTask({ ...TEXT_ONLY_BINDING });
    textOnly = generationTasksReducer(textOnly, { type: 'add-reference', taskId: 't1', reference: WEB_REF });
    expect(taskOf(textOnly, 't1').references).toHaveLength(0);

    let capped = createTask({ ...OPENAI_BINDING, references: [WEB_REF] });
    capped = setModel(capped, 't1', { ...OPENAI_BINDING, maxRefs: 1 });
    expect(taskOf(capped, 't1').references).toHaveLength(1);
    capped = generationTasksReducer(capped, { type: 'add-reference', taskId: 't1', reference: ASSET_REF });
    expect(taskOf(capped, 't1').references).toHaveLength(1);
  });

  it('start → generating（写 startedAt）；finish → done（保留 refs+prompt，清 startedAt）', () => {
    let state = createTask({ ...OPENAI_BINDING, references: [ASSET_REF] });
    state = generationTasksReducer(state, { type: 'set-params', taskId: 't1', params: { prompt: 'p' } });
    state = generationTasksReducer(state, { type: 'start-generating', taskId: 't1' });
    expect(taskOf(state, 't1').status).toBe('generating');
    expect(taskOf(state, 't1').startedAt).not.toBeNull();
    state = generationTasksReducer(state, { type: 'finish-generating', taskId: 't1' });
    expect(taskOf(state, 't1').status).toBe('done');
    expect(taskOf(state, 't1').startedAt).toBeNull();
    expect(taskOf(state, 't1').references).toHaveLength(1);
    expect(taskOf(state, 't1').prompt).toBe('p');
  });

  it('fail：有参考图回 collecting、无参考图回 idle（保留 refs+prompt，清 startedAt）', () => {
    let withRef = createTask({ ...OPENAI_BINDING, references: [WEB_REF] });
    withRef = generationTasksReducer(withRef, { type: 'set-params', taskId: 't1', params: { prompt: 'p' } });
    withRef = generationTasksReducer(withRef, { type: 'start-generating', taskId: 't1' });
    withRef = generationTasksReducer(withRef, { type: 'fail-task', taskId: 't1' });
    expect(taskOf(withRef, 't1').status).toBe('collecting');
    expect(taskOf(withRef, 't1').startedAt).toBeNull();
    expect(taskOf(withRef, 't1').references).toHaveLength(1);
    expect(taskOf(withRef, 't1').prompt).toBe('p');

    let textOnly = createTask({ ...OPENAI_BINDING });
    textOnly = generationTasksReducer(textOnly, { type: 'start-generating', taskId: 't1' });
    textOnly = generationTasksReducer(textOnly, { type: 'fail-task', taskId: 't1' });
    expect(taskOf(textOnly, 't1').status).toBe('idle');
    expect(taskOf(textOnly, 't1').startedAt).toBeNull();
  });

  it('set-reference-bytes：回填单张参考图 bytes，不触碰其余参考图与状态', () => {
    let state = createTask({ ...OPENAI_BINDING, references: [WEB_REF, ASSET_REF] });
    const refs = taskOf(state, 't1').references;
    expect(refs[0].bytes).toBeUndefined();
    expect(refs[1].bytes).toBeUndefined();

    state = generationTasksReducer(state, {
      type: 'set-reference-bytes',
      taskId: 't1',
      refId: refs[0].id!,
      bytes: 2048
    });
    const after = taskOf(state, 't1');
    expect(after.references[0].bytes).toBe(2048);
    expect(after.references[1].bytes).toBeUndefined();
    expect(after.status).toBe('collecting');
  });

  it('clear-task：从 Map 删除该任务，并回退 activeTaskId', () => {
    let state = createTask({ taskId: 't1' });
    state = createTask({ taskId: 't2' }, state);
    state = generationTasksReducer(state, { type: 'clear-task', taskId: 't2' });
    expect(state.tasks['t2']).toBeUndefined();
    expect(state.activeTaskId).toBe('t1');
  });

  it('set-active 切换聚焦任务', () => {
    let state = createTask({ taskId: 't1' });
    state = createTask({ taskId: 't2' }, state);
    state = generationTasksReducer(state, { type: 'set-active', taskId: 't1' });
    expect(state.activeTaskId).toBe('t1');
  });
});

describe('concurrency gate', () => {
  function makeGenerating(count: number) {
    let state = createInitialGenerationTasks();
    for (let i = 0; i < count; i += 1) {
      state = createTask({ taskId: `t${i}`, ...OPENAI_BINDING }, state);
      state = generationTasksReducer(state, { type: 'start-generating', taskId: `t${i}` });
    }
    return state;
  }

  it('countGenerating 反映在飞数', () => {
    expect(countGenerating(makeGenerating(3).tasks)).toBe(3);
    expect(countGenerating(makeGenerating(0).tasks)).toBe(0);
  });

  it('在飞数 < 5 时 canSubmitNew 为 true；达 5 时为 false（并发上限，不排队）', () => {
    expect(canSubmitNew(makeGenerating(4).tasks)).toBe(true);
    expect(canSubmitNew(makeGenerating(5).tasks)).toBe(false);
  });
});

describe('set-model (v3.9 模型切换联动重置)', () => {
  it('切到 gemini：size/quality/n 按新协议默认值重置', () => {
    let state = createTask({ ...OPENAI_BINDING });
    state = generationTasksReducer(state, {
      type: 'set-params',
      taskId: 't1',
      params: { size: '1024x1024', quality: 'high', n: 5 }
    });
    state = setModel(state, 't1', GEMINI_BINDING);
    const task = taskOf(state, 't1');
    expect(task.modelRecordId).toBe('model-gemini');
    expect(task.protocolId).toBe('gemini-image-v1');
    expect(task.size).toBe('1:1@1K');
    expect(task.quality).toBe('');
    expect(task.n).toBe(1);
    expect(task.maxN).toBe(1);
  });

  it('maxN 下调：默认 n 超过新 maxN 时钳制（8 → 3）', () => {
    let state = createTask({ ...OPENAI_BINDING });
    state = setModel(state, 't1', {
      ...OPENAI_BINDING,
      maxN: 3,
      defaults: { size: 'auto', quality: 'auto', n: 8 }
    });
    expect(taskOf(state, 't1').n).toBe(3);
    expect(taskOf(state, 't1').maxN).toBe(3);
  });

  it('参考图超新模型 maxRefs 时截断（gpt 16 → gemini 3）', () => {
    const manyRefs: GenerationReference[] = Array.from({ length: 10 }, (_, i) => ({
      kind: 'web',
      imageUrl: `https://x.com/${i}.png`
    }));
    let state = createTask({ ...OPENAI_BINDING, references: manyRefs });
    expect(taskOf(state, 't1').references).toHaveLength(10);
    state = setModel(state, 't1', GEMINI_BINDING);
    expect(taskOf(state, 't1').references).toHaveLength(3);
    expect(taskOf(state, 't1').status).toBe('collecting');
  });

  it('切到不支持参考图的模型时清空参考图并回 idle', () => {
    let state = createTask({ ...OPENAI_BINDING, references: [WEB_REF, ASSET_REF] });
    state = setModel(state, 't1', TEXT_ONLY_BINDING);
    const task = taskOf(state, 't1');
    expect(task.supportsReferenceImage).toBe(false);
    expect(task.references).toHaveLength(0);
    expect(task.status).toBe('idle');
  });

  it('切到 gemini 后再切回 gpt：size/quality 恢复 gpt 默认', () => {
    let state = createTask({ ...OPENAI_BINDING });
    state = setModel(state, 't1', GEMINI_BINDING);
    expect(taskOf(state, 't1').size).toBe('1:1@1K');
    state = setModel(state, 't1', OPENAI_BINDING);
    const task = taskOf(state, 't1');
    expect(task.size).toBe('auto');
    expect(task.quality).toBe('auto');
  });
});

describe('pickDefaultModelId（默认模型）', () => {
  const models = [{ id: 'm1' }, { id: 'm2' }];

  it('lastModelId 存在且仍在列表 → 用它', () => {
    expect(pickDefaultModelId(models, 'm2')).toBe('m2');
  });

  it('lastModelId 不存在 / 已删除 → 列表第一条', () => {
    expect(pickDefaultModelId(models, 'deleted')).toBe('m1');
    expect(pickDefaultModelId(models, null)).toBe('m1');
    expect(pickDefaultModelId(models, undefined)).toBe('m1');
  });

  it('模型列表为空 → 不选中', () => {
    expect(pickDefaultModelId([], 'm1')).toBeNull();
  });
});

describe('validateTaskForSubmit（无模型/能力/参数门禁）', () => {
  it('无模型阻止提交', () => {
    const state = createTask();
    const result = validateTaskForSubmit(taskOf(state, 't1'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('model_missing');
    }
  });

  it('模型记录不存在 / 连接不存在 / Key 缺失均阻止提交', () => {
    const state = createTask({ ...OPENAI_BINDING });
    const task = { ...taskOf(state, 't1'), prompt: 'p' };
    expect(validateTaskForSubmit(task, { modelExists: false })).toMatchObject({ ok: false, reason: 'model_not_found' });
    expect(validateTaskForSubmit(task, { connectionExists: false })).toMatchObject({
      ok: false,
      reason: 'connection_missing'
    });
    expect(validateTaskForSubmit(task, { hasKey: false })).toMatchObject({ ok: false, reason: 'key_missing' });
  });

  it('prompt 为空 / n 越界 / 参考图超限阻止提交', () => {
    let state = createTask({ ...OPENAI_BINDING });
    expect(validateTaskForSubmit(taskOf(state, 't1'))).toMatchObject({ ok: false, reason: 'prompt_empty' });

    state = generationTasksReducer(state, { type: 'set-params', taskId: 't1', params: { prompt: 'p', n: 11 } });
    expect(validateTaskForSubmit(taskOf(state, 't1'))).toMatchObject({ ok: false, reason: 'n_invalid' });

    state = setModel(state, 't1', { ...OPENAI_BINDING, maxRefs: 1 });
    state = generationTasksReducer(state, {
      type: 'set-params',
      taskId: 't1',
      params: { n: 1 }
    });
    // 直接构造超限态，覆盖门禁（正常 reducer 已阻止加入）。
    const overLimit = { ...taskOf(state, 't1'), references: [WEB_REF, ASSET_REF] };
    expect(validateTaskForSubmit(overLimit)).toMatchObject({ ok: false, reason: 'references_exceeded' });
  });

  it('参数合法时通过', () => {
    let state = createTask({ ...OPENAI_BINDING });
    state = generationTasksReducer(state, { type: 'set-params', taskId: 't1', params: { prompt: 'p' } });
    expect(
      validateTaskForSubmit(taskOf(state, 't1'), {
        modelExists: true,
        connectionExists: true,
        hasKey: true,
        sizeValid: true,
        qualityValid: true
      })
    ).toEqual({ ok: true });
  });
});

describe('buildGenerationSubmitFields（v3.9 载荷）', () => {
  it('只携带 modelRecordId，不携带 model/provider/baseUrl/key', () => {
    let state = createTask({ ...OPENAI_BINDING });
    state = generationTasksReducer(state, {
      type: 'set-params',
      taskId: 't1',
      params: { prompt: '  a cat  ', size: '1024x1024', quality: 'high', n: 2 }
    });
    const fields = buildGenerationSubmitFields(taskOf(state, 't1'), [
      { kind: 'web', imageUrl: 'https://x.com/a.png' }
    ]);
    expect(fields).toEqual({
      taskId: 't1',
      modelRecordId: 'model-openai',
      prompt: 'a cat',
      size: '1024x1024',
      quality: 'high',
      n: 2,
      references: [{ kind: 'web', imageUrl: 'https://x.com/a.png' }]
    });
    expect(fields && 'model' in fields).toBe(false);
    expect(fields && 'provider' in fields).toBe(false);
  });

  it('未选模型返回 null', () => {
    const state = createTask();
    expect(buildGenerationSubmitFields(taskOf(state, 't1'), [])).toBeNull();
  });
});

describe('任务状态展示文案（阶段优先 + 模式二级）', () => {
  it('阶段词只表达生命周期：idle 与 collecting 同为待生成', () => {
    expect(taskStageLabel('idle')).toBe('待生成');
    expect(taskStageLabel('collecting')).toBe('待生成');
    expect(taskStageLabel('generating')).toBe('生成中');
    expect(taskStageLabel('done')).toBe('已完成');
  });

  it('模式词由参考图数量推导，为空即文生图', () => {
    expect(taskModeLabel(0)).toBe('文生图');
    expect(taskModeLabel(1)).toBe('图生图');
  });

  it('状态位文案为「阶段 · 模式」，不再出现「收集中」', () => {
    const collecting = taskOf(createTask({ references: [WEB_REF] }), 't1');
    expect(taskStatusText(collecting)).toBe('待生成 · 图生图');

    const idle = taskOf(createTask(), 't1');
    expect(taskStatusText(idle)).toBe('待生成 · 文生图');

    for (const status of ['idle', 'collecting', 'generating', 'done'] as const) {
      expect(taskStatusText({ status, references: [] })).not.toContain('收集中');
    }
  });
});
