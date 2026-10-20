import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deleteGeneratedBlob, getGeneratedBlob, openAssetDB, putGeneratedBlob } from '../src/shared/idb-asset-store';

/**
 * 生成图字节 IndexedDB 承载层测试。
 * 用 fake-indexeddb 在 node 环境模拟原生 IndexedDB。
 */
describe('idb-asset-store 生成图字节承载层', () => {
  beforeEach(() => {
    // 每个测试用全新 IDB 实例，保证隔离
    globalThis.indexedDB = new IDBFactory();
  });

  afterEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it('openAssetDB 建立单一 object store', async () => {
    const db = await openAssetDB();
    expect(db.objectStoreNames.contains('generated-images')).toBe(true);
    db.close();
  });

  it('put → get 往返字节一致', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const blob = new Blob([bytes], { type: 'image/png' });

    await putGeneratedBlob('asset_a', blob);
    const got = await getGeneratedBlob('asset_a');

    expect(got).toBeInstanceOf(Blob);
    expect(got?.type).toBe('image/png');
    const gotBytes = new Uint8Array(await (got as Blob).arrayBuffer());
    expect(Array.from(gotBytes)).toEqual([1, 2, 3, 4, 5]);
  });

  it('get 不存在的键返回 undefined', async () => {
    const got = await getGeneratedBlob('absent');
    expect(got).toBeUndefined();
  });

  it('delete 后 get 返回 undefined', async () => {
    const blob = new Blob([new Uint8Array([9, 9])], { type: 'image/png' });
    await putGeneratedBlob('asset_b', blob);
    expect(await getGeneratedBlob('asset_b')).toBeInstanceOf(Blob);

    await deleteGeneratedBlob('asset_b');
    expect(await getGeneratedBlob('asset_b')).toBeUndefined();
  });

  it('put 覆盖同键旧值', async () => {
    await putGeneratedBlob('asset_c', new Blob([new Uint8Array([1])], { type: 'image/png' }));
    await putGeneratedBlob('asset_c', new Blob([new Uint8Array([2, 2])], { type: 'image/png' }));

    const got = await getGeneratedBlob('asset_c');
    const gotBytes = new Uint8Array(await (got as Blob).arrayBuffer());
    expect(Array.from(gotBytes)).toEqual([2, 2]);
  });
});
