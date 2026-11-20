#!/usr/bin/env node
/**
 * iPhone 日历增强包 · 主订阅层 .ics 生成器
 *
 * 依据：PRD v0.2（F1 主订阅日历）
 *   E1  法定节假日      → {节日名}·休
 *   E1b 多日假期        → 正日 {节日名}·休，其余 {节日名}假期·休
 *   E2  调休补班        → {被调节假日名}·班
 *   E3  二十四节气      → {节气名}
 *   E4  传统节日        → {节日名}({农历月日})
 *   W3  同日冲突        → 唯一优先级：法定节假日 > 传统节日 > 节气
 *   U2  标题 ≤ 20 字符；U1 全部为全天事件
 *
 * 用法：node generate-ics.cjs [年份] [年份...]
 *   node generate-ics.cjs 2027            → calendar-2027.ics
 *   node generate-ics.cjs 2026 2027       → calendar-2026.ics / calendar-2027.ics
 *                                           + calendar-2026-2027.ics（合并，固定订阅地址用）
 * 数据：data/holidays.json（官方口径，逐年人工录入）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Solar } = require('lunar-javascript');
const { dkey, addDays, parseDate, serializeIcs } = require('./lib/ics.cjs');

const YEARS = [...new Set(process.argv.slice(2).map((s) => parseInt(s, 10)).filter((n) => n > 2000))].sort(
  (a, b) => a - b
);
if (!YEARS.length) YEARS.push(2027);
const MULTI = YEARS.length > 1;

const DATA_PATH = path.join(__dirname, 'data', 'holidays.json');
// 输出目录可被 OUT_DIR 覆盖：本地开发写 ../output，GitHub 仓库里写 ..（站点根目录，订阅路径更干净）
const OUT_DIR = process.env.OUT_DIR
  ? path.resolve(__dirname, process.env.OUT_DIR)
  : path.join(__dirname, '..', 'output');
const PRODID = '-//iPhone 日历增强包//中国节假日与节气//CN';

/** 日历显示名：单年写年份，多年写区间（用户一眼看出年更已生效） */
const calNameFor = (years) =>
  years.length === 1
    ? `中国节假日与节气 ${years[0]}`
    : `中国节假日与节气 ${years[0]}–${years[years.length - 1]}`;

/** 本期传统节日白名单（需求概要 P0-4：春节/元宵/清明/端午/中秋/重阳/腊八/小年/除夕；清明走节气+法定节假日） */
const TRADITIONAL_FESTIVALS = new Set(['除夕', '春节', '元宵节', '端午节', '中秋节', '重阳节', '腊八节', '小年', '小年夜']);

/** 读取该年份的官方放假数据；缺失则返回 null（对应 PRD W1：不推算） */
function loadHolidayData(year) {
  if (!fs.existsSync(DATA_PATH)) return null;
  const all = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  return all[String(year)] || null;
}

/**
 * 建立日期索引：
 *  holidayMap: 'YYYY-MM-DD' -> { name, index, total, mainIdx }
 *  workdayMap: 'YYYY-MM-DD' -> 被调节假日名
 *  mainIdx 为该假期的"正日"位置——农历节日与假期同名，或节气名+"节"等于假期名（清明）。
 *  无正日时回落为首日，保证至少一条 {节日名}·休。
 */
function buildDayIndex(yearData) {
  const holidayMap = new Map();
  const workdayMap = new Map();
  const holidayMeta = [];
  if (!yearData) return { holidayMap, workdayMap, holidayMeta };

  for (const h of yearData.holidays || []) {
    const s = parseDate(h.start);
    const e = parseDate(h.end);
    const days = [];
    let cur = s;
    for (;;) {
      days.push(cur);
      if (cur.y === e.y && cur.m === e.m && cur.d === e.d) break;
      cur = addDays(cur.y, cur.m, cur.d, 1);
    }

    let mainIdx = -1;
    const festNames = [];
    days.forEach((dt, i) => {
      const lunar = Solar.fromYmd(dt.y, dt.m, dt.d).getLunar();
      const fest = (lunar.getFestivals() || []).find((f) => TRADITIONAL_FESTIVALS.has(f));
      const jq = lunar.getJieQi();
      festNames[i] = fest || null;
      if (fest && fest === h.name) mainIdx = i;
      else if (jq && (jq === h.name || `${jq}节` === h.name)) mainIdx = i;
    });
    if (mainIdx < 0) mainIdx = 0;

    days.forEach((dt, i) => {
      holidayMap.set(dkey(dt.y, dt.m, dt.d), {
        name: h.name,
        index: i,
        total: days.length,
        mainIdx,
        festName: festNames[i],
      });
    });
    holidayMeta.push({
      name: h.name,
      start: h.start,
      end: h.end,
      total: days.length,
      officialDays: h.officialDays,
      mainDate: dkey(days[mainIdx].y, days[mainIdx].m, days[mainIdx].d),
    });
  }

  for (const w of yearData.workdays || []) workdayMap.set(w.date, w.for);
  return { holidayMap, workdayMap, holidayMeta };
}

