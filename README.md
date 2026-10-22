# 素材采图（Asset Extension Tool）

Chrome MV3 扩展：保存网页图片到本地，用资产库检索、筛选、分类，并支持自带 API Key 的 AI 生图。

## 功能

- **保存**：图片右键菜单、图片右下角角标按钮两种入口，复用同一条保存链路
- **落盘**：保存到本地磁盘，统一托管在 `WYJHExtension` 目录
- **资产库**：按站点、文件夹、标签筛选，瀑布流网格展示
- **编辑**：修改标签与文件夹、定位磁盘文件、复制图像（失败时降级复制 URL）
- **AI 生图**：侧边栏承载，多任务并发；文生图与图生图统一为同一任务模型
- **多图收集**：网页图可加入侧边栏当前任务（右键「加入当前生图任务」/ 角标选择），把不同页面、不同标签页的图持续收进同一任务
- **自建服务**：内置 OpenAI Images / Gemini Image 两套协议，用户自行添加服务商连接与模型
- **血缘**：生成图记录来源参考图、提示词、模型等快照，历史资产可追溯

## 安装与构建

要求 Node.js 20+。

```bash
npm install
npm run build
```

1. 打开 `chrome://extensions`
2. 启用「开发者模式」
3. 点「加载已解压的扩展程序」，选择本项目 `dist/` 目录

## 开发

```bash
npm run dev      # Vite 开发服务器
npm run lint     # ESLint
npm run test     # Vitest 单测
npm run build    # tsc 类型检查 + vite 构建
npm run pack     # 构建并打包为 zip
```

## 分发

通过 GitHub Releases 分发：推送 `v*` 标签后，`.github/workflows/release.yml` 会构建并上传两个资产：

- `asset-extension-tool-v<version>.zip`：带版本号，便于归档与回溯。
- `asset-extension-tool.zip`：固定名，始终指向最新正式 Release。

固定下载地址（始终最新）：

```text
https://github.com/tf961656585/asset-extension-tool/releases/latest/download/asset-extension-tool.zip
```

接收方下载解压后，按上面的「加载已解压的扩展程序」加载。

> Chrome 不允许点击链接直接安装非 Web Store 扩展，接收方仍需开启开发者模式。

## 目录结构

| 路径 | 职责 |
|---|---|
| `src/manifest.ts` | 扩展清单（权限、入口、content script、sidePanel） |
| `src/background/` | Service Worker：右键菜单、保存链路、磁盘下载、生图调度与落库（资产库唯一写入方） |
| `src/content/` | 内容脚本：角标按钮组与状态机、图片识别策略 |
| `src/popup/` | 弹窗 UI：资产浏览、筛选、编辑、设置、帮助 |
| `src/sidepanel/` | 侧边栏 UI：生图任务、参数面板与网页图收集判定（`collect-decision.ts`） |
| `src/shared/` | 共享领域层：数据模型、保存 / 生图请求、消息协议、存储封装 |
| `tests/` | 单元与契约测试 |
| `scripts/` | 构建打包脚本 |

## 数据与隐私

- 资产元数据存 `chrome.storage.local` 的 `asset_manager_v1`
- 生成图的图片字节存 IndexedDB，不写入 `chrome.storage.local`
- 服务商 API Key 按连接存本地，仅 Service Worker 读取；不写入日志、消息载荷或血缘，也不会上传到作者服务器
- 无遥测、无统计脚本；网络请求只发往用户配置的服务商与图片源

## 许可证

[MIT](LICENSE)
