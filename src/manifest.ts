import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'Asset Extension Tool',
  description: '快速保存网页图像并进行检索、筛选和分类管理。',
  version: '0.1.0',
  action: {
    default_title: '资产扩展工具',
    default_popup: 'src/popup/index.html'
  },
  permissions: ['storage', 'downloads', 'tabs', 'activeTab', 'clipboardWrite', 'contextMenus', 'sidePanel'],
  host_permissions: ['<all_urls>'],
  side_panel: {
    default_path: 'src/sidepanel/index.html'
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module'
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
      all_frames: true,
      match_about_blank: true
    }
  ]
});
