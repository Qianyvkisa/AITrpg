// 把 release.ps1 从 UTF-8 无 BOM 转回 UTF-16 LE with BOM。
//
// 为什么要转：PowerShell 5.1 没有 BOM 时按系统 ANSI(GBK) 解码脚本，
// 中文注释和字符串会变成乱码，解析器直接在乱码行上炸掉。
// 这个文件原本就是 UTF-16 LE，编辑工具改写后丢了编码信息，这里补回来。
import fs from 'node:fs';

const P = 'D:\\Tool\\AIrpg\\release.ps1';

const text = fs.readFileSync(P, 'utf8');
// 去掉可能残留的 BOM 字符，避免写出来变成双 BOM
const clean = text.replace(/^\uFEFF/, '');

// writeFileSync 的 'utf16le' 编码只负责字节序，不会写 BOM，必须自己拼。
// 没有 BOM 的话 PowerShell 5.1 仍按 ANSI 解码，等于白转。
const BOM = Buffer.from([0xff, 0xfe]);
fs.writeFileSync(P, Buffer.concat([BOM, Buffer.from(clean, 'utf16le')]));

const b = fs.readFileSync(P);
console.log(`前 4 字节: ${b[0]},${b[1]},${b[2]},${b[3]}  (255,254 = UTF-16 LE BOM)`);
console.log(`大小: ${b.length}`);
console.log(`内容行数: ${clean.split('\n').length}`);
