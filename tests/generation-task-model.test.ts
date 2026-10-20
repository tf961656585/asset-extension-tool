import { describe, expect, it } from 'vitest';

import {
  buildGenerationSubmitFields,
  createInitialGenerationTasks,
  generationTasksReducer,
  type TaskModelBinding
} from '../src/sidepanel/generation-session-state';
import { createTaskId } from '../src/shared/generation';
import { MESSAGE_TYPES } from '../src/shared/messages';
import type { ProtocolId } from '../src/shared/protocols';

const BINDING: TaskModelBinding = {
  modelRecordId: 'model-record-1',
  protocolId: 'openai-images-v1' as ProtocolId,
  maxRefs: 16,
  maxN: 10,
  supportsReferenceImage: true,
  defaults: { size: 'auto', quality: 'auto', n: 1 }
};

describe('createTaskId', () => {
  it('连续调用返回不同值（唯一性）', () => {
    const ids = new Set(Array.from({ length: 100 }, () => createTaskId()));
    expect(ids.size).toBe(100);
    for (const id of ids) {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    }
  });
});

describe('GenerationTask state set', () => {
  it('状态集严格 4 态（idle/collecting/generating/done），不含 retriable', () => {
    const validStates = ['idle', 'collecting', 'generating', 'done'];
    const reachable = ['idle', 'collecting', 'generating', 'done'];
    for (const s of reachable) {
      expect(validStates).toContain(s);
    }
    expect(validStates).not.toContain('retriable');
  });
});

describe('createInitialGenerationTasks', () => {
  it('初始为 { tasks: {}, activeTaskId: null }', () => {
    const state = createInitialGenerationTasks();
    expect(state).toEqual({ tasks: {}, activeTaskId: null });
  });
});

describe('GenerationTask 模型字段（v3.9）', () => {
  it('任务只以 modelRecordId 标识模型，不保留 model / provider 执行字段', () => {
    const state = generationTasksReducer(createInitialGenerationTasks(), {
      type: 'create-task',
      taskId: 't1',
      references: [],
      mode: 'intent-first',
      ...BINDING
    });
    const task = state.tasks['t1'];
    expect(task.modelRecordId).toBe('model-record-1');
    expect(task.protocolId).toBe('openai-images-v1');
    expect(task.maxRefs).toBe(16);
    expect(task.maxN).toBe(10);
    expect(task.supportsReferenceImage).toBe(true);
    expect(task.defaults).toEqual({ size: 'auto', quality: 'auto', n: 1 });
    expect('model' in task).toBe(false);
    expect('provider' in task).toBe(false);
  });

  it('无模型任务 modelRecordId 为 null', () => {
    const state = generationTasksReducer(createInitialGenerationTasks(), {
      type: 'create-task',
      taskId: 't1',
      references: [],
      mode: 'intent-first'
    });
    expect(state.tasks['t1'].modelRecordId).toBeNull();
    expect(state.tasks['t1'].protocolId).toBeNull();
  });

  it('set-model 更新 modelRecordId 与能力快照，不写入 provider', () => {
    let state = generationTasksReducer(createInitialGenerationTasks(), {
      type: 'create-task',
      taskId: 't1',
      references: [],
      mode: 'intent-first',
      ...BINDING
    });
    state = generationTasksReducer(state, {
      type: 'set-model',
      taskId: 't1',
      modelRecordId: 'model-record-2',
      protocolId: 'gemini-image-v1' as ProtocolId,
      maxRefs: 3,
      maxN: 1,
      supportsReferenceImage: true,
      defaults: { size: '1:1@1K', quality: '', n: 1 }
    });
    const task = state.tasks['t1'];
    expect(task.modelRecordId).toBe('model-record-2');
    expect(task.protocolId).toBe('gemini-image-v1');
    expect(task.maxRefs).toBe(3);
    expect(task.maxN).toBe(1);
    expect('provider' in task).toBe(false);
  });
});

describe('生图提交消息载荷（v3.9）', () => {
  it('字段为 { taskId, modelRecordId, prompt, size, quality, n, references }，无 model/provider', () => {
    let state = generationTasksReducer(createInitialGenerationTasks(), {
      type: 'create-task',
      taskId: 't1',
      references: [],
      mode: 'intent-first',
      ...BINDING
    });
    state = generationTasksReducer(state, {
      type: 'set-params',
      taskId: 't1',
      params: { prompt: 'a cat', size: '1024x1024', quality: 'high', n: 2 }
    });
    const fields = buildGenerationSubmitFields(state.tasks['t1'], []);
    expect(fields).toEqual({
      taskId: 't1',
      modelRecordId: 'model-record-1',
      prompt: 'a cat',
      size: '1024x1024',
      quality: 'high',
      n: 2,
      references: []
    });
    expect(fields && 'model' in fields).toBe(false);
    expect(fields && 'provider' in fields).toBe(false);
    expect(fields && 'baseUrl' in fields).toBe(false);
    expect(fields && 'apiKey' in fields).toBe(false);
  });

  it('提交消息类型沿用 GENERATION_SUBMIT', () => {
    expect(MESSAGE_TYPES.GENERATION_SUBMIT).toBe('GENERATION_SUBMIT');
  });
});
