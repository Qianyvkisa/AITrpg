// ---------------------------------------------------------------------------
// 创建 v0.2.2 GitHub Release 并上传 exe
//
// 为什么用 Node 而不是 PowerShell：
//   1) 正文含大量中文，PowerShell 5.1 转请求体时按本地代码页处理会丢中文；
//   2) 上传 107 MB 的二进制文件，用 fetch + stream 比 Invoke-RestMethod 稳。
//
// 用法：node tools\publish-release.mjs
// 需要环境变量 GH_TOKEN（从 git 凭据管理器取）
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'Qianyvkisa/AITrpg';
const TAG = 'v0.2.2';
const BODY_FILE = join(root, 'tools', 'ui', 'shots', 'release-body.json');

// 本地产物名 vs 上传到 GitHub 的附件名，这两个必须分开看。
//
// 本地：electron-builder 按 artifactName（`${productName}.${ext}`）产出，
//       productName 是中文的「COC跑团」，所以本地文件叫 COC跑团.exe。
//
// GitHub：Release 的附件名**只接受 ASCII**，实测中文会被平台静默剥掉——
//       `中文测试.exe` 存成 `default.exe`，`abc跑团xyz.exe` 存成 `abc.xyz.exe`。
//       所以 `COC跑团.exe` 传上去会变成 `COC.exe`。这是平台硬限制，
//       name/label/PATCH 三条路都试过，改不了。
//
// 结论：本地读 COC跑团.exe，上传时显式用 ASCII 名，别让 GitHub 去剥。
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const productName = pkg.build?.productName || pkg.name;
const LOCAL_NAME = `${productName}.exe`;
// 附件名：把非 ASCII 字符去掉，剩下的 ASCII 部分兜底成 'COC'
const asciiStem = productName.replace(/[^\x20-\x7E]/g, '').trim() || 'COC';
const ASSET_NAME = `${asciiStem}.exe`;

// 优先用根目录的产物（release.ps1 的产物落点），回退到 dist\
const exeCandidates = [
  join(root, LOCAL_NAME),
  join(root, 'dist', LOCAL_NAME)
];
const EXE = exeCandidates.find((p) => existsSync(p));
if (!EXE) {
  console.error(`找不到打包产物 ${LOCAL_NAME}，先跑 release.ps1 或 electron-builder`);
  process.exit(1);
}

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

// 先清掉同名旧资产，避免重复；顺手把历史遗留的英文 slug 名字也清掉，
// 否则一个 Release 下会同时躺着两个 107 MB 的 exe，玩家不知道该下哪个。
const STALE_NAMES = new Set([
  ASSET_NAME,
  ...(release.assets || [])
    .map((a) => a.name)
    .filter((n) => /^COC-Keeper-v[\d.]+-win-x64-portable\.exe$/i.test(n))
]);
for (const a of release.assets || []) {
  if (STALE_NAMES.has(a.name)) {
    const del = await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${a.id}`, {
      method: 'DELETE', headers: H
    });
    console.log(del.ok ? `已删除旧资产: ${a.name}` : `删除失败(${del.status}): ${a.name}`);
  }
}

const uploadUrl = `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(ASSET_NAME)}`;

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
