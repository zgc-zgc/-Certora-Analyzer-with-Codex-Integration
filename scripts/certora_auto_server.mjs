import { chromium } from 'playwright';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));  // 增加请求体大小限制到 100MB
app.use(express.urlencoded({ limit: '100mb', extended: true })); // 同样增加表单数据限制

// 处理 Codex 输出，只保留最终回答
function extractCodexAnswer(fullOutput) {
    // 从最后一个 tokens used: 回溯，找到最近一个非空候选块
    const lines = fullOutput.split('\n');
    const tokenIdxs = [];
    for (let i = 0; i < lines.length; i++) {
        if (/tokens used:/i.test(lines[i])) tokenIdxs.push(i);
    }

    const isMetaLine = (l) => (
        /^\[[\d\-T:\.Z]+\]/.test(l) ||
        /\] (exec|bash -lc|codex|thinking)\b/i.test(l) ||
        /workdir:|model:|provider:|approval:|sandbox:|reasoning/i.test(l) ||
        /OpenAI Codex/i.test(l)
    );

    for (let k = tokenIdxs.length - 1; k >= 0; k--) {
        const t = tokenIdxs[k];
        // 找到 t 之前最近的时间戳行
        let s = -1;
        for (let i = t - 1; i >= 0; i--) {
            if (/^\[[\d\-T:\.Z]+\]/.test(lines[i])) { s = i; break; }
        }
        const slice = lines.slice(s + 1, t);
        const filtered = slice.filter(l => !isMetaLine(l)).join('\n').trim();
        if (filtered) return filtered;
    }

    // 尝试从 "Final answer:" 标记提取
    const finalIdx = lines.findIndex(l => /^(Final answer|最终答案)\s*:/i.test(l));
    if (finalIdx !== -1) {
        return lines.slice(finalIdx + 1).join('\n').trim();
    }

    // 回退：从最后一个 "User instructions:" 之后开始，过滤明显的系统行
    let userInstrIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].includes('User instructions:')) { userInstrIdx = i; break; }
    }
    let candidate = (userInstrIdx >= 0 ? lines.slice(userInstrIdx + 1) : lines)
        .filter(l => !isMetaLine(l) && !/tokens used:/i.test(l))
        .join('\n').trim();
    return candidate || fullOutput;
}

