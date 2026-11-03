# bit-stock-mcp

一个面向bit美股券商的 MCP Server，可以让任何AI Agent 比如龙虾，codex，workbuddy等等。 通过这个MCP操作你的bit的股票账户。

### 推荐专业股票投资AI Agent：driven
- 免费试用链接：https://driven.ai/r/yang1 

### 使用前你需要拥有一个bit的美股账户，👇下面是开户指引。
- BIT开户链接：https://research.bshareweb.com/stock_research/prd/channel_20260803.html?invite_code=Y296E2  
- 或者下载app填写注册页面填写邀请码 【Y296E2】
- ✅ 中国大陆用户用内地身份证即可开户。
- ✅ 支持USDT等虚拟货币入金。
- ✅ 不在CRS范围内。
  
### 

- BIT证券是一家全球化的一站式券商，致力于为全球投资者提供安全、高效的美港股投资服务。
>  ✅ 真实美股，覆盖 10,000+ 美股及 ETF，支持股东权益
>  ✅ 港股、港股 IPO 已开放，美港股一个账户搞定
>  ✅ 身份证即可开户，支持稳定币/银行电汇/Wise/股票转仓等多种入金方式
>  ✅ 美股、港股 0 佣金，美股期权0佣金&平台费仅$0.3/张
>  ✅ 用户资产由持牌机构托管，与平台资产严格隔离，更安全、更放心
>  ✅ 不在 C-R-S 自动信息交换安排内，更适合跨境资产配置
>  ✅ 陆续还有更多市场开放（日股、韩股等）

- 原官方API：https://www.bit.com/docs/en-us/stock.html 

服务使用 Node.js 原生模块实现，无 npm 运行时依赖；提供账户、持仓和订单查询，也支持下单、改单与撤单。交易功能默认关闭，并内置数量、金额、市场单、交易时段和标的白名单等风控开关。

> [!CAUTION]
> 本项目可以操作真实证券账户。请先保持只读模式完成验证，并自行评估交易、凭证保管和网络暴露风险。本项目不构成投资建议。

## 功能特性

- MCP Streamable HTTP，无状态 JSON 响应
- Bearer Token、`X-API-Key` 或 URL Token 鉴权
- 账户余额、持仓、活动订单及历史订单查询
- 限价单和可选的市场单下单、改单、撤单
- 默认只读，交易操作需显式开启
- 单笔数量和限价单金额上限
- 标的白名单、盘前盘后交易和市场单独立开关
- 下单、改单、撤单审计日志
- `dry_run` 下单预检，不向交易接口发送订单
- 原生 Node.js 实现，无需执行 `npm install`

## MCP 工具

| 工具 | 类型 | 说明 |
| --- | --- | --- |
| `get_balance` | 只读 | 查询股票账户现金余额 |
| `get_positions` | 只读 | 查询持仓，并计算市值和未实现盈亏 |
| `list_open_orders` | 只读 | 查询当前交易日的活动订单 |
| `get_orders` | 只读 | 按标的、方向、时间或订单 ID 查询历史订单 |
| `get_order_detail` | 只读 | 查询单个订单及费用明细 |
| `place_order` | 交易 | 下单；支持 `dry_run=true` 预检 |
| `edit_order` | 交易 | 修改活动限价单的数量和价格 |
| `cancel_order` | 交易 | 撤销活动订单 |

## 环境要求

- Node.js 18 或更高版本
- 可访问 bit.com / Matrixport 股票 API 的账户与 API Key
- 生产环境建议使用 Linux、PM2、Nginx 和 HTTPS

## 快速开始

### 1. 配置环境变量

```bash
cp .env.example .env
openssl rand -hex 32
```

将 `openssl` 生成的随机值填入 `.env` 的 `MCP_AUTH_TOKEN`，再填写以下必需配置：

```dotenv
BIT_ACCESS_KEY=你的访问密钥
BIT_SECRET_KEY=你的私密密钥
MCP_AUTH_TOKEN=至少24个字符的随机令牌
```

限制配置文件权限：

```bash
chmod 600 .env
```

### 2. 验证 API Key 和签名

```bash
node server.js --selftest
```

看到 `SELFTEST OK` 表示余额、持仓和活动订单接口均已通过验证。自检输出可能包含账户信息，请勿粘贴到公开 Issue 或日志平台。

### 3. 启动服务

```bash
node server.js
```

默认监听 `127.0.0.1:8790`：

```bash
curl http://127.0.0.1:8790/health
```

## 配置说明

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BIT_BASE_URL` | `https://mapi.matrixport.com` | 股票 API 地址 |
| `BIT_ACCESS_KEY` | 无 | API Access Key，必填 |
| `BIT_SECRET_KEY` | 无 | API Secret Key，必填 |
| `BIT_AUTH_MODE` | `v2` | 签名模式；仅在兼容旧接口时尝试 `v1` |
| `BIT_TIMEOUT_MS` | `10000` | 上游 API 请求超时，单位毫秒 |
| `HOST` | `127.0.0.1` | 服务监听地址 |
| `PORT` | `8790` | 服务监听端口 |
| `MCP_PATH` | `/mcp` | MCP HTTP 路径 |
| `MCP_AUTH_TOKEN` | 无 | MCP 访问令牌，必填且不少于 24 个字符 |
| `TRADING_ENABLED` | `false` | 是否允许真实下单、改单和撤单 |
| `ALLOW_MARKET_ORDERS` | `false` | 是否允许市场单 |
| `ALLOW_OUTSIDE_RTH` | `true` | 是否允许客户端提交非正常交易时段订单 |
| `MAX_ORDER_QTY` | `1000` | 单笔最大数量 |
| `MAX_ORDER_NOTIONAL_USD` | `10000` | 单笔限价单最大名义金额（美元） |
| `SYMBOL_ALLOWLIST` | 空 | 允许交易的标的，逗号分隔；空值表示不限制 |
| `DEFAULT_REGION` | `US` | 标的未带市场后缀时使用的默认地区 |
| `LOG_DIR` | `./logs` | 审计日志目录 |

