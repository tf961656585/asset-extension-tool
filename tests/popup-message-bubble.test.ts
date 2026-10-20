import { describe, expect, it } from 'vitest';
import appSource from '../src/popup/App.tsx?raw';

describe('popup message bubble contract', () => {
  it('动作反馈使用消息气泡浮层而不是固定 notice 区块', () => {
    expect(appSource).toContain('className={`message-bubble message-bubble-${notice.type}`}');
    expect(appSource).not.toContain('className={`notice notice-${notice.type}`}');
  });

  it('消息气泡包含无障碍属性', () => {
    expect(appSource).toContain('role="status"');
    expect(appSource).toContain("aria-live={notice.type === 'error' ? 'assertive' : 'polite'}");
    expect(appSource).toContain('aria-atomic="true"');
  });

  it('消息气泡在触发后会自动消失', () => {
    expect(appSource).toContain('MESSAGE_BUBBLE_AUTO_DISMISS_MS');
    expect(appSource).toContain('window.setTimeout(() => {');
    expect(appSource).toContain('setNotice(createInitialNotice());');
  });
});
