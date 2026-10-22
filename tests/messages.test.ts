import { describe, expect, it } from 'vitest';

import {
  MESSAGE_TYPES,
  isGenerationSubmitPayload,
  type GenerationFeedbackPayload,
  type GenerationSubmitPayload
} from '../src/shared/messages';

describe('message types', () => {
  it('不暴露 SCAN_IMAGES 与旧的 GENERATION_ADD_REFERENCE 消息类型', () => {
    expect('SCAN_IMAGES' in MESSAGE_TYPES).toBe(false);
    // v3.10 的收集能力走 GENERATION_COLLECT_* 系列，不复用 v3.2 已删除的旧名。
    expect('GENERATION_ADD_REFERENCE' in MESSAGE_TYPES).toBe(false);
  });

  it('包含保存、生图与收集三类消息类型（含多任务 CREATE/CANCEL 与 v3.10 COLLECT 系列）', () => {
    expect(Object.keys(MESSAGE_TYPES)).toEqual([
      'SAVE_IMAGE',
      'SAVE_FEEDBACK',
      'GENERATION_SUBMIT',
      'GENERATION_CREATE_TASK',
      'GENERATION_CANCEL_TASK',
      'GENERATION_FEEDBACK',
      'GENERATION_COLLECT_REFERENCE',
      'GENERATION_COLLECT_TARGET_QUERY',
      'GENERATION_COLLECT_TARGET_REQUEST',
      'GENERATION_COLLECT_REQUEST',
      'GENERATION_COLLECT_REPLY',
      'GENERATION_COLLECT_FEEDBACK'
    ]);
  });
});

describe('generation payloads carry taskId', () => {
  const validPayload: GenerationSubmitPayload = {
    taskId: 'task_1',
    modelRecordId: 'model_1',
    prompt: 'p',
    size: 'auto',
    quality: 'auto',
    n: 1,
    references: [{ kind: 'local', filename: 'a.png', base64: 'YQ==', mimeType: 'image/png' }]
  };

  it('GenerationSubmitPayload 含 taskId 与 modelRecordId（不再携带 model / provider）', () => {
    expect(validPayload.taskId).toBe('task_1');
    expect(validPayload.modelRecordId).toBe('model_1');
    expect(validPayload.quality).toBe('auto');
    expect('model' in validPayload).toBe(false);
    expect('provider' in validPayload).toBe(false);
    // 载荷态：local 来源用 base64 字符串，不得使用 Blob/File/ArrayBuffer
    expect(typeof validPayload.references[0].base64).toBe('string');
  });

  it('GenerationFeedbackPayload 含 taskId，level 为 info|success|error（无 retriable）', () => {
    const info: GenerationFeedbackPayload = { taskId: 'task_1', level: 'info', message: '提交' };
    const success: GenerationFeedbackPayload = { taskId: 'task_1', level: 'success', message: '完成', count: 2 };
    const error: GenerationFeedbackPayload = {
      taskId: 'task_1',
      level: 'error',
      message: '服务商未配置 Key',
      reason: 'key_missing'
    };
    expect(info.level).toBe('info');
    expect(success.level).toBe('success');
    expect(error.level).toBe('error');
    expect(error.reason).toBe('key_missing');
    const allLevels = [info.level, success.level, error.level];
    expect(allLevels).not.toContain('retriable');
  });

  it('运行时校验：合法载荷通过', () => {
    expect(isGenerationSubmitPayload(validPayload)).toBe(true);
  });

  it('运行时校验：缺少 modelRecordId、只带旧 model 字段、taskId 为空均拒绝', () => {
    expect(isGenerationSubmitPayload({ ...validPayload, modelRecordId: undefined })).toBe(false);
    expect(isGenerationSubmitPayload({ ...validPayload, modelRecordId: '' })).toBe(false);
    expect(isGenerationSubmitPayload({ ...validPayload, taskId: '   ' })).toBe(false);

    const legacy = {
      taskId: 'task_1',
      model: 'gpt-image-2',
      prompt: 'p',
      size: 'auto',
      quality: 'auto',
      n: 1,
      references: []
    };
    expect(isGenerationSubmitPayload(legacy)).toBe(false);
  });

  it('运行时校验：字段类型与参考图载荷结构非法时拒绝', () => {
    expect(isGenerationSubmitPayload(null)).toBe(false);
    expect(isGenerationSubmitPayload('payload')).toBe(false);
    expect(isGenerationSubmitPayload({ ...validPayload, prompt: undefined })).toBe(false);
    expect(isGenerationSubmitPayload({ ...validPayload, size: 1024 })).toBe(false);
    expect(isGenerationSubmitPayload({ ...validPayload, n: '1' })).toBe(false);
    expect(isGenerationSubmitPayload({ ...validPayload, references: undefined })).toBe(false);
    expect(
      isGenerationSubmitPayload({ ...validPayload, references: [{ kind: 'unknown' }] })
    ).toBe(false);
    expect(
      isGenerationSubmitPayload({
        ...validPayload,
        references: [{ kind: 'local', base64: 123 }]
      })
    ).toBe(false);
  });
});
