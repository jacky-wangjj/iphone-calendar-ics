# iPhone 日历增强包

把「法定节假日 + 调休补班 + 二十四节气 + 传统节日」变成一条 iPhone 原生日历订阅链接。
不装第三方 App、不占后台、靠系统自己刷新。

可选再叠一层「黄历宜忌」，每天一条农历加宜忌，单独订阅、不想要就不订。

## 订阅地址

**主推（jsDelivr，国内可达性更好）**：

| 层 | 订阅地址 |
|---|---|
| 主层（推荐） | `https://cdn.jsdelivr.net/gh/jacky-wangjj/iphone-calendar-ics@main/calendar.ics` |
| 宜忌层（可选） | `https://cdn.jsdelivr.net/gh/jacky-wangjj/iphone-calendar-ics@main/yiji.ics` |

备用（GitHub Pages，jsDelivr 连不上时再换）：

| 层 | 订阅地址 |
|---|---|
| 主层 | `https://jacky-wangjj.github.io/iphone-calendar-ics/calendar.ics` |
| 宜忌层 | `https://jacky-wangjj.github.io/iphone-calendar-ics/yiji.ics` |

- 在线订阅页：`https://jacky-wangjj.github.io/iphone-calendar-ics/`
- 图文订阅指南：`https://jacky-wangjj.github.io/iphone-calendar-ics/guide.html`
- 离线包说明页：`https://jacky-wangjj.github.io/iphone-calendar-ics/offline-guide.html`

地址不带任何分享码，可整条复制。

现在的 `calendar.ics` 装 **2026–2027 两年共 121 条**，`yiji.ics` 装 730 条（每天一条）。
每年 11 月重新生成后覆盖同名文件，**订阅地址永不变化**，用户订一次就够了。

> `raw.githubusercontent.com` 的地址不要用来订阅：它把 `.ics` 当 `text/plain` 返回，国内也常连不上。

### 在 iPhone 上订阅

1. 用 **Safari** 打开链接（微信里打不开订阅弹窗）
2. 弹出「订阅…日历？」→ 点订阅
3. 事件没立刻出现：设置 → 日历 → 账户 → 获取新数据，手动刷新一次

按钮不管用时走手动：设置 → 日历 → 账户 → 添加账户 → 其他 → 添加已订阅的日历 → 粘贴链接。

顺带建议开一下系统农历：设置 → 日历 → 其他历法 → 农历。农历由系统原生渲染，零事件零耗电。

## 部署（一次性，约 3 分钟）

仓库必须是 **Public**，否则 Pages 和 jsDelivr 都用不了。

1. 新建仓库，把本目录推上去
2. **Settings → Pages → Source 选 `Deploy from a branch`，分支 `main`，目录 `/ (root)`**，保存
3. 等 1 分钟，访问 `https://<owner>.github.io/<repo>/calendar.ics`，看到 `BEGIN:VCALENDAR` 就成了

`.nojekyll` 已经放好，跳过 Jekyll 构建；`.gitattributes` 里 `*.ics -text` 是关键——它阻止 git 把 CRLF 转成 LF，
否则 RFC5545 要求的 CRLF 行尾会被破坏。

## 本地生成

```bash
cd scripts
npm install

npm run build          # 当前覆盖的年份，生成到仓库根目录
npm run verify         # 校验 RFC5545
```

指定年份：

```bash
OUT_DIR=.. node generate-ics.cjs 2026 2027    # 传两年 → 额外产出合并版 calendar.ics
OUT_DIR=.. node generate-ics.cjs 2027         # 传一年 → 只产出 calendar-2027.ics
```

`OUT_DIR` 不传则输出到 `../output/`（开发时用）。

想验证「同一份数据生成的文件是否真的一样」，固定 `DTSTAMP` 做可复现构建：

```bash
DTSTAMP=20261121T000000Z OUT_DIR=.. node generate-ics.cjs 2026 2027
md5 calendar.ics    # 连跑两次，md5 应完全一致
```

## 年更流程

每年 11 月国务院发布次年安排后：

1. 到 gov.cn 找到当年通知，把 `holidays` 与 `workdays` 补进 `scripts/data/holidays.json`
2. 打开仓库 **Actions → 生成并发布日历 → Run workflow**，年份留空（自动取「当年 + 次年」）
3. 等它跑完：自动生成、校验、提交，Pages 与 jsDelivr 跟随生效
4. jsDelivr 有 12 小时缓存，着急的话到 jsDelivr 控制台手动 purge

工作流还挂了每年 11 月 1 日的定时任务，只做一件事：**检查次年数据有没有录入**。
没录入就失败，用 GitHub 的失败通知提醒你别忘了——放假安排无法推算，只能人工录。

## 事件怎么写

| 场景 | 标题 |
|---|---|
| 法定节假日正日 | `国庆节·休` |
| 假期的其余天 | `国庆节假期·休` |
| 假期内另有独立传统节日 | `除夕·休`（不被「春节假期·休」盖掉） |
| 调休补班 | `国庆节·班` |
| 二十四节气 | `小寒` |
| 传统节日（不放假） | `腊八节(腊月初八)` |
| 同日冲突 | 法定节假日 > 传统节日 > 节气，只出一条 |
| 宜忌层普通日 | `冬月初五 · 宜开市，出行 忌修造` |
| 宜忌层诸事不宜 | `冬月初六 · 诸事不宜` |

主层标题 ≤ 20 字，宜忌层 ≤ 18 字（保证周视图不折行）；全部是全天事件，`TRANSP:TRANSPARENT`，不占「忙碌」。
不写 `DESCRIPTION`——iPhone 日历里那条描述只会变成一坨没用的字。

## 目录

```
.
├── calendar.ics / yiji.ics            合并版，对外订阅地址
├── calendar-2026.ics / yiji-2026.ics  单年版，回看或分年订阅
├── calendar-2027.ics / yiji-2027.ics
├── index.html                         订阅引导页（Pages 根路径）
├── scripts/
│   ├── generate-ics.cjs               主层生成器
│   ├── generate-yiji.cjs              宜忌层生成器
│   ├── verify.cjs                     RFC5545 校验
│   ├── lib/ics.cjs                    序列化（折行/转义/全天事件）
│   └── data/holidays.json             人工录入的官方放假数据
└── .github/workflows/
    ├── verify.yml                     push / PR 校验
    └── update-calendar.yml            手动生成 + 年度体检
```

## 数据口径

- **法定节假日与调休**：逐年人工录入国务院办公厅通知原文，绝不推算。未录入的年份不会凭空生成假期。
- **节气与传统节日**：由 [lunar-javascript](https://github.com/6tail/lunar-javascript)（MIT）推算，节气按自然日归属。
- **黄历宜忌**：以《钦定协纪辨方书》为底本的口径，属民俗参考，**不构成任何决策依据**。

年份与天数一览：

| 年份 | 假期天数 | 补班天数 | 主层条数 |
|---|---|---|---|
| 2026 | 33 | 6 | 62 |
| 2027 | 29 | 5 | 59 |

## License

MIT
