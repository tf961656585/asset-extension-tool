import { describe, expect, it } from 'vitest';

import {
  addFolder,
  createAssetRecord,
  createDefaultData,
  filterAssets,
  parseTagInput,
  updateAssetFolder,
  updateAssetTags,
  upsertAsset
} from '../src/shared/model';

describe('asset model', () => {
  it('支持网站模糊搜索', () => {
    let data = createDefaultData();

    data = upsertAsset(
      data,
      createAssetRecord({
        imageUrl: 'https://cdn.alpha.com/a.png',
        sourcePageUrl: 'https://news.alpha.com/post/1',
        downloadId: 1,
        filename: 'a.png'
      })
    );

    data = upsertAsset(
      data,
      createAssetRecord({
        imageUrl: 'https://cdn.beta.com/b.png',
        sourcePageUrl: 'https://beta.com/post/2',
        downloadId: 2,
        filename: 'b.png'
      })
    );

    const result = filterAssets(data, { siteKeyword: 'alpha' });
    expect(result).toHaveLength(1);
    expect(result[0].sourceDomain).toContain('alpha.com');
  });

  it('支持文件夹与标签组合过滤', () => {
    let data = createDefaultData();
    const { data: withFolder, folder } = addFolder(data, '设计稿');
    data = withFolder;

    const asset = createAssetRecord({
      imageUrl: 'https://img.site.com/hero.png',
      sourcePageUrl: 'https://site.com/home',
      downloadId: 9,
      filename: 'hero.png'
    });

    data = upsertAsset(data, asset);
    data = updateAssetFolder(data, asset.id, folder.id);
    data = updateAssetTags(data, asset.id, ['hero', 'homepage']);

    const result = filterAssets(data, {
      folderId: folder.id,
      tags: ['hero']
    });

    expect(result).toHaveLength(1);
    expect(result[0].tags).toContain('hero');
  });

  it('标签输入会去重并归一化', () => {
    const tags = parseTagInput(' Hero,hero, Banner ');
    expect(tags).toEqual(['hero', 'banner']);
  });

  it('默认配置包含保存位置设置', () => {
    const data = createDefaultData();
    expect(data.settings.saveBaseDir).toBe('');
  });
});
