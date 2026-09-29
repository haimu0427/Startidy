<p align="right">
  <a href="README.en.md">English</a> | <strong>简体中文</strong>
</p>

# Startidy 🌟

[![npm version](https://img.shields.io/npm/v/@haimu0427/startidy.svg)](https://www.npmjs.com/package/@haimu0427/startidy)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **Contract-driven GitHub Stars organizer for AI agents and developers.**  
> 让 AI Agent 帮你自动分类、整理混乱的 GitHub Stars 到 GitHub Lists 中，安全、增量且完全受控。

---

<!-- DEMO_IMAGES_START -->
<p align="center">
  <img src="./assets/demo-1.png" alt="AI Agent Workflow" width="49%" style="border-radius: 6px; border: 1px solid #e1e4e8;" />
  <img src="./assets/demo-2.png" alt="CLI Preview and Apply" width="49%" style="border-radius: 6px; border: 1px solid #e1e4e8;" />
  <br>
  <em>(左：AI Agent 自动分析与分类规划 / 右：CLI 契约校验与三步安全执行)</em>
</p>
<!-- DEMO_IMAGES_END -->

---

## 💡 为什么需要 Startidy？

随着 Star 的仓库越来越多（几百甚至数千个），GitHub 官方的 Lists 整理起来费时费力。普通脚本要么容易误删分类，要么需要把敏感 Token 喂给第三方大模型。

**Startidy v2 采用全新的“Agent + 契约驱动”模式：**
1. **Agent 负责大脑，CLI 负责手脚**：不需要配置任何 LLM API Key，直接由你日常使用的 AI（Claude Code、Codex、Cursor、Gemini 等）做语义理解与分类规划。
2. **严格的契约保障（Contract-Driven）**：通过 JSON Schema 严格校验输入输出，杜绝 AI 幻觉引发的破坏性操作。
3. **安全三步走（Snapshot → Preview → Apply）**：每次操作前生成清晰的变更预览（Review），只有你确认后才会写入 GitHub。
4. **增量安全保护**：默认保留已有分类，支持网络中断断点续传（Resume），绝不重复创建同名 List。

---

## ⚡ 快速开始 (Quick Start)

仅需 **3 步**，即可让 AI Agent 帮你自动整理 GitHub Stars：

### 1. 安装方式

确保本机安装了 Node.js (>= 22) 和已登录的 GitHub CLI (`gh auth login`)。

#### 方式 A：通过 npm 全局安装（推荐）

```bash
npm install -g @haimu0427/startidy
# 或无需安装直接通过 npx 运行
npx @haimu0427/startidy doctor
```

#### 方式 B：从源码本地构建

```bash
# 克隆仓库
git clone https://github.com/haimu0427/Startidy.git
cd Startidy

# 安装依赖并构建
bun install
bun run build

# 链接到全局命令行 (可在任何目录使用 startidy 命令)
bun link   # 或使用 npm link
```

验证环境状态：
```bash
startidy doctor
```

### 2. 载入 Agent Skill

Startidy 在 [`skills/startidy/`](skills/startidy/) 目录下提供了符合标准的 Agent Skill，支持各种主流 AI 终端：

* **Claude Code**: 将 `skills/startidy` 软链接或复制到 `.claude/skills/startidy`
* **Codex / ChatGPT / Antigravity**: 软链接或复制到 `.agents/skills/startidy`
* **Cursor**: 在项目技能/Rules 中引入 `skills/startidy/SKILL.md`

### 3. 让 AI 对话执行！

现在，打开你的 AI 终端（如 Claude Code 或 Cursor），直接向它发指令：

> **“请帮我分析我的 GitHub Stars，并规划一份合理的分类列表帮我整理。”**

AI Agent 会根据 Skill 自动执行标准三阶段流：
1. **读取状态**：执行 `startidy snapshot` 获取当前所有 Stars 和 Lists 详情。
2. **语义规划 & 预览**：根据仓库简介自动归类，生成 `plan.json` 并调用 `startidy preview` 生成变更预览，向你展示将要创建的列表及归类方案。
3. **安全应用**：当你确认方案满意后，AI 执行 `startidy apply` 安全同步至 GitHub。

---

## 🛠️ CLI 常用指令参考

| 命令 | 用途 | 关键参数 |
| :--- | :--- | :--- |
| `startidy doctor` | 检查 Node、gh 登录态和依赖环境 | `--json` |
| `startidy snapshot` | 抓取当前所有 Stars 与 Lists 快照 | `--out <file>`, `--json` |
| `startidy details` | 批量拉取候选仓库的 README 补充信息 | `--snapshot <file>`, `--candidates`, `--limit 20` |
| `startidy preview` | 校验分类计划并生成变更预览 diff | `--snapshot <file>`, `--plan <file>`, `--out <file>` |
| `startidy apply` | 执行已经校验的变更或恢复中断任务 | `--review <file>`, `--resume <runId>` |
| `startidy status` | 查看指定运行任务的执行日志与状态 | `--run <runId>` |
| `startidy resolve` | 处理由于网络或冲突阻断的异常状态 | `--run <runId>`, `--action <adopt/retry/abort>` |

---

## 🤝 致谢 (Acknowledgements)

本项目基于并灵感源自 [@hellosunghyun](https://github.com/hellosunghyun) 的开源项目 [hellosunghyun/startidy](https://github.com/hellosunghyun/startidy)。

在此基础上，v2 版本进行了彻底的架构重构：移除了对外部 LLM API 的直接依赖，转而拥抱现代 Agent 体系，演进为一套完全由 Contract 约束、依托 Host Agent 语义理解并具备断点恢复与安全隔离机制的确定性工具链。感谢原作者为 GitHub Lists 自动化整理提供的先驱探索与启发！

---

## 📚 开发者与 Agent 指南

- [AGENTS.md](AGENTS.md)：面向 Codex、Cursor、Antigravity 等各类 AI Agent 宿主的架构契约与调试规范。
- [CLAUDE.md](CLAUDE.md)：面向 Claude Code 的开发构建与调试备忘。

---

## 📄 License

[MIT License](LICENSE) © 2024 hellosunghyun & © 2026 haimu0427
