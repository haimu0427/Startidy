# Startidy v2 架构计划

状态：待评审的实现设计；本文不表示功能已经实现。设计基于当前仓库和截至 2026-09-29 核对的官方文档。

## 1. 产品约定与范围

已经确认的方向：

- 从第一版重构版本开始面向其他用户发布，支持不同宿主 agent。
- 仅由宿主 agent 规划、分类、提问和理解回答；Startidy 不维护独立 LLM provider。
- 使用 skill + CLI；CLI 通过 `gh api` 访问 GitHub。
- 首次全面了解 Stars 和现有 Lists，以现有整理结果为基础确认方案。
- 后续默认增量，优先沿用已有分类；确有需要时提出新分类，已有仓库保持原位。
- 用户明确要求时才进行局部调整或全量重新规划。
- 分类和变更在第二阶段讨论、预览并确认，第三阶段执行已确认的内容。

第一版支持本地或具有等价执行环境的 agent：能读取 skill/JSON、写入计划文件、运行 CLI、访问已认证的 `gh`。只有聊天能力、没有命令执行环境的宿主不能仅靠安装 skill 完成写入。云端环境需要自己的依赖和认证，不会自动继承本机 `gh` 登录态。

首发验证目标：Codex、Claude Code、Cursor；同一 CLI 在 Linux、macOS、Windows 上验证。其他宿主标注为满足能力要求时可用，未经验证的不宣称已经通过兼容测试。GitHub.com 为首发服务端目标；数据中保留 hostname，Enterprise 的 Lists 能力另行验证后再承诺支持。

本轮只完成架构与实施计划，不修改现有执行代码，不安装 skill，不发布软件，也不修改用户的 GitHub 数据。

## 2. 语言、框架与改造规模

| 项目 | 决策 | 原因 |
| --- | --- | --- |
| 语言 | 保留 TypeScript | 已有代码可复用，适合描述计划、快照和操作类型 |
| 运行时 | Node.js 22+；首发 CI 验证 22、24 LTS | 不再以已结束维护的 Node 18 为发布基线 |
| CLI | 保留 Commander | 命令解析需求简单，无需更换框架 |
| 构建 | 可保留 Bun 构建，固定开发/CI 版本 | npm 发布编译后的 JavaScript，用户运行不依赖 Bun |
| 数据校验 | JSON Schema 2020-12 + Ajv 对应方言 | 向所有 agent 暴露同一可执行契约 |
| 类型生成 | 从 schema 生成公开数据类型 | 避免 TS 类型和 JSON 格式各自演化；生成器仅为开发依赖 |
| 存储 | 本地 JSON、JSONL、原子文件替换、账号级锁 | 满足低频使用、恢复执行，不引入数据库或后台服务 |
| 测试 | Node 内置测试能力，编译后运行；必要时使用开发期 TS runner | 核心重点是行为和恢复边界，避免引入应用框架 |
| LLM SDK | 删除运行时依赖及其配置 | 规划、分类都在宿主 agent 中完成 |
| MCP / Web / 常驻进程 | 首发不引入 | 当前全部流程可由已有命令执行环境完成 |

