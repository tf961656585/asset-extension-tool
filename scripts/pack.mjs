#!/usr/bin/env node
// 打包脚本：读取 package.json 的 version，将 dist/ 内部内容压缩为
// `<name>-v<version>.zip`（解压后即为扩展根目录，不含 dist 外层）。
// 零额外依赖，使用系统自带 zip（macOS / Linux 自带；Windows 可用 WSL 或 PowerShell Compress-Archive）。
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

const distDir = resolve(root, 'dist');
if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
  console.error('[pack] 未找到 dist/，请先运行 `npm run build`。');
  process.exit(1);
}

const outZip = resolve(root, `${pkg.name}-v${pkg.version}.zip`);

// 先删除已存在的同名 zip，避免旧条目残留（zip 默认会合并而非重建）
if (existsSync(outZip)) unlinkSync(outZip);

try {
  execFileSync('zip', ['-r', '-X', '-q', outZip, '.', '-x', '*.DS_Store'], {
    cwd: distDir,
    stdio: 'inherit',
  });
} catch {
  console.error(
    '[pack] 打包失败：请确认系统已安装 zip（macOS/Linux 自带；Windows 可用 WSL，' +
      '或改用 PowerShell `Compress-Archive -Path dist/* -DestinationPath out.zip`）。'
  );
  process.exit(1);
}

console.log(`[pack] 已生成 ${outZip}`);
