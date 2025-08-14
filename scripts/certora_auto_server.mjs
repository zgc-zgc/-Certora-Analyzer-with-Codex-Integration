import { chromium } from 'playwright';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));  // 增加请求体大小限制到 100MB
app.use(express.urlencoded({ limit: '100mb', extended: true })); // 同样增加表单数据限制

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

        // 并发获取所有JSON文件的内容
        const fetchPromises = sortedRules.map(async (rule) => {
            try {
                console.log(`获取 ${rule.outputFile}...`);
                const response = await fetch(rule.url);
                if (response.ok) {
                    const jsonContent = await response.json();
                    return {
                        ...rule,
                        content: jsonContent
                    };
                } else {
                    return {
                        ...rule,
                        content: null,
                        error: `HTTP ${response.status}`
                    };
                }
            } catch (error) {
                console.error(`获取 ${rule.outputFile} 失败:`, error.message);
                return {
                    ...rule,
                    content: null,
                    error: error.message
                };
            }
        });

        const rulesWithContent = await Promise.all(fetchPromises);

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

// 新增 /analyze-rule 端点用于单个规则的 Codex 分析
app.post('/analyze-rule', async (req, res) => {
    const { content, type } = req.body;

    if (!content || !type) {
        return res.status(400).json({
            success: false,
            error: '缺少必需参数: content 和 type'
        });
    }

    console.log(`开始分析规则类型: ${type}, 内容长度: ${content.length}`);

    try {
        const { spawn } = await import('child_process');
        let codexCommand, promptText;

        if (type === 'VIOLATED') {
            promptText = `分析以下CVL验证失败的trace，判断是否为假阳性(false positive)。
重点关注：
1. 检查initial state是否包含矛盾的变量设置，导致不可达的状态
2. 分析调用链是否符合实际业务逻辑
3. 确认违规是真实bug还是由于不现实的初始状态

请提供简洁分析结果：

${content}`;
        } else if (type === 'SANITY_FAILED') {
            promptText = `分析以下汇总的CVL sanity failed规则信息，找出共同的失败原因和修复建议：

${content}`;
        }

        // 清理提示文本中的null字节
        const cleanPromptText = promptText.replace(/\0/g, '');

        codexCommand = ['codex', 'exec', cleanPromptText];

        // 分析阶段使用只读模式
        const codexProcess = spawn('codex', ['exec', '--sandbox', 'read-only', cleanPromptText], {
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
            if (error.code === 'ENOENT') {
                console.error('Codex CLI 未找到，请确保已安装');
                res.json({
                    success: false,
                    error: 'Codex CLI 未找到，请安装 Codex CLI'
                });
            } else if (error.code === 'EPIPE') {
                console.log('进程管道关闭 (EPIPE) - 这通常是正常的');
            } else {
                console.error('Codex 进程错误:', error);
                res.json({
                    success: false,
                    error: `进程错误: ${error.message}`
                });
            }
        });

        codexProcess.on('close', (code) => {
            console.log(`Codex 进程结束，退出码: ${code}`);
            if (code === 0) {
                res.json({
                    success: true,
                    analysis: output
                });
            } else {
                const errorMsg = errorOutput || `进程异常退出，码: ${code}`;
                console.error('Codex 执行错误:', errorMsg);
                res.json({
                    success: false,
                    error: errorMsg
                });
            }
        });

    } catch (error) {
        console.error('分析错误:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
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
        const combinedAnalysis = analyses.join('\n\n---\n\n');

        // 分离和格式化分析结果
        const formattedAnalyses = analyses.map((analysis, index) => {
            return `╔═══════════════════════════════════════════════════════════════════════════════════╗
║                                   分析结论 ${index + 1}                                    ║
╚═══════════════════════════════════════════════════════════════════════════════════╝

${analysis}

╔═══════════════════════════════════════════════════════════════════════════════════╗
║                                 分析结论 ${index + 1} 结束                                ║
╚═══════════════════════════════════════════════════════════════════════════════════╝`;
        });

        const promptText = `# CVL 验证失败修复任务

## 任务概述
根据以下 ${analyses.length} 个分析结论，依次修复发现的问题。每个结论都已用符号框明确标识和分离。

## 分析结论
${formattedAnalyses.join('\n\n')}

## 修复执行步骤

### 步骤1：逐一分析结论
- 仔细阅读上述 ${analyses.length} 个结论
- 识别每个结论中提到的具体问题

### 步骤2：制定修复计划
- 列出需要修复的具体问题清单
- 确定修复的优先级和顺序
- 识别涉及的文件和代码位置

### 步骤3：执行修复
- 根据分析结论依次修复问题：
  - 修正 CVL 规范中的逻辑错误
  - 调整矛盾的初始条件或假设
  - 完善规范覆盖度和边界条件处理

CRITICAL:尽量使用invariant来强化,消除初始状态的矛盾状态.非必要不使用require、assume等,这会掩盖一些场景.
CRITICAL:尽量使用invariant来强化,消除初始状态的矛盾状态.非必要不使用require、assume等,这会掩盖一些场景.
CRITICAL:尽量使用invariant来强化,消除初始状态的矛盾状态.非必要不使用require、assume等,这会掩盖一些场景.

### 步骤4：语法检查与迭代修复
- 修复完成后，立即运行 \`certoraRun {.conf}\` 命令检查spec语法
- 如发现语法错误，自动修复语法问题
- 重复运行 \`certoraRun {.conf}\` 直到无语法错误
- 确保所有修改的spec文件语法正确

### 步骤5：最终验证
- 运行完整的 \`certoraRun {.conf}\` 验证
- 监控验证进度，等待完成,CERTORA CLI会提供完整的URL
- **重要：如果验证成功提交，必须提供验证结果的URL**

## 执行要求
1. **结构化输出**：对每个修复步骤提供清晰的说明
2. **代码展示**：显示修改前后的代码对比
3. **错误处理**：如遇到错误，说明具体原因和解决方案
4. **URL反馈**：验证完成后，必须提供Certora验证结果URL
5. **持续修复**：如果仍有验证失败，分析原因并继续修复

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
    const { prompt } = req.body;

    if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({
            success: false,
            error: '缺少修复 prompt'
        });
    }

    console.log(`开始流式批量修复，prompt 长度: ${prompt.length}`);

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

        sendProgress('开始执行修复...', 'info');

        // 修复阶段使用full-auto模式（允许写文件和执行命令）
        const codexProcess = spawn('codex', ['exec', '--full-auto', cleanPromptText], {
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

        // 修复阶段使用full-auto模式（允许写文件和执行命令）
        const codexProcess = spawn('codex', ['exec', '--full-auto', cleanPromptText], {
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