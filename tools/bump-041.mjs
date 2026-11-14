// 升版本号 0.4.0 → 0.4.1
// 本次改动：打包产物位置规则固化（exe 只出根目录），属修补。
import fs from 'node:fs';

const P = 'D:\\Tool\\AIrpg\\package.json';
const before = JSON.parse(fs.readFileSync(P, 'utf8')).version;
const c = fs.readFileSync(P, 'utf8').replace(/"version":\s*"0\.4\.0"/, '"version": "0.4.1"');
fs.writeFileSync(P, c, 'utf8');
console.log(`版本 ${before} → ${JSON.parse(fs.readFileSync(P, 'utf8')).version}`);
