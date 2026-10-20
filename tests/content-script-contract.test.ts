import { describe, expect, it } from 'vitest';

import manifest from '../src/manifest';

describe('content script contract', () => {
  it('角标脚本应覆盖 frame 与 about:blank 场景', async () => {
    const resolvedManifest = (await Promise.resolve(manifest)) as chrome.runtime.ManifestV3;
    const quickSaveScript = resolvedManifest.content_scripts?.find((script) =>
      script.js?.includes('src/content/index.ts')
    );

    expect(quickSaveScript).toBeDefined();
    expect(quickSaveScript?.matches).toEqual(['<all_urls>']);
    expect(quickSaveScript?.run_at).toBe('document_idle');
    expect(quickSaveScript?.all_frames).toBe(true);
    expect(quickSaveScript?.match_about_blank).toBe(true);
  });
});