// 过滤 Codex 输出，移除prompt回显和系统信息
function filterCodexOutput(output) {
    const lines = output.split('\n');
    const filteredLines = [];
    let inSystemInfo = true;
    let inPromptSection = false;

    for (const line of lines) {
        // 系统信息阶段 - 保留到 "User instructions:" 之前的所有内容
        if (inSystemInfo) {
            if (line.includes('User instructions:')) {
                inSystemInfo = false;
                inPromptSection = true;
                continue; // 跳过 "User instructions:" 这一行
            }
            // 保留系统信息
            filteredLines.push(line);
            continue;
        }

        // 检测prompt结束，开始实际分析
        if (inPromptSection) {
            // 检测prompt结束（通常是开始实际分析的地方）
            if (line.match(/^(根据|基于|分析|这个|我来|让我|首先|## |### |\*\*|# )/)) {
                inPromptSection = false;
                filteredLines.push(line); // 包含这行分析开始的内容
            }
            // 在prompt阶段，跳过所有内容
            continue;
        }

        // 跳过其他系统信息行（如tokens used等）
        if (line.includes('[') && line.includes(']') &&
            (line.includes('codex') || line.includes('tokens used'))) {
            continue;
        }

        // 保留实际的分析内容
        filteredLines.push(line);
    }

    return filteredLines.join('\n');
}

function parseRunInfo(urlStr) {
    const u = new URL(urlStr);
    const parts = u.pathname.split('/').filter(Boolean);
    let runId, outputId;
    for (let i = 0; i < parts.length; i++) {
        if (parts[i] === 'output' && parts[i - 1] !== 'outputs') {
            runId = parts[i + 1];
            outputId = parts[i + 2];
            break;
        }
    }
    const anonymousKey = u.searchParams.get('anonymousKey') || '';
    return { origin: `${u.protocol}//${u.host}`, runId, outputId, anonymousKey };
}

function parseMaybeJson(val) {
    if (typeof val === 'string') {
        try { return JSON.parse(val); } catch { return val; }
    }
    return val;
}

function getProgressRoots(progressJson) {
    const roots = [];
    if (!progressJson) return roots;
    const pj = parseMaybeJson(progressJson);
    if (pj && pj.verificationProgress != null) {
        const vp = parseMaybeJson(pj.verificationProgress);
        if (vp) {
            if (vp.rules) return Array.isArray(vp.rules) ? vp.rules : [vp.rules];
            if (Array.isArray(vp)) return vp;
            if (vp.children) return Array.isArray(vp.children) ? vp.children : [vp.children];
        }
    }
    if (pj && pj.rules) return Array.isArray(pj.rules) ? pj.rules : [pj.rules];
    if (Array.isArray(pj)) return pj;
    if (pj && pj.children) return Array.isArray(pj.children) ? pj.children : [pj.children];
    return roots;
}

function collectFailedRuleOutputs(node, runInfo, results = [], currentPath = []) {
    if (!node) return results;

    const name = node.name || '';
    const status = (node.status || '').toUpperCase();
    const output = Array.isArray(node.output) ? node.output : [];
    const children = Array.isArray(node.children) ? node.children : [];
    const nextPath = currentPath.concat(name);

    if (status && status !== 'VERIFIED' && output.length > 0) {
        for (const outputFile of output) {
            if (typeof outputFile === 'string' && /^rule_output_\d+\.json$/.test(outputFile)) {
                const baseUrl = `${runInfo.origin}/result/${runInfo.runId}/${runInfo.outputId}`;
                const params = new URLSearchParams();
                if (runInfo.anonymousKey) {
                    params.append('anonymousKey', runInfo.anonymousKey);
                }
                params.append('output', outputFile);
                const fullUrl = `${baseUrl}?${params.toString()}`;

                results.push({
                    ruleName: nextPath.join(' > '),
                    status: status,
                    outputFile: outputFile,
                    url: fullUrl
                });
            }
        }
    }

    for (const child of children) {
        collectFailedRuleOutputs(child, runInfo, results, nextPath);
    }

    return results;
}

// 主要端点：分析URL并返回所有JSON内容（支持实时进度）
app.post('/analyze-and-fetch-stream', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: '请提供URL' });
    }

    // 设置SSE响应头
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control'
    });

    const sendProgress = (message, type = 'info') => {
        res.write(`data: ${JSON.stringify({ type, message })}\n\n`);
    };

    try {
        sendProgress(`分析URL: ${url}`);
        console.log('分析URL:', url);
        const runInfo = parseRunInfo(url);

        const browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        });
        const page = await context.newPage();

        let progressData = null;

        sendProgress('访问页面...');

        page.on('response', async (response) => {
            try {
                const resUrl = response.url();
                const status = response.status();

                if (resUrl.includes('progress') && status === 200) {
                    const text = await response.text();
                    if (text && text.trim() !== '') {
                        try {
                            progressData = JSON.parse(text);
                            sendProgress('找到progress数据');
                        } catch (parseError) {
                            console.log('Progress响应解析失败:', parseError.message);
                        }
                    }
                }
            } catch (responseError) {
                console.log('响应处理错误:', responseError.message);
            }
        });

        await page.goto(url, { waitUntil: 'networkidle' });
        await page.waitForTimeout(3000);

        if (!progressData) {
            sendProgress('未找到progress数据', 'error');
            res.write(`data: ${JSON.stringify({ type: 'error', message: '未找到progress数据' })}\n\n`);
            res.end();
            await browser.close();
            return;
        }

        const failedRules = collectFailedRuleOutputs(progressData, runInfo, [], '');
        sendProgress(`找到 ${failedRules.length} 个非verified规则，正在获取JSON内容...`);

        const results = [];
        for (const rule of failedRules) {
            try {
                sendProgress(`获取 ${rule.outputFile}...`);
                const jsonResponse = await page.goto(rule.jsonUrl, { waitUntil: 'networkidle' });
                const jsonText = await jsonResponse.text();
                const jsonContent = JSON.parse(jsonText);

                results.push({
                    ...rule,
                    content: jsonContent
                });
            } catch (jsonError) {
                console.log(`获取${rule.outputFile}失败:`, jsonError.message);
                results.push({
                    ...rule,
                    content: null,
                    error: jsonError.message
                });
            }
        }

        await browser.close();

        const response = {
            url,
            timestamp: new Date().toISOString(),
            totalRules: failedRules.length,
            rules: results
        };

        sendProgress('分析完成！', 'success');
        res.write(`data: ${JSON.stringify({ type: 'complete', data: response })}\n\n`);
        res.end();

    } catch (error) {
        console.error('处理错误:', error);
        sendProgress(`错误: ${error.message}`, 'error');
        res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
        res.end();
    }
});

