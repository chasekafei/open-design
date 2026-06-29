# Railway 部署维护说明

本文档记录本 fork 在 **Railway 直连部署**（无反向代理注入 Bearer）场景下的定制改动、环境变量约定，以及后续从上游 `main` 同步时的保留清单。

适用分支：`railway-deploy`（生产）、`railway-deploy-test`（合并/验证用）。

---

## 能否合并到 `railway-deploy`？

**可以。** 若你已在 `railway-deploy-test` 上完成端到端验证（聊天、简报、技能侧文件读取、预览热更新、控制台无关键 401），将测试分支合并进 `railway-deploy` 属于常规操作：

```bash
git checkout railway-deploy
git merge railway-deploy-test   # 预期为 fast-forward 或干净 merge
git push origin railway-deploy
```

然后在 Railway 生产 Service 上确认跟踪分支为 `railway-deploy` 并触发重新部署。

> `railway-deploy-test` 相对旧版 `railway-deploy` 的增量 = **上游 `main` 全量合并** + **3 个 Railway 修复 commit**（见下文「2026-06 测试分支新增修复」）。

---

## 部署架构（与上游默认的差异）

| 维度 | 上游推荐（`deploy/README.md`） | 本 fork Railway 方案 |
|------|-------------------------------|----------------------|
| 暴露方式 | localhost + 反向代理注入 `Authorization` | 容器直接 `0.0.0.0:7456`，浏览器直连 HTTPS |
| API 鉴权 | 代理统一带 Bearer，或 `OD_DISABLE_API_AUTH=1` | `OD_API_TOKEN` + **HTML 注入** `window.fetch` 包装 |
| 允许来源 | Compose 将 `OPEN_DESIGN_ALLOWED_ORIGINS` 映射为 `OD_ALLOWED_ORIGINS` | Railway **无 compose 层**，必须直接设 `OD_ALLOWED_ORIGINS` |
| Agent | 宿主机 CLI | 镜像内安装 `@anthropic-ai/claude-code` |

---

## Railway 环境变量（必配 / 常见）

在 Railway Service → Variables 中设置（**不要**只依赖 `deploy/.env` 里的 `OPEN_DESIGN_ALLOWED_ORIGINS`，daemon 不读该变量名）。

| 变量 | 必填 | 说明 |
|------|------|------|
| `OD_BIND_HOST` | 是 | `0.0.0.0`（`deploy/Dockerfile` 已默认，建议在 Railway 再显式设一次） |
| `OD_PORT` | 是 | `7456`，且 **Networking 公网端口须与之一致**（或用 `${{PORT}}` 时 daemon 也要跟 Railway 分配的端口一致） |
| `OD_API_TOKEN` | 是 | `openssl rand -hex 32`；浏览器通过注入脚本带 Bearer |
| `OD_ALLOWED_ORIGINS` | 是 | 精确浏览器 Origin，如 `https://your-app.up.railway.app`（无尾斜杠） |
| `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` 等 | 视供应商 | 驱动容器内 Claude Code |
| `CLAUDE_BIN` | 可选 | Dockerfile 已设 `/usr/local/bin/claude` |
| `OD_DATA_DIR` | 可选 | 持久卷挂载点；entrypoint 会 `chown` 后降权运行 |

**不要混淆：**

- `OPEN_DESIGN_ALLOWED_ORIGINS` → 仅 docker-compose 模板变量，**Railway 无效**
- `OD_DISABLE_API_AUTH=1` → 会关闭全部 Bearer 校验，仅适合有其它网关鉴权的环境，Railway 直连不要用

---

## 镜像定制（`deploy/Dockerfile`）

相对上游 GHCR 镜像 / 旧版 fork Dockerfile，**必须保留**的 Railway 相关层：

1. **构建阶段分层** — 先 `pnpm install` 再 `COPY apps`，避免 web 改动击穿依赖缓存（`9a92fcdf8` 起）
2. **Stage-2 资源复制** — 除 `skills/`、`design-systems/`、`craft/`、`plugins/_official/` 外，必须包含：
   - **`design-templates/`**（`6fd17710a`）— agent 读取 `web-prototype` 等模板种子；缺了会「找不到技能侧文件」
3. **运行时** — `tini` + `su-exec` + `bash` + `git` + **全局 Claude Code**
4. **`OD_BIND_HOST=0.0.0.0`**、`EXPOSE 7456`
5. **Entrypoint** — 启动前对 `OD_DATA_DIR`（默认 `/app/.od`）做 `chown`，再以 `open-design` 用户跑 daemon（`1cb31c397`）

Railway 构建配置：

```text
RAILWAY_DOCKERFILE_PATH=deploy/Dockerfile
```

构建 context 应为 **仓库根目录**（与 Dockerfile 内 `COPY design-templates` 等路径一致）。

---

## Daemon 代码定制（合并上游时需保留）

以下为 **Railway / 公网直连** 专用逻辑，分散在 `apps/daemon`；从 `main` 合并时若冲突，应在新架构上**重新接回**，不要整段丢弃。

### 1. SPA API Token 注入 — `apps/daemon/src/static-spa.ts`

- `buildApiTokenBootstrapScript` / `renderIndexHtmlWithToken` / `registerStaticSpaFallback`
- `server.ts` 注册静态 SPA fallback 时传入 `{ apiToken }`
- 测试：`apps/daemon/tests/api-token-guard.test.ts`

**原因：** 浏览器非 loopback，`fetch('/api/...')` 无法自动带 Bearer；`EventSource` 也无法带 Header（见下）。

### 2. Bearer 中间件与浏览器例外 — `apps/daemon/src/server.ts`

在 `OD_API_TOKEN` 启用时，对 `/api` 的统一校验中保留：

