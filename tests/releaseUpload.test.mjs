import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { isReleaseTag, publishRelease } from '../tools/publish-release.mjs';

test('基础版本使用简短标签，原有 fix 格式仍可用', () => {
  assert.equal(isReleaseTag('v0.5', '0.5.0'), true);
  assert.equal(isReleaseTag('v0.5.0-fix1', '0.5.0'), true);
  assert.equal(isReleaseTag('v0.4.1', '0.4.1'), true);
  assert.equal(isReleaseTag('v0.4.1-fix6', '0.5.0'), false);
  assert.equal(isReleaseTag('v0.5.0-fix0', '0.5.0'), false);
});

const options = {
  repo: 'test/keeper', tag: 'v0.4.1-fix2', commit: 'a'.repeat(40), notes: '修复检定结算',
  assetName: 'COC-v0.4.1-fix2.exe', data: Buffer.from('test-exe'), token: 'fake-token'
};
const asset = {
  id: 42, name: options.assetName, state: 'uploaded', size: options.data.length,
  digest: `sha256:${createHash('sha256').update(options.data).digest('hex')}`
};
const draft = {
  id: 7, tag_name: options.tag, draft: true, assets: [],
  upload_url: 'https://uploads.github.com/repos/test/keeper/releases/7/assets{?name,label}'
};

function mock(...responses) {
  const calls = [];
  const fetcher = async (url, request) => {
    calls.push({ url: new URL(url), ...request });
    assert.ok(responses.length, '意外的 GitHub 请求');
    const [status, body] = responses.shift();
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  };
  return { calls, fetcher };
}

test('在指定提交创建草稿，附件上传并校验成功后公开发布', async () => {
  const { calls, fetcher } = mock([200, []], [201, draft], [201, asset], [200, { ...draft, draft: false }]);
  const result = await publishRelease(options, fetcher);
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'POST', 'POST', 'PATCH']);
  assert.deepEqual(JSON.parse(calls[1].body), {
    tag_name: options.tag, target_commitish: options.commit, name: options.tag,
    body: options.notes, draft: true, prerelease: false
  });
  assert.equal(calls[2].url.searchParams.get('name'), options.assetName);
  assert.deepEqual(calls[2].body, options.data);
  assert.deepEqual(JSON.parse(calls[3].body), { draft: false });
  assert.equal(result.release.draft, false);
});

test('上传失败保留草稿，重试可清理未完成的上传占位并继续', async () => {
  const failed = mock([200, []], [201, draft], [502, { message: 'upstream failure' }]);
  await assert.rejects(publishRelease(options, failed.fetcher), /HTTP 502/);
  assert.deepEqual(failed.calls.map((call) => call.method), ['GET', 'POST', 'POST']);

  const incomplete = { id: asset.id, name: asset.name, state: 'starter', size: 0 };
  const retry = mock([200, [{ ...draft, assets: [incomplete] }]], [204], [201, asset], [200, { ...draft, draft: false }]);
  await publishRelease(options, retry.fetcher);
  assert.deepEqual(retry.calls.map((call) => call.method), ['GET', 'DELETE', 'POST', 'PATCH']);
  assert.match(retry.calls[1].url.pathname, /\/releases\/assets\/42$/);
});

test('由系统 HTTP 客户端传输附件，并在发布后返回正式下载链接', async () => {
  const publishedAsset = { ...asset, browser_download_url: `https://github.com/test/keeper/releases/download/${options.tag}/${options.assetName}` };
  const { calls, fetcher } = mock([200, [draft]], [200, { ...draft, draft: false, assets: [publishedAsset] }]);
  const result = await publishRelease(options, fetcher, async (upload) => {
    assert.equal(upload.origin, 'https://uploads.github.com');
    assert.equal(upload.searchParams.get('name'), options.assetName);
    return asset;
  });
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'PATCH']);
  assert.equal(result.asset.browser_download_url, publishedAsset.browser_download_url);
});

test('已经发布的相同附件可确认成功，内容不同时保留原附件', async () => {
  const published = { ...draft, draft: false, assets: [asset] };
  const same = mock([200, [published]]);
  assert.equal((await publishRelease(options, same.fetcher)).asset.digest, asset.digest);
  assert.equal(same.calls.length, 1);

  const different = mock([200, [published]]);
  await assert.rejects(publishRelease({ ...options, data: Buffer.from('different') }, different.fetcher), /内容不同/);
  assert.equal(different.calls.length, 1);
});