Node 版本选择依据 [Node.js 官方发布状态](https://nodejs.org/en/about/previous-releases)。Ajv 的方言要求依据 [Ajv JSON Schema 文档](https://ajv.js.org/json-schema.html)。具体依赖版本在实施时锁定。

这是一轮职责和数据协议重构。可复用 GraphQL 操作知识、分页思路、仓库读取、并发工具和部分命令代码；必须重新设计现有的批量分类后立即写入流程、凭据配置、仅保存类别的 plan、增量判断及执行日志。跨 agent 的业务代码适配量较小，这些改造不能仅靠添加 SKILL.md 完成。

| 现有实现 | 迁移方式 |
| --- | --- |
| `src/api/lists.ts` | 复用查询和 mutation 知识，迁入 gh adapter；完整保留 ID 和归属集合 |
| `src/api/repos.ts`、`src/api/readme.ts` | 保留读取职责，统一经 gh 请求；完善稳定 ID、README 来源和错误状态 |
| `src/api/client.ts` | 用 gh 子进程运输替代直接 token/fetch client |
| `src/services/classifier.ts` | 分类交给宿主；写入、批处理、恢复分别进入 core/adapter |
| `src/services/gemini.ts` | 退役，并移除 OpenAI SDK 和 LLM 配置 |
| `src/prompts/*` | 有用的分类指导迁入 skill，去除硬编码偏好 |
| `src/utils/plan-storage.ts` | 用有版本、账号隔离的快照/计划/运行存储替代 |
| `src/utils/rate-limiter.ts` | 复用并发与等待基础，重试按错误和操作语义重写 |
| `src/commands/*`、`src/index.ts` | 复用 Commander 基础，替换成稳定的读取、预览、执行入口 |

## 3. 跨 agent 的兼容边界

Agent Skills 标准统一 `SKILL.md` 和资源组织；它不统一全部提问工具、安装入口或执行权限。[Agent Skills 规范](https://agentskills.io/specification)

| 层面 | 共用的内容 | 处理差异的方式 |
| --- | --- | --- |
| 分类逻辑 | 一份 SKILL.md 和分类参考 | 不按模型复制 prompt |
| 机器交互 | 同一组 CLI 命令、schema、错误码 | 不实现 Codex/Claude/Cursor 业务 adapter |
| 提问 | 语义化说明何时询问、需要确定什么 | 宿主提问工具可用时使用；否则文本询问并等待实际回答 |
| 安装/发现 | 一个版本的 skill 内容 | 根 README 提供各宿主安装方法；必要时增加轻量发布清单 |
| Shell/路径 | 文件参数、JSON 输入输出 | CLI 内部使用 Node API；示例避免依赖 Bash 管道和命令替换 |
| 权限/网络 | 统一 doctor 诊断 | 沿用宿主执行权限；缺少能力时返回具体错误 |
| 上下文大小 | 持久化计划、按批读取详情 | 不要求一次将所有 README 放进上下文 |

使用通用 frontmatter：`name`、`description`，以及有需要时的 `compatibility`、字符串型 `metadata`。不依赖某一家专有的动态命令展开、hook、变量替换、固定提问工具名或自动子 agent。不要把 `allowed-tools` 当作所有宿主都执行的权限机制。

当前官方发现位置的例子：Codex 的 `.agents/skills`、Claude Code 的 `.claude/skills`；Cursor 也有自己的发现和分发入口。源目录 `skills/startidy` 是仓库中的发布源，不能假设所有宿主都会扫描它。[Codex](https://learn.chatgpt.com/docs/build-skills)、[Claude Code](https://code.claude.com/docs/en/skills)、[Cursor](https://prod.cursor.com/help/customization/skills)

语言理解差异可能影响分类质量，因此还要用相同样例在首发宿主中验证结果；不要求不同模型产生完全相同的类别。

## 4. 分层与依赖方向

```text
用户 ⇄ Skill / 宿主 Agent
            │ 读取数据、讨论规则、生成 plan.json
            ▼
        startidy CLI
            │ 解析参数、调用 core、输出 JSON
            ▼
           core
            │ 标准化、候选判断、校验、diff、执行调度
            ▼ 通过 ports 接口
    github-gh       file-store
        │                │
      gh api        快照、偏好、缓存、运行记录
        │
      GitHub
```

```text
src/
├── core/
│   ├── ports.ts           # GitHubPort / StorePort 及窄接口
│   ├── snapshot.ts        # 标准化快照与读取完整性
│   ├── candidates.ts      # 初始化、增量和待处理判断
│   ├── plan.ts            # schema 校验、引用和语义校验
│   ├── diff.ts            # 纯函数，输出稳定的变更集
│   ├── policy.ts          # 处理范围和允许的变更
│   ├── executor.ts        # 操作依赖、远端核对、恢复调度
│   └── errors.ts          # 领域错误码
├── adapters/
│   ├── github-gh.ts       # gh 子进程、GitHub API 与错误转换
│   └── file-store.ts      # 用户目录、账号锁、原子写入、日志
├── cli/
│   ├── doctor.ts
│   ├── snapshot.ts
│   ├── details.ts
│   ├── preview.ts
│   ├── apply.ts
│   ├── status.ts
│   └── output.ts          # stdout/stderr、JSON、退出码
├── schemas/
│   ├── snapshot.schema.json
│   ├── plan.schema.json
│   └── review.schema.json
├── generated/             # 生成的契约类型，不手工编辑
└── index.ts               # 组装 adapter、core 和命令
skills/
└── startidy/
    ├── SKILL.md
    └── references/
        ├── classification.md
        ├── commands.md
        ├── plan-format.md
        └── plan.schema.json  # 发布时复制生成，来自 src/schemas
tests/
├── core/
├── adapters/
├── cli/
└── fixtures/
docs/
└── architecture-v2.md
```

文件在对应能力实施时创建，不提前建立空目录或空文件。首发保持一个 npm 包和一个仓库。

- core 不导入 Commander、文件系统、子进程或宿主 SDK。纯函数接收数据，执行器接收 ports。
- GitHubPort 暴露 `getViewer`、`readSnapshot`、`readReadme`、`createList`、`updateList`、`deleteList`、`setMemberships` 等领域能力。不要把任意 shell/GraphQL 执行作为公开计划操作。
- StorePort 提供账号状态、不可变快照、运行日志和锁；时间、等待和重试依赖可以注入测试。
- `index.ts` 完成依赖组装即可，不引入依赖注入容器或插件框架。
- skill 是行为入口；CLI 即使没有 skill 也能导出数据、预览和执行人工编写的有效计划。

## 5. 三阶段的具体工作流

### 5.1 读取

1. `doctor` 检查 CLI/schema 版本、Node、gh、网络、当前身份及 Lists 读取能力。
2. `snapshot` 分页读取 Stars、所有可见的本人 Lists、完整归属；合并本地偏好与处理历史，输出候选集。
3. agent 先读取名称、描述、语言等元数据，再通过 `details` 分批补足 README。首次全面分析仍可以按需读取详情，不把全量 README 同时塞进上下文。

### 5.2 规划和确认

1. 首次先说明观察到的现有分类，再提出分类框架、命名、多分类与新 List 可见性建议；用户可以文本纠正。
2. 后续使用保存的偏好，只询问新歧义、分类扩充或用户主动提出的调整。
3. agent 分批生成同一份计划的 decisions，可把中间草稿保存在本次工作目录；续接会话时读取这些草稿。对所有本次候选给出归类、保留、暂缓或忽略的明确结果。
4. `preview` 校验并生成完整的 `review.json`。agent 展示账号、范围、类别变化、仓库归属变化和待定项；大量仓库可展示汇总、代表项及完整文件。
5. 用户的确认对应这份具体预览。修改方案后重新生成预览；对于没有改变的已确认方案，恢复执行不重复询问。

提问工具异步返回时，发出问题不代表已经得到回答。没有提问工具时可直接文字提问，等待用户回复后继续依赖该回答的工作。

### 5.3 执行

1. `apply --review review.json` 读取已经预览的完整计划，不再调用模型。
2. 核对账号、版本、文件完整性、本地状态版本和相关远端状态。
3. 创建必要的 Lists，更新选定元数据，再写入仓库归属；删除操作仅处理明确列出的对象，且在依赖的迁移验证完成后执行。
4. 对已完成的操作读回核对，记录部分成功；输出成功、失败、暂缓和恢复入口。

## 6. CLI 公共契约

以下是拟定命令，尚未实现：

```text
startidy doctor --json
startidy snapshot --out snapshot.json --json
startidy details --snapshot snapshot.json --candidates --offset 0 --limit 20 --out details.json --json
startidy preview --snapshot snapshot.json --plan plan.json --out review.json --json
startidy apply --review review.json --json
startidy status --run RUN_ID --json
startidy apply --resume RUN_ID --json
```

`details` 也支持 `--repo-id ID`（可重复）选择明确仓库；需要全量或局部重组时由 agent 选择相应 ID，而非只读取默认候选。`--candidates` 与显式 ID 二选一。

| 命令 | GitHub 行为 | 本地行为 |
| --- | --- | --- |
| doctor | 身份和能力只读检查 | 不改认证，不切换账号 |
| snapshot | 读取完整状态 | 保存快照；观察到仓库不代表已经处理 |
| details | 读取仓库 README | 更新缓存，逐项报告缺失或错误 |
| preview | 只读刷新受影响对象 | 保存规范化计划与变更预览 |
| apply | 执行预览中的 GitHub 写入 | 日志、检查点、偏好与处理状态 |
| status | 默认只读本地记录 | 返回进度、剩余项和是否可恢复 |

共同规则：

- `--json` 下 stdout 仅输出一个 JSON envelope；进度和诊断进入 stderr。关闭动画、颜色、升级提示和交互输入。
- 成功和失败均带 `schemaVersion`、`command`、`ok`；成功有 `data`，失败有 `error.code`、`message`、`details`、`retryable`，必要时包含 `runId`。
- `--out` 指定文件保存完整业务对象；stdout 返回计数、文件位置和摘要。没有 `--out` 时，读取命令可在 `data` 中返回完整对象。
- 读取 JSON 文件、需要时支持 `--plan -` 从 stdin 读取。避免让 agent 构造带复杂转义的大段 shell 参数。
- `preview` 表达预览；`apply` 明确表达执行。CLI 不嵌套第二套问答 UI，也不使用原有 `run` 的自动删建行为。
- 提供 `--state-dir` 和对应 `STARTIDY_STATE_DIR` 环境变量，便于自定义持久化与测试；所有操作仍按真实账号隔离。
- 不支持无界的任意 URL/命令作为计划内容；仓库和 List 引用必须来自快照或本计划新建项。

拟定退出码：`0` 成功/无变更，`2` 参数或计划无效，`3` 依赖/认证/权限不足，`4` 状态冲突，`5` 网络或限流重试耗尽，`6` 部分执行或需核对后恢复，`1` 非预期内部错误。细分原因看稳定的 `error.code`；禁止仅凭一条 gh 文本错误就把网络失败等同于 token 失效。

## 7. 数据契约

### 7.1 schema 与版本

`src/schemas` 是公开 JSON 契约的唯一手工来源，使用 JSON Schema 2020-12。由它生成 TS 类型和发布给 skill 的 schema。构建检查生成物是否一致。领域内部类型可手工维护，但不再手写第二套外部输入类型。

CLI 版本、数据 `schemaVersion`、skill 所需契约主版本分别表达；不要求 CLI 的每次补丁更新都改计划格式。遇到未知主版本拒绝写入，返回升级提示。顶层未知操作或拼错字段校验失败，预留结构化 `metadata` 供无行为含义的扩展。

### 7.2 Snapshot

快照至少包含：

- `schemaVersion`、`snapshotId`、`capturedAt`、`account: {hostname, viewerId, login}`。
- `coverage: {starsComplete, listsComplete, membershipsComplete}`，以及读取错误信息。
- `repositories`：稳定 repo node ID、owner/name、描述、语言、当前是否 starred；List 中未再 starred 的仓库也纳入引用集合。
- `lists`：稳定 List ID、名称、描述、可见性、成员 repo IDs；保留尚不支持的成员类型信息，不悄悄丢弃。
- `stateRevision`、用户偏好、处理状态摘要、`candidates` 及候选原因，以及未完成运行的恢复入口。

README 正文存放在 details 文件/缓存中，避免膨胀基本快照。login 与 owner/name 用于展示；身份和关系匹配使用稳定 ID。

分页未完成或权限导致读取不完整，不能解释为零 Stars、零 Lists 或成员已被移除。`preview/apply` 必须拒绝缺少相关完整性保证的计划。

### 7.3 Plan：显式变更意图

计划描述本次要做的事情，未提及的仓库、Lists、字段和归属保持不变。避免把 agent 生成的一个不完整数组理解为用户希望覆盖整个账号。

下面是一个仅新增归属的示例；ID 为说明用途，不是真实账号数据：

```json
{
  "schemaVersion": "1.0",
  "account": { "hostname": "github.com", "viewerId": "U_example" },
  "baseSnapshotId": "snap_example",
  "mode": "incremental",
  "scope": { "repoIds": ["R_example"], "listIds": [] },
  "lists": {
    "create": [
      {
        "key": "agent-tools",
        "name": "AI: Agents",
        "description": "Tools for building and using agents",
        "isPrivate": true
      }
    ],
    "update": [],
    "delete": []
  },
  "decisions": [
    {
      "repoId": "R_example",
      "outcome": "assign",
      "addTo": [{ "newListKey": "agent-tools" }],
      "removeFrom": [],
      "reason": "Fits the proposed agent tooling category"
    }
  ]
}
```

约定：

- `mode` 为 `bootstrap | incremental | targeted | full`。模式描述本次范围和策略，不由 agent 在没有用户意图依据时随意升级。
- `scope.repoIds` 是本次做分类决策的明确集合；`scope.listIds` 是可修改/删除元数据的现有 Lists 集合。把仓库放进一个已有 List 不要求允许修改该 List 元数据。
- 已有 List 引用为 `{listId: ...}`，新建 List 引用为 `{newListKey: ...}`；二选一，不使用名字作为关系键。
- `lists.update` 使用 `{listId, changes, reason}`，只改变明确提供的字段；`lists.delete` 使用 `{listId, reason}`，从不根据缺席推断删除。
- `assign` 使用 `addTo/removeFrom`；`keep` 保留现状；`defer` 保留远端状态并留下待处理记录；`ignore` 是用户明确要求跳过的持久偏好。不同 outcome 使用区分开的 schema 分支。
- `keep/defer/ignore` 不允许携带归属修改。分类证据不足时可以 defer，不回退到第一个类别或伪造结果。
- scope 内每个 repo 必须恰好有一个 decision；全量模式也必须列出明确 scope。分批草稿可不完整，正式 preview 会校验覆盖性。
- 同一个目标不能同时新增和移除；不能向已删除 List 添加成员；新建 key 必须唯一，引用必须可解析。
- 可选 `preferencesUpdate` 保存用户已确定的命名语言、分类规则、多分类偏好及新 List 可见性。snapshot 将其回传，agent 不直接修改隐藏状态文件。
- 创建项必须显式给出 `isPrivate`；现有 List 的可见性保持原样。新建可见性的选择在首次讨论中确定，示例值不是全局产品默认值。

### 7.4 Review：绑定预览和执行

`preview` 输出一个可携带的 review 文件，包含规范化 plan、相关 baseline、CLI/契约版本、账号和状态版本、稳定排序的操作清单、影响计数以及内容摘要。它足以说明“用户看到并确认的是哪一份计划”，无须依赖聊天上下文恢复执行内容。

`apply` 重新校验 review、重新计算差异，不能信任 agent 手写的操作清单。计划、范围或相关现状发生变化时返回 `PLAN_STALE` 等冲突，重新 preview。与本次操作无关的变化不应触发全量重新分类。

内容摘要用于一致性检查，不是签名或人类授权证明。人类意图由宿主对话和权限系统承接；不要设计 `approved: true` 字段并将其当作可信批准。

## 8. 增量与重组策略

### 8.1 模式

| 模式 | 进入条件 | 默认行为 |
| --- | --- | --- |
| bootstrap | 首次建立可用的分类规则与处理记录 | 全面观察、承接已有 Lists、优先补充；首次讨论明确决定的已有分类调整也须逐项列出 |
| incremental | 已有初始化记录的日常调用 | 仅处理候选，新增 List 或归属；拒绝改动已处理仓库、移除归属、改名、改变可见性或删除 List |
| targeted | 用户要求调整指定仓库或分类 | 仅允许显式 scope 中的变更；例如更名、合并或拆分一个类别 |
| full | 用户明确要求全量重新评估 | 全部当前 Stars 都进入决策范围，仍以差异写入；不会隐含删除所有 Lists |

bootstrap 的默认方案保留已有归属；要修改它们，agent 必须在首次讨论中明确提出，并在 preview 中单列。incremental 出现需要改旧分类的想法时，返回建议并等用户明确要求局部调整，不能自行改成 targeted/full。

用户要求调整某个 List 时，先完整展开它的成员构成 scope。用户要求全部 Stars 重分类，不自动授权修改 List 中已经不再 starred 的其他仓库。删除 List 的影响必须包含其全部成员；不允许因忽略这些成员而产生隐藏移除。

### 8.2 候选选择

候选判断同时使用完整远端快照、已提交的处理历史和用户偏好。原则如下：

| 观察到的情形 | 日常行为 |
| --- | --- |
| 未处理、未归类的新 Star | 分类候选 |
| 新发现但用户已经手动放进 List | 优先建议 keep 并记录已有整理，避免重复分类 |
| 上次明确 defer 或执行失败 | 待处理候选；展示上次原因 |
| 历史已处理，当前归属没有变化 | 跳过 |
| 历史已处理，但归属被用户改动或移空 | 尊重当前结果，标记外部变更，不自动补回 |
| 用户明确 ignore | 排除，直到用户要求重新纳入 |
| 用户取消 Star | 默认不修改任何 List，保留必要历史 |
| 曾处理后取消、又重新 Star | 默认保留已有处理记录；显式要求时重新分类 |
| README 改动、仓库改名或转移 | 不自动重分类；稳定 ID 用于识别同一仓库 |
| 没有可读的本地记录，但已有 Lists | 报告需初始化/恢复记录，以 GitHub 现状为基础，不解释为应全量重建 |
| 已初始化账号的 Lists 突然为空 | 当作远端变化，展示事实，不自动触发 bootstrap 或还原 |

候选记录至少有 `repoId`、`reason` 和建议处理方式。没有记录的旧仓库与真正新增的仓库可能无法可靠区分，因此称为“未处理候选”，不要仅依靠时间戳推断用户意图。

snapshot 只更新观察快照，不把候选标为已处理。用户确认后，apply 才提交 keep/ignore/defer 等本地决定，或在远端写入验证成功后提交 assign 结果。一次初始化若中断，历史仍保持可恢复；未完成部分不会因下一次扫描而消失。

如果账号有尚未对账的 partial/uncertain run，先处理原运行的恢复或明确终止。其涉及仓库不能同时作为一份新计划的普通候选，避免分类两次或重复创建。用户取消待恢复运行时保留已经成功的事实；取消不等于撤销其 GitHub 变更。

### 8.3 核心校验

`plan.ts` 校验格式、引用、账号、重复项和范围覆盖；`policy.ts` 校验模式允许哪些变化；`diff.ts` 仅计算已经通过校验的意图产生的差异。

输入缺少字段、分类数量不足或解析失败，均返回可定位错误。CLI 不推测用户意图、不自动补齐分类、不把未知类别映射到第一个 List。规则性错误应返回 JSON pointer 等字段位置，便于 agent 修正。

分类数量、命名和多分类偏好是用户策略；GitHub 真正的长度、容量和权限约束归 adapter/校验层管理。当前代码中的“32 个类别、20 个字符、英语命名”混合了产品偏好与平台假设；首发前核验实际限制，不把旧 README 当作永久 API 契约，更不要求始终凑满类别数量。

## 9. 差异计算与执行恢复

### 9.1 归属的计算方式

GitHub 的 `updateUserListsForItem` 接收该项目最终应属于的 Lists，因此通过当前集合计算：

```text
最终归属 = (当前归属 ∪ 明确新增的归属) − 明确移除的归属
```

incremental 下移除集合必须为空，且仅对该模式允许的候选增加归属。没有显式涉及的归属一律保留。[GitHub User Lists API](https://docs.github.com/en/graphql/reference/users#updateuserlistsforiteminput)

示例：某仓库已属于 A，方案只要求加入 B，执行后的集合为 A+B。不能只把 B 传入 API。合并 A 到 B 时，计划明确列出每个受影响成员的新增 B、移除 A，保留成员的其他所有 Lists。

diff 输出有限种操作：`CreateList`、`UpdateList`、`SetMemberships`、`DeleteList`，附带依赖、来源 decision 和预期前后状态。无变化时输出空操作，不发写请求。创建的逻辑 key 在执行后映射为真实 List ID，并立即持久化。

### 9.2 执行顺序

1. 获取本机账号级锁并核对身份，按账号与 review 内容摘要查找已有 run；已完成则返回原结果，部分完成则走恢复，避免把重试当成全新执行。
2. 对新 run 核对状态版本、重新读取相关对象并验证 review 前提；恢复 run 则使用包含本次已验证操作的预期状态。相关外部变化返回冲突。
3. 持久化本次计划及已确认偏好变更；偏好落盘不代表 GitHub 执行成功。
4. 先创建目标 Lists，再执行兼容依赖的元数据更新与仓库归属变更；尽可能在移动归属前完成必要结构准备。
5. 每个操作写入“准备执行”日志后发送请求，核对远端结果，再写入“已验证”日志和对应处理状态。
6. 只删除计划明确列出的、依赖迁移已验证且成员已清空的 Lists；非空删除必须先把成员移除显式展开到计划。遇到不支持的成员类型停止相关删除。
7. 最后核对影响范围，保存结果、失败项和未处理项，释放锁。

创建/更名如果受到名称或容量冲突阻碍，报告具体冲突并重新规划顺序；不能为了腾位置临时删除计划外的 Lists。需要临时改名或先删后建才能完成的特殊迁移，首发允许返回需重新规划，而非自动发明步骤。

### 9.3 操作日志和恢复

每个操作拥有稳定 op ID，状态为 `pending → in_flight → verified`，或进入 `failed / uncertain / conflict`。run 的状态为 `applying / completed / partial / needs_review`。在发出远端请求前持久化意图，崩溃恢复才能知道哪里可能已发生变更。

`apply --resume RUN_ID` 使用原 review 和日志，核对已完成步骤及剩余步骤的远端状态。预期 baseline 必须包含本 run 自己已经验证的变更，不能误将它们判为外部冲突。与本 run 无关的新变化按范围规则处理。

| 失败类别 | 行为 |
| --- | --- |
| 读取超时、暂时性 5xx | 有上限的退避重试 |
| 限流 | 读取服务端等待/重置提示，在预算内等待，超限返回可恢复错误 |
| 权限不足、schema/参数错误 | 直接给出可定位错误，不重复相同请求 |
| 设置归属的响应丢失 | 先读回；已达到目标则记成功，仍为预期旧状态才重试，其他状态报冲突 |
| 创建 List 的响应丢失 | 先查询本次创建前后的 List ID 和完整属性；仅在可唯一核对时认领，否则标记 uncertain，禁止盲重试创建 |
| 删除响应丢失 | 读回确认：确已删除可完成；权限错误/不可读取不能当作成功 |
| 一个操作失败、部分操作已成功 | 记录实际部分结果，停止依赖链并返回恢复入口 |

初版可在首个写入失败时停止后续写入，保留先前已验证结果；无需为了吞吐引入复杂的跨操作并行恢复。

GitHub 不提供这些多操作的整体事务。`clientMutationId` 只用于关联，不假设它能去重。创建后的完整备份也不能保证恢复同一个被删除 List 的 ID/URL，因此不承诺任意操作的无损自动回滚。

账号锁只协调同一状态目录中的本机进程，不阻止网页或另一台机器修改。执行前、每个归属写入前和完成后都核对相关状态，能缩小冲突窗口；API 没有适用的条件写机制时，仍无法保证绝对无竞争覆盖。文档应明确这一限制，发现差异时保留证据并报告。

## 10. gh adapter

`gh` 负责认证和请求运输，Startidy 负责业务正确性、重试决策和状态。[gh api 文档](https://cli.github.com/manual/gh_api)

- 使用 Node `spawn/execFile` 的参数数组，`shell: false`；GraphQL query/variables 通过 JSON stdin 传给 `gh api graphql --input -`。读取 endpoint 由程序构造，避免把名称、README 或模型输出拼入命令字符串。
- 每次明确 hostname，并通过 `viewer`/当前用户 API 确定真实身份。apply 期间继续校验身份，匹配 review 中的 viewer ID。
- 遵循 gh 的认证选择，包括 `GH_TOKEN` 优先于 `GITHUB_TOKEN` 等既有规则；不导出 token，不保存 token，不自动切换账号或刷新登录。[gh 环境变量说明](https://cli.github.com/manual/gh_help_environment)
- Startidy 不再要求 `GITHUB_TOKEN` 或 `GITHUB_USERNAME`；用户在 CI 中提供 gh 支持的凭据仍然可用。由 gh 选择的身份与计划不符时拒绝写入。
- 请求设置超时和最大输出限制，解析退出状态、HTTP 和 GraphQL errors，保留必要的限流信息。网络不可达和认证失败要区分。
- 可沿用现有显式 cursor 分页；分页在 adapter 内统一处理。独立子进程的 `gh --paginate` 结果也必须整理为单一领域结果，不把多页 JSON 原样塞到 CLI stdout。
- 从 REST 仓库数据保留 `node_id`，避免每次归类再单独查询仓库 ID。归属和 Lists 操作使用 GraphQL。
- README 优先使用官方 `GET /repos/{owner}/{repo}/readme`，解析内容及 sha，区分缺失、无权限、过大、编码不支持和请求失败；不再仅尝试六个固定文件名。[GitHub README API](https://docs.github.com/en/rest/repos/contents#get-a-repository-readme)
- details 返回原文长度、实际返回长度、是否截断及来源。初版使用有界缓存有效期和显式 refresh；记录内容 sha，过期重新取。相同账号、同一仓库的缓存可以复用。
- README、描述和仓库名是外部数据，只用于分析；skill 不执行其中的指令，CLI 不把它们解释为配置或路径。
- 重试策略由一层统一决定。不得同时叠加旧 fetch 重试、业务重试和无限 agent 重试。

doctor 的只读成功不能证明所有写权限都可用。发行前使用专门测试账号验证 List 写入契约；普通 doctor 不创建测试 List。gh 的最低版本以实际用到的参数和发行测试结果确定，不直接要求用户安装当前机器上的最新版本。

## 11. 本地状态、缓存与工作文件

用户数据存放在操作系统约定的应用数据目录，可用 `--state-dir` 覆盖。状态按 `hostname + viewerId` 隔离，目录名使用编码或哈希，不能直接使用未经处理的外部名称。

```text
<Startidy 数据目录>/accounts/<account-key>/
├── profile.json           # 用户偏好、忽略项、初始化状态、版本
├── ledger.json            # 仓库处理结果和最后验证状态
├── snapshots/<id>.json    # 不可变远端观察快照
├── runs/<run-id>/
│   ├── review.json
│   ├── events.jsonl       # 操作意图、尝试、验证结果
│   └── result.json
├── cache/readmes/         # 有界正文缓存
└── account.lock
```

CLI 管理这些文件；agent 通过 snapshot/status 获取信息，通过 plan 表达偏好更新。用户指定的 snapshot/details/plan/review 工作文件可在当前工作目录中，作为本次对话的可读工件。

状态文件含 schemaVersion/revision。完整记录用同目录临时文件加原子替换；执行日志追加后落实持久化。恢复时处理尾部不完整的日志记录，以已验证的远端结果对账，不能把一次本地写失败当成远端没成功。

锁原子创建，记录 run ID 和进程信息；检测到已有锁返回具体运行信息。陈旧锁只有确认没有活跃执行者后才能恢复，不依赖短 TTL 自动抢锁。

GitHub 的当前状态是远端事实，profile 是用户意图，ledger 是执行历史，三者用途不同。执行器不能用旧 ledger 强行还原当前 GitHub 状态。私有仓库 README、快照和归属只留在用户工作目录/数据目录，不进入 npm 或 skill 发布包；提供明确缓存保留策略。

已有 `.startidy-plan.json` 或 `.stardust-plan.json` 只有类别数据，不能推导已处理仓库、账号或删除权限。首发迁移仅将它们作为可选分类建议读取，在确认真实账号和当前 Lists 后建立新记录，不自动应用旧文件。

## 12. Skill 的职责与发布

### 12.1 内容边界

SKILL.md 只写触发条件、依赖、主流程、增量默认行为、问答方式及参考文件的读取时机。

- `classification.md`：如何根据用户用途提出类别、保留现有整理、多分类权衡、证据不足时 defer。旧 prompt 中的领域示例可复用，但不保留固定数量、强制英文或强制填满多个类别。
- `commands.md`：可用命令、文件参数、版本和错误处理入口。
- `plan-format.md`：解释 plan 字段语义、增量/局部/全量例子，链接生成的 schema。
- 细节以 references 按需加载。分类规则只维护一份；CLI 内只保留可验证的范围和平台约束。

为公开分发，skill 原文可用简明英文，要求与用户对话时沿用用户语言。规则名称和 JSON 字段固定，用户可见的类别名称由对话决定。

### 12.2 分发形式

单一源码、同步版本发布两个工件：

1. npm CLI 包：编译后的 Node JavaScript、运行时 schema、必要资源与许可信息。
2. 通用 skill 包：SKILL.md、references、生成的 plan schema；可从 Git 仓库固定 tag 或 release 压缩包安装。

根 README 同时说明 CLI 安装、gh 登录和各宿主的 skill 安装入口。skill 描述环境要求，doctor 验证实际依赖；frontmatter 中声明依赖不等于会安装 Node 或 gh。

首发可直接复制/安装同一 skill 目录；若接入宿主插件市场，新增对应的发布 manifest 即可，不复制分类逻辑或创建多套 skill。市场上架步骤按目标市场分别完成，不能把“通用 skill 文件可读”写成“所有市场已支持一键安装”。

安装后的 skill 不能依赖 `../../dist/index.js` 等源码相对路径。首选调用已安装的 `startidy`；一次性运行文档可以提供固定版本的 npm 执行方式。一轮操作固定 CLI 版本，不在 preview 与 apply 之间自动升级。

移除当前 CLI 启动即执行的后台升级检查，或把版本检查改为显式诊断；避免污染 JSON 或在每次命令产生无关网络请求。

首发版本建议为 v2.0.0，CLI 命令和认证模型有破坏性变化。是否拥有现有 npm 包名的发布权限要在发行准备时核对；若使用新 scope，统一调整命令示例和 skill 依赖说明。保持原项目归属和许可信息。旧 `run/classify` 入口退役时明确给出迁移指引，不静默映射到会写入的新命令。

## 13. 实施顺序与验收

按依赖顺序完成，阶段内部保持可测试的小改动；本计划不要求多 agent 并行。

| 阶段 | 工作 | 完成依据 |
| --- | --- | --- |
| 1. 契约与核心 | schema、生成类型、ports、候选、policy、diff、错误结构 | fixtures 验证默认增量、不越界、遗漏不删除、稳定差异 |
| 2. 读取能力 | gh adapter、doctor、snapshot、details、文件存储 | 分页完整，身份正确，详情缺失可解释，JSON 输出干净 |
| 3. 可确认计划 | preview、review、偏好表达、用户文件输入 | 计划能独立校验，完整列出影响，相关漂移可发现 |
| 4. 执行与恢复 | apply、journal、账号锁、验证、status/resume | 重复运行无多余写入，超时不重复创建，部分成功可续跑 |
| 5. Skill 与迁移 | 通用 skill、参考文件、旧配置退役、README/CLAUDE.md 更新 | 无 LLM Key 完成宿主规划；旧行为不被误调用 |
| 6. 发布验证 | npm 打包、skill 归档、跨系统/宿主样例、迁移说明 | 从发行包安装可用，包内无用户数据，兼容范围有测试记录 |

关键验收场景：

1. 首次已有 Lists：新方案保留其 ID、成员及可见性，仅执行明确变更。
2. 再次运行无新候选：无需 LLM 分类、无 GitHub 写入；重复执行已完成 review 返回已完成结果。
3. 增量新仓库加入既有 List：其他仓库和其他归属保持不变。
4. 用户手动移除已处理仓库的所有归属：下次不会自动加回。
5. 新类别：只创建一次；创建成功但响应丢失可核对，无法唯一确认则暂停恢复。
6. 局部合并：仅操作列出的范围，保留每个成员的其他分类，不遗漏取消 Star 的成员。
7. 全量重新规划：已有目标相同时无多余写入，不默认删除 Lists。
8. 读取到一半失败：不生成“空账号”或“已删除成员”的有效快照。
9. preview 后被修改、切换账号或更换凭据身份：相关冲突阻止写入，无关变化不触发全量重做。
10. 中断发生在 API 成功与日志落盘之间：先对账再续跑，不错误重复操作。
11. 缺失/损坏状态文件、换机器：报告需恢复记录，保留远端现状。
12. 多进程使用同一账号：锁和 revision 生效；不会同时执行两个互相覆盖的计划。
13. JSON 模式在 Windows/Unix 都可解析，路径含空格、Unicode 名称不会变成 shell 代码。
14. 没有提问工具的宿主用文本完成确认；有工具的宿主等待实际回复。
15. npm/skill 发行包在没有源码 checkout、没有 Bun、没有 LLM Key 的环境中可以使用。

验证分为纯 core 测试、模拟 gh 子进程的 adapter 测试、完整打包后的 CLI 测试和各宿主行为样例。真实 GitHub 写入测试只用专门授权的测试账号，并核对测试产生的具体对象；本轮设计不执行这些写入。

## 14. 实施前的剩余决策

架构本身已可按本方案实现。下列事项在对应阶段落实，不需要先重新讨论已确定的产品方向：

- 确定发行包名、Git 仓库和可用发布权限；这些不改变 core。
- 根据实际参数、权限和 User Lists 契约测试确定最低 gh 版本及平台限制。
- 确定 schema 到 TS 的开发期生成器并固定版本；确保运行时校验与生成输出一致。
- 测试实际发布包中的 Bun 构建产物；只有发现不能满足 Node/Windows 的问题时，才调整构建工具。
- 分类语言、类别粒度、多分类以及新 List 的可见性属于使用时的用户偏好，留在首次对话和后续显式调整中。
- 第一版不承诺数据库、多设备自动同步、离线写回、无损撤销删除、所有市场一键安装或没有执行环境的纯聊天宿主。

本文建议的工程复杂度集中在数据契约、增量边界和可恢复执行。它们都服务于已经确定的三阶段流程；首发保持单包、单 skill、文件存储和少量稳定命令。
