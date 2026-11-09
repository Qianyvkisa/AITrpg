// ---------------------------------------------------------------------------
// 创建 v0.2.1 GitHub Release 并上传 exe
//
// 为什么用 Node 而不是 PowerShell：
//   1) 正文含大量中文，PowerShell 5.1 转请求体时按本地代码页处理会丢中文；
//   2) 上传 107 MB 的二进制文件，用 fetch + stream 比 Invoke-RestMethod 稳。
//
// 用法：node tools\publish-release.mjs
// 需要环境变量 GH_TOKEN（从 git 凭据管理器取）
// ---------------------------------------------------------------------------

import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'Qianyvkisa/AITrpg';
const TAG = 'v0.2.1';
const EXE = join(root, 'COC-Keeper-v0.2.1-win-x64-portable.exe');
const BODY_FILE = join(root, 'tools', 'ui', 'shots', 'release-body.json');

const token = process.env.GH_TOKEN;
if (!token) { console.error('缺少 GH_TOKEN'); process.exit(1); }

const H = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'coc-keeper-release'
};

const { body, name } = JSON.parse(readFileSync(BODY_FILE, 'utf8'));

// ---- 1) 建 Release（已存在则复用）----
let release;
{
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: TAG,
      name,
      body,
      draft: false,
      prerelease: false
    })
  });
  if (r.ok) {
    release = await r.json();
    console.log(`已创建 Release: ${release.html_url}`);
  } else if (r.status === 422) {
    // 已存在，取回来
    const r2 = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, { headers: H });
    release = await r2.json();
    console.log(`Release 已存在，复用: ${release.html_url}`);
  } else {
    console.error('创建失败:', r.status, await r.text());
    process.exit(1);
  }
}

// ---- 2) 上传 exe ----
const size = statSync(EXE).size;
console.log(`上传 ${EXE}（${(size / 1024 / 1024).toFixed(1)} MB）…`);

// 已存在同名资产则先删掉，避免重复
for (const a of release.assets || []) {
  if (a.name === 'COC-Keeper-v0.2.1-win-x64-portable.exe') {
    await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${a.id}`, {
      method: 'DELETE', headers: H
    });
    console.log('已删除同名旧资产:', a.name);
  }
}

const uploadUrl = `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent('COC-Keeper-v0.2.1-win-x64-portable.exe')}`;

const data = readFileSync(EXE);
const up = await fetch(uploadUrl, {
  method: 'POST',
  headers: {
    ...H,
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(size)
  },
  body: data
});

if (!up.ok) {
  console.error('上传失败:', up.status, await up.text());
  process.exit(1);
}
const asset = await up.json();
console.log(`上传完成: ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`);
console.log(`下载地址: ${asset.browser_download_url}`);
console.log(`Release 页面: ${release.html_url}`);
