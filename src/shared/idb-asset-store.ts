/**
 * 生成图字节的 IndexedDB 承载层（spec FR-21）。
 *
 * 职责：生成图图片字节（Blob）的唯一持久化通道，与 chrome.storage.local（元数据）分离。
 * 采集图不产生任何 IndexedDB 条目。
 *
 * schema：单一数据库 → 单一 object store，键为生成图资产的 id，值为该图 Blob。
 */
const DB_NAME = 'asset-extension';
const STORE_NAME = 'generated-images';
const DB_VERSION = 1;

/** 打开（必要时升级创建）资产图字节数据库。 */
export function openAssetDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withStore<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const request = run(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** 写入生成图字节（键为资产 id）。 */
export async function putGeneratedBlob(id: string, blob: Blob): Promise<void> {
  const db = await openAssetDB();
  await withStore<IDBValidKey>(db, 'readwrite', (store) => store.put(blob, id));
  db.close();
}

/** 读取生成图字节；键不存在时返回 undefined。 */
export async function getGeneratedBlob(id: string): Promise<Blob | undefined> {
  const db = await openAssetDB();
  const result = await withStore<Blob | undefined>(db, 'readonly', (store) => store.get(id));
  db.close();
  return result ?? undefined;
}

/** 删除生成图字节（资产从资产库移除时同步调用，不残留无主字节）。 */
export async function deleteGeneratedBlob(id: string): Promise<void> {
  const db = await openAssetDB();
  await withStore<undefined>(db, 'readwrite', (store) => store.delete(id));
  db.close();
}
