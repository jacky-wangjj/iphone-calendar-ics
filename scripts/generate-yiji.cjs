#!/usr/bin/env node
/**
 * iPhone 日历增强包 · 宜忌层 .ics 生成器（方案B，独立可选订阅）
 *
 * 依据：PRD v0.2 Optional 节（O1~O3 / U6 / U7）+ 《黄历宜忌数据源调研报告》第六节文案规范
 *   口径    《钦定协纪辨方书》底本 + lunar 库（6tail, MIT）程序化推算
 *   粒度    简洁——标题只放核心宜/忌
 *   格式    普通日    {农历月日} · 宜{A}，{B} 忌{C}
 *           无"忌"    {农历月日} · 宜{A}，{B}
 *           诸事不宜  {农历月日} · 诸事不宜
 *           节日/节气 {节日名}({农历月日}) · 宜{A} 忌{B}
 *   约束    标题 ≤ 18 字符（U7，严于主层 20）；描述字段留空（U6）
 *
 * 用法：node generate-yiji.cjs [年份] [年份...]
 *   node generate-yiji.cjs 2027          → yiji-2027.ics
 *   node generate-yiji.cjs 2026 2027     → yiji-2026.ics / yiji-2027.ics
 *                                          + yiji-2026-2027.ics 与 yiji.ics（固定订阅地址用）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Solar } = require('lunar-javascript');
const { dkey, serializeIcs } = require('./lib/ics.cjs');

const YEARS = [...new Set(process.argv.slice(2).map((s) => parseInt(s, 10)).filter((n) => n > 2000))].sort(
  (a, b) => a - b
);
if (!YEARS.length) YEARS.push(2027);
const MULTI = YEARS.length > 1;

const OUT_DIR = process.env.OUT_DIR
  ? path.resolve(__dirname, process.env.OUT_DIR)
  : path.join(__dirname, '..', 'output');
const PRODID = '-//iPhone 日历增强包//黄历宜忌//CN';

const calNameFor = (years) =>
  years.length === 1 ? `黄历宜忌 ${years[0]}` : `黄历宜忌 ${years[0]}–${years[years.length - 1]}`;

/** 标题长度上限（U7） */
const TITLE_LIMIT = 18;

/** 日历简介（X-WR-CALDESC），显示在 iOS 日历「简介」里 */
const CAL_DESC =
  `每日黄历宜忌，依据《钦定协纪辨方书》底本口径推算，二十四节气与农历取自 lunar 历法库。` +
  `属民俗参考，不构成任何决策依据。年更时覆盖同一地址，无需重新订阅。`;

/** 节日/节气的判定白名单，与主订阅层保持一致 */
const TRADITIONAL_FESTIVALS = new Set([
  '除夕',
  '春节',
  '元宵节',
  '端午节',
  '中秋节',
  '重阳节',
  '腊八节',
  '小年',
  '小年夜',
]);

/** 不作为展示项的占位词：馀事勿取＝其余不宜，诸事不宜＝整日不宜，无＝空 */
const PLACEHOLDERS = new Set(['馀事勿取', '余事勿取', '诸事不宜', '无']);

const SEP_MD = ' · ';

/**
 * 归一化宜/忌列表：
 *  - 去掉占位词
 *  - 若任一列表含"诸事不宜"，整日判定为诸事不宜（民俗语义上"宜诸事不宜"即无事可为）
 * @returns {{yi:string[], ji:string[], allBad:boolean}}
 */
function normalize(yiRaw, jiRaw) {
  const hasBad = [...yiRaw, ...jiRaw].some((x) => x === '诸事不宜');
  const clean = (arr) => (arr || []).filter((x) => !PLACEHOLDERS.has(x));
  return { yi: clean(yiRaw), ji: clean(jiRaw), allBad: hasBad };
}

/**
 * 按可用条目生成候选正文，按"信息价值"从高到低排列。
 * 节日/节气日遵循 PRD O3：宜忌各只取 1 项，优先保证"忌"不被挤掉。
 */
function candidates(yi, ji, isKeyDay) {
  const pick = (arr, n) => arr.slice(0, n).join('，');
  const out = [];
  if (isKeyDay) {
    if (yi.length && ji.length) out.push(`宜${pick(yi, 1)} 忌${pick(ji, 1)}`);
    if (yi.length) out.push(`宜${pick(yi, 2)}`, `宜${pick(yi, 1)}`);
    if (ji.length) out.push(`忌${pick(ji, 2)}`, `忌${pick(ji, 1)}`);
    return out;
  }
  if (yi.length && ji.length) {
    out.push(`宜${pick(yi, 2)} 忌${pick(ji, 1)}`);
    out.push(`宜${pick(yi, 1)} 忌${pick(ji, 1)}`);
  }
  if (yi.length) out.push(`宜${pick(yi, 2)}`, `宜${pick(yi, 1)}`);
  if (ji.length) out.push(`忌${pick(ji, 2)}`, `忌${pick(ji, 1)}`);
  return out;
}