注意：`MAX_ORDER_NOTIONAL_USD` 只能根据限价计算，因此仅约束限价单；市场单仍受 `ALLOW_MARKET_ORDERS` 和 `MAX_ORDER_QTY` 控制。

## 测试 MCP 接口

推荐通过 `Authorization` 请求头传递 Token：

```bash
export MCP_TOKEN='你的MCP_AUTH_TOKEN'

curl -s http://127.0.0.1:8790/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

调用只读工具：

```bash
curl -s http://127.0.0.1:8790/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_balance","arguments":{}}}'
```

下单预检不会向交易 API 发送订单，即使 `TRADING_ENABLED=false` 也可使用：

```bash
curl -s http://127.0.0.1:8790/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"place_order","arguments":{"symbol":"AAPL.US","side":"Buy","qty":"1","order_type":"LO","price":"100.00","dry_run":true}}}'
```

## 接入 Driven

- URL：`https://mcp.example.com/mcp`
- 请求头：`Authorization: Bearer <MCP_AUTH_TOKEN>`

如果客户端只能填写 URL，服务也支持：

- 路径 Token：`https://mcp.example.com/mcp/<MCP_AUTH_TOKEN>`
- 查询 Token：`https://mcp.example.com/mcp?token=<MCP_AUTH_TOKEN>`

Token 放在 URL 中可能被代理访问日志、浏览器历史或监控系统记录，仅应作为兼容方案；优先使用请求头。

## 生产部署

### PM2

将项目部署到 `/www/wwwroot/bitmcp`。如果使用其他目录，请同步修改 `ecosystem.config.js` 中的 `cwd`。

```bash
cd /www/wwwroot/bitmcp
node -v
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

`pm2 startup` 会输出一条系统命令，请按提示执行，以便服务器重启后自动拉起进程。

### Nginx 与 HTTPS

使用 Nginx 将公网 HTTPS 请求反向代理到本机端口：

```nginx
location /mcp {
    proxy_pass http://127.0.0.1:8790;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 60s;
}

location = /health {
    proxy_pass http://127.0.0.1:8790;
}
```

不要在公网防火墙中开放 `8790`；仅暴露启用 HTTPS 的 `443` 端口。

## 开启真实交易

建议按以下顺序操作：

1. 保持 `TRADING_ENABLED=false`，确认余额、持仓和订单查询正确。
2. 使用 `dry_run=true` 检查准备提交的订单参数。
3. 设置较小的 `MAX_ORDER_QTY` 和 `MAX_ORDER_NOTIONAL_USD`。
4. 建议设置 `SYMBOL_ALLOWLIST`，限制可交易标的。
5. 确认无误后，将 `TRADING_ENABLED` 改为 `true` 并重启服务。
6. 先用小数量、远离市价的限价单完成“下单 → 查询 → 撤单”验证。

```bash
pm2 restart bitmcp
```

交易审计记录默认写入 `logs/audit.log`。请限制日志目录权限，并按需设置轮转与备份策略。

## 安全建议

- 永远不要提交 `.env`、真实 API Key、MCP Token、账户信息或审计日志。
- API Key 应只授予必要权限，并配置服务器出口 IP 白名单。
- 定期轮换 API Key 和 `MCP_AUTH_TOKEN`；一旦泄露应立即吊销。
- 保持 `HOST=127.0.0.1`，通过 HTTPS 反向代理对外提供服务。
- 生产环境优先设置 `SYMBOL_ALLOWLIST`，并保持市场单关闭。
- 在调用 `place_order`、`edit_order` 或 `cancel_order` 前，应向用户复述完整操作并取得明确确认。

## macOS 中找不到 `.env.example`？

以 `.` 开头的文件在 macOS 和 Linux 中属于隐藏文件。Finder 中可按 `Command + Shift + .` 显示或隐藏它们；终端中可使用以下命令查看：

```bash
ls -la
```

## 常见问题

### 启动时报 `MCP_AUTH_TOKEN must be set`

确认已经创建 `.env`，并将至少 24 个字符的随机 Token 填入 `MCP_AUTH_TOKEN`。

### 自检返回 `20080401`、`412` 或认证错误

1. 确认 API Key 已开通股票接口权限。
2. 确认服务器出口 IP 已加入 API Key 白名单。
3. 检查服务器时间是否准确；签名时间戳偏差过大会被拒绝。
4. 若账户仍使用旧签名方式，可尝试 `BIT_AUTH_MODE=v1` 后重新自检。

### MCP 请求返回 `401 unauthorized`

确认客户端发送的 Token 与 `.env` 中的 `MCP_AUTH_TOKEN` 完全一致，并检查反向代理是否保留 `Authorization` 请求头。

### 交易工具提示 `Trading is disabled`

这是默认保护机制。完成只读和 `dry_run` 验证后，再设置 `TRADING_ENABLED=true` 并重启服务。

## 项目结构

```text
.
├── .env.example          # 环境变量模板，不包含真实凭证
├── .gitignore            # Git 忽略规则
├── README.md             # 项目说明
├── bitclient.js          # bit.com / Matrixport 股票 REST API 客户端
├── ecosystem.config.js   # PM2 配置
└── server.js             # MCP Server、工具定义与风控逻辑
```

<!-- 请在上传 GitHub 前，在此处或合适章节补充你的项目背景、说明和联系方式。 -->
