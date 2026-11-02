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
4. 在“广告单元创建”中生成任务，选择 REST 账户及父广告单元资源名（格式 networks/NETWORK_CODE/adUnits/ID），逐项发布。系统会先按编码检查远端已有广告单元，再创建或记录已有资源。

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
