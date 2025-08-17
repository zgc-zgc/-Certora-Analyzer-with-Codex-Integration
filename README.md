# Certora Scraper（中文指南）

用于配合 Certora Prover 的可视化分析与自动化修复工具集：抓取验证数据、生成 Markdown、触发 Codex 分析、顺序修复 CVL/Conf、自动执行 certoraRun 并闭环修复语法错误、成功后提取验证 URL。

## 功能亮点

- 可视化 UI（`certora_analyzer.html`）：一键抓取验证数据、查看 Markdown、批量/逐条 Codex 分析。
- 顺序修复闭环（程序内）：
  - 逐项使用 Codex 修复“已分析完成”的结论。
  - 自动调用 bash 运行 `certoraRun`（非 Codex 执行）。
  - 检测语法/编译错误时自动构建修复提示并再次调用 Codex，循环直至成功或手动停止。
  - 提取并展示验证 URL。
- Conf 自动发现：从填写的项目路径 `<workdir>/certora/conf` 下拉选择 `.conf`。
- 安全约束：仅修改 `.cvl` 与 `.conf` 文件，禁止改动 `src/`, `contract/`, `contracts/` 下的 `.sol`。

## 快速开始

1) 安装依赖

```bash
npm install
```

2) 启动服务（提供后端 API 与 Codex/Playwright 执行）

```bash
node scripts/certora_auto_server.mjs
```

3) 打开 UI 页面并操作

- 双击或用浏览器打开 `certora_analyzer.html`。
- 在“Solidity 项目路径（workdir）”中填写你的项目根目录（绝对路径）。
- 下方“certoraRun 配置文件”会自动从 `<workdir>/certora/conf` 加载 `.conf` 供选择，也可点击“刷新”。
- 在“输入 Certora URL”填入 Certora Prover 的结果页链接，点击“获取验证数据”。
- 对需要的规则点击“分析”或“Codex 分析所有规则”。分析结果可在页面直接编辑。
- 点击“执行顺序修复”：
  - 程序会按你编辑后的多条分析结论逐项修复。
  - 结束后自动运行 `certoraRun <所选 conf>`；若有语法/编译错误，会自动交给 Codex 修复并重试；成功后展示验证 URL。

提示：UI 顶部提供“停止”按钮，可安全中止当前 Codex 进程与 certoraRun 重试；顺序修复流程不会因浏览器 SSE 断开而意外结束。

## 使用说明（UI）

- 输入 Certora URL：粘贴 `https://prover.certora.com/output/...`。
- Solidity 项目路径（workdir）：用于后端工作目录与自动发现 Conf。
- certoraRun 配置文件：从 `<workdir>/certora/conf` 下拉选择 `.conf`；为空则跳过 certoraRun。
- 结果表：
  - Markdown：查看或复制自动生成的 Markdown（Call Trace / Variables / Global State Diff / Warnings）。
  - Codex 分析结果：
    - 支持流式分析；结束后文本框可直接编辑以微调修复建议。
    - “复制”按钮可一键复制文本。
- 执行顺序修复：
  - 仅修复“已有分析文本”的项（占位或进行中不会被纳入）。
  - 修完全部项后若选择了 `.conf`，会自动执行 certoraRun 并进行语法错误闭环修复。

## 后端 API（简要）

- POST `/analyze-and-fetch`：抓取并汇总验证数据（非流式）。
- POST `/analyze-and-fetch-stream`：抓取并实时推送进度（SSE）。
- POST `/analyze-rule-stream`：对单个规则发起 Codex 流式分析（SSE）。
- POST `/generate-fix-prompt`：根据多个分析结果生成修复提示文本。
- POST `/fix-sequential-stream`：顺序修复 + 自动 certoraRun + 语法错误闭环（SSE）。
- POST `/kill-processes`：终止所有 Codex 相关进程。
- GET `/list-conf?projectPath=<abs>`：列出 `<projectPath>/certora/conf` 下 `.conf` 文件。

## 目录与文件

- `certora_analyzer.html`：主界面，获取数据 / Codex 分析 / 顺序修复 / certoraRun 闭环。
- `scripts/certora_auto_server.mjs`：后端服务，Playwright 抓取、Codex 与 certoraRun 调度、SSE 输出、conf 自动发现。
- `scripts/certora_scrape.mjs`：抓取辅助脚本。
- `scripts/get_failed_rules.mjs`：命令行获取非 VERIFIED 规则列表。

## 约束与注意

- 强约束：只允许修改 CVL/Conf，不允许改动 Solidity 源码（`src/`, `contract/`, `contracts/`）。
- 若确需修改 Solidity（极端情况），工具会提示先说明原因而非直接改动。
- certoraRun 由程序在修复完成后调用，请勿在 Codex 中自行运行；日志中会自动显示 URL 或错误信息。

## 常见问题

- 下拉框未显示 `.conf`
  - 确保 `workdir` 正确；`<workdir>/certora/conf` 存在并包含 `.conf`；点击“刷新”。
- 只修复了一个就结束
  - 已修复此问题：顺序修复不会因 SSE 断开而结束；黑色日志框会显示“开始第 x/y、完成第 x/y、下一项”等节点。
- certoraRun 命令未找到
  - 请确认环境已正确安装 Certora CLI，并可在 `workdir` 下直接执行 `certoraRun`。

## 依赖

- Node.js（建议 v18+）
- Playwright（UI 抓取用）
- Express / CORS / node-fetch（服务与 HTTP）

## 许可

本仓库默认沿用当前项目的许可策略。若需变更，请在提交前沟通确认。
