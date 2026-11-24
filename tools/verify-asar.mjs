// 校验打包产物里是否包含主题相关文件。
//
// 为什么需要：src/**/* 已在 build.files 里，理论上全都会进去，
// 但「理论上」不足以证明——漏一个 themes.css 的表现是
// 「exe 能开、界面全白」，用户不会去翻 asar，只会说「打包坏了」。
// 所以每次打包后跑一次这个。
import asar from '@electron/asar';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ASAR = fileURLToPath(new URL('../dist/win-unpacked/resources/app.asar', import.meta.url));

if (!existsSync(ASAR)) {
  console.log('找不到 ' + ASAR);
  process.exit(1);
}

const entries = asar.listPackage(ASAR);
const norm = new Set(entries.map((e) => e.replace(/\\/g, '/')));

const REQUIRED = [
  '/src/index.html',
  '/src/app.js',
  '/src/state.js',
  '/src/styles.css',
  '/src/themes.css',
  '/src/motif-art.css',
  '/src/tentacle.css',
  '/src/ritual.css',
  '/src/investigator.css',
  '/src/rulebook.html',
  '/src/ui/theme.js',
  '/src/modals/settings.js',
  '/src/core/autoAdvance.js',
  '/src/core/autoAdvanceRunner.js',
  '/main.js',
  '/preload.js'
];

for (const file of ['src/tentacle.css', 'src/ritual.css', 'src/investigator.css']) {
  if (!norm.has('/' + file)) continue;
  const themeCss = asar.extractFile(ASAR, file).toString('utf8');
  for (const [, path] of themeCss.matchAll(/url\('(assets\/(?:tentacle|ritual|investigator)\/[\w-]+\.webp)'\)/g)) {
    const entry = '/src/' + path;
    if (!REQUIRED.includes(entry)) REQUIRED.push(entry);
  }
}

let bad = 0;
if (norm.has('/assets/coc-kp.pdf')) {
  console.log('包含本地规则书 PDF');
  bad++;
}
for (const entry of norm) {
  if (entry.startsWith('/electron/') && entry.endsWith('.log')) {
    console.log('包含运行日志 ' + entry);
    bad++;
  }
}
if (norm.has('/assets/资源')) {
  console.log('包含美术源素材目录');
  bad++;
}
for (const f of REQUIRED) {
  const hit = norm.has(f);
  if (!hit) bad++;
  console.log((hit ? 'OK   ' : '缺失 ') + f);
}

console.log('');
console.log('asar 条目总数: ' + entries.length);
console.log(bad === 0 ? '关键文件及排除项校验通过' : bad + ' 项内容校验失败');
process.exit(bad === 0 ? 0 : 1);