// 主要端点：分析URL并返回所有JSON内容
app.post('/analyze-and-fetch', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: '请提供URL' });
    }

    console.log('分析URL:', url);
    const runInfo = parseRunInfo(url);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    });
    const page = await context.newPage();

    let progressData = null;

    page.on('response', async (response) => {
        try {
            const resUrl = response.url();
            const status = response.status();
            if (status < 200 || status >= 300) return;

            const ct = (response.headers()['content-type'] || '').toLowerCase();
            if (ct.includes('application/json') || ct.includes('text/json')) {
                if (resUrl.includes('progress') || resUrl.includes(runInfo.outputId)) {
                    const body = await response.text();
                    try {
                        const json = JSON.parse(body);
                        if (json.verificationProgress || json.rules) {
                            progressData = json;
                            console.log('找到progress数据');
                        }
                    } catch { }
                }
            }
        } catch { }
    });

    try {
        console.log('访问页面...');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => { });
        await browser.close();

        if (!progressData) {
            return res.status(404).json({ error: '未找到验证数据' });
        }

        const roots = getProgressRoots(progressData);
        const failedRules = [];

        for (const root of roots) {
            collectFailedRuleOutputs(root, runInfo, failedRules);
        }

        // 去重
        const uniqueRules = new Map();
        for (const rule of failedRules) {
            if (!uniqueRules.has(rule.outputFile)) {
                uniqueRules.set(rule.outputFile, rule);
            }
        }

        const sortedRules = Array.from(uniqueRules.values()).sort((a, b) => {
            const numA = parseInt(a.outputFile.match(/\d+/)?.[0] || '0');
            const numB = parseInt(b.outputFile.match(/\d+/)?.[0] || '0');
            return numA - numB;
        });

        console.log(`找到 ${sortedRules.length} 个非verified规则，正在并发获取JSON内容...`);

        // 带重试的获取函数：直至成功
        const fetchJsonWithRetry = async (rule, delayMs = 2000) => {
            let attempt = 0;
            // 无限重试直到成功
            // 注意：为防止过快重试，增加固定等待
            while (true) {
                attempt++;
                try {
                    console.log(`获取 ${rule.outputFile} (尝试 ${attempt})...`);
                    const response = await fetch(rule.url);
                    if (!response.ok) {
                        console.warn(`HTTP ${response.status} 获取 ${rule.outputFile} 失败，重试中...`);
                    } else {
                        const jsonContent = await response.json();
                        // 简单校验
                        if (jsonContent && typeof jsonContent === 'object') {
                            return { ...rule, content: jsonContent };
                        }
                        console.warn(`解析 ${rule.outputFile} JSON 失败，重试中...`);
                    }
                } catch (e) {
                    console.warn(`获取 ${rule.outputFile} 出错: ${e.message}，重试中...`);
                }
                // 等待后重试
                await new Promise(r => setTimeout(r, delayMs));
            }
        };

        // 并发获取所有JSON文件的内容（每个都有自身的无限重试）
        const rulesWithContent = await Promise.all(sortedRules.map(rule => fetchJsonWithRetry(rule)));

        // 返回完整结果
        res.json({
            url: url,
            runInfo: runInfo,
            timestamp: new Date().toISOString(),
            totalRules: rulesWithContent.length,
            rules: rulesWithContent
        });

    } catch (error) {
        console.error('分析错误:', error);
        await browser.close();
        res.status(500).json({ error: error.message });
    }
});