/**
 * 组装标题：正文候选为外层（先保信息量），前缀为内层（后降级）。
 * 节日/节气日先用 `{节日名}({农历})`，超限退化为 `{节日名}`。
 * @returns {{title:string, form:string, body:string}}
 */
function buildTitle(lunarMD, keyName, norm) {
  const isKeyDay = Boolean(keyName);

  if (norm.allBad) {
    // 整日不宜时仍保留节日/节气身份，避免"立春恰逢诸事不宜"导致节气名消失
    for (const prefix of isKeyDay ? [`${keyName}(${lunarMD})`, keyName, lunarMD] : [lunarMD]) {
      const t = `${prefix}${SEP_MD}诸事不宜`;
      if (t.length <= TITLE_LIMIT) return { title: t, form: '诸事不宜', body: '诸事不宜' };
    }
    return { title: `${lunarMD}${SEP_MD}诸事不宜`, form: '诸事不宜', body: '诸事不宜' };
  }

  const prefixes = isKeyDay ? [`${keyName}(${lunarMD})`, keyName, lunarMD] : [lunarMD];
  for (const body of candidates(norm.yi, norm.ji, isKeyDay)) {
    for (const prefix of prefixes) {
      const t = `${prefix}${SEP_MD}${body}`;
      if (t.length <= TITLE_LIMIT) {
        return { title: t, form: isKeyDay ? '节日/节气日' : '普通日', body };
      }
    }
  }

  // 理论不可达：最短候选（单宜 3 字 + 农历 4 字 + 分隔 3 字 = 10）
  return { title: `${lunarMD}${SEP_MD}诸事不宜`, form: '兜底', body: '诸事不宜' };
}

function buildEvents(year) {
  const events = [];
  // 正交统计：格式维度（节日日/普通日/诸事不宜）与内容维度（是否含忌）分开计
  const stats = {
    keyDays: 0,
    normalDays: 0,
    allBad: 0,
    allBadKeyDays: 0,
    withJi: 0,
    withoutJi: 0,
    prefixDegraded: [],
  };
  const samples = {};

  for (let m = 1; m <= 12; m++) {
    const dim = new Date(year, m, 0).getDate();
    for (let d = 1; d <= dim; d++) {
      const k = dkey(year, m, d);
      const lunar = Solar.fromYmd(year, m, d).getLunar();
      const lunarMD = `${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`;
      const jq = lunar.getJieQi();
      const fest = (lunar.getFestivals() || []).find((f) => TRADITIONAL_FESTIVALS.has(f)) || null;
      const keyName = fest || jq || null;

      const norm = normalize(lunar.getDayYi(), lunar.getDayJi());
      const { title, form, body } = buildTitle(lunarMD, keyName, norm);
      const hasJi = body.includes('忌');

      events.push({ date: k, title, type: 'yiji', lunarMD, form, keyName, body, hasJi });
      if (samples[form] === undefined) samples[form] = { date: k, title, lunarMD };

      if (norm.allBad) {
        stats.allBad++;
        if (keyName) stats.allBadKeyDays++;
      }
      if (keyName) stats.keyDays++;
      else stats.normalDays++;
      if (hasJi) stats.withJi++;
      else stats.withoutJi++;
      // 记录因长度限制丢弃了农历括号前缀的节日日
      if (keyName && !title.startsWith(`${keyName}(`)) {
        stats.prefixDegraded.push({ date: k, title });
      }
    }
  }

  return { events, stats, samples };
}

/* ---------------- 核对表 ---------------- */

