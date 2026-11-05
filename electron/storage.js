'use strict';

// ---------------------------------------------------------------------------
// 数据目录与 JSON 读写：所有持久化文件都落在 userData/data 下
// ---------------------------------------------------------------------------
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

function dataDir() {
  const dir = path.join(app.getPath('userData'), 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fileOf(name) {
  return path.join(dataDir(), name);
}

function readJSON(name, fallback) {
  try {
    const p = fileOf(name);
    if (!fs.existsSync(p)) return fallback;
    let text = fs.readFileSync(p, 'utf8');
    // 记事本等编辑器保存 UTF-8 时会带 BOM，JSON.parse 遇到 BOM 会直接抛异常，
    // 导致配置被静默丢弃、回退到默认值。这里先剥掉。
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch (e) {
    console.error('[readJSON]', name, e.message);
    return fallback;
  }
}

function writeJSON(name, value) {
  fs.writeFileSync(fileOf(name), JSON.stringify(value, null, 2), 'utf8');
  return true;
}

function deleteFile(name) {
  const p = fileOf(name);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  return true;
}

/** 列出数据目录下满足条件的文件（返回绝对路径与 stat） */
function listFiles(predicate) {
  const dir = dataDir();
  return fs
    .readdirSync(dir)
    .filter(predicate)
    .map((f) => {
      const p = path.join(dir, f);
      return { name: f, path: p, stat: fs.statSync(p) };
    });
}

module.exports = { dataDir, fileOf, readJSON, writeJSON, deleteFile, listFiles };
