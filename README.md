# AdX 渠道管理平台

独立的 AdX 数据管理与渠道服务。前端使用 React、Vite、Ant Design；后端使用 Node.js、Express 和 SQLite。

## 功能

- 平台管理后台：经营总览、组合维度报表、渠道与分成管理。
- JSON 数据导入：上传后先预检字段和错误，再幂等写入；保留导入批次与审计。
- 管理员账户：创建管理员、重置管理员密码。
- 渠道账户：创建、启停、重置密码，服务端隔离渠道数据。
- 渠道 API：每个渠道独立密钥，可轮换；使用 `Authorization: Bearer`，只返回本渠道结算后数据。
- 渠道工作台：渠道登录后查看自己的收益、展示、匹配率和明细。
- 双域名入口：管理端与渠道端共享服务，但按 Host 和角色双重隔离。
- 分成口径：管理后台保存原始收入并设置渠道分成比例；渠道页面与渠道 API 只返回 `原始收入 × 分成比例` 的结算收入。

## Google Ad Manager REST 接入

管理端的账户连接、报表同步和广告单元发布均使用 Google Ad Manager REST v1。服务账号需要获得目标 Network 的访问权限，OAuth scope 为 https://www.googleapis.com/auth/admanager。旧数据库中的 soap_accounts、soap_sync_runs、soap_account_id 仅作为兼容既有数据的内部表名；运行时不再发送 SOAP 请求。原有账户凭证保留，但自动入库默认关闭，须重新测试和配置。

1. 在“Ad Manager REST”中保存服务账号 JSON 和 Network Code，测试连接。
2. 在“结算配置”中建立上游账户并关联 REST 账户。
3. 在 REST 账户中选择渠道、上游账户及金额单位，配置报表；按日期预览并核对收入及维度口径，再启用自动入库。每次重新配置都会暂停自动入库。
4. 在“广告单元”按账号查询 GAM 现有广告单元；点击“新建广告单元”打开弹窗，可切换创建单个或批量创建。账号、网站（来自当前 Network 的 GAM Sites）和父单元必选。批量默认提供 Banner 1/2/3、插页 INT、锚定 ANC 五个版位，可添加或删除，逐个调整尺寸、名称与编码，一次最多创建 100 个（多网站按实际组合数计）。同一 Network 的广告单元编码不可重复；失败项保留记录，重试时先从 GAM 对账，避免超时后重复创建。原有 JSON 任务收纳在兼容区域。

GAM AdUnit REST 资源没有直接的 Site 字段；此处选择的域名来自对应账户的 GAM Sites，关联保存在本站记录中，GAM 侧通过选定的父广告单元、编码和尺寸创建资源。Banner 模板提供 250x250、300x250、320x50、336x280；插页模板提供 1x1、320x480、480x320、768x1024、1024x768、页外、原生自定义呈现和自适应尺寸；锚定模板提供 320x50。页外、原生、自适应分别映射 REST SizeType 的 INTERSTITIAL、NATIVE、FLUID。尺寸必须由操作员在预览中确认。

REST 报表固定使用 DATE、HOUR、SITE、COUNTRY_CODE、AD_UNIT_NAME 维度及 Ad Exchange 请求、响应、展示、点击、收入指标。REST 的 AD_EXCHANGE_REVENUE 与旧版 SOAP 的行项目级收入不能未经对账就认定为相同口径；应使用旧报表或 Ad Manager 控制台核对同一日期范围后再启用。金额单位可配置为美元或 micros，配置错误会使结算金额失真。自动同步只处理显式启用的账户，默认抓取 Network 时区的昨天与今天；手动同步使用页面选定的日期范围（最多 31 天）。

## JSON 格式

支持根数组、`data` 数组或 `rows` 数组。当前自动识别字段：

```json
[
  {
    "date": "2026-10-01",
    "url": "https://example.com/page",
    "account": "account-a",
    "ad_unit": "Banner 300x250",
    "country": "US",
    "requests": 1000,
    "matched_requests": 900,
    "impressions": 800,
    "clicks": 12,
    "revenue": 15.25
  }
]
```