/** 逐日生成事件，按 法定节假日 > 传统节日 > 节气 取一条（PRD W3） */
function buildEvents(year) {
  const yearData = loadHolidayData(year);
  const { holidayMap, workdayMap, holidayMeta } = buildDayIndex(yearData);
  const events = [];
  const stats = { holiday: 0, work: 0, festival: 0, jieqi: 0, merged: [] };

  for (let m = 1; m <= 12; m++) {
    const dim = new Date(year, m, 0).getDate();
    for (let d = 1; d <= dim; d++) {
      const k = dkey(year, m, d);
      const solar = Solar.fromYmd(year, m, d);
      const lunar = solar.getLunar();
      const lunarMD = `${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`;
      const jq = lunar.getJieQi();
      const fest = (lunar.getFestivals() || []).find((f) => TRADITIONAL_FESTIVALS.has(f)) || null;

      const hol = holidayMap.get(k);
      const workFor = workdayMap.get(k);

      if (workFor) {
        events.push({ date: k, title: `${workFor}·班`, type: 'work', lunarMD, note: `调休补班（${workFor}）` });
        stats.work++;
        continue;
      }

      if (hol) {
        // 假期内若落在独立传统节日当天（如除夕落在春节假期首日），以节日名标注，避免该日身份被假期名覆盖
        const title = hol.festName
          ? `${hol.festName}·休`
          : hol.index === hol.mainIdx
            ? `${hol.name}·休`
            : `${hol.name}假期·休`;
        const absorbed = [fest, jq].filter(Boolean);
        events.push({
          date: k,
          title,
          type: 'holiday',
          lunarMD,
          note: `${hol.name}假期 第${hol.index + 1}/${hol.total}天${absorbed.length ? `（合并：${absorbed.join('、')}）` : ''}`,
          absorbed,
        });
        stats.holiday++;
        if (absorbed.length) stats.merged.push({ date: k, title, absorbed });
        continue;
      }

      if (fest) {
        const title = `${fest}(${lunarMD})`;
        events.push({
          date: k,
          title,
          type: 'festival',
          lunarMD,
          note: jq ? `传统节日（同日节气 ${jq} 按优先级让位）` : '传统节日',
          absorbed: jq ? [jq] : [],
        });
        stats.festival++;
        if (jq) stats.merged.push({ date: k, title, absorbed: [jq] });
        continue;
      }

      if (jq) {
        events.push({ date: k, title: jq, type: 'jieqi', lunarMD, note: '二十四节气' });
        stats.jieqi++;
      }
    }
  }

  events.sort((a, b) => a.date.localeCompare(b.date));
  return { events, stats, yearData, holidayMeta };
}

/* ---------------- iCalendar 序列化（复用 lib/ics.cjs） ---------------- */

const toIcs = (events, years) =>
  serializeIcs({ events, calName: calNameFor(years), prodid: PRODID });

/* ---------------- 核对表（对应 PRD 验收第 1 条） ---------------- */