// 新增 /analyze-rule-stream 端点用于单个规则的流式 Codex 分析
app.post('/analyze-rule-stream', async (req, res) => {
    const { content, type, projectPath } = req.body;

    if (!content || !type) {
        return res.status(400).json({
            success: false,
            error: '缺少必需参数: content 和 type'
        });
    }

    console.log(`开始流式分析规则类型: ${type}, 内容长度: ${content.length}`);

    // 设置SSE响应头
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control'
    });

    const sendProgress = (message, type = 'output') => {
        res.write(`data: ${JSON.stringify({ type, message })}\n\n`);
    };

    try {
        const { spawn } = await import('child_process');
        let promptText;

        if (type === 'VIOLATED') {
            promptText = `分析以下CVL验证失败的trace，判断是否为假阳性(false positive)。
重点关注：
1. 检查initial state是否包含矛盾的变量设置，导致相互矛盾的状态
2. 分析调用链是否符合实际业务逻辑
3. 确认违规是真实bug还是由于相互矛盾的初始状态

请提供简洁分析结果：

${content}`;
        } else if (type === 'SANITY_FAILED') {
            promptText = `分析以下汇总的CVL sanity failed规则信息，找出失败原因和修复建议：

${content}`;
        }

        // 清理提示文本中的null字节
        const cleanPromptText = promptText.replace(/\0/g, '');

        sendProgress('开始分析...', 'info');
        if (projectPath && projectPath.trim()) {
            sendProgress(`设置工作目录: ${projectPath.trim()}`, 'info');
        }

        // 分析阶段使用只读模式 + 高级推理 + 详细推理总结
        const codexArgs = [
            'exec',
            '--sandbox', 'read-only',
            '-c', 'model_reasoning_effort=high',
            '-c', 'model_reasoning_summary=detailed'
        ];
        if (projectPath && projectPath.trim()) {
            codexArgs.push('-C', projectPath.trim());
        }
        codexArgs.push(cleanPromptText);

        const codexProcess = spawn('codex', codexArgs, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env }
        });

        let fullOutput = '';
        let hasError = false;
        // 缓冲并在检测到 "User instructions:" 时一次性输出其之前的系统信息区块
        let preambleBuffer = '';
        let seenUserInstructions = false;
        let emittedSystemHeader = false;
        // 不再流式输出助理内容：仅输出系统头，其余等待最终结果
        let headerEmitted = false;

        codexProcess.stdout.on('data', (data) => {
            const chunk = data.toString();
            fullOutput += chunk;

            // 1) 系统头：缓冲直到出现 User instructions
            if (!seenUserInstructions) {
                preambleBuffer += chunk;
                const idx = preambleBuffer.indexOf('User instructions:');
                if (idx !== -1 && !emittedSystemHeader) {
                    // 截断到包含 "User instructions:" 的整行之前（不包含该行的时间戳等）
                    const lineStart = preambleBuffer.lastIndexOf('\n', idx);
                    const cutoff = lineStart >= 0 ? lineStart : idx;
                    const before = preambleBuffer.slice(0, cutoff).trimEnd();
                    if (before) {
                        sendProgress(before, 'output');
                    }
                    emittedSystemHeader = true;
                    seenUserInstructions = true;
                }
                return;
            }

            // 2) 已过 User instructions: 不再发送任何流式输出，等待进程结束后发送 final
            headerEmitted = true;
        });

        codexProcess.stderr.on('data', (data) => {
            const errorOutput = data.toString();
            sendProgress(errorOutput, 'error');
        });

        codexProcess.on('error', (error) => {
            hasError = true;
            if (error.code === 'ENOENT') {
                console.error('Codex CLI 未找到，请确保已安装');
                sendProgress('Codex CLI 未找到，请安装 Codex CLI', 'error');
            } else if (error.code === 'EPIPE') {
                console.log('进程管道关闭 (EPIPE) - 这通常是正常的');
            } else {
                console.error('Codex 进程错误:', error);
                sendProgress(`进程错误: ${error.message}`, 'error');
            }
        });

        codexProcess.on('close', (code) => {
            console.log(`Codex 进程结束，退出码: ${code}`);
            if (code === 0 && !hasError) {
                // 提取最终分析结果，仅在结束时输出
                const finalResult = extractCodexAnswer(fullOutput);
                sendProgress(finalResult, 'final');
                sendProgress('分析完成', 'success');
            } else {
                const errorMsg = `进程异常退出，码: ${code}`;
                console.error('Codex 执行错误:', errorMsg);
                sendProgress(errorMsg, 'error');
            }
            res.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
            res.end();
        });

    } catch (error) {
        console.error('分析错误:', error);
        sendProgress(`分析错误: ${error.message}`, 'error');
        res.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
        res.end();
    }
});