上传正式样例后，应补充固定 schema 和样例级回归测试，避免自动字段识别产生歧义。

导入预检会按整份文件统计通过与拒绝行，并列出：Google 字段到系统核心字段的映射、缺失的核心字段，以及只保留在 `raw_json` 中的扩展字段。日期与总收入为当前入库必需字段；没有任何有效行的文件会被拒绝，不会产生“成功但无数据”的导入批次。

目前兼容普通导出表头、常见中文表头，以及 `DATE`、`DIMENSION_*`、`METRIC_*` 形式的 API 字段名。Google API 的位置型 `dimensionValues` / `metricValueGroups` 行必须同时携带报告字段定义后才能安全解释；在获得真实样例前不会猜测数组位置。

系统会将核心字段标准化用于聚合，同时在 `raw_json` 中保留每行完整原始字段。正式字段定义以 Google Ad Manager 官方文档为准：

- API 字段开关：https://support.google.com/admanager/answer/16865393#api-fields
- 互动式报告维度：https://support.google.com/admanager/table/16419917
- 互动式报告指标：https://support.google.com/admanager/table/16431202

Ad Manager 的部分维度与指标不可组合。后台字段模板需要按报告类型分组，不允许用户任意组合后直接提交到 Google API。

## 本地运行

## 查询与同步性能

经营总览按日期、渠道和域名维护汇总表；REST 同步及 JSON 导入后只重建受影响的日期，分成或域名规则变化后重建全表。汇总失败时回退到原始事实表查询，避免返回过期收入。总览和数据报表按登录用户及完整查询参数缓存，写入后失效；响应的 `Server-Timing` 可区分命中与实际计算耗时。

GAM OAuth token 按账户和凭证版本复用，提前刷新并合并并发请求。定时同步最多并行两个账户，记录授权、报表准备、远端运行、标准化及入库阶段耗时；429 和暂时性 5xx 只对可安全重试的 GET/PATCH 退避重试，创建资源及启动报表的 POST 不自动重发。Google 报表生成和网络延迟无法保证毫秒级。

## 本地运行

```bash
cp .env.example .env
npm install
npm run dev
```

生产环境必须通过环境变量创建首个管理员，不提供默认账户或默认密码。不要将 `.env`、JSON 原始数据或渠道密钥提交到 Git。

## 部署域名

目标域名：

- 管理后台：`https://adx.geekforest.ai`
- 渠道后台：`https://adxpub.geekforest.ai`

两个域名反向代理到同一个应用端口。应用依据 Host 限制登录角色：管理域名仅允许管理员，渠道域名仅允许渠道账号。Nginx 必须保留原始 `Host` 并传递 `X-Forwarded-Proto`。

生产部署还需要服务器目录、Nginx 配置位置和 DNS/证书权限。服务默认监听 `4180`，Nginx 应反向代理到 `127.0.0.1:4180`。

## 数据报告

管理后台的“数据报告”默认展示已同步的 Google Ad Manager REST 报表，可按日期、小时、网站、国家、广告单元名称及 ID、上游账号、渠道、广告主和 BD 组合分组，并按指标筛选、分页和导出 CSV。点击任一行可在弹窗中查看该分组的更细维度。渠道后台只查询本渠道数据，收入使用现有结算规则计算。

Google 原始报表固定采集 DATE、HOUR、SITE、COUNTRY_CODE、AD_UNIT_NAME、AD_UNIT_ID 和五项 Ad Exchange 指标；广告主、BD 是上游账户的业务元数据，应在“结算配置”编辑。报表的“Google REST 实际同步”来源仅包含成功同步入库的 REST 行，其他导入来源需切换“全部来源”查看。旧库首次启动时增加广告单元 ID 维度并重建收入事实表；生产升级前应停止本网站服务并备份 SQLite 主文件及 WAL。