| 例外 | 路径 / 条件 | 原因 |
|------|-------------|------|
| 健康探针 | `/api/health`、`/ready`、`/version` 等 | 监控 |
| 同源 SSE | `GET` + `isLocalSameOrigin` + `/memory/events` | EventSource 无 Authorization |
| **项目 SSE** | `GET` + 同源 + `/projects/:id/events` | 预览热更新（`427315ae4`） |
| 插件预览 iframe | `GET` + 同源 + `/plugins/:id/preview|example|asset/...` | iframe 无 Bearer |
| 项目 raw 预览 | `GET` + `Origin: null` 或同源 + `/projects/:id/raw/...` | sandbox iframe |
| Loopback | `req.socket` 为 127.0.0.1 等 | 本地桌面 |

**原因：** Railway 上远程 TCP 不满足 loopback 短路，未配置 `OD_ALLOWED_ORIGINS` 时同源检查也会失败。

### 3. Agent 读设计模板侧文件 — `apps/daemon/src/runtimes/chat-prompt-inputs.ts` + `server.ts`

`resolveChatExtraAllowedDirs` 对非 Codex agent 的 `--add-dir` 须包含：

- `DESIGN_TEMPLATES_DIR`
- `USER_DESIGN_TEMPLATES_DIR`
- 当前激活技能的 `activeSkillDirs`

`derivePreflight`（`apps/daemon/src/prompts/system.ts` 与 `packages/contracts/src/prompts/system.ts`）须强调从 **`.od-skills/<folder>/assets/...`** 读取，而非项目根下的裸 `assets/...`。

**原因：** PR #955 将 `web-prototype` 等迁至 `design-templates/` 后，旧 allowlist 只有 `skills/`，Claude Read 会报 `template.html` / `layouts.md` 不存在（`ea81010c0`）。

### 4. 其它已合并的 fork 修补（仍在 `railway-deploy` 历史中）

| 区域 | 改动要点 |
|------|----------|
| `routes/vela.ts` | 无 vela CLI 时 `/api/amr/models` 返回空列表，避免 500 |
| `connectors/routes.ts` | 反向代理场景下 Composio 配置 PUT 等同源修复 |
| `prompts/official-system.ts` | `FILESYSTEM_WORKFLOW_HANDOFF` 保留 **flat raw 路径**说明（`d56a6b41e`） |
| Bearer / SSE 路径 | 使用 Express 剥离后的 `req.path`（`/memory/events` 而非 `/api/memory/events`） |

---

## 2026-06 测试分支新增修复（合并后应留在 `railway-deploy`）

| Commit | 摘要 |
|--------|------|
| `427315ae4` | 同源绕过 `/api/projects/:id/events`，修复 SSE 401 |
| `6fd17710a` | Dockerfile 打包 `design-templates/` |
| `ea81010c0` | `--add-dir` 含 design-templates + preflight 路径说明 |

---

## 与上游 `main` 合并工作流（建议）

每次上游大版本同步：

```bash
git checkout railway-deploy-test
git fetch origin
git merge origin/main          # 或 rebase，按团队习惯
# 重点检查冲突文件（历次合并曾冲突）：
#   apps/daemon/src/static-spa.ts
#   apps/daemon/src/server.ts
#   apps/daemon/src/routes/vela.ts
#   apps/daemon/src/prompts/official-system.ts
#   deploy/Dockerfile
#   apps/daemon/tests/api-token-guard.test.ts
pnpm guard && pnpm typecheck
pnpm --filter @open-design/daemon exec vitest run tests/api-token-guard.test.ts
# 部署到 Railway 测试 Service，跑一轮：登录/API、新建项目、播客/移动原型、看控制台
git push origin railway-deploy-test
# 验证通过后：
git checkout railway-deploy && git merge railway-deploy-test && git push
```

**合并原则：**

- `main` 的结构重构（模块化 routes、新 prompt 栈）→ **采用 upstream**
- 上表「Daemon 代码定制」→ **在 upstream 结构上重新接线**
- `deploy/Dockerfile` → **保留 fork 的 Claude Code、su-exec、design-templates、OD_BIND_HOST**

---

## 已知可忽略的控制台噪音

| 现象 | 说明 |
|------|------|
| `/api/community/discord` 502 | 容器访问 Discord API 失败，仅影响社群人数徽章 |
| CSP `connect-src` / `style-src` | 沙箱预览 iframe 的安全策略，预期行为 |
| 浏览器扩展 `web-client-content-script.js` | 与 Open Design 无关 |

---

## 验证清单（合并或改 Dockerfile 后）

- [ ] Railway Networking 端口 = daemon 监听端口
- [ ] `OD_ALLOWED_ORIGINS` = 实际 HTTPS Origin
- [ ] 打开 Web UI，API 非 401/403
- [ ] 新建项目 + 对话，技能侧文件读取无「读取 ×3 错误」
- [ ] `/api/projects/.../events` 非 401（预览自动刷新）
- [ ] 入口 **Templates** 标签有模板卡片（证明 `design-templates` 在镜像内）

---

## 相关文件索引

```text
deploy/Dockerfile              # 镜像与资源复制
deploy/docker-compose.yml      # 本地参考；Railway 不经过此文件的 env 映射
deploy/.env.example            # 本地变量模板（注意 OD_* vs OPEN_DESIGN_*）
apps/daemon/src/static-spa.ts  # fetch Bearer 注入
apps/daemon/src/server.ts      # Bearer 中间件、SSE 绕过、技能 staging
apps/daemon/src/runtimes/chat-prompt-inputs.ts
apps/daemon/tests/api-token-guard.test.ts
specs/current/skills-and-design-templates.md  # design-templates 架构说明
```
