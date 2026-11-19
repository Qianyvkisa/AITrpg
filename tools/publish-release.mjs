// 由 release.ps1 推送精确的 Git 标签后调用。先上传草稿附件，再公开发布。
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

export async function publishRelease({ repo, tag, commit, notes, assetName, data, token }, fetcher = fetch, sendAsset) {
  const url = `https://api.github.com/repos/${repo}/releases`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'coc-keeper-release'
  };
  const digest = `sha256:${createHash('sha256').update(data).digest('hex')}`;

  async function request(endpoint, method = 'GET', options = {}) {
    const response = await fetcher(endpoint, {
      ...options,
      method,
      headers: { ...headers, ...options.headers },
      signal: AbortSignal.timeout(300_000)
    });
    if (!response.ok) {
      throw new Error(`${method} ${new URL(endpoint).pathname} 失败（HTTP ${response.status}）：${await response.text()}`);
    }
    if (response.status !== 204) return response.json();
  }

  const json = (body) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let release;
  for (let page = 1; !release; page++) {
    const releases = await request(`${url}?per_page=100&page=${page}`);
    release = releases.find((item) => item.tag_name === tag);
    if (releases.length < 100) break;
  }

  if (!release) {
    release = await request(url, 'POST', json({
      tag_name: tag, target_commitish: commit, name: tag, body: notes, draft: true, prerelease: false
    }));
  }

  let asset = release.assets?.find((item) => item.name === assetName);
  if (asset?.state === 'starter' && release.draft) {
    // GitHub 在传输失败后可能留下空附件，可以在同一草稿内重试。
    await request(`${url}/assets/${asset.id}`, 'DELETE');
    asset = null;
  }
  if (asset && (asset.digest !== digest || asset.size !== data.length)) {
    throw new Error(`${tag} 已有内容不同的同名附件。`);
  }
  if (!release.draft) {
    if (!asset) throw new Error(`${tag} 已公开发布且缺少预期附件 ${assetName}。`);
    return { release, asset };
  }

  if (!asset) {
    const upload = new URL(release.upload_url.split('{')[0]);
    if (upload.origin !== 'https://uploads.github.com') throw new Error('GitHub 返回了无效的附件上传地址。');
    upload.searchParams.set('name', assetName);
    asset = sendAsset
      ? await sendAsset(upload)
      : await request(upload, 'POST', {
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(data.length) },
        body: data
      });
    if (asset.state !== 'uploaded' || asset.size !== data.length || (asset.digest && asset.digest !== digest)) {
      throw new Error('GitHub 返回的附件信息与本地 EXE 不一致。');
    }
  }

  release = await request(`${url}/${release.id}`, 'PATCH', json({ draft: false }));
  return { release, asset: release.assets?.find((item) => item.id === asset.id) || asset };
}

async function uploadWithPowerShell(shell, url, exePath) {
  // 用 Windows 的 HTTP 客户端从文件流传输大附件，沿用系统代理与证书配置。
  const command = `
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $token = if ($env:GH_TOKEN) { $env:GH_TOKEN } else { $env:GITHUB_TOKEN }
    $headers = @{
      Authorization = "Bearer $token"
      Accept = 'application/vnd.github+json'
      'X-GitHub-Api-Version' = '2022-11-28'
    }
    $arguments = @{
      Method = 'Post'
      Uri = $env:COC_RELEASE_UPLOAD_URL
      Headers = $headers
      ContentType = 'application/octet-stream'
      InFile = $env:COC_RELEASE_UPLOAD_FILE
      TimeoutSec = 300
    }
    $asset = Invoke-RestMethod @arguments
    $asset | ConvertTo-Json -Depth 6 -Compress
  `;
  const { stdout } = await promisify(execFile)(shell, ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
    timeout: 320_000,
    env: { ...process.env, COC_RELEASE_UPLOAD_URL: url.href, COC_RELEASE_UPLOAD_FILE: exePath }
  });
  return JSON.parse(stdout.trim());
}

async function main() {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string' },
      tag: { type: 'string' },
      commit: { type: 'string' },
      message: { type: 'string' },
      powershell: { type: 'string' },
      'notes-file': { type: 'string' }
    }
  });
  const { repo, tag, commit } = values;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const prefix = `v${pkg.version}-fix`;

  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^[a-f\d]{40}$/.test(commit || '')) {
    throw new Error('请提供有效的 --repo 和 --commit。');
  }
  if (!tag?.startsWith(prefix) || !/^[1-9]\d*$/.test(tag.slice(prefix.length))) {
    throw new Error(`--tag 应使用 ${prefix}<编号>。`);
  }
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('缺少 GH_TOKEN 或 GITHUB_TOKEN。');

  const productName = pkg.build?.productName || pkg.name;
  const asciiStem = productName.replace(/[^a-z\d_-]/gi, '') || 'COC';
  const assetName = `${asciiStem}-${tag}.exe`;
  const notes = values['notes-file']
    ? readFileSync(values['notes-file'], 'utf8').replace(/^\uFEFF/, '')
    : values.message || tag;
  const exePath = join(root, `${productName}.exe`);
  const data = readFileSync(exePath);
  const sendAsset = values.powershell && ((url) => uploadWithPowerShell(values.powershell, url, exePath));
  console.log(`正在发布 ${tag} 的附件 ${assetName}（${data.length} 字节）`);
  const { release, asset } = await publishRelease({ repo, tag, commit, notes, assetName, data, token }, fetch, sendAsset);
  console.log(`Release 页面：${release.html_url}`);
  console.log(`下载地址：${asset.browser_download_url}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
