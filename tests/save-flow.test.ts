import { describe, expect, it } from 'vitest';

import { buildAssetFilename, buildManagedRootDir } from '../src/shared/model';
import { createSavePayload, resolveSaveRequest } from '../src/shared/save';

describe('save flow helpers', () => {
  it('保存路径会统一落在 WYJHExtension 目录', () => {
    expect(buildManagedRootDir('')).toBe('WYJHExtension');
    expect(buildManagedRootDir('Pictures/Assets')).toBe('Pictures/Assets/WYJHExtension');
    expect(buildManagedRootDir('Pictures/WYJHExtension')).toBe('Pictures/WYJHExtension');
  });

  it('路径构建会清理非法路径片段', () => {
    expect(buildManagedRootDir('../unsafe//dir')).toBe('unsafe/dir/WYJHExtension');
  });

  it('文件名构建包含域名目录和时间戳扩展名', () => {
    const filename = buildAssetFilename({
      imageUrl: 'https://cdn.site.com/cover.webp',
      sourceDomain: 'sub.site.com',
      saveBaseDir: 'DownloadBase',
      now: new Date('2026-02-20T12:34:56.000Z')
    });

    expect(filename).toBe('DownloadBase/WYJHExtension/sub.site.com/2026-02-20T12-34-56-000Z.webp');
  });

  it('统一保存请求会自动填充来源域名与目标路径', () => {
    const payload = createSavePayload('https://img.site.com/a.png', 'https://news.site.com/post/1');
    const request = resolveSaveRequest(payload, 'Workspace', new Date('2026-02-20T01:02:03.000Z'));

    expect(request.sourcePageUrl).toBe('https://news.site.com/post/1');
    expect(request.sourceDomain).toBe('news.site.com');
    expect(request.filename).toBe('Workspace/WYJHExtension/news.site.com/2026-02-20T01-02-03-000Z.png');
  });
});
