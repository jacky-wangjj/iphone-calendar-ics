#!/usr/bin/env node
/**
 * RFC5545 校验器
 *
 * 用法：node verify.cjs [文件] [标题字数上限]
 *   默认校验 output/calendar-2027.ics，上限 20 字（PRD U2）
 *   宜忌层：node verify.cjs ../output/yiji-2027.ics 18    （PRD U7）
 *   不带参数时依次校验两个已生成文件。
 */
'use strict';

const fs = require('fs');
const path = require('path');

function verify(file, titleLimit) {
  const raw = fs.readFileSync(file, 'utf8');
  const errs = [];
  const names = path.basename(file);

  // 1) CRLF 行尾
  const lines = raw.split('\r\n');
  if (!raw.endsWith('\r\n')) errs.push('文件未以 CRLF 结尾');
  if (/[^\r]\n/.test(raw)) errs.push('存在裸 LF 换行');

  // 2) 每行 ≤ 75 字节（折行正确性）
  lines.forEach((l, i) => {
    const b = Buffer.byteLength(l, 'utf8');
    if (b > 75) errs.push(`第${i + 1}行 ${b} 字节超限: ${l.slice(0, 40)}`);
  });

  // 3) 结构配对
  const ve = (raw.match(/BEGIN:VEVENT/g) || []).length;
  const ev = (raw.match(/END:VEVENT/g) || []).length;
  if (ve !== ev) errs.push(`VEVENT 不配对 ${ve}/${ev}`);
  if (!raw.includes('BEGIN:VCALENDAR') || !raw.includes('END:VCALENDAR')) errs.push('VCALENDAR 缺失');

  // 4) 逐条事件必备字段
  const blocks = raw.split('BEGIN:VEVENT').slice(1).map((b) => b.split('END:VEVENT')[0]);
  blocks.forEach((b, i) => {
    const g = (k) => {
      const m = b.match(new RegExp(`${k}:([^\\r\\n]+)`));
      return m ? m[1].trim() : null;
    };
    const uid = g('UID');
    const st = b.match(/DTSTART;VALUE=DATE:(\d{8})/);
    const en = b.match(/DTEND;VALUE=DATE:(\d{8})/);
    const sm = g('SUMMARY');
    if (!uid) errs.push(`事件${i + 1} 缺 UID`);
    if (!st || !en) errs.push(`事件${i + 1} 缺 DTSTART/DTEND`);
    else {
      const a = new Date(Date.UTC(+st[1].slice(0, 4), +st[1].slice(4, 6) - 1, +st[1].slice(6, 8)));
      const x = new Date(Date.UTC(+en[1].slice(0, 4), +en[1].slice(4, 6) - 1, +en[1].slice(6, 8)));
      if ((x - a) / 86400000 !== 1) errs.push(`事件${i + 1} DTEND 非次日`);
    }
    if (!sm) errs.push(`事件${i + 1} 缺 SUMMARY`);
    if (sm && sm.length > titleLimit) errs.push(`事件${i + 1} 标题超 ${titleLimit} 字（${sm.length}）: ${sm}`);
    if (/^DESCRIPTION:/m.test(b)) errs.push(`事件${i + 1} 含 DESCRIPTION（U6 要求留空）`);
  });

  // 5) UID 唯一
  const uids = blocks.map((b) => (b.match(/UID:([^\r\n]+)/) || [])[1]).filter(Boolean);
  if (new Set(uids).size !== uids.length) errs.push('UID 存在重复');

  // 6) 全部为全天事件
  if (/DTSTART:/.test(raw.replace(/DTSTART;VALUE=DATE:/g, ''))) errs.push('存在非全天事件');

  const longest = blocks.reduce((a, b) => {
    const s = (x) => ((x.match(/SUMMARY:([^\r\n]+)/) || [])[1] || '').length;
    return s(b) > s(a) ? b : a;
  }, '');
  const lsm = (longest.match(/SUMMARY:([^\r\n]+)/) || [])[1] || '';

  console.log(`\n── ${names} ──`);
  console.log(
    `事件 ${blocks.length}｜${Buffer.byteLength(raw, 'utf8')} 字节｜行数 ${lines.length - 1}｜最长标题「${lsm}」${lsm.length}/${titleLimit} 字`
  );
  if (errs.length) {
    console.log(`❌ 问题 ${errs.length} 项：`);
    errs.forEach((e) => console.log(`   - ${e}`));
    return false;
  }
  console.log('✅ RFC5545 全部通过（CRLF / 行宽≤75字节 / 结构配对 / DTEND次日 / 标题上限 / UID唯一 / 全天事件 / 无DESCRIPTION）');
  return true;
}

const args = process.argv.slice(2);
let ok = true;
if (args.length) {
  ok = verify(path.resolve(args[0]), parseInt(args[1] || '20', 10));
} else {
  const outDir = path.join(__dirname, '..', 'output');
  const year = new Date().getFullYear() + 1;
  const targets = [
    [path.join(outDir, `calendar-${year}.ics`), 20],
    [path.join(outDir, `yiji-${year}.ics`), 18],
  ];
  for (const [f, lim] of targets) {
    if (fs.existsSync(f)) ok = verify(f, lim) && ok;
  }
}
process.exit(ok ? 0 : 1);