// 新增 /generate-fix-prompt 端点用于生成修复 prompt
app.post('/generate-fix-prompt', async (req, res) => {
    const { analyses } = req.body;

    if (!analyses || !Array.isArray(analyses) || analyses.length === 0) {
        return res.status(400).json({
            success: false,
            error: '缺少分析结果'
        });
    }

    console.log(`生成修复 prompt，共 ${analyses.length} 个分析结果`);

    try {
        // 标准化输入：支持字符串数组或对象数组 { text, ruleName }
        const items = analyses.map((a) => {
            if (a && typeof a === 'object') {
                // 兼容不同字段名
                const text = a.text ?? a.analysis ?? '';
                const ruleName = a.ruleName ?? a.name ?? a.rule ?? '';
                return { text: String(text || ''), ruleName: String(ruleName || '') };
            }
            return { text: String(a || ''), ruleName: '' };
        });

        // 分离和格式化分析结果（在结论头部加入规则名）
        const formattedAnalyses = items.map((item, index) => {
            const headerTitle = item.ruleName
                ? `分析结论 ${index + 1} · 规则：${item.ruleName}`
                : `分析结论 ${index + 1}`;
            return `╔═══════════════════════════════════════════════════════════════════════════════════╗
║ ${headerTitle}
╚═══════════════════════════════════════════════════════════════════════════════════╝

${item.text}

╔═══════════════════════════════════════════════════════════════════════════════════╗
║                                 分析结论 ${index + 1} 结束                                ║
╚═══════════════════════════════════════════════════════════════════════════════════╝`;
        });

        const promptText = `# CVL 验证失败修复任务

## 任务概述
根据以下 ${analyses.length} 个分析结论，依次修复发现的问题。每个结论都已用符号框明确标识和分离（头部包含对应规则名）。

## 分析结论
${formattedAnalyses.join('\n\n')}

## 修复执行步骤

### 步骤1：逐一分析结论
- 仔细阅读上述 ${analyses.length} 个结论
- 识别每个结论中提到的具体问题

### 步骤2：制定修复计划
- 列出需要修复的具体问题清单
- 确定修复的优先级和顺序
- 识别涉及的spec文件和cvl代码位置

### 步骤3：执行修复
- **直接修改实际的 .spec 文件/.conf文件**
- 根据分析结论依次修复问题：
  - 修正 CVL 规范中的逻辑错误
  - 调整矛盾的初始条件或假设
  - 完善规范覆盖度和边界条件处理

CRITICAL:尽量使用invariant来强化,消除初始状态的矛盾状态.非必要不使用require、assume等,这会掩盖一些场景.

### 步骤4：语法检查与迭代修复
- 修复完成后，立即运行 \`certoraRun *.conf\` 命令检查spec语法
- 如发现语法错误，自动修复语法问题
- 重复运行 \`certoraRun *.conf\` 直到无语法错误
- 确保所有修改的spec文件语法正确

### 步骤5：最终验证
- 运行完整的 \`certoraRun *.conf\` 验证
- 监控验证进度，等待完成,CERTORA CLI会提供完整的URL
- **重要：如果验证成功提交，必须提供验证结果的URL**

请开始执行修复任务，严格按照上述步骤进行：`;

        res.json({
            success: true,
            prompt: promptText
        });

    } catch (error) {
        console.error('生成 prompt 错误:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 修改后的 /fix-all-stream 端点用于流式批量修复
app.post('/fix-all-stream', async (req, res) => {
    const { prompt, projectPath } = req.body;

    if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({
            success: false,
            error: '缺少修复 prompt'
        });
    }

    console.log(`开始流式批量修复，prompt 长度: ${prompt.length}`);
    if (projectPath) {
        console.log(`指定项目路径: ${projectPath}`);
    } else {
        console.log('使用自动项目搜索');
    }

    // 设置SSE响应头
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control'
    });

    const sendProgress = (message, type = 'output') => {
        res.write(`data: ${JSON.stringify({ type, message })}\n\n`);
    };

    try {
        const { spawn } = await import('child_process');

        // 清理提示文本中的null字节
        const cleanPromptText = prompt.replace(/\0/g, '');

        // 构建 Codex 命令参数 + 高级推理 + 详细推理总结
        const codexArgs = [
            'exec',
            '--dangerously-bypass-approvals-and-sandbox',
            '-c', 'model_reasoning_effort=high',
            '-c', 'model_reasoning_summary=detailed'
        ];

        // 如果用户指定了项目路径，添加 -C 参数
        if (projectPath && projectPath.trim()) {
            codexArgs.push('-C', projectPath.trim());
            sendProgress(`设置工作目录: ${projectPath.trim()}`, 'info');
        } else {
            sendProgress('开始执行修复（使用自动项目搜索）...', 'info');
        }

        codexArgs.push(cleanPromptText);

        console.log('Codex 命令参数:', codexArgs.slice(0, -1)); // 不打印完整 prompt

        // 修复阶段使用危险模式（允许完全访问和执行命令）+ 高级推理
        const codexProcess = spawn('codex', codexArgs, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env }
        });

        let hasError = false;

        codexProcess.stdout.on('data', (data) => {
            const output = data.toString();
            sendProgress(output, 'output');

            // 检查是否包含验证URL
            const urlMatch = output.match(/https:\/\/prover\.certora\.com\/output\/[^\s]+/);
            if (urlMatch) {
                sendProgress(urlMatch[0], 'url');
            }
        });

        codexProcess.stderr.on('data', (data) => {
            const errorOutput = data.toString();
            sendProgress(errorOutput, 'error');
        });

        codexProcess.on('error', (error) => {
            hasError = true;
            if (error.code === 'EPIPE') {
                console.log('修复进程管道关闭 (EPIPE) - 这通常是正常的');
            } else {
                console.error('修复进程错误:', error);
                sendProgress(`进程错误: ${error.message}`, 'error');
            }
        });

        codexProcess.on('close', (code) => {
            console.log(`修复进程结束，退出码: ${code}`);
            if (code === 0 && !hasError) {
                sendProgress('修复任务完成', 'success');
            } else {
                sendProgress(`修复进程异常退出，退出码: ${code}`, 'error');
            }
            res.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
            res.end();
        });

    } catch (error) {
        console.error('修复错误:', error);
        sendProgress(`修复错误: ${error.message}`, 'error');
        res.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
        res.end();
    }
});

