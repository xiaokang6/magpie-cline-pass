# magpie-cline-pass

[![test](https://github.com/xiaokang6/magpie-cline-pass/actions/workflows/test.yml/badge.svg)](https://github.com/xiaokang6/magpie-cline-pass/actions/workflows/test.yml)

把 **Cline Pass** 订阅接入 [magpie](https://usemagpie.ai) 的供应商插件。

它把 [dsh-cline-pass](https://github.com/yhshzh/dsh-cline-pass) 的核心逻辑搬到了 magpie 的插件接口上：

- Cline Pass 模型出现在 magpie 的模型列表里，agent 用 `cline-pass/<模型>` 访问；
- 每个模型可以**探测** Cline 网关背后的上游渠道（probe）、**逐个校验**（validate）、**钉住**渠道（pin），并在**首个 token 之前**在渠道之间故障转移；
- 读取 Cline Pass 的 5 小时 / 每周 / 每月额度，显示在账号卡片和 `magpie quota` 里；
- 用 magpie 自己的 `tool` 钩子暴露一组管理工具，所有 agent 都能通过 magpie 的 MCP 服务器调用。

它**不是**代理服务，也不启动任何端口。账号池、Key 存储、账号级故障转移、额度休息、模型选择和路由组全部交给 magpie 本身。

## 参考

本插件的核心逻辑参考了 **[yhshzh/dsh-cline-pass](https://github.com/yhshzh/dsh-cline-pass)**（MIT License）：

- 两套路由字段的探测与注入（planner / direct）；
- 按上游渠道展开候选、`strict` / `preferred` 与首个 token 前故障转移；
- Cline 模型目录、用量窗口和渠道校验；
- `probe / validate / test / pin` 这组管理工具的设计。

dsh-cline-pass 是 DeepSeek Harness 的插件；本项目把同样的思路移植到 magpie 的插件接口。两者的账号池实现不同：账号和 Key 由 magpie 管理。

## 代码结构：从 dsh-cline-pass 到 magpie

| dsh-cline-pass | 这里 | 说明 |
| --- | --- | --- |
| `lib/index.js` 的账号池 | 无 | 账号、Key、轮询、休息、账号级故障转移由 magpie 自己管 |
| `lib/protocol.js` | `lib/protocol.js` | 纯函数：两套路由的字段、别名、候选展开、回读、错误分类 |
| `lib/cline.js` | `lib/cline.js` | Cline 网关、模型 feed、用量接口的传输层 |
| `lib/engine.js` | `lib/engine.js` | probe / harvest / validate / test |
| `lib/adapter.js` | `lib/request.js` | 每个账号的 `fetch`：注入 pin、首 token 前故障转移、记录 |
| `lib/store.js` | `lib/store.js` | 渠道、校验结果、请求历史；写到 magpie 配置目录 |
| `lib/tools.js` | `lib/tools.js` | `status/models/probe/validate/test/pin/history` |
| `lib/panel.js` + `client.js` | magpie 自带界面 | 供应商卡片、用量、账号、模型选择都由 magpie 画；插件用工具和 options 管理渠道 |

magpie 调用的钩子：

| 钩子 | 这里做什么 |
| --- | --- |
| `config` | 声明 `cline-pass` 供应商和 19 个回退模型 |
| `auth.methods` | 一个 API Key 登录方式 |
| `auth.loader` | 每个账号拿自己的 Key，返回一个带 pin 和故障转移的 `fetch` |
| `auth.usage` | 读 5 小时 / 每周 / 每月窗口 |
| `provider.models` | 从公开 feed 拉订阅模型，缓存 5 分钟 |
| `tool` | 把 probe / validate / pin 等暴露给所有 agent |

## 和 magpie 已有供应商的关系

magpie 自带一个内置的 ClinePass 供应商（id `clinepass`），社区还有一个 Cline 插件（id `cline`）。这个插件的 id 是 `cline-pass`，三者可以共存：

| 供应商 | 模型在 agent 里的写法 | 特点 |
| --- | --- | --- |
| 内置 ClinePass | `clinepass/cline-pass/deepseek-v4.1-flash` | 内置、简单 |
| 社区 Cline | `cline/cline-pass/deepseek-v4.1-flash` | 完整 Cline 账号、OAuth/API Key、免费模型 |
| **本插件** | `cline-pass/deepseek-v4.1-flash` | 渠道探测 / 校验 / 钉住 / 首 token 前故障转移 |

只想用 Cline Pass、并且需要控制上游渠道时选这个；想要 Cline 的按量计费模型或浏览器登录，用社区插件。

## 安装

从本地文件夹：

```bash
magpie plugin add D:\AI\chajian\magpie
```

从 git：

```bash
magpie plugin add github:xiaokang6/magpie-cline-pass
```

发布到 npm 后也可以：

```bash
magpie plugin add magpie-cline-pass
```

在 magpie 窗口里：**插件 → 添加插件**，填入文件夹路径或包名，然后在 `Cline Pass` 那一行登录。

## 登录

需要一个 Cline 账号的 API Key，在 [app.cline.bot → Settings → API Keys](https://app.cline.bot/dashboard/account) 创建。

```bash
magpie plugin login cline-pass
```

在窗口里则是供应商那一行的 **登录**。Key 保存在 magpie 的 `plugin-auth.json`（权限 600），插件只通过 magpie 的 `getAuth()` 按账号读取，不写日志、不写状态文件。

多个账号：在 magpie 里给 `cline-pass` 再登录一次即可；插件本身不维护账号池，magpie 会负责轮询、休息和账号级故障转移。

## 模型

插件从 Cline 的公开接口读取订阅模型：

```text
GET https://api.cline.bot/api/v1/ai/cline/recommended-models
```

只取 `clinePass` 组，并缓存 5 分钟。首次加载或接口失败时使用内置快照（19 个模型，2026-10-19 的 `models.dev` 数据 + dsh-cline-pass 的校准表）。模型 key 会去掉 `cline-pass/` 前缀，所以：

```text
agent 里：cline-pass/glm-5.3
请求体里：{"model":"cline-pass/glm-5.3"}
```

每个模型的上下文、输出上限、推理档位和输入模态来自内置快照；快照里没有的新模型使用保守默认值（200k 上下文、64k 输出、纯文本），直到下次更新。

## 用量

`auth.usage` 读取：

```text
GET https://api.cline.bot/api/v1/users/me/plan/usage-limits
```

映射为 magpie 的三个窗口：

| Cline 的 type | 显示 | span |
| --- | --- | --- |
| `five_hour` | 5 hours | 18000 秒 |
| `weekly` | Weekly | 604800 秒 |
| `monthly` | Monthly | 2592000 秒 |

未知的窗口类型会原样显示，不会被丢掉。404 表示账号没有 Cline Pass 订阅；401 会把账号标记为需要重新登录。

## 渠道探测、校验与钉住

Cline 的网关前面有两套路由，钉住字段的写法不同：

- **planner**（Vercel AI Gateway）：`providerOptions.gateway.only/order/sort`；
- **direct**（OpenRouter）：顶层 `provider.only/order/ignore/sort`。

插件默认**同时写两套**。每套路由都会忽略对方字段；只写上次探测到的那一套，会在路由切换时悄悄失效。

### 图形界面：Cline Pass 钉住

插件加载后，magpie 侧边栏的「插件」分组里会多一个 **「Cline Pass 钉住」** 页面：

1. 打开页面，每个模型一行；
2. 模式选「自动 / strict / preferred」；
3. 在「上游渠道」里填渠道名（逗号分隔，按尝试顺序），「排除」填不想用的渠道，「排序」选 cost / ttft / tps；
4. 点「保存钉住」。

渠道名先探测，见下面的「命令行直接探测」。页面只编辑插件 options；保存后如果请求仍在用旧规则，到 **插件 → 已安装** 把本插件关掉再打开。页面不联网，也不读取插件的探测状态，所以它只负责「钉住规则」，不负责「发现渠道」。

### 不配置 MCP：命令行直接探测

仓库里带了一个很小的 MCP 客户端，不需要给 agent 配 MCP：

```powershell
cd D:\AI\chajian\magpie

# 看实际工具名
node scripts\magpie-tool.mjs --list

# 探测 glm-5.3 有哪些渠道
node scripts\magpie-tool.mjs magpie_probe model=glm-5.3

# 逐个校验渠道（探测之后）
node scripts\magpie-tool.mjs magpie_validate model=glm-5.3

# 保存钉住（可选）
node scripts\magpie-tool.mjs magpie_pin model=glm-5.3 upstreams=openai-compatible-private pinMode=strict
```

参数用 `key=value`，数组用逗号分隔（如 `upstreams=zai,baseten`），也接受一个 JSON 对象。脚本只是向 `http://127.0.0.1:3425/mcp/magpie/tools` 发 MCP 请求；magpie 没启动时会报连接失败。

从 GitHub 安装时，工具名前缀是 `magpie-cline-pass_`；先用 `--list` 看实际名字，再把上面的 `magpie_probe` 换成 `magpie-cline-pass_probe`。脚本在包的 `scripts/magpie-tool.mjs` 里。

### 三种工具流程

需要先让 magpie 知道哪个账号的 Key，随便发一次请求或让 magpie 刷新一次账号即可；工具使用最近一次登录的账号。

```text
<short>_probe    model=glm-5.3
<short>_validate model=glm-5.3
<short>_test     model=glm-5.3 [upstream]
<short>_pin      model=glm-5.3 upstreams=["zai","baseten"] pinMode=preferred
```

`<short>` 是 magpie 给插件起的短名，运行 `magpie plugin` 可以看到实际工具名：从 GitHub 安装时是 `magpie-cline-pass_probe`，从名为 `magpie` 的本地文件夹安装时是 `magpie_probe`。

- **probe**：先正常问一次，读出实际服务的渠道；再对两套路由各发一次“不存在的渠道”请求，让网关在花 token 之前报出可用渠道列表。最多 3 个很小的真实请求。
- **validate**：对每个已知渠道发一个 `max_tokens: 64` 的小请求，只有响应里报告服务渠道等于钉住的渠道才算 `ok`。一个 200 不算证据：未知的 `only` 会被路由静默丢弃。每个渠道一次真实请求，并发 5。
- **test**：按当前保存的钉住配置发一个小请求，报告 target / actual / adherence。不改任何配置。
- **pin**：把某个模型的钉住配置写进状态文件；`clear: true` 删除，回退到插件 options。

`pinMode`：

- `strict`：每个渠道单独试；一个渠道失败就失败，不会改用别的渠道。
- `preferred`：按列表顺序试；在**首个内容帧之前**失败会自动换下一个。`exclude` 会被编译成 allow-list（网关会忽略自己的 ignore 字段）。

探测/校验结果和最近请求会写到 magpie 配置目录的 `cline-pass-state.json`。里面有模型名、渠道、耗时和错误文本，没有 Key、提示词或对话内容。

### 用插件 options 配置钉住

```bash
magpie plugin options <插件名> '{
  "pins": {
    "glm-5.3": { "upstreams": ["zai", "baseten"], "pinMode": "preferred" },
    "kimi-k3": { "exclude": ["openrouter"], "pinMode": "strict" }
  }
}'
```

模型 key 可以写短名，也可以写完整的 `cline-pass/...`。优先级：**工具写入的 pin > options 里的 pin > 自动路由**。

Windows PowerShell 5.1 会吞掉原生参数里的内层双引号；在它里面要把 JSON 写成 `'{\"pins\":…}'`，或者用 magpie 窗口里的选项编辑器。options 改动后如果没生效，把插件关掉再打开。

`sort` 可选 `cost`、`ttft`、`tps`（会翻译成两套路由各自的名字）。

## 工具

| 工具 | 作用 |
| --- | --- |
| `status` | 供应商、模型数、钉住配置、已知渠道、最近请求、上次用量 |
| `models` | 模型列表 + 每个模型的 pin / 渠道 / 校验结果 |
| `probe` | 探测一个模型的渠道 |
| `validate` | 逐渠道校验 |
| `test` | 测试当前钉住配置 |
| `pin` | 保存 / 清除一个模型的钉住配置 |
| `history` | 最近请求（最多 100 条） |

工具由 magpie 的 MCP 服务器统一暴露：`http://127.0.0.1:3425/mcp/magpie/tools`。不想让它们出现在每个 agent 的工具列表里时：

```bash
magpie plugin options <插件名> '{"exposeTools":false}'
```

供应商和用量不受影响。

## 故障转移

- **渠道级**：`preferred` 模式下，请求在首个内容帧之前失败（连接错误、非 2xx、流里先出现错误帧、流在没有任何内容时结束），就换下一个候选。内容一旦发给 agent，就不再重试。
- **账号级**：401 带 `X-Magpie-Sign-In: expired` 返回，magpie 会标记账号；配额/限流错误交给 magpie 的账号池处理。插件不自己轮询账号。
- **模型级**：Cline 返回 403 “需要订阅”时用 `kept` 返回，避免把“没订阅”误判成“登录过期”。

## 开发与测试

```bash
npm test
```

测试只依赖 Node 内置的 `node:test`，不联网。覆盖：

- 两套路由的字段注入、别名（`zai` / `z-ai`）、exclude 编译、strict/preferred 展开；
- 钉住回读（adopted / fallback / not-adopted / violated / unresolved）；
- 错误分类、用量窗口映射、模型目录解析；
- 流式请求在首个内容帧前换渠道、内容后不再重试、401 标记；
- 状态文件持久化和 Key 不落盘。

隔离环境里跑真实 magpie：

```bash
sb=$(mktemp -d)
HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$HOME/.cache \
  MAGPIE_ADDR=127.0.0.1:3499 \
  magpie plugin add /path/to/magpie-cline-pass

HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$HOME/.cache \
  MAGPIE_ADDR=127.0.0.1:3499 \
  magpie plugin login cline-pass

# 然后
magpie provider test cline-pass
magpie quota
```

开发时参考了 magpie 的插件文档和 dsh-cline-pass 的源码；两者都不属于这个包。

## 已知限制

- 只有 API Key 登录，没有 Cline 的浏览器/OAuth 登录；OAuth 请用社区 `cline` 插件。
- 模型的窗口/输出上限来自发版时的快照；Cline 新加的模型会先用保守默认值。
- 钉住能力取决于 Cline 网关实际暴露的渠道。写这个插件时 Cline Pass 的多数模型只报出一个 `openai-compatible-private` 渠道；插件会如实探测和显示，不会凭空造渠道。
- 管理工具使用最近一次被 magpie 调用的账号 Key；它不遍历账号池。多账号的日常请求仍由 magpie 路由。
- `pin` 工具写入的是 magpie 配置目录里的状态文件，不是 magpie 的插件 options；两者都生效，工具写入优先。

## License

MIT
