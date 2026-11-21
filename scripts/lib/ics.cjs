'use strict';
/**
 * iCalendar 序列化公共模块
 *
 * 主订阅层（generate-ics.cjs）与宜忌层（generate-yiji.cjs）共用，
 * 保证 RFC5545 输出规则只有一处实现：
 *   - CRLF 行尾
 *   - TEXT 值转义（反斜杠 / 分号 / 逗号 / 换行）
 *   - 折行：每行 ≤ 75 字节，续行以空格开头，不切断 UTF-8 字符
 *   - 全天事件：DTSTART;VALUE=DATE，DTEND = DTSTART + 1 天
 *   - TRANSP:TRANSPARENT（不占用"忙碌"）
 */

const pad = (n) => String(n).padStart(2, '0');

const dkey = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

const dtstamp = (y, m, d) => `${y}${pad(m)}${pad(d)}`;

const parseDate = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
};

const addDays = (y, m, d, n) => {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};

/** RFC5545 TEXT 转义 */
const escText = (s) =>
  String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');

/** RFC5545 折行：每行 ≤ 75 字节，续行以空格开头，且不切断 UTF-8 字符 */
function fold(line) {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > 75) {
      out.push(cur);
      cur = ` ${ch}`;
      bytes = 1 + b;
    } else {
      cur += ch;
      bytes += b;
    }
  }
  out.push(cur);
  return out.join('\r\n');
}

/**
 * @param {object} opt
 * @param {Array<{date:string,title:string,type:string}>} opt.events
 * @param {string} opt.calName       X-WR-CALNAME
 * @param {string} opt.prodid        PRODID
 * @param {number} [opt.year]        单年生成时传入；多年度合并时省略
 * @param {string} [opt.desc]        X-WR-CALDESC，显示在 iOS 日历「简介」里
 * @param {string} [opt.uidDomain]   UID 域名后缀
 *
 * UID 取「事件自身年份」，不用文件年份——这样单年文件与多年合并文件里
 * 同一天事件的 UID 完全一致，年更覆盖时不会让客户端把事件当成新的重挂一遍。
 */
function serializeIcs({ events, calName, prodid, year, desc, uidDomain = 'calendar-enhance.local' }) {
  // DTSTAMP 默认取当前时间；用 DTSTAMP=20261121T000000Z 可做可复现构建（两次生成字节级一致，便于 diff 核对）
  const stamp =
    process.env.DTSTAMP || new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${prodid}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escText(calName)}`,
  ];
  if (desc) lines.push(`X-WR-CALDESC:${escText(desc)}`);
  lines.push(
    'X-WR-TIMEZONE:Asia/Shanghai',
    // 提示客户端刷新频率：数据年更，每天拉一次足够；不写则由客户端自行决定（iOS 默认每周）
    'X-PUBLISHED-TTL:PT24H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT24H'
  );

  for (const ev of events) {
    const { y, m, d } = parseDate(ev.date);
    const nx = addDays(y, m, d, 1);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${dtstamp(y, m, d)}-${ev.type}-${y}@${uidDomain}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${dtstamp(y, m, d)}`,
      `DTEND;VALUE=DATE:${dtstamp(nx.y, nx.m, nx.d)}`,
      `SUMMARY:${escText(ev.title)}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

module.exports = { pad, dkey, dtstamp, parseDate, addDays, escText, fold, serializeIcs };