function toChecklist({ events, stats, yearData, holidayMeta }, year) {
  const L = [];
  L.push(`# ${year} 年主订阅层 · 数据核对表`, '');
  L.push(`> 生成时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  L.push(`> 数据来源：${yearData ? yearData.source : '**未收录，按 PRD W1 不生成任何事件**'}`);
  if (yearData) L.push(`> 发布日期：${yearData.publishedAt}｜原文：${yearData.url}`);
  L.push('', '---', '', '## 一、法定节假日与国务院文件比对', '');
  L.push('| 假期 | 官方天数 | 生成天数 | 起 | 止 | 正日 | 一致性 |', '|---|---|---|---|---|---|---|');
  for (const h of holidayMeta) {
    L.push(`| ${h.name} | ${h.officialDays} | ${h.total} | ${h.start} | ${h.end} | ${h.mainDate} | ${h.officialDays === h.total ? '✅' : '❌'} |`);
  }
  L.push('', '## 二、调休补班', '');
  const workEvents = events.filter((e) => e.type === 'work');
  L.push('| 日期 | 事件 |', '|---|---|');
  for (const e of workEvents) L.push(`| ${e.date} | ${e.title} |`);
  L.push('', `共 ${workEvents.length} 天补班。`, '');

  L.push('## 三、事件统计', '');
  L.push('| 类型 | 条数 |', '|---|---|');
  L.push(`| 法定节假日 | ${stats.holiday} |`);
  L.push(`| 调休补班 | ${stats.work} |`);
  L.push(`| 传统节日 | ${stats.festival} |`);
  L.push(`| 二十四节气 | ${stats.jieqi} |`);
  L.push(`| **合计** | **${events.length}** |`);
  L.push('', `标题最长：${events.reduce((a, b) => (a.title.length >= b.title.length ? a : b)).title}（${
    events.reduce((a, b) => (a.title.length >= b.title.length ? a : b)).title.length
  } 字符，限 20）`, '');

  if (stats.merged.length) {
    L.push('## 四、同日冲突合并记录（PRD W3）', '');
    L.push('| 日期 | 最终标题 | 被合并信息 |', '|---|---|---|');
    for (const m of stats.merged) L.push(`| ${m.date} | ${m.title} | ${m.absorbed.join('、')} |`);
    L.push('');
  }

  L.push('## 五、全年事件清单', '');
  L.push('| 日期 | 标题 | 农历 | 说明 |', '|---|---|---|---|');
  for (const e of events) L.push(`| ${e.date} | ${e.title} | ${e.lunarMD} | ${e.note} |`);
  L.push('');
  return L.join('\n');
}

/* ---------------- main ---------------- */

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const allEvents = [];

  for (const year of YEARS) {
    const result = buildEvents(year);
    const { events, yearData } = result;

    if (!yearData) {
      console.warn(`⚠️  data/holidays.json 中未收录 ${year} 年官方放假安排。`);
      console.warn('    按 PRD W1：不得自行推算，本次仅生成节气与传统节日，法定节假日缺席。');
    }
    if (!events.length) {
      console.error(`${year} 年未生成任何事件，跳过。`);
      continue;
    }

    const icsPath = path.join(OUT_DIR, `calendar-${year}.ics`);
    const mdPath = path.join(OUT_DIR, `${year}-数据核对表.md`);
    fs.writeFileSync(icsPath, toIcs(events, [year]), 'utf8');
    fs.writeFileSync(mdPath, toChecklist(result, year), 'utf8');

    const longest = events.reduce((a, b) => (a.title.length >= b.title.length ? a : b));
    console.log(`✅ ${year}：${icsPath}`);
    console.log(`   事件 ${events.length} 条：节假日 ${result.stats.holiday} / 补班 ${result.stats.work} / 传统节日 ${result.stats.festival} / 节气 ${result.stats.jieqi}`);
    console.log(`   最长标题：「${longest.title}」${longest.title.length} 字符（上限 20）｜同日合并 ${result.stats.merged.length} 处`);
    console.log(`✅ ${year}：核对表 ${mdPath}`);

    allEvents.push(...events);
  }

  if (!allEvents.length) {
    console.error('全年份均无事件，终止。');
    process.exit(1);
  }

  allEvents.sort((a, b) => a.date.localeCompare(b.date));

  if (MULTI) {
    const span = `${YEARS[0]}-${YEARS[YEARS.length - 1]}`;
    const merged = toIcs(allEvents, YEARS);
    const spanPath = path.join(OUT_DIR, `calendar-${span}.ics`);
    // 固定订阅地址用：内容滚动覆盖，URL 永不变（对应《订阅配置与托管方案》第四节）
    const fixedPath = path.join(OUT_DIR, 'calendar.ics');
    fs.writeFileSync(spanPath, merged, 'utf8');
    fs.writeFileSync(fixedPath, merged, 'utf8');
    console.log(`✅ 合并 ${span}：${spanPath}`);
    console.log(`✅ 固定地址用：${fixedPath}（${allEvents.length} 条，${(Buffer.byteLength(merged) / 1024).toFixed(1)} KB）`);
  }
}

main();