function toChecklist({ events, stats, samples }, year) {
  const L = [];
  const longest = events.reduce((a, b) => (a.title.length >= b.title.length ? a : b));
  L.push(`# ${year} 年宜忌层 · 数据核对表`, '');
  L.push(`> 生成时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  L.push('> 推算口径：《钦定协纪辨方书》底本 + lunar 库（6tail, MIT）程序化推算');
  L.push('> 展示粒度：简洁——标题仅核心宜/忌；占位词「馀事勿取」「诸事不宜」「无」不作展示', '');
  L.push('---', '', '## 一、格式与内容统计', '');
  L.push('| 维度 | 项 | 条数 |', '|---|---|---|');
  L.push(`| 格式 | 节日/节气日 | ${stats.keyDays} |`);
  L.push(`| 格式 | 普通日 | ${stats.normalDays} |`);
  L.push(`| 内容 | 含「忌」条目 | ${stats.withJi} |`);
  L.push(`| 内容 | 不含「忌」条目 | ${stats.withoutJi} |`);
  L.push(`| 内容 | 整日「诸事不宜」 | ${stats.allBad}（其中节日/节气日 ${stats.allBadKeyDays}） |`);
  L.push(`| **合计** | 逐日一条 | **${events.length}** |`);
  L.push('', `标题最长：「${longest.title}」${longest.title.length} 字符（上限 ${TITLE_LIMIT}）`, '');

  L.push('### 格式样例', '');
  L.push('| 格式 | 样例 |', '|---|---|');
  for (const [form, s] of Object.entries(samples)) L.push(`| ${form} | ${s.title} |`);
  L.push('');

  L.push('## 二、节日/节气日清单（PRD O3 格式，宜忌各取 1 项）', '');
  L.push('| 日期 | 标题 | 长度 | 是否保留农历括号 |', '|---|---|---|---|');
  for (const e of events.filter((x) => x.keyName)) {
    const keep = e.title.startsWith(`${e.keyName}(`) ? '✅' : '— 长度降级';
    L.push(`| ${e.date} | ${e.title} | ${e.title.length} | ${keep} |`);
  }
  L.push('');
  if (stats.prefixDegraded.length) {
    L.push(`> 因 18 字上限丢弃农历括号的节日日 ${stats.prefixDegraded.length} 天（节日名保留，农历靠系统原生显示）：`, '');
    for (const x of stats.prefixDegraded) L.push(`> - ${x.date}　${x.title}`);
    L.push('');
  }

  L.push('## 三、诸事不宜日清单', '');
  const bad = events.filter((x) => x.form === '诸事不宜');
  L.push(`共 ${bad.length} 天：`, '');
  L.push(bad.map((e) => e.date).join('、') || '无', '');

  L.push('## 四、抽查（前 15 天）', '');
  L.push('| 日期 | 标题 | 农历 | 长度 |', '|---|---|---|---|');
  for (const e of events.slice(0, 15)) L.push(`| ${e.date} | ${e.title} | ${e.lunarMD} | ${e.title.length} |`);
  L.push('');
  return L.join('\n');
}

/* ---------------- main ---------------- */

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const allEvents = [];

  for (const year of YEARS) {
    const result = buildEvents(year);
    const { events } = result;
    if (!events.length) {
      console.error(`${year} 年未生成任何事件，跳过。`);
      continue;
    }

    const icsPath = path.join(OUT_DIR, `yiji-${year}.ics`);
    const mdPath = path.join(OUT_DIR, `${year}-宜忌核对表.md`);
    fs.writeFileSync(
      icsPath,
      serializeIcs({
        events,
        calName: calNameFor([year]),
        prodid: PRODID,
        desc: CAL_DESC,
      }),
      'utf8'
    );
    fs.writeFileSync(mdPath, toChecklist(result, year), 'utf8');

    const longest = events.reduce((a, b) => (a.title.length >= b.title.length ? a : b));
    const s = result.stats;
    console.log(`✅ ${year}：${icsPath}`);
    console.log(`   事件 ${events.length} 条：节日/节气日 ${s.keyDays} / 普通日 ${s.normalDays}｜含忌 ${s.withJi} / 不含忌 ${s.withoutJi}｜诸事不宜 ${s.allBad}`);
    console.log(`   最长标题：「${longest.title}」${longest.title.length} 字符（上限 ${TITLE_LIMIT}）｜农历括号降级 ${s.prefixDegraded.length} 天`);
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
    const merged = serializeIcs({
      events: allEvents,
      calName: calNameFor(YEARS),
      prodid: PRODID,
      desc: CAL_DESC,
    });
    const spanPath = path.join(OUT_DIR, `yiji-${span}.ics`);
    const fixedPath = path.join(OUT_DIR, 'yiji.ics');
    fs.writeFileSync(spanPath, merged, 'utf8');
    fs.writeFileSync(fixedPath, merged, 'utf8');
    console.log(`✅ 合并 ${span}：${spanPath}`);
    console.log(`✅ 固定地址用：${fixedPath}（${allEvents.length} 条，${(Buffer.byteLength(merged) / 1024).toFixed(1)} KB）`);
  }
}

main();