// 保留原有的 /fix-all 端点以保持兼容性
app.post('/fix-all', async (req, res) => {
    const { analyses } = req.body;

    if (!analyses || !Array.isArray(analyses) || analyses.length === 0) {
        return res.status(400).json({
            success: false,
            error: '缺少分析结果'
        });
    }

    console.log(`开始批量修复，共 ${analyses.length} 个任务`);

    try {
        const { spawn } = await import('child_process');
        const combinedAnalysis = analyses.join('\n\n---\n\n');

        const promptText = `基于以下CVL分析结果，生成修复建议和代码改进：

${combinedAnalysis}

请提供具体的修复步骤和代码建议。`;

        // 清理提示文本中的null字节
        const cleanPromptText = promptText.replace(/\0/g, '');

        // 修复阶段使用危险模式（允许完全访问和执行命令）+ 高级推理
        const codexProcess = spawn('codex', [
            'exec',
            '--dangerously-bypass-approvals-and-sandbox',
            '-c', 'model_reasoning_effort=high',
            '-c', 'model_reasoning_summary=detailed',
            cleanPromptText
        ], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env }
        });

        let output = '';
        let errorOutput = '';

        codexProcess.stdout.on('data', (data) => {
            output += data.toString();
        });

        codexProcess.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        codexProcess.on('error', (error) => {
            if (error.code === 'EPIPE') {
                console.log('修复进程管道关闭 (EPIPE) - 这通常是正常的');
            } else {
                console.error('修复进程错误:', error);
                res.json({
                    success: false,
                    error: `进程错误: ${error.message}`
                });
            }
        });

        codexProcess.on('close', (code) => {
            console.log(`修复进程结束，退出码: ${code}`);
            if (code === 0) {
                res.json({
                    success: true,
                    message: '修复建议已生成',
                    analysis: output
                });
            } else {
                const errorMsg = errorOutput || `修复进程异常退出，码: ${code}`;
                console.error('修复执行错误:', errorMsg);
                res.json({
                    success: false,
                    error: errorMsg
                });
            }
        });

    } catch (error) {
        console.error('修复错误:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

const PORT = 3002;
app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════╗
║     Certora Auto Analyzer                 ║
║     服务运行在: http://localhost:${PORT}    ║
╚════════════════════════════════════════════╝
    `);
});
