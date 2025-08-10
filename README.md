# Certora Scraper

分析 Certora Prover 验证结果的工具集。

## 核心文件

### 1. `certora_auto.html` + `certora_auto_server.mjs`
完整的Web界面，自动获取并分析所有非verified规则的JSON内容。

**使用方法：**
```bash
# 启动服务器
node scripts/certora_auto_server.mjs

# 打开浏览器访问
certora_auto.html
```

### 2. `certora_har_to_markdown.html`
将HAR文件转换为Markdown格式的独立工具。

### 3. `scripts/get_failed_rules.mjs`
命令行工具，快速获取非verified规则列表。

```bash
node scripts/get_failed_rules.mjs "https://prover.certora.com/output/..."
```

## 安装

```bash
npm install
```

## 主要功能

- 自动分析Certora验证结果
- 提取所有非verified规则
- 生成格式化的Markdown文档
- 支持Call Trace、Variables、Global State Diff分析

## 依赖

- playwright - 用于网页自动化
- express - Web服务器
- cors - 跨域支持
- node-fetch - HTTP请求