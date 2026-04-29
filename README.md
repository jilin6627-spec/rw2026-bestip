# rw2026-bestip

Xray + Cloudflare Tunnel 自动部署，深度集成 edgetunnel 优选IP系统。

## 核心特性

- **多源优选IP**：支持配置多个 edgetunnel Worker API，自动聚合IP池
- **TCP延迟测速**：对所有候选IP进行实际TCP连接测速，选出最快入口
- **定时自动刷新**：可配置测速间隔（默认4小时），订阅自动更新
- **状态面板**：`/bestip` 实时查看测速结果、当前最优IP
- **多节点订阅**：自动为TOP N个最快IP生成独立节点

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `UUID` | ✅ | 节点UUID |
| `ARGO_DOMAIN` | ✅ | Cloudflare隧道域名 |
| `ARGO_AUTH` | ✅ | 隧道Token或JSON凭证 |
| `BESTIP_APIS` | ✅ | 优选IP API地址，逗号分隔多个 |
| `CFIP` | ❌ | 回退IP（默认cdns.doon.eu.org）|
| `CFPORT` | ❌ | 端口（默认443）|
| `BESTIP_INTERVAL` | ❌ | 测速间隔ms（默认14400000=4h）|
| `BESTIP_CONCURRENCY` | ❌ | 并发测速数（默认10）|
| `BESTIP_TIMEOUT` | ❌ | 测速超时ms（默认3000）|
| `BESTIP_TOP_N` | ❌ | 保留前N个最快IP（默认3）|

## API端点

- `GET /health` - 健康检查
- `GET /sub` - 订阅链接（自动使用最优IP）
- `GET /bestip` - 优选IP状态面板（JSON）
- `GET /bestip/test` - 手动触发测速

## 部署

### Railway
直接连接本仓库，设置环境变量即可。

### Docker
```bash
docker build -t rw2026-bestip .
docker run -d -e UUID=xxx -e ARGO_DOMAIN=xxx -e ARGO_AUTH=xxx -e BESTIP_APIS=xxx rw2026-bestip
```
