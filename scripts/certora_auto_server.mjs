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

        console.log(`找到 ${sortedRules.length} 个非verified规则，正在获取JSON内容...`);

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
            promptText = `请先完整的阅读markdown中的工作指南:
工作指南:            
```markdown
# ** Certora形式化验证中Havoc导致的初始状态不可及问题及假阳性处理策略 **

## ** 1\.概述 **

                Certora Prover在形式化验证中，由于其默认对初始状态和外部交互的非确定性建模（通过havoc机制），可能导致假阳性（spurious counterexamples）的出现。这些假阳性源于验证工具探索了实际系统中不可达或不相关的状态和行为。本指南将深入探讨havoc机制的原理及其在Certora Prover中的应用，分析其如何导致初始状态不可达问题产生的假阳性。指南将详细阐述缓解这些问题的关键策略，包括精确约束初始状态、优化外部调用摘要以及有针对性地限定验证范围，旨在提升验证结果的准确性和效率，从而增强对智能合约安全性的信心。

## ** 2\. Certora Prover中非确定性与havoc机制简介 **

                本节将奠定Certora Prover中非确定性的基础理解，阐明havoc机制的关键作用。

### ** 2.1.havoc在形式化验证中的作用 **

                Certora Prover作为一种先进的形式化验证工具，能够将智能合约字节码和用户定义的属性转换为数学公式，并通过SMT求解器进行分析.这一过程算法性地探索系统状态空间，以验证预期的行为属性.
                    Certora验证语言（CVL）中的havoc关键字在建模不确定性和非确定性方面发挥着核心作用, 它允许变量取任意的、非确定性的值，这对于实现输入空间的全面覆盖和考虑所有可能的调用上下文至关重要。  
havoc机制的这种内在非确定性并非Certora Prover的缺陷，而是确保形式化验证 * 完备性 * 的有意设计选择。通过探索所有逻辑上可能的行为，包括那些未明确建模或约束的行为，Prover旨在避免遗漏真正的漏洞。因此，用户面临的挑战是如何将这种广泛的非确定性 * 约束 * 到仅与 * 相关 * 且 * 可达 * 的行为，以避免产生虚假的（假阳性）反例。
            havoc被描述为分配任意值并建模不确定性 ，这是“完整覆盖”的关键 。这种机制，虽然强大，但是导致“不可达初始状态”和“假阳性”的直接原因。Certora Prover旨在自动定位即使是最佳审计师也可能遗漏的关键漏洞，并且“从不犯推理错误” 。
            havoc的目的是创建系统行为的 * 过近似 *。过近似是 * 完备的 *，因为它包含了所有可能的真实行为，保证如果存在错误，Prover会发现它。然而，这种过近似也可能包含在实际系统操作上下文中 * 逻辑上可能但实际上不可能 * 的行为。当这些不可能的行为导致属性违反时，它们表现为 * 虚假反例 *（假阳性）。这种权衡是根本性的：完备性（不遗漏错误）通常伴随着假阳性的风险，如果模型不够精确的话。因此，“假阳性”并非Prover逻辑中的错误，而是表明用户对系统环境或未验证组件的 * 规范 * 过于宽松的有价值信号。解决方案不是禁用havoc，而是通过添加更精确的约束来细化其范围。

### ** 2.2.初始状态建模与未指定变量 **

                Certora非确定性的一个关键方面在于其对初始状态的建模。在验证开始时，存储状态是未指定的，并且所有变量默认都会被havoc 。这意味着Prover会考虑所有可能的变量初始值，除非在规范中明确约束 。
            这种默认的havoc行为是导致假阳性的主要原因。Prover可能会从逻辑上可能但在实际合约部署或操作上下文中明显不可能或不相关的状态生成反例 。  
“不可达初始状态”问题是Certora Prover对初始条件采取“最大非确定性”方法的直接结果。这种保守的默认设置通过考虑最广泛的起始点来确保完备性，但它要求用户明确干预，将验证范围缩小到系统的 * 有效 * 初始状态。初始状态未指定，变量默认被havoc, 如果初始状态导致反例, 也不能说明漏洞的存在, 除非证明初始状态没有被过度近似。
            havoc被明确定义为“将变量分配任意的、非确定性的值……在验证开始时，所有变量都会被havoc以模拟未知初始状态” 。这是一种“悲观”的方法。默认设置旨在实现最大覆盖和完备性，假设 * 任何 * 可能的初始状态，以确保不会因未考虑的起始点而遗漏真正的漏洞。虽然完备，但这通常会从在通用数学模型中 * 逻辑上可能 * 但在所验证的特定合约或协议的实际操作中 * 不可能 * 的状态生成反例。这突显了一个关键的差距：Prover的通用模型与特定系统的真实世界不变量和部署条件之间的差异。为了使验证结果有意义，用户必须将他们对 * 有效 * 初始状态的假设明确编码到规范中。这就是require invariant和havoc assuming等特定CVL结构对于修剪搜索空间和消除虚假反例变得不可或缺的原因。

** 摘要声明 ** 用于替换对某些合约方法的调用，特别是在外部合约的精确代码不可用时，或为了简化复杂代码以防止超时。

* ** HAVOC\_ALL **: 这是最保守的摘要类型。应用时，Prover假设被调用的函数可以对 * 任何 * 合约（包括调用合约）的存储产生任意副作用，并可以返回任意值。虽然始终完备，但它在实践中通常过于严格，因为它“抹去了Prover在调用前对合约状态的所有了解” 10。这种最大非确定性可能导致大量的假阳性。  
* ** HAVOC\_ECF **: 这种摘要类型提供了比HAVOC\_ALL更精细的近似。它假设被调用的方法 * 不可重入 *，并且可以对 * 除了 * 正在验证的合约之外的合约产生任意影响。重要的是，它假设当前（调用）合约的状态和ETH余额（除了方法调用本身转移的任何值）* 不会 * 改变 10。这提供了一个有用的中间地带，与
            HAVOC\_ALL相比减少了假阳性，同时保持了外部交互的高度非确定性。  
* ** NONDET（视图摘要）**: 这些用于视图函数，假设它们没有副作用，并且只是用一个非确定性值替换调用。它们对于视图函数是完备的 10。  
* ** 表达式摘要（Expression Summaries）**: 这些将对摘要方法的调用替换为CVL表达式，通常是CVL函数或幽灵公理的调用。它们需要一个expect子句来解释返回值 10。这允许在外部调用的行为被充分理解时，对其进行精确的、确定性建模。  
* ** AUTO摘要 **: 这些是未解析调用的默认摘要 10。  
* ** DISPATCHER摘要 **: 这些假设方法调用的接收者可以是实现该方法的任何合约。它们可能由于潜在调用目标数量众多，特别是在顺序控制流中，显著导致“路径爆炸问题” 10。用  
  AUTO摘要替换DISPATCHER摘要可以显著降低路径计数并防止超时 11。

            havoc摘要类型的选择代表了完备性、精确性和验证性能之间的关键权衡。HAVOC\_ALL保证完备性，但可能引入大量假阳性并加剧状态爆炸。更精确的摘要，如HAVOC\_ECF和NONDET，通过做出更强的假设（例如，不可重入，无副作用）提供更高的精确度，这可以显著减少假阳性并提高性能。然而，这些更精确的摘要需要仔细考虑和验证，以确保其基本假设准确反映外部代码的行为，因为不完备的假设可能导致遗漏漏洞。  
havoc摘要类型对状态和返回值有不同的影响 10。
            HAVOC\_ALL是“始终完备”的，但“过于严格”，并且“抹去了所有知识” 10。这表明了最大程度的非确定性。
            HAVOC\_ECF是一个“有用的中间地带” 10，意味着非确定性的减少。
            DISPATCHER可能导致“路径爆炸” 11，表明存在性能成本。摘要通常有助于“简化被验证的代码以避免超时” 10。过近似程序上的证明是完备的，但虚假反例可能由原始代码未展示的行为引起 7。

* ** HAVOC\_ALL（最过近似）**: 为外部调用引入最高程度的非确定性。虽然它最大化了完备性（通过不遗漏任何潜在的副作用），但这种广泛性意味着它会发现实际中不可能的场景中的反例，从而导致高比例的假阳性。更大的非确定性状态空间也会对性能产生负面影响。  
* ** HAVOC\_ECF（较少过近似）**: 通过假设不可重入和对调用合约状态的有限影响来减少非确定性。这 * 约束 * 了可能的副作用，从而减少了假阳性并提高了性能。然而，这引入了一个关于外部代码行为的 * 假设 *（不可重入，对自身合约修改有限），该假设 * 必须有效 *。如果此假设在实际系统中被违反，则证明变得 * 不完备 *。  
* ** NONDET（视图函数过近似更少）**: 假设完全没有副作用。这进一步减少了非确定性，从而减少了假阳性并提高了性能，但依赖于对外部函数纯度的更强假设。  
* ** DISPATCHER（复杂，路径计数高）**: 虽然对于建模动态调度很有用，但其固有的复杂性以及需要探索多个潜在调用目标可能导致状态爆炸和超时。这些性能问题可能间接导致“假阳性”，如果Prover未能完成验证，或者只是阻碍了有效的验证。

            因此，选择合适的摘要是CVL中的一个关键设计决策。它需要深入了解外部系统的行为，并仔细评估所需精确度（以减少假阳性）与引入不完备假设的风险之间的权衡。过度摘要（例如，在HAVOC\_ECF足够时使用HAVOC\_ALL）会导致不必要的假阳性，而摘要不足（例如，不摘要复杂的外部调用）则会导致性能瓶颈。  
** 表1：Certora Havoc摘要类型比较 **

| 摘要类型 | 描述 | 关键假设 | 对调用合约状态的影响 | 对其他合约状态的影响 | 对ETH余额的影响 | 返回值处理 | 完备性影响 | 典型用例 | 假阳性 / 性能潜力 |
| : ---- | : ---- | : ---- | : ---- | : ---- | : ---- | : ---- | : ---- | : ---- | : ---- |
| HAVOC\_ALL | 最保守的摘要，允许任意副作用。 | 无特定假设。 | 任意改变。 | 任意改变。 | 任意改变。 | 任意值。 | 始终完备。 | 外部代码未知或高度复杂。 | 高假阳性，性能差。 |
| HAVOC\_ECF | 假设不可重入，限制对调用合约的影响。 | 不可重入。 | 不改变（除显式转账）。 | 任意改变。 | 不减少（除显式转账）。 | 任意值。 | 完备（若假设成立）。 | 外部代码已知不可重入。 | 中等假阳性，性能中等。 |
| NONDET | 用于视图函数，假设无副作用。 | 无副作用。 | 无改变。 | 无改变。 | 无改变。 | 非确定性值。 | 完备（若视图函数纯净）。 | 外部视图函数。 | 低假阳性，性能好。 |
| AUTO | 未解析调用的默认摘要。 | Prover自动推断。 | 依赖于推断。 | 依赖于推断。 | 依赖于推断。 | 依赖于推断。 | 依赖于推断的准确性。 | 默认行为，或作为DISPATCHER替代。 | 假阳性 / 性能可变。 |
| DISPATCHER | 接收者可以是实现该方法的任何合约。 | 动态调度。 | 依赖于实际调用。 | 依赖于实际调用。 | 依赖于实际调用。 | 依赖于实际调用。 | 完备（若所有目标都被探索）。 | 接口调用，多态性。 | 高路径计数，易超时。 |
| 表达式摘要 | 将调用替换为CVL表达式（函数 / 幽灵公理）。 | 外部行为可精确建模。 | 由表达式定义。 | 由表达式定义。 | 由表达式定义。 | 由表达式定义。 | 完备（若表达式准确）。 | 外部行为已知且确定。 | 低假阳性，性能好。 |

### ** 2.3.形式化验证中不可达状态的构成

            在形式化验证的语境中，不可达状态指的是一种系统配置，尽管在给定数据类型和变量范围的情况下在数学上是可能的，但无法通过从合法、实际的初始状态开始的任何有效操作序列或输入来达到 。这些状态是“既非有效也非无效，但设计永远不会达到的状态” 。

            将不可达状态与“无效状态”区分开来至关重要。无效状态代表系统绝不应进入的错误或不期望的配置。本报告所讨论的核心问题在于，当形式化验证器由于其全面的探索，将这些实际上不可达的状态视为验证的有效起点时，从而导致虚假发现 。

            在智能合约中，以下是不可达状态的典型示例：

            假设一个代币合约中，totalSupply（总供应量）始终等于所有单个用户余额的总和。一个初始状态，例如totalSupply为负数或小于预铸造的用户余额（如果构造函数强制执行正确性），在数学上是可能的，但在实际中是不可达的。

            在ERC20实现中，unchecked算术可能用于内部余额更新，依赖于更高级别的逻辑（如totalSupply限制）来防止溢出。然而，如果havoc为用户引入任意大的余额，则在这些unchecked操作中可能会发生溢出，即使在合约的实际使用中不可能出现如此大的余额 。

            变量被合约的构造函数或部署脚本保证初始化为特定值，但被Proverhavoc为任意、未初始化的值 。

            明确指出一个重大挑战：“归纳步骤对设计者来说的挑战是，你必须将每一个不可达状态声明为无效，否则它可能会从你未预料到的不可达状态开始处理。”它再次强调了这一点：“任何未被声明为无效的状态都可能成为归纳的起点——即使该状态是不可达的。”这揭示了形式化验证特有的“设计者负担”。与传统测试不同，传统测试隐含地关注可达状态，而形式化验证默认探索整个数学定义的状态空间。如果规范没有明确和穷尽地约束初始状态或声明某些状态无效，Prover将考虑它们。这使得任务从仅仅“在可达状态中发现错误”转变为更具挑战性的“精确定义

            所有可达和有效状态的集合”。这种概念上的转变对于习惯于经验测试方法学的开发者来说，通常是一个显著的障碍。

### ** 2.4.Certora的过近似原则：为何考虑不可达状态

Certora Prover的设计固有地采用了“过近似”原则。它“假设所有可能的输入值作为起始状态，即使是那些永远无法达到的值” 。这一策略是确保

            健全性的有意选择——保证Prover“不会允许一个不真实的规则通过验证”并且“保证报告任何规则违规” 。这种方法优先避免“假阴性”（遗漏实际错误）而非所有报告反例的严格精确性 。

            Certora的核心机制涉及将合约代码和CVL规则转换为逻辑公式，然后将其输入SMT求解器。这些求解器旨在探索“无限可能的执行空间”，以找到任何违反指定属性的场景 。如果没有用户的明确约束，SMT求解器将根据变量最广泛的数学解释进行操作，这自然包括理论上可能但实际系统中不可达的状态 。

            与模糊测试 / 传统测试相比，模糊测试和传统测试从具体的程序状态开始，可能难以找到复杂、相关联的参数值以达到深层、有问题状态 ，而Certora的符号方法在这方面表现出色。然而，这种穷尽状态空间探索的能力固有地伴随着一个警告，即可能探索并报告在部署环境中可能不实际可达的状态。

            Certora的过近似是确保健全性的设计选择，这意味着它优先发现任何可能的违规，即使它发生在不可达状态中 。这与用户隐含的期望（即工具只应在实际合约执行期间

            可达的状态中发现违规）形成对比。问题陈述本身（来自不可达初始状态的假阳性）突出了这种紧张关系。这表明了形式化验证与传统测试目标之间的根本哲学差异。Certora Prover在其默认模式下回答的问题是：“给定任何数学上可能的初始状态和执行路径，此属性是否始终成立？”然而，用户通常更感兴趣的是：“给定仅在我的部署系统中实际可达的初始状态和执行路径，此属性是否成立？”“假阳性”正是由于理论可能性（由havoc和过近似穷尽探索）与实际可达性之间的这种差距而产生的。有效弥合这一差距需要用户通过精心设计的规范明确而精确地定义“可达”状态空间。

### ** 2.5.汇合点：Havoc与不可达状态

            havoc机制直接使得Prover能够探索这些不可达的初始状态。通过在规则开始时为所有变量分配“任意的、非确定性值” ，

            havoc可以将合约状态填充为在没有适当约束的情况下永远不会在现实场景中出现的值。这意味着Prover将尽职尽责地尝试在这些不现实的配置中找到反例 。

            一个常见的场景是与Solidity的unchecked算术结合使用。尽管unchecked块通常用于气体优化，并且在合约逻辑维护更高级别的不变量（如totalSupply不超过type(uint256).max）时是安全的，但havoc可以引入任意大的代币余额，导致这些unchecked操作中发生溢出。这会导致报告违规（假阳性），即使在正常、可达的条件下这种溢出是不可能的 。

            MockAssetA的例子明确解决了这个问题，通过修改ERC20实现以严格遵守安全算术，从而防止在验证过程中因havoc引起的溢出 。

            当havoc用任意值填充不可达状态，并且随后在其中一个状态中违反了某个属性（例如，assert语句）时，Prover会生成一个“虚假反例” 。这些反例在过近似模型中在数学上是有效的，但与部署合约中的实际、可利用的漏洞不符。它们是“虚假警报”，会消耗审计资源。

            havoc的广泛非确定性与Prover的过近似相结合，意味着如果用户规范中未充分约束初始状态，Prover将对“垃圾”进行操作——即那些在数学上可能但实际上不可达的状态。明确指出：“即使这样的状态通过任何用户的任何行动路径都是不可达的，该工具仍然将此初始状态视为有效状态。”这强调了

            规范的质量和精确性至关重要。如果用户未能准确建模合约的实际初始条件和环境约束，Certora强大的符号执行能力将忠实地探索这些不切实际的场景，从而导致假阳性。本质上，规范编写者的责任是确保验证的“输入”（定义和约束的状态空间）是“干净”且与智能合约的实际操作上下文相关的。

## ** 3\.理解不可达初始状态导致的假阳性 **

                本节将深入探讨havoc导致虚假反例的机制，并指导如何解释call trace。

### ** 3.1.havoc如何导致虚假反例 **

                Certora Prover对未赋值变量和初始状态的默认havoc行为意味着它会探索 * 所有 * 逻辑上可能的值和配置，即使是那些在合约部署或操作的实际世界语境中不可能或不相关的状态
            当Prover识别出反例时，它会呈现一个“模型”——对所有CVL变量和合约存储的特定赋值——导致assert语句失败, 如果此模型的初始状态，或通过havoc外部调用达到的中间状态，是实际合约永远不可能现实存在（相互矛盾, 并非难以达到），则报告的违规是假阳性。
            havoc导致的假阳性并非Prover逻辑中的缺陷，而是验证的抽象模型与智能合约更受约束的真实世界环境之间不匹配的诊断信号。Prover正确地探索了 * 由规范定义 * 的完整状态空间，但如果该规范过于宽松，它就会包含导致虚假反例的“不可达”状态。havoc探索“所有逻辑上可能的值” 这导致了来自“不可能状态”的反例 。Prover本质上是 * 完备的 *；它将在 * 定义 * 的状态空间内找到 * 任何 * 违反。如果用户规范（“定义的状态空间”）比系统在生产中的 * 实际可达状态空间 * 更广泛，那么在模型的“不可达”部分中找到的任何反例都是假阳性。问题不在于havoc本身，而在于CVL规范中havoc的 * 约束不足 *。Prover只是强调，根据当前规范，违规 * 是 * 可能的。这种视角转变至关重要：假阳性不是Prover的错误，而是有价值的反馈。它们表明规范编写者有责任准确建模系统的真实不变量、前置条件和环境假设。这种识别和解决假阳性的迭代过程是实现高保真形式化验证的核心。

            假阳性生成机制: 假阳性最普遍的来源是CVL规则开始时初始状态约束不足。默认情况下，Certora的havoc机制在规则开始时为所有变量和合约存储分配任意值，以模拟完全未知的初始配置 。如果合约的实际初始状态空间受到更严格的限制（例如，由于构造函数逻辑或部署不变量），并且这些限制未在CVL规则中通过   

require语句明确捕获，Prover可能会在这些不现实的起始条件下发现反例 。

            一个常见的场景是当规则断言一个不变量，如totalSupply() == sumOfBalances;。如果初始状态中，totalSupply被havoc为一个值，例如小于单个用户余额总和的值（一个在正确执行构造函数后不可能出现的状态），则该不变量将立即失败。这导致假阳性，因为报告的违规发生在实际合约永远无法进入的初始状态 。类似地，

            havoc与Solidity的unchecked算术的相互作用可能导致虚假溢出，如MockAssetA案例所示 。

            当外部函数调用或复杂的内部逻辑使用HAVOC_ALL或NONDET摘要进行抽象时 ，Prover假设这些调用可以任意修改合约存储或返回任何值。如果外部合约或内部函数的实际行为比这种广泛假设更受约束，则过近似可能导致在实际交互中永远不会发生的反例。这是由过于通用模型引起的虚假反例的经典形式 。

            尽管并非直接由havoc引起，但误导性的“通过”也可以被视为假阳性的一种形式，就用户认为正在验证的内容而言。这发生在“空洞前提条件”（require语句过于严格，以至于没有输入能够满足它们，导致断言变得微不足道地为真）或“重言式断言”（无论代码行为如何，断言始终为真）的情况下。例如，包含require x > 2; require x < 1; 的规则将始终通过，因为没有x可以同时满足这两个条件，使得任何后续的assert都为空洞真理 。同样，`assert x < 2 |   

| x >= 2;`是一个重言式，不提供任何有意义的验证 。Certora的健全性检查旨在标记这些问题 。

            假阳性不仅仅是一种不便；它们会消耗宝贵的开发者 / 审计人员时间来分析虚假的反例。如果这些情况频繁发生，它们可能导致对形式化验证结果的信任潜在侵蚀。形式化验证工具（如Certora）的核心价值主张是其“数学确定性”的承诺 。如果这种确定性反复被不可操作的发现所破坏，那么工具的感知价值和可信度就会降低。对于安全性和正确性至关重要的系统（例如，DeFi协议、航空航天软件、医疗设备），形式化验证结果的精确性和可操作性与它们的理论健全性同样重要。假阳性通过引入噪音和侵蚀信任，有效地降低了从用户角度来看的

            实际健全性，即使底层数学引擎在理论上仍然健全。这强调了对用户友好的机制和最佳实践的迫切需求，这些机制和最佳实践使用户能够管理穷尽状态探索与生成实际相关反例之间的权衡。

### ** 3.2.解释Certora的验证报告和调用跟踪 **

                当规则验证失败时，Certora Prover会生成详细的验证报告，包括一个具体的反例, 该报告可通过命令行输出中提供的网页链接访问,
                    为了诊断假阳性，必须深入研究失败的特定规则或函数的验证结果。报告中的“调用跟踪”（Call Trace）子窗口是一个不可或缺的诊断工具。它提供了导致失败的执行步骤的详细分解，显示了操作序列和状态变化 。此跟踪将揭示初始状态（例如，“assume invariant in pre - state”显示关键变量的零值）以及变量（包括幽灵变量）如何被  havoc为意外值。调用跟踪还会突出显示havoc被触发的位置，通常是由对未解析被调用者的外部调用引起的，Prover会保守地随机化变量以考虑潜在的状态变化。
            详细的反例和调用跟踪是区分真实错误和假阳性的主要诊断工具。当反例的初始状态或中间状态（如跟踪中所示）在给定系统的真实世界约束和不变量的情况下明显不可能或不相关时，假阳性就被明确识别。Certora提供了反例和调用跟踪 。这些输出显示了初始状态和随后的状态变化 5调用跟踪允许用户检查 * 特定 * 的初始状态和导致断言失败的havoc操作或外部调用的 * 确切 * 序列。如果用户在审查此跟踪后能自信地声明：“我的合约 * 从不 * 以这种特定状态开始”，或者“这种外部调用在实践中 * 从不 * 产生这种特定效果”，那么他们就识别出了一个假阳性。跟踪提供了具体的、逐步的证据，以查明Prover模型中“不可达”或“不切实际”的方面。有效调试Certora假阳性需要对 * 实际 * 系统的不变量、前置条件和预期行为有强大的心智模型。然后将这种心智模型与Prover生成的反例进行批判性比较。这种“失败 - 分析 - 改进”的迭代过程是形式化验证的核心，将原始Prover输出转化为可操作的规范改进。

## ** 4\.缓解havoc导致的假阳性的策略 **

                本节概述了细化Certora规范以减少havoc导致的假阳性的具体、可操作的策略。

### ** 4.1.细化初始状态约束 **

#### ** 4.1.1.利用havoc assuming进行精确状态初始化 **

                虽然未赋值变量默认会被havoc，但 havoc语句可以通过assuming condition子句进行增强。此子句限制了havoc变量可能取的值。这在功能上等同于在基本havoc声明后立即放置一个require语句。
            这种构造对于建模必须满足某些固有约束或不变量的复杂场景特别有用。例如，havoc sumAllBalance assuming sumAllBalance @new () \== sumAllBalance@old() \+ balance \- old\_balance; 展示了其在维护状态之间关系方面的用途。同样，对于双状态上下文中的幽灵变量，havoc foo assuming foo\_add\_even(x); 可以确保特定属性在状态之间保持不变。  
havoc assuming是将初始状态的广泛、完备过近似转换为更精确但仍完备的模型的主要机制，该模型不易生成虚假反例。它使规范编写者能够注入Prover在最大非确定性下否则无法得知或考虑的真实世界不变量或前置条件。没有assuming的havoc默认为初始状态的任意值   
havoc assuming允许为这些值指定条件, 没有assuming，Prover会探索变量所有数学上可能的初始配置，包括那些违反真实世界不变量的配置（例如，total\_supply为负，或owner地址为address(0)，如果这在实际合约中是无效状态）。havoc assuming提供了一种将这些真实世界不变量直接作为初始状态变量的约束注入的方法。这有效地修剪了SMT求解器的搜索空间，阻止它在实践中不可能的状态中找到反例，从而直接减少了假阳性。此功能对于弥合通用数学模型与智能合约操作环境的特定、受约束的现实之间的差距至关重要。它允许用户通过将Prover的工作重点放在真正可达的状态空间上，使验证结果更具相关性和可操作性。

#### ** 4.1.2.幽灵变量的persistent关键字 **

                默认情况下，Certora的Prover会havoc幽灵变量，即使它们被明确初始化。这是因为Prover保守地假设外部影响（例如对未解析被调用者的调用）可能会改变这些变量。这可能导致断言的显著不准确性，因为Prover可能会生成幽灵变量被虚假更改的反例。
            解决此问题的直接方法是相关幽灵变量声明为persistent。  
persistent关键字明确指示Certora Prover，标记的幽灵变量的值应保持静态，并且在验证过程中 * 不 * 受随机化或havoc的影响 。这确保了Prover对不变量和属性的分析是基于这些幽灵变量的预期不变值，从而带来更准确和可靠的形式化验证结果 8。
            persistent关键字是声明关于特定状态组件（特别是幽灵变量）* 不变性假设 * 的关键机制，Prover否则会保守地假设这些组件是可变的。这直接解决了与幽灵变量完整性相关的常见且通常令人沮丧的假阳性来源，而幽灵变量对于表达复杂属性至关重要。Certora在不确定函数是否可以与变量交互时会进行HAVOC。
            havoc指的是为变量分配任意的、非确定性的值……例如，当在未知合约上调用外部函数时，Prover假设它可能任意影响第三个合约的状态 。Certora Prover在设计上遵循最大保守原则以确保完备性。对于任何其可变性或受外部影响的可能性无法明确证明的变量，Prover默认假设它
                * 可以 * 任意更改。这是一种完备但通常过于宽泛的默认设置。幽灵变量，尽管是规范的一部分，但除非明确约束，否则仍受此保守假设的约束。persistent关键字作为Prover的明确声明：“假设此幽灵变量的值在规则执行期间是固定的，即使存在外部调用或其他非确定性事件。”这直接消除了Prover可能虚构幽灵变量虚假更改从而导致属性违反的假阳性。这突出了在规范中明确声明关于状态不变性或稳定性的假设的必要性。这是将模型细化以与真实世界保证保持一致的一个具体实例，允许Prover专注于相关行为。

#### ** 4.1.3.require语句的战略应用（及其注意事项）**

                CVL中的require语句定义了规则的前置条件。如果require语句在特定示例中评估为假，则Prover在验证期间会完全忽略该示例。此机制可用于排除从不可能状态开始的反例，从而减少假阳性。  
requireInvariant命令是一种特殊形式，允许将先前验证过的不变量作为假设添加到另一个规则中。这是一种快速有效的方法，可以排除源于与既定系统不变量不一致的状态的反例 。  
** 注意事项 **：require语句的使用必须极其谨慎。过于激进地使用require可能导致 * 不完备性 *，因为Prover会简单地忽略任何导致require表达式评估为假的模型，从而可能遗漏所需属性的真实违规 。Certora Prover甚至会针对可能排除有意义跟踪的require语句发出警告, 此外，在不变量的preserved块中添加任意require语句，如果基本假设未独立验证，可能会使归纳证明失效。然而，在preserved块中使用requireInvariant j(y)被认为是完备并被鼓励去做的，前提是j不变量本身已独立验证。
            虽然require语句在通过断言前置条件来修剪搜索空间方面功能强大，但它们是一把双刃剑。它们可以有效地减少假阳性，但如果它们无意中过滤掉有效、脆弱的状态，则会带来引入 * 不完备性 * 的重大风险。requireInvariant提供了一种更安全、模块化的方法，利用已验证的不变量作为前置条件，从而保持完备性。require语句导致Prover忽略它们失败的示例 。这可以通过过滤不可能的状态来减少假阳性 。但是，过于激进地使用 require可能会导致遗漏真实的违规 。  
havoc y assuming y \> 10;等同于uint256 y; require y \> 0; 4。在 preserved块中添加假设会使证明失效，如果我们没有理由相信它实际成立，这就是为什么我们不建议在preserved块中添加require语句。
* havoc assuming * 约束了变量初始值的非确定性 *。它指示SMT求解器：“为X选择任何值，但它 * 必须 * 满足此条件。”然后Prover尝试在该受约束空间内找到反例。此方法保持了完备性，因为Prover仍在探索给定约束下的所有有效可能性。  
* require * 过滤掉整个执行路径 *，如果条件不成立。它本质上告诉Prover：“如果此时此条件不满足，则简单地丢弃此执行分支。”这是一种更激进的修剪机制。  
* require的关键风险在于，如果条件在真实、脆弱的场景中 * 可能 * 为假，那么Prover * 从不检查 * 该场景。这导致 * 不完备性 *（Prover可能报告“通过”，而实际存在错误）。havoc assuming通常对于初始状态约束更安全，因为它仍然强制Prover在有效、受约束的初始状态空间内探索潜在的违规。  
* requireInvariant 是一种特别有价值的模式，因为它允许利用
                * 已验证 * 的不变量作为假设，从而促进模块化并在组合证明中保持完备性。

havoc assuming和require之间在初始状态约束方面的选择是细致入微的。它取决于条件是否代表系统的固有、始终为真的属性（最好通过havoc assuming或requireInvariant解决），或者如果违反，则意味着当前执行路径与正在检查的属性不相关（使用require，但要极其谨慎并清楚了解不完备性的可能性）。  
** 表2：用于初始状态细化的CVL构造 **

| 构造 | 语法示例 | 初始状态细化的主要目的 | 对非确定性的影响 | 完备性 / 正确性影响 | 最佳实践 / 主要注意事项 |
| : ---- | : ---- | : ---- | : ---- | : ---- | : ---- |
| havoc assuming | havoc x assuming x \> 0; | 约束变量的初始随机值范围。 | 减少。 | 保持完备性，减少假阳性。 | 用于表达系统固有的前置条件或不变量。 |
| persistent(幽灵变量) | persistent ghost | 声明幽灵变量在验证期间值不变。 | 消除幽灵变量的非确定性。 | 保持完备性，消除幽灵变量相关假阳性。 | 仅用于确实不变的幽灵变量。 |
| require | require balance \> 0; | 忽略不满足条件的执行路径。 | 减少（通过过滤）。 | 若过滤掉真实漏洞，可能导致不完备性。 | 谨慎使用，确保不会排除有效但脆弱的场景。requireInvariant更安全。 |

### ** 4.2.优化外部调用摘要 **

#### ** 4.2.1.为外部交互选择合适的函数摘要 **

                如前所述，HAVOC\_ALL是最保守的摘要，假设外部调用会导致任意状态变化。虽然完备，但其宽泛性常常导致通过探索不切实际的场景而产生大量假阳性。
            当已知外部调用不可重入且保证不会修改调用合约的状态或减少其ETH余额（超出明确转移的任何值）时，通常首选HAVOC\_ECF。此摘要通过将havoc的范围限制为仅外部合约，显著减少了假阳性并提高了性能。
            NONDET适用于已知没有副作用的外部视图函数，将其执行替换为非确定性返回值。
            表达式摘要提供了最高的精确度。当外部调用的行为可以通过CVL函数或幽灵公理准确建模时，表达式摘要可以用这种精确的、确定性逻辑替换调用。这种方法有效地消除了这些特定外部交互的havoc相关假阳性。
            用AUTO或更具体的摘要替换DISPATCHER摘要可以显著降低“路径计数”并防止超时。
            DISPATCHER摘要通过考虑多个潜在调用目标，可能导致状态空间爆炸，这本身虽然不是假阳性，但可能阻止Prover完成验证，从而阻碍真实错误的识别。
            外部调用摘要的选择是直接影响验证模型精度并因此影响假阳性率的关键设计决策。更精确的摘要（例如，HAVOC\_ECF优于HAVOC\_ALL，或表达式摘要）减少了过近似的程度，从而减少了虚假反例。然而，这种提高的精度是以需要对外部代码行为进行更强、* 已验证 * 的假设为代价的。不同的摘要类型对状态和性能有不同的影响。
            HAVOC\_ALL“抹去了所有知识” ，这意味着最大程度的非确定性，从而导致更广泛的可能（且通常不切实际的）状态变化。
            HAVOC\_ECF“假设它可以对 * 除了 * 正在验证的合约之外的合约产生任意影响” ，这代表了对非确定性的 * 约束 *，特别是防止对调用合约状态的更改。表达式摘要用 * 确定性 * CVL逻辑替换非确定性调用 ，有效地消除了该调用的havoc。havoc摘要引入了外部调用的非确定性，以解释未知行为。摘要越保守（HAVOC\_ALL），引入的非确定性越多。这导致SMT求解器更大的搜索空间，以及从不切实际或不可能的外部行为（假阳性）中发现虚假反例的可能性更高。相反，更精确的摘要（如HAVOC\_ECF或表达式摘要）通过编码外部调用的已知或假定属性来 * 减少 * 这种非确定性。这缩小了搜索空间，使验证更有效，并导致更少的假阳性。这强调了理解外部依赖行为的重要性。如果外部合约的行为被充分理解，则应尽可能精确地编码在摘要中。如果确实未知，则必须从保守摘要（HAVOC\_ALL）开始，然后随着更多假设的验证，仔细将其细化为HAVOC\_ECF或表达式摘要。这是有效模块化验证的关键方面。

#### ** 4.2.2.利用with(env)和envfree进行环境控制 **

                Certora Prover通过env结构变量建模调用上下文，该变量捕获了诸如msg.sender、msg.value、block.number和block.timestamp之类的全局Solidity变量 。Prover默认考虑“所有可能的调用上下文”   with (env e)子句在methods块中使用，允许明确绑定并可能限制调用摘要方法时使用的环境（env）。这使得能够更精确地建模摘要外部调用发生的环境条件。 envfree注释可以应用于完全独立于环境的函数，允许它们在没有env参数的情况下被调用 。这明确消除了这些特定函数的环境非确定性，从而简化了模型。with (env)和envfree提供了对Certora Prover所考虑的 * 环境非确定性 * 的细粒度控制。通过明确约束或消除环境变量对特定调用的影响，可以有效缓解由不切实际或不相关的环境上下文引起的假阳性，从而实现更有针对性和更准确的验证。命令可能包含“未指定值的未赋值变量” 。存储状态在规则开始时也是未指定的 env变量（例如，msg.sender，block.timestamp）是任何调用的未指定、非确定性初始状态的一部分。如果Prover被允许为外部调用选择msg.sender、msg.value或block.timestamp的 * 任何 * 值，它可能会在实际系统中不可能或不相关的环境上下文中找到反例（例如，address(0)执行特权操作，或时间戳在遥远的过去）。with (env) 允许用户为这些env变量 * 专门为摘要调用 * 添加特定约束，有效地修剪环境状态空间。envfree更进一步，对于确实不依赖env变量的函数，完全消除了环境非确定性，进一步简化了模型并减少了环境因素导致假阳性的可能性。形式化验证不仅限于合约的内部逻辑；它还包括其与环境的交互。准确建模环境与建模合约本身一样重要，以避免假阳性并确保验证结果的相关性。这些构造提供了实现这种精确环境建模的必要工具。

### ** 4.3.利用过滤器定位验证范围 **

#### ** 4.3.1.在规则中应用filtered块以排除方法 **

    Certora Prover支持“参数化规则”，即包含未定义方法变量的规则。当验证此类规则时，Prover会为实例化参数化规则的每个方法（或方法组合）生成单独的报告。filtered块可以添加到规则声明中，位于规则参数之后。这些块允许用户阻止对特定方法的参数化规则进行验证。与在规则主体中使用require语句来忽略某些方法的反例相比，这种方法通常在计算上更有效 。过滤器由 var \-\> expr对组成，其中var必须与规则的一个方法参数匹配，并且expr是一个可以引用var的布尔表达式（例如，f \-\> f.isView，g \-\> g.selector\!= sig: someMethod().selector）。
规则过滤器不仅仅是性能优化；它们是 * 范围管理 * 的关键机制，直接有助于减少假阳性。通过明确排除属性不应成立的方法的验证，过滤器确保Prover仅将资源用于相关检查，从而防止因不适用上下文而产生的虚假反例。参数化规则会检查许多方法 。过滤器允许排除方法 。这比
require“计算成本更低” 。规则过滤器允许防止对某些方法的参数化规则进行验证。  
require语句警告：“仔细考虑排除这些行为的原因很重要，因为使用require过于激进可能会遗漏所需属性的违规” 。如果参数化规则旨在表达适用于一类通用方法（例如，“所有视图函数不应改变状态”）的属性，但该类中存在某些方法 * 不期望满足 * 该属性（例如，mint函数显然会改变totalSupply），那么对mint函数检查该属性将不可避免地导致反例。这个反例，虽然在技术上是 * 按规定编写的 * 规则的违反，但在 * 预期属性的上下文 * 中是假阳性。过滤器允许用户明确定义规则的 * 适用域 *，有效地表示：“此规则仅适用于满足此条件的方法。”这可以防止Prover报告不应满足该属性的方法的“违规”，从而消除这些特定的假阳性。计算效率是这种精确范围界定的一个有价值的副产品。过滤器是“元规范”的一种形式，定义了属性相关性的边界。它们对于管理大型规范的复杂性以及确保验证工作集中于有意义的属性至关重要，从而提高了验证结果的信噪比。

#### ** 4.3.2.在不变量中应用filtered块进行上下文检查 **

    Certora中的不变量是系统应始终保持的属性。它们通过归纳法证明：首先，通过建立一个基本情况（例如，在构造函数调用后保持不变），然后证明合约中的每个函数都保持不变量（归纳步骤）。
filtered块也可以添加到不变量声明中，以阻止Prover检查特定方法的保持不变量性 。例如，filtered { f \-\> f.selector\!= sig: deposit(uint).selector } 将阻止deposit(uint)方法被检查某个特定不变量。  
** 注意事项 **：虽然在减少假阳性方面看似有用，但在检查不变量时过滤方法通常被认为 * 不完备 * 。如果某个不变量对于特定方法不通过，推荐的方法通常是使用preserved块。preserved块允许以更细粒度的方式添加假设，尽管它们也需要仔细的理由以避免不完备性。需要注意的是，如果某个方法存在preserved块，即使过滤器通常会排除该方法，该方法 * 仍将 * 被验证。将过滤器应用于不变量，虽然表面上可以减少假阳性，但存在严重的不完备性风险。这是因为不变量旨在在 * 所有 * 有效操作下保持。排除某些方法意味着Prover未能验证这些方法是否保持了不变量。如果这些被排除的方法实际上可能破坏不变量，那么证明就失去了其完备性，从而可能遗漏真实漏洞。因此，这种方法应被视为一种临时的、高风险的权宜之计，而不是一种健全的实践。Prover检查一个方法是否保持不变量，首先require不变量（前置状态检查），然后执行方法，然后assert不变量（后置状态检查）。添加 require语句到preserved块中会增加额外的假设，这可能会使证明失效，除非有理由相信该假设确实成立。
这种方法的核心问题在于，不变量的归纳证明要求它在所有可能的系统转换下都成立。如果通过过滤排除了某些转换，那么归纳步骤就不再是全面的。Prover不再能保证在这些被排除的方法执行后不变量仍然成立。这可能导致Prover报告“通过”，而实际上存在一个真实的反例，只是它位于被过滤掉的执行路径中。因此，当不变量失败时，正确的做法是理解失败的原因，并相应地修改不变量或代码，而不是简单地通过过滤来“隐藏”问题。preserved块提供了一种替代方案，它允许在执行方法之前添加假设，例如requireInvariant另一个已验证的不变量。这是一种更安全的方法，因为它依赖于已验证的属性，而不是简单地忽略某些行为。然而，即使是preserved块中的假设也需要仔细验证，以确保它们不会引入新的不完备性。

## ** 5\.结论与建议 **

    Certora Prover中的havoc机制是形式化验证不可或缺的组成部分，它通过引入非确定性来确保对智能合约行为的全面探索，从而保障验证的完备性。然而，这种固有的非确定性，尤其是在初始状态建模和外部调用摘要方面，若未精确约束，极易导致假阳性反例的出现。这些假阳性并非Prover的错误，而是验证模型与智能合约实际操作环境之间存在不匹配的诊断信号。
高效处理havoc导致的假阳性的核心在于 * 细化Certora验证规范 *，以更准确地反映系统的真实不变量、前置条件和环境假设。基于对havoc机制及其影响的深入分析，提出以下建议：

1. ** 精确约束初始状态 **：  
   * ** 利用havoc assuming **：对于规则中的变量，应使用havoc assuming子句来精确限制其初始值的范围，使其符合合约的实际部署或操作前置条件。这有效地将真实世界的不变量注入到Prover的初始状态模型中，从而修剪了不相关的搜索空间，显著减少了假阳性。  
   * ** 应用persistent关键字 **：对于在验证过程中应保持不变的幽灵变量，务必在.conf文件中将其声明为persistent。这消除了Prover对幽灵变量可能被外部影响任意改变的保守假设，避免了因幽灵变量虚假变化而导致的断言失败。  
   * ** 战略性使用require语句 **：require语句可以用于定义规则的前置条件，从而忽略不相关的执行路径。然而，必须极其谨慎地使用，以避免无意中过滤掉真实漏洞，导致不完备性。对于基于已验证不变量的前置条件，推荐使用requireInvariant，这是一种更安全、模块化的方法。
2. ** 优化外部调用摘要 **：  
   * ** 选择合适的摘要类型 **：根据对外部合约行为的了解程度，选择最能反映其副作用的摘要类型。  
     * 当外部合约行为完全未知时，可从HAVOC\_ALL开始，但应尽快尝试细化。  
     * 当外部调用已知不可重入且不会修改调用合约状态时，优先使用HAVOC\_ECF。它在完备性和精确度之间提供了更好的平衡。  
     * 对于纯视图函数，使用NONDET摘要。  
     * 当外部行为可以被精确建模时，应使用表达式摘要来替换非确定性调用。  
   * ** 控制环境非确定性 **：利用with(env)子句在methods块中对摘要方法的调用环境进行精确建模和限制。对于确实不依赖于环境的函数，使用envfree注释，以消除不必要的环境非确定性。
3. ** 有针对性地限定验证范围 **：  
   * ** 在规则中使用filtered块 **：对于参数化规则，通过filtered块明确指定规则适用的方法范围。这不仅提高了验证效率，更重要的是，它防止了Prover在属性不应成立的方法上报告虚假反例，从而提高了验证结果的信噪比。  
   * ** 谨慎对待不变量中的过滤器 **：虽然不变量中也可以使用filtered块，但应避免这种做法，因为它可能导致不完备性。不变量应在所有有效操作下保持。如果某个方法破坏了不变量，应通过preserved块添加经过验证的假设，或修改不变量 / 代码本身，而不是简单地排除该方法。

形式化验证是一个迭代过程。在遇到假阳性时，关键在于深入分析Certora Prover生成的验证报告和调用跟踪。通过仔细检查反例的初始状态和执行路径，识别模型中与真实系统不符的假设，然后有针对性地调整CVL规范。这种持续的细化过程是提高验证精度、减少假阳性并最终实现对智能合约高置信度安全保证的关键。
```
根据上述工作指南,分析下列验证反例:
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


${item.text}

║                                 分析结论 ${index + 1} 结束                                ║
╚═══════════════════════════════════════════════════════════════════════════════════╝`;
        });

        const promptText = `# CVL 验证失败修复任务

## 任务概述
根据以下 ${analyses.length} 个分析结论，依次修复发现的问题。每个结论都已用符号框明确标识和分离（头部包含对应规则名）。
在开始工作之前,请先仔细阅读markdown内的工作指南:
```markdown 
# ** Certora形式化验证中Havoc导致的初始状态不可及问题及假阳性处理策略 **

## ** 1\.概述 **

            Certora Prover在形式化验证中，由于其默认对初始状态和外部交互的非确定性建模（通过havoc机制），可能导致假阳性（spurious counterexamples）的出现。这些假阳性源于验证工具探索了实际系统中不可达或不相关的状态和行为。本指南将深入探讨havoc机制的原理及其在Certora Prover中的应用，分析其如何导致初始状态不可达问题产生的假阳性。指南将详细阐述缓解这些问题的关键策略，包括精确约束初始状态、优化外部调用摘要以及有针对性地限定验证范围，旨在提升验证结果的准确性和效率，从而增强对智能合约安全性的信心。

## ** 2\. Certora Prover中非确定性与havoc机制简介 **

            本节将奠定Certora Prover中非确定性的基础理解，阐明havoc机制的关键作用。

### ** 2.1.havoc在形式化验证中的作用 **

            Certora Prover作为一种先进的形式化验证工具，能够将智能合约字节码和用户定义的属性转换为数学公式，并通过SMT求解器进行分析.这一过程算法性地探索系统状态空间，以验证预期的行为属性.
                Certora验证语言（CVL）中的havoc关键字在建模不确定性和非确定性方面发挥着核心作用, 它允许变量取任意的、非确定性的值，这对于实现输入空间的全面覆盖和考虑所有可能的调用上下文至关重要。  
havoc机制的这种内在非确定性并非Certora Prover的缺陷，而是确保形式化验证 * 完备性 * 的有意设计选择。通过探索所有逻辑上可能的行为，包括那些未明确建模或约束的行为，Prover旨在避免遗漏真正的漏洞。因此，用户面临的挑战是如何将这种广泛的非确定性 * 约束 * 到仅与 * 相关 * 且 * 可达 * 的行为，以避免产生虚假的（假阳性）反例。
        havoc被描述为分配任意值并建模不确定性 ，这是“完整覆盖”的关键 。这种机制，虽然强大，但是导致“不可达初始状态”和“假阳性”的直接原因。Certora Prover旨在自动定位即使是最佳审计师也可能遗漏的关键漏洞，并且“从不犯推理错误” 。
        havoc的目的是创建系统行为的 * 过近似 *。过近似是 * 完备的 *，因为它包含了所有可能的真实行为，保证如果存在错误，Prover会发现它。然而，这种过近似也可能包含在实际系统操作上下文中 * 逻辑上可能但实际上不可能 * 的行为。当这些不可能的行为导致属性违反时，它们表现为 * 虚假反例 *（假阳性）。这种权衡是根本性的：完备性（不遗漏错误）通常伴随着假阳性的风险，如果模型不够精确的话。因此，“假阳性”并非Prover逻辑中的错误，而是表明用户对系统环境或未验证组件的 * 规范 * 过于宽松的有价值信号。解决方案不是禁用havoc，而是通过添加更精确的约束来细化其范围。

### ** 2.2.初始状态建模与未指定变量 **

            Certora非确定性的一个关键方面在于其对初始状态的建模。在验证开始时，存储状态是未指定的，并且所有变量默认都会被havoc 。这意味着Prover会考虑所有可能的变量初始值，除非在规范中明确约束 。
        这种默认的havoc行为是导致假阳性的主要原因。Prover可能会从逻辑上可能但在实际合约部署或操作上下文中明显不可能或不相关的状态生成反例 。  
“不可达初始状态”问题是Certora Prover对初始条件采取“最大非确定性”方法的直接结果。这种保守的默认设置通过考虑最广泛的起始点来确保完备性，但它要求用户明确干预，将验证范围缩小到系统的 * 有效 * 初始状态。初始状态未指定，变量默认被havoc, 如果初始状态导致反例, 也不能说明漏洞的存在, 除非证明初始状态没有被过度近似。
        havoc被明确定义为“将变量分配任意的、非确定性的值……在验证开始时，所有变量都会被havoc以模拟未知初始状态” 。这是一种“悲观”的方法。默认设置旨在实现最大覆盖和完备性，假设 * 任何 * 可能的初始状态，以确保不会因未考虑的起始点而遗漏真正的漏洞。虽然完备，但这通常会从在通用数学模型中 * 逻辑上可能 * 但在所验证的特定合约或协议的实际操作中 * 不可能 * 的状态生成反例。这突显了一个关键的差距：Prover的通用模型与特定系统的真实世界不变量和部署条件之间的差异。为了使验证结果有意义，用户必须将他们对 * 有效 * 初始状态的假设明确编码到规范中。这就是require invariant和havoc assuming等特定CVL结构对于修剪搜索空间和消除虚假反例变得不可或缺的原因。

** 摘要声明 ** 用于替换对某些合约方法的调用，特别是在外部合约的精确代码不可用时，或为了简化复杂代码以防止超时。

* ** HAVOC\_ALL **: 这是最保守的摘要类型。应用时，Prover假设被调用的函数可以对 * 任何 * 合约（包括调用合约）的存储产生任意副作用，并可以返回任意值。虽然始终完备，但它在实践中通常过于严格，因为它“抹去了Prover在调用前对合约状态的所有了解” 10。这种最大非确定性可能导致大量的假阳性。  
* ** HAVOC\_ECF **: 这种摘要类型提供了比HAVOC\_ALL更精细的近似。它假设被调用的方法 * 不可重入 *，并且可以对 * 除了 * 正在验证的合约之外的合约产生任意影响。重要的是，它假设当前（调用）合约的状态和ETH余额（除了方法调用本身转移的任何值）* 不会 * 改变 10。这提供了一个有用的中间地带，与
        HAVOC\_ALL相比减少了假阳性，同时保持了外部交互的高度非确定性。  
* ** NONDET（视图摘要）**: 这些用于视图函数，假设它们没有副作用，并且只是用一个非确定性值替换调用。它们对于视图函数是完备的 10。  
* ** 表达式摘要（Expression Summaries）**: 这些将对摘要方法的调用替换为CVL表达式，通常是CVL函数或幽灵公理的调用。它们需要一个expect子句来解释返回值 10。这允许在外部调用的行为被充分理解时，对其进行精确的、确定性建模。  
* ** AUTO摘要 **: 这些是未解析调用的默认摘要 10。  
* ** DISPATCHER摘要 **: 这些假设方法调用的接收者可以是实现该方法的任何合约。它们可能由于潜在调用目标数量众多，特别是在顺序控制流中，显著导致“路径爆炸问题” 10。用  
  AUTO摘要替换DISPATCHER摘要可以显著降低路径计数并防止超时 11。

        havoc摘要类型的选择代表了完备性、精确性和验证性能之间的关键权衡。HAVOC\_ALL保证完备性，但可能引入大量假阳性并加剧状态爆炸。更精确的摘要，如HAVOC\_ECF和NONDET，通过做出更强的假设（例如，不可重入，无副作用）提供更高的精确度，这可以显著减少假阳性并提高性能。然而，这些更精确的摘要需要仔细考虑和验证，以确保其基本假设准确反映外部代码的行为，因为不完备的假设可能导致遗漏漏洞。  
havoc摘要类型对状态和返回值有不同的影响 10。
        HAVOC\_ALL是“始终完备”的，但“过于严格”，并且“抹去了所有知识” 10。这表明了最大程度的非确定性。
        HAVOC\_ECF是一个“有用的中间地带” 10，意味着非确定性的减少。
        DISPATCHER可能导致“路径爆炸” 11，表明存在性能成本。摘要通常有助于“简化被验证的代码以避免超时” 10。过近似程序上的证明是完备的，但虚假反例可能由原始代码未展示的行为引起 7。

* ** HAVOC\_ALL（最过近似）**: 为外部调用引入最高程度的非确定性。虽然它最大化了完备性（通过不遗漏任何潜在的副作用），但这种广泛性意味着它会发现实际中不可能的场景中的反例，从而导致高比例的假阳性。更大的非确定性状态空间也会对性能产生负面影响。  
* ** HAVOC\_ECF（较少过近似）**: 通过假设不可重入和对调用合约状态的有限影响来减少非确定性。这 * 约束 * 了可能的副作用，从而减少了假阳性并提高了性能。然而，这引入了一个关于外部代码行为的 * 假设 *（不可重入，对自身合约修改有限），该假设 * 必须有效 *。如果此假设在实际系统中被违反，则证明变得 * 不完备 *。  
* ** NONDET（视图函数过近似更少）**: 假设完全没有副作用。这进一步减少了非确定性，从而减少了假阳性并提高了性能，但依赖于对外部函数纯度的更强假设。  
* ** DISPATCHER（复杂，路径计数高）**: 虽然对于建模动态调度很有用，但其固有的复杂性以及需要探索多个潜在调用目标可能导致状态爆炸和超时。这些性能问题可能间接导致“假阳性”，如果Prover未能完成验证，或者只是阻碍了有效的验证。

        因此，选择合适的摘要是CVL中的一个关键设计决策。它需要深入了解外部系统的行为，并仔细评估所需精确度（以减少假阳性）与引入不完备假设的风险之间的权衡。过度摘要（例如，在HAVOC\_ECF足够时使用HAVOC\_ALL）会导致不必要的假阳性，而摘要不足（例如，不摘要复杂的外部调用）则会导致性能瓶颈。  
** 表1：Certora Havoc摘要类型比较 **

| 摘要类型 | 描述 | 关键假设 | 对调用合约状态的影响 | 对其他合约状态的影响 | 对ETH余额的影响 | 返回值处理 | 完备性影响 | 典型用例 | 假阳性 / 性能潜力 |
| : ---- | : ---- | : ---- | : ---- | : ---- | : ---- | : ---- | : ---- | : ---- | : ---- |
| HAVOC\_ALL | 最保守的摘要，允许任意副作用。 | 无特定假设。 | 任意改变。 | 任意改变。 | 任意改变。 | 任意值。 | 始终完备。 | 外部代码未知或高度复杂。 | 高假阳性，性能差。 |
| HAVOC\_ECF | 假设不可重入，限制对调用合约的影响。 | 不可重入。 | 不改变（除显式转账）。 | 任意改变。 | 不减少（除显式转账）。 | 任意值。 | 完备（若假设成立）。 | 外部代码已知不可重入。 | 中等假阳性，性能中等。 |
| NONDET | 用于视图函数，假设无副作用。 | 无副作用。 | 无改变。 | 无改变。 | 无改变。 | 非确定性值。 | 完备（若视图函数纯净）。 | 外部视图函数。 | 低假阳性，性能好。 |
| AUTO | 未解析调用的默认摘要。 | Prover自动推断。 | 依赖于推断。 | 依赖于推断。 | 依赖于推断。 | 依赖于推断。 | 依赖于推断的准确性。 | 默认行为，或作为DISPATCHER替代。 | 假阳性 / 性能可变。 |
| DISPATCHER | 接收者可以是实现该方法的任何合约。 | 动态调度。 | 依赖于实际调用。 | 依赖于实际调用。 | 依赖于实际调用。 | 依赖于实际调用。 | 完备（若所有目标都被探索）。 | 接口调用，多态性。 | 高路径计数，易超时。 |
| 表达式摘要 | 将调用替换为CVL表达式（函数 / 幽灵公理）。 | 外部行为可精确建模。 | 由表达式定义。 | 由表达式定义。 | 由表达式定义。 | 由表达式定义。 | 完备（若表达式准确）。 | 外部行为已知且确定。 | 低假阳性，性能好。 |

### ** 2.3.形式化验证中不可达状态的构成

        在形式化验证的语境中，不可达状态指的是一种系统配置，尽管在给定数据类型和变量范围的情况下在数学上是可能的，但无法通过从合法、实际的初始状态开始的任何有效操作序列或输入来达到 。这些状态是“既非有效也非无效，但设计永远不会达到的状态” 。

        将不可达状态与“无效状态”区分开来至关重要。无效状态代表系统绝不应进入的错误或不期望的配置。本报告所讨论的核心问题在于，当形式化验证器由于其全面的探索，将这些实际上不可达的状态视为验证的有效起点时，从而导致虚假发现 。

        在智能合约中，以下是不可达状态的典型示例：

        假设一个代币合约中，totalSupply（总供应量）始终等于所有单个用户余额的总和。一个初始状态，例如totalSupply为负数或小于预铸造的用户余额（如果构造函数强制执行正确性），在数学上是可能的，但在实际中是不可达的。

        在ERC20实现中，unchecked算术可能用于内部余额更新，依赖于更高级别的逻辑（如totalSupply限制）来防止溢出。然而，如果havoc为用户引入任意大的余额，则在这些unchecked操作中可能会发生溢出，即使在合约的实际使用中不可能出现如此大的余额 。

        变量被合约的构造函数或部署脚本保证初始化为特定值，但被Proverhavoc为任意、未初始化的值 。

        明确指出一个重大挑战：“归纳步骤对设计者来说的挑战是，你必须将每一个不可达状态声明为无效，否则它可能会从你未预料到的不可达状态开始处理。”它再次强调了这一点：“任何未被声明为无效的状态都可能成为归纳的起点——即使该状态是不可达的。”这揭示了形式化验证特有的“设计者负担”。与传统测试不同，传统测试隐含地关注可达状态，而形式化验证默认探索整个数学定义的状态空间。如果规范没有明确和穷尽地约束初始状态或声明某些状态无效，Prover将考虑它们。这使得任务从仅仅“在可达状态中发现错误”转变为更具挑战性的“精确定义

        所有可达和有效状态的集合”。这种概念上的转变对于习惯于经验测试方法学的开发者来说，通常是一个显著的障碍。

### ** 2.4.Certora的过近似原则：为何考虑不可达状态

Certora Prover的设计固有地采用了“过近似”原则。它“假设所有可能的输入值作为起始状态，即使是那些永远无法达到的值” 。这一策略是确保

        健全性的有意选择——保证Prover“不会允许一个不真实的规则通过验证”并且“保证报告任何规则违规” 。这种方法优先避免“假阴性”（遗漏实际错误）而非所有报告反例的严格精确性 。

        Certora的核心机制涉及将合约代码和CVL规则转换为逻辑公式，然后将其输入SMT求解器。这些求解器旨在探索“无限可能的执行空间”，以找到任何违反指定属性的场景 。如果没有用户的明确约束，SMT求解器将根据变量最广泛的数学解释进行操作，这自然包括理论上可能但实际系统中不可达的状态 。

        与模糊测试 / 传统测试相比，模糊测试和传统测试从具体的程序状态开始，可能难以找到复杂、相关联的参数值以达到深层、有问题状态 ，而Certora的符号方法在这方面表现出色。然而，这种穷尽状态空间探索的能力固有地伴随着一个警告，即可能探索并报告在部署环境中可能不实际可达的状态。

        Certora的过近似是确保健全性的设计选择，这意味着它优先发现任何可能的违规，即使它发生在不可达状态中 。这与用户隐含的期望（即工具只应在实际合约执行期间

        可达的状态中发现违规）形成对比。问题陈述本身（来自不可达初始状态的假阳性）突出了这种紧张关系。这表明了形式化验证与传统测试目标之间的根本哲学差异。Certora Prover在其默认模式下回答的问题是：“给定任何数学上可能的初始状态和执行路径，此属性是否始终成立？”然而，用户通常更感兴趣的是：“给定仅在我的部署系统中实际可达的初始状态和执行路径，此属性是否成立？”“假阳性”正是由于理论可能性（由havoc和过近似穷尽探索）与实际可达性之间的这种差距而产生的。有效弥合这一差距需要用户通过精心设计的规范明确而精确地定义“可达”状态空间。

### ** 2.5.汇合点：Havoc与不可达状态

        havoc机制直接使得Prover能够探索这些不可达的初始状态。通过在规则开始时为所有变量分配“任意的、非确定性值” ，

        havoc可以将合约状态填充为在没有适当约束的情况下永远不会在现实场景中出现的值。这意味着Prover将尽职尽责地尝试在这些不现实的配置中找到反例 。

        一个常见的场景是与Solidity的unchecked算术结合使用。尽管unchecked块通常用于气体优化，并且在合约逻辑维护更高级别的不变量（如totalSupply不超过type(uint256).max）时是安全的，但havoc可以引入任意大的代币余额，导致这些unchecked操作中发生溢出。这会导致报告违规（假阳性），即使在正常、可达的条件下这种溢出是不可能的 。

        MockAssetA的例子明确解决了这个问题，通过修改ERC20实现以严格遵守安全算术，从而防止在验证过程中因havoc引起的溢出 。

        当havoc用任意值填充不可达状态，并且随后在其中一个状态中违反了某个属性（例如，assert语句）时，Prover会生成一个“虚假反例” 。这些反例在过近似模型中在数学上是有效的，但与部署合约中的实际、可利用的漏洞不符。它们是“虚假警报”，会消耗审计资源。

        havoc的广泛非确定性与Prover的过近似相结合，意味着如果用户规范中未充分约束初始状态，Prover将对“垃圾”进行操作——即那些在数学上可能但实际上不可达的状态。明确指出：“即使这样的状态通过任何用户的任何行动路径都是不可达的，该工具仍然将此初始状态视为有效状态。”这强调了

        规范的质量和精确性至关重要。如果用户未能准确建模合约的实际初始条件和环境约束，Certora强大的符号执行能力将忠实地探索这些不切实际的场景，从而导致假阳性。本质上，规范编写者的责任是确保验证的“输入”（定义和约束的状态空间）是“干净”且与智能合约的实际操作上下文相关的。

## ** 3\.理解不可达初始状态导致的假阳性 **

            本节将深入探讨havoc导致虚假反例的机制，并指导如何解释call trace。

### ** 3.1.havoc如何导致虚假反例 **

            Certora Prover对未赋值变量和初始状态的默认havoc行为意味着它会探索 * 所有 * 逻辑上可能的值和配置，即使是那些在合约部署或操作的实际世界语境中不可能或不相关的状态
        当Prover识别出反例时，它会呈现一个“模型”——对所有CVL变量和合约存储的特定赋值——导致assert语句失败, 如果此模型的初始状态，或通过havoc外部调用达到的中间状态，是实际合约永远不可能现实存在（相互矛盾, 并非难以达到），则报告的违规是假阳性。
        havoc导致的假阳性并非Prover逻辑中的缺陷，而是验证的抽象模型与智能合约更受约束的真实世界环境之间不匹配的诊断信号。Prover正确地探索了 * 由规范定义 * 的完整状态空间，但如果该规范过于宽松，它就会包含导致虚假反例的“不可达”状态。havoc探索“所有逻辑上可能的值” 这导致了来自“不可能状态”的反例 。Prover本质上是 * 完备的 *；它将在 * 定义 * 的状态空间内找到 * 任何 * 违反。如果用户规范（“定义的状态空间”）比系统在生产中的 * 实际可达状态空间 * 更广泛，那么在模型的“不可达”部分中找到的任何反例都是假阳性。问题不在于havoc本身，而在于CVL规范中havoc的 * 约束不足 *。Prover只是强调，根据当前规范，违规 * 是 * 可能的。这种视角转变至关重要：假阳性不是Prover的错误，而是有价值的反馈。它们表明规范编写者有责任准确建模系统的真实不变量、前置条件和环境假设。这种识别和解决假阳性的迭代过程是实现高保真形式化验证的核心。

        假阳性生成机制: 假阳性最普遍的来源是CVL规则开始时初始状态约束不足。默认情况下，Certora的havoc机制在规则开始时为所有变量和合约存储分配任意值，以模拟完全未知的初始配置 。如果合约的实际初始状态空间受到更严格的限制（例如，由于构造函数逻辑或部署不变量），并且这些限制未在CVL规则中通过   

require语句明确捕获，Prover可能会在这些不现实的起始条件下发现反例 。

        一个常见的场景是当规则断言一个不变量，如totalSupply() == sumOfBalances;。如果初始状态中，totalSupply被havoc为一个值，例如小于单个用户余额总和的值（一个在正确执行构造函数后不可能出现的状态），则该不变量将立即失败。这导致假阳性，因为报告的违规发生在实际合约永远无法进入的初始状态 。类似地，

        havoc与Solidity的unchecked算术的相互作用可能导致虚假溢出，如MockAssetA案例所示 。

        当外部函数调用或复杂的内部逻辑使用HAVOC_ALL或NONDET摘要进行抽象时 ，Prover假设这些调用可以任意修改合约存储或返回任何值。如果外部合约或内部函数的实际行为比这种广泛假设更受约束，则过近似可能导致在实际交互中永远不会发生的反例。这是由过于通用模型引起的虚假反例的经典形式 。

        尽管并非直接由havoc引起，但误导性的“通过”也可以被视为假阳性的一种形式，就用户认为正在验证的内容而言。这发生在“空洞前提条件”（require语句过于严格，以至于没有输入能够满足它们，导致断言变得微不足道地为真）或“重言式断言”（无论代码行为如何，断言始终为真）的情况下。例如，包含require x > 2; require x < 1; 的规则将始终通过，因为没有x可以同时满足这两个条件，使得任何后续的assert都为空洞真理 。同样，`assert x < 2 |   

| x >= 2;`是一个重言式，不提供任何有意义的验证 。Certora的健全性检查旨在标记这些问题 。

        假阳性不仅仅是一种不便；它们会消耗宝贵的开发者 / 审计人员时间来分析虚假的反例。如果这些情况频繁发生，它们可能导致对形式化验证结果的信任潜在侵蚀。形式化验证工具（如Certora）的核心价值主张是其“数学确定性”的承诺 。如果这种确定性反复被不可操作的发现所破坏，那么工具的感知价值和可信度就会降低。对于安全性和正确性至关重要的系统（例如，DeFi协议、航空航天软件、医疗设备），形式化验证结果的精确性和可操作性与它们的理论健全性同样重要。假阳性通过引入噪音和侵蚀信任，有效地降低了从用户角度来看的

        实际健全性，即使底层数学引擎在理论上仍然健全。这强调了对用户友好的机制和最佳实践的迫切需求，这些机制和最佳实践使用户能够管理穷尽状态探索与生成实际相关反例之间的权衡。

### ** 3.2.解释Certora的验证报告和调用跟踪 **

            当规则验证失败时，Certora Prover会生成详细的验证报告，包括一个具体的反例, 该报告可通过命令行输出中提供的网页链接访问,
                为了诊断假阳性，必须深入研究失败的特定规则或函数的验证结果。报告中的“调用跟踪”（Call Trace）子窗口是一个不可或缺的诊断工具。它提供了导致失败的执行步骤的详细分解，显示了操作序列和状态变化 。此跟踪将揭示初始状态（例如，“assume invariant in pre - state”显示关键变量的零值）以及变量（包括幽灵变量）如何被  havoc为意外值。调用跟踪还会突出显示havoc被触发的位置，通常是由对未解析被调用者的外部调用引起的，Prover会保守地随机化变量以考虑潜在的状态变化。
        详细的反例和调用跟踪是区分真实错误和假阳性的主要诊断工具。当反例的初始状态或中间状态（如跟踪中所示）在给定系统的真实世界约束和不变量的情况下明显不可能或不相关时，假阳性就被明确识别。Certora提供了反例和调用跟踪 。这些输出显示了初始状态和随后的状态变化 5调用跟踪允许用户检查 * 特定 * 的初始状态和导致断言失败的havoc操作或外部调用的 * 确切 * 序列。如果用户在审查此跟踪后能自信地声明：“我的合约 * 从不 * 以这种特定状态开始”，或者“这种外部调用在实践中 * 从不 * 产生这种特定效果”，那么他们就识别出了一个假阳性。跟踪提供了具体的、逐步的证据，以查明Prover模型中“不可达”或“不切实际”的方面。有效调试Certora假阳性需要对 * 实际 * 系统的不变量、前置条件和预期行为有强大的心智模型。然后将这种心智模型与Prover生成的反例进行批判性比较。这种“失败 - 分析 - 改进”的迭代过程是形式化验证的核心，将原始Prover输出转化为可操作的规范改进。

## ** 4\.缓解havoc导致的假阳性的策略 **

            本节概述了细化Certora规范以减少havoc导致的假阳性的具体、可操作的策略。

### ** 4.1.细化初始状态约束 **

#### ** 4.1.1.利用havoc assuming进行精确状态初始化 **

            虽然未赋值变量默认会被havoc，但 havoc语句可以通过assuming condition子句进行增强。此子句限制了havoc变量可能取的值。这在功能上等同于在基本havoc声明后立即放置一个require语句。
        这种构造对于建模必须满足某些固有约束或不变量的复杂场景特别有用。例如，havoc sumAllBalance assuming sumAllBalance @new () \== sumAllBalance@old() \+ balance \- old\_balance; 展示了其在维护状态之间关系方面的用途。同样，对于双状态上下文中的幽灵变量，havoc foo assuming foo\_add\_even(x); 可以确保特定属性在状态之间保持不变。  
havoc assuming是将初始状态的广泛、完备过近似转换为更精确但仍完备的模型的主要机制，该模型不易生成虚假反例。它使规范编写者能够注入Prover在最大非确定性下否则无法得知或考虑的真实世界不变量或前置条件。没有assuming的havoc默认为初始状态的任意值   
havoc assuming允许为这些值指定条件, 没有assuming，Prover会探索变量所有数学上可能的初始配置，包括那些违反真实世界不变量的配置（例如，total\_supply为负，或owner地址为address(0)，如果这在实际合约中是无效状态）。havoc assuming提供了一种将这些真实世界不变量直接作为初始状态变量的约束注入的方法。这有效地修剪了SMT求解器的搜索空间，阻止它在实践中不可能的状态中找到反例，从而直接减少了假阳性。此功能对于弥合通用数学模型与智能合约操作环境的特定、受约束的现实之间的差距至关重要。它允许用户通过将Prover的工作重点放在真正可达的状态空间上，使验证结果更具相关性和可操作性。

#### ** 4.1.2.幽灵变量的persistent关键字 **

            默认情况下，Certora的Prover会havoc幽灵变量，即使它们被明确初始化。这是因为Prover保守地假设外部影响（例如对未解析被调用者的调用）可能会改变这些变量。这可能导致断言的显著不准确性，因为Prover可能会生成幽灵变量被虚假更改的反例。
        解决此问题的直接方法是相关幽灵变量声明为persistent。  
persistent关键字明确指示Certora Prover，标记的幽灵变量的值应保持静态，并且在验证过程中 * 不 * 受随机化或havoc的影响 。这确保了Prover对不变量和属性的分析是基于这些幽灵变量的预期不变值，从而带来更准确和可靠的形式化验证结果 8。
        persistent关键字是声明关于特定状态组件（特别是幽灵变量）* 不变性假设 * 的关键机制，Prover否则会保守地假设这些组件是可变的。这直接解决了与幽灵变量完整性相关的常见且通常令人沮丧的假阳性来源，而幽灵变量对于表达复杂属性至关重要。Certora在不确定函数是否可以与变量交互时会进行HAVOC。
        havoc指的是为变量分配任意的、非确定性的值……例如，当在未知合约上调用外部函数时，Prover假设它可能任意影响第三个合约的状态 。Certora Prover在设计上遵循最大保守原则以确保完备性。对于任何其可变性或受外部影响的可能性无法明确证明的变量，Prover默认假设它
            * 可以 * 任意更改。这是一种完备但通常过于宽泛的默认设置。幽灵变量，尽管是规范的一部分，但除非明确约束，否则仍受此保守假设的约束。persistent关键字作为Prover的明确声明：“假设此幽灵变量的值在规则执行期间是固定的，即使存在外部调用或其他非确定性事件。”这直接消除了Prover可能虚构幽灵变量虚假更改从而导致属性违反的假阳性。这突出了在规范中明确声明关于状态不变性或稳定性的假设的必要性。这是将模型细化以与真实世界保证保持一致的一个具体实例，允许Prover专注于相关行为。

#### ** 4.1.3.require语句的战略应用（及其注意事项）**

            CVL中的require语句定义了规则的前置条件。如果require语句在特定示例中评估为假，则Prover在验证期间会完全忽略该示例。此机制可用于排除从不可能状态开始的反例，从而减少假阳性。  
requireInvariant命令是一种特殊形式，允许将先前验证过的不变量作为假设添加到另一个规则中。这是一种快速有效的方法，可以排除源于与既定系统不变量不一致的状态的反例 。  
** 注意事项 **：require语句的使用必须极其谨慎。过于激进地使用require可能导致 * 不完备性 *，因为Prover会简单地忽略任何导致require表达式评估为假的模型，从而可能遗漏所需属性的真实违规 。Certora Prover甚至会针对可能排除有意义跟踪的require语句发出警告, 此外，在不变量的preserved块中添加任意require语句，如果基本假设未独立验证，可能会使归纳证明失效。然而，在preserved块中使用requireInvariant j(y)被认为是完备并被鼓励去做的，前提是j不变量本身已独立验证。
        虽然require语句在通过断言前置条件来修剪搜索空间方面功能强大，但它们是一把双刃剑。它们可以有效地减少假阳性，但如果它们无意中过滤掉有效、脆弱的状态，则会带来引入 * 不完备性 * 的重大风险。requireInvariant提供了一种更安全、模块化的方法，利用已验证的不变量作为前置条件，从而保持完备性。require语句导致Prover忽略它们失败的示例 。这可以通过过滤不可能的状态来减少假阳性 。但是，过于激进地使用 require可能会导致遗漏真实的违规 。  
havoc y assuming y \> 10;等同于uint256 y; require y \> 0; 4。在 preserved块中添加假设会使证明失效，如果我们没有理由相信它实际成立，这就是为什么我们不建议在preserved块中添加require语句。
* havoc assuming * 约束了变量初始值的非确定性 *。它指示SMT求解器：“为X选择任何值，但它 * 必须 * 满足此条件。”然后Prover尝试在该受约束空间内找到反例。此方法保持了完备性，因为Prover仍在探索给定约束下的所有有效可能性。  
* require * 过滤掉整个执行路径 *，如果条件不成立。它本质上告诉Prover：“如果此时此条件不满足，则简单地丢弃此执行分支。”这是一种更激进的修剪机制。  
* require的关键风险在于，如果条件在真实、脆弱的场景中 * 可能 * 为假，那么Prover * 从不检查 * 该场景。这导致 * 不完备性 *（Prover可能报告“通过”，而实际存在错误）。havoc assuming通常对于初始状态约束更安全，因为它仍然强制Prover在有效、受约束的初始状态空间内探索潜在的违规。  
* requireInvariant 是一种特别有价值的模式，因为它允许利用
            * 已验证 * 的不变量作为假设，从而促进模块化并在组合证明中保持完备性。

havoc assuming和require之间在初始状态约束方面的选择是细致入微的。它取决于条件是否代表系统的固有、始终为真的属性（最好通过havoc assuming或requireInvariant解决），或者如果违反，则意味着当前执行路径与正在检查的属性不相关（使用require，但要极其谨慎并清楚了解不完备性的可能性）。  
** 表2：用于初始状态细化的CVL构造 **

| 构造 | 语法示例 | 初始状态细化的主要目的 | 对非确定性的影响 | 完备性 / 正确性影响 | 最佳实践 / 主要注意事项 |
| : ---- | : ---- | : ---- | : ---- | : ---- | : ---- |
| havoc assuming | havoc x assuming x \> 0; | 约束变量的初始随机值范围。 | 减少。 | 保持完备性，减少假阳性。 | 用于表达系统固有的前置条件或不变量。 |
| persistent(幽灵变量) | persistent ghost | 声明幽灵变量在验证期间值不变。 | 消除幽灵变量的非确定性。 | 保持完备性，消除幽灵变量相关假阳性。 | 仅用于确实不变的幽灵变量。 |
| require | require balance \> 0; | 忽略不满足条件的执行路径。 | 减少（通过过滤）。 | 若过滤掉真实漏洞，可能导致不完备性。 | 谨慎使用，确保不会排除有效但脆弱的场景。requireInvariant更安全。 |

### ** 4.2.优化外部调用摘要 **

#### ** 4.2.1.为外部交互选择合适的函数摘要 **

            如前所述，HAVOC\_ALL是最保守的摘要，假设外部调用会导致任意状态变化。虽然完备，但其宽泛性常常导致通过探索不切实际的场景而产生大量假阳性。
        当已知外部调用不可重入且保证不会修改调用合约的状态或减少其ETH余额（超出明确转移的任何值）时，通常首选HAVOC\_ECF。此摘要通过将havoc的范围限制为仅外部合约，显著减少了假阳性并提高了性能。
        NONDET适用于已知没有副作用的外部视图函数，将其执行替换为非确定性返回值。
        表达式摘要提供了最高的精确度。当外部调用的行为可以通过CVL函数或幽灵公理准确建模时，表达式摘要可以用这种精确的、确定性逻辑替换调用。这种方法有效地消除了这些特定外部交互的havoc相关假阳性。
        用AUTO或更具体的摘要替换DISPATCHER摘要可以显著降低“路径计数”并防止超时。
        DISPATCHER摘要通过考虑多个潜在调用目标，可能导致状态空间爆炸，这本身虽然不是假阳性，但可能阻止Prover完成验证，从而阻碍真实错误的识别。
        外部调用摘要的选择是直接影响验证模型精度并因此影响假阳性率的关键设计决策。更精确的摘要（例如，HAVOC\_ECF优于HAVOC\_ALL，或表达式摘要）减少了过近似的程度，从而减少了虚假反例。然而，这种提高的精度是以需要对外部代码行为进行更强、* 已验证 * 的假设为代价的。不同的摘要类型对状态和性能有不同的影响。
        HAVOC\_ALL“抹去了所有知识” ，这意味着最大程度的非确定性，从而导致更广泛的可能（且通常不切实际的）状态变化。
        HAVOC\_ECF“假设它可以对 * 除了 * 正在验证的合约之外的合约产生任意影响” ，这代表了对非确定性的 * 约束 *，特别是防止对调用合约状态的更改。表达式摘要用 * 确定性 * CVL逻辑替换非确定性调用 ，有效地消除了该调用的havoc。havoc摘要引入了外部调用的非确定性，以解释未知行为。摘要越保守（HAVOC\_ALL），引入的非确定性越多。这导致SMT求解器更大的搜索空间，以及从不切实际或不可能的外部行为（假阳性）中发现虚假反例的可能性更高。相反，更精确的摘要（如HAVOC\_ECF或表达式摘要）通过编码外部调用的已知或假定属性来 * 减少 * 这种非确定性。这缩小了搜索空间，使验证更有效，并导致更少的假阳性。这强调了理解外部依赖行为的重要性。如果外部合约的行为被充分理解，则应尽可能精确地编码在摘要中。如果确实未知，则必须从保守摘要（HAVOC\_ALL）开始，然后随着更多假设的验证，仔细将其细化为HAVOC\_ECF或表达式摘要。这是有效模块化验证的关键方面。

#### ** 4.2.2.利用with(env)和envfree进行环境控制 **

            Certora Prover通过env结构变量建模调用上下文，该变量捕获了诸如msg.sender、msg.value、block.number和block.timestamp之类的全局Solidity变量 。Prover默认考虑“所有可能的调用上下文”   with (env e)子句在methods块中使用，允许明确绑定并可能限制调用摘要方法时使用的环境（env）。这使得能够更精确地建模摘要外部调用发生的环境条件。 envfree注释可以应用于完全独立于环境的函数，允许它们在没有env参数的情况下被调用 。这明确消除了这些特定函数的环境非确定性，从而简化了模型。with (env)和envfree提供了对Certora Prover所考虑的 * 环境非确定性 * 的细粒度控制。通过明确约束或消除环境变量对特定调用的影响，可以有效缓解由不切实际或不相关的环境上下文引起的假阳性，从而实现更有针对性和更准确的验证。命令可能包含“未指定值的未赋值变量” 。存储状态在规则开始时也是未指定的 env变量（例如，msg.sender，block.timestamp）是任何调用的未指定、非确定性初始状态的一部分。如果Prover被允许为外部调用选择msg.sender、msg.value或block.timestamp的 * 任何 * 值，它可能会在实际系统中不可能或不相关的环境上下文中找到反例（例如，address(0)执行特权操作，或时间戳在遥远的过去）。with (env) 允许用户为这些env变量 * 专门为摘要调用 * 添加特定约束，有效地修剪环境状态空间。envfree更进一步，对于确实不依赖env变量的函数，完全消除了环境非确定性，进一步简化了模型并减少了环境因素导致假阳性的可能性。形式化验证不仅限于合约的内部逻辑；它还包括其与环境的交互。准确建模环境与建模合约本身一样重要，以避免假阳性并确保验证结果的相关性。这些构造提供了实现这种精确环境建模的必要工具。

### ** 4.3.利用过滤器定位验证范围 **

#### ** 4.3.1.在规则中应用filtered块以排除方法 **

    Certora Prover支持“参数化规则”，即包含未定义方法变量的规则。当验证此类规则时，Prover会为实例化参数化规则的每个方法（或方法组合）生成单独的报告。filtered块可以添加到规则声明中，位于规则参数之后。这些块允许用户阻止对特定方法的参数化规则进行验证。与在规则主体中使用require语句来忽略某些方法的反例相比，这种方法通常在计算上更有效 。过滤器由 var \-\> expr对组成，其中var必须与规则的一个方法参数匹配，并且expr是一个可以引用var的布尔表达式（例如，f \-\> f.isView，g \-\> g.selector\!= sig: someMethod().selector）。
规则过滤器不仅仅是性能优化；它们是 * 范围管理 * 的关键机制，直接有助于减少假阳性。通过明确排除属性不应成立的方法的验证，过滤器确保Prover仅将资源用于相关检查，从而防止因不适用上下文而产生的虚假反例。参数化规则会检查许多方法 。过滤器允许排除方法 。这比
require“计算成本更低” 。规则过滤器允许防止对某些方法的参数化规则进行验证。  
require语句警告：“仔细考虑排除这些行为的原因很重要，因为使用require过于激进可能会遗漏所需属性的违规” 。如果参数化规则旨在表达适用于一类通用方法（例如，“所有视图函数不应改变状态”）的属性，但该类中存在某些方法 * 不期望满足 * 该属性（例如，mint函数显然会改变totalSupply），那么对mint函数检查该属性将不可避免地导致反例。这个反例，虽然在技术上是 * 按规定编写的 * 规则的违反，但在 * 预期属性的上下文 * 中是假阳性。过滤器允许用户明确定义规则的 * 适用域 *，有效地表示：“此规则仅适用于满足此条件的方法。”这可以防止Prover报告不应满足该属性的方法的“违规”，从而消除这些特定的假阳性。计算效率是这种精确范围界定的一个有价值的副产品。过滤器是“元规范”的一种形式，定义了属性相关性的边界。它们对于管理大型规范的复杂性以及确保验证工作集中于有意义的属性至关重要，从而提高了验证结果的信噪比。

#### ** 4.3.2.在不变量中应用filtered块进行上下文检查 **

    Certora中的不变量是系统应始终保持的属性。它们通过归纳法证明：首先，通过建立一个基本情况（例如，在构造函数调用后保持不变），然后证明合约中的每个函数都保持不变量（归纳步骤）。
filtered块也可以添加到不变量声明中，以阻止Prover检查特定方法的保持不变量性 。例如，filtered { f \-\> f.selector\!= sig: deposit(uint).selector } 将阻止deposit(uint)方法被检查某个特定不变量。  
** 注意事项 **：虽然在减少假阳性方面看似有用，但在检查不变量时过滤方法通常被认为 * 不完备 * 。如果某个不变量对于特定方法不通过，推荐的方法通常是使用preserved块。preserved块允许以更细粒度的方式添加假设，尽管它们也需要仔细的理由以避免不完备性。需要注意的是，如果某个方法存在preserved块，即使过滤器通常会排除该方法，该方法 * 仍将 * 被验证。将过滤器应用于不变量，虽然表面上可以减少假阳性，但存在严重的不完备性风险。这是因为不变量旨在在 * 所有 * 有效操作下保持。排除某些方法意味着Prover未能验证这些方法是否保持了不变量。如果这些被排除的方法实际上可能破坏不变量，那么证明就失去了其完备性，从而可能遗漏真实漏洞。因此，这种方法应被视为一种临时的、高风险的权宜之计，而不是一种健全的实践。Prover检查一个方法是否保持不变量，首先require不变量（前置状态检查），然后执行方法，然后assert不变量（后置状态检查）。添加 require语句到preserved块中会增加额外的假设，这可能会使证明失效，除非有理由相信该假设确实成立。
这种方法的核心问题在于，不变量的归纳证明要求它在所有可能的系统转换下都成立。如果通过过滤排除了某些转换，那么归纳步骤就不再是全面的。Prover不再能保证在这些被排除的方法执行后不变量仍然成立。这可能导致Prover报告“通过”，而实际上存在一个真实的反例，只是它位于被过滤掉的执行路径中。因此，当不变量失败时，正确的做法是理解失败的原因，并相应地修改不变量或代码，而不是简单地通过过滤来“隐藏”问题。preserved块提供了一种替代方案，它允许在执行方法之前添加假设，例如requireInvariant另一个已验证的不变量。这是一种更安全的方法，因为它依赖于已验证的属性，而不是简单地忽略某些行为。然而，即使是preserved块中的假设也需要仔细验证，以确保它们不会引入新的不完备性。

## ** 5\.结论与建议 **

    Certora Prover中的havoc机制是形式化验证不可或缺的组成部分，它通过引入非确定性来确保对智能合约行为的全面探索，从而保障验证的完备性。然而，这种固有的非确定性，尤其是在初始状态建模和外部调用摘要方面，若未精确约束，极易导致假阳性反例的出现。这些假阳性并非Prover的错误，而是验证模型与智能合约实际操作环境之间存在不匹配的诊断信号。
高效处理havoc导致的假阳性的核心在于 * 细化Certora验证规范 *，以更准确地反映系统的真实不变量、前置条件和环境假设。基于对havoc机制及其影响的深入分析，提出以下建议：

1. ** 精确约束初始状态 **：  
   * ** 利用havoc assuming **：对于规则中的变量，应使用havoc assuming子句来精确限制其初始值的范围，使其符合合约的实际部署或操作前置条件。这有效地将真实世界的不变量注入到Prover的初始状态模型中，从而修剪了不相关的搜索空间，显著减少了假阳性。  
   * ** 应用persistent关键字 **：对于在验证过程中应保持不变的幽灵变量，务必在.conf文件中将其声明为persistent。这消除了Prover对幽灵变量可能被外部影响任意改变的保守假设，避免了因幽灵变量虚假变化而导致的断言失败。  
   * ** 战略性使用require语句 **：require语句可以用于定义规则的前置条件，从而忽略不相关的执行路径。然而，必须极其谨慎地使用，以避免无意中过滤掉真实漏洞，导致不完备性。对于基于已验证不变量的前置条件，推荐使用requireInvariant，这是一种更安全、模块化的方法。
2. ** 优化外部调用摘要 **：  
   * ** 选择合适的摘要类型 **：根据对外部合约行为的了解程度，选择最能反映其副作用的摘要类型。  
     * 当外部合约行为完全未知时，可从HAVOC\_ALL开始，但应尽快尝试细化。  
     * 当外部调用已知不可重入且不会修改调用合约状态时，优先使用HAVOC\_ECF。它在完备性和精确度之间提供了更好的平衡。  
     * 对于纯视图函数，使用NONDET摘要。  
     * 当外部行为可以被精确建模时，应使用表达式摘要来替换非确定性调用。  
   * ** 控制环境非确定性 **：利用with(env)子句在methods块中对摘要方法的调用环境进行精确建模和限制。对于确实不依赖于环境的函数，使用envfree注释，以消除不必要的环境非确定性。
3. ** 有针对性地限定验证范围 **：  
   * ** 在规则中使用filtered块 **：对于参数化规则，通过filtered块明确指定规则适用的方法范围。这不仅提高了验证效率，更重要的是，它防止了Prover在属性不应成立的方法上报告虚假反例，从而提高了验证结果的信噪比。  
   * ** 谨慎对待不变量中的过滤器 **：虽然不变量中也可以使用filtered块，但应避免这种做法，因为它可能导致不完备性。不变量应在所有有效操作下保持。如果某个方法破坏了不变量，应通过preserved块添加经过验证的假设，或修改不变量 / 代码本身，而不是简单地排除该方法。

形式化验证是一个迭代过程。在遇到假阳性时，关键在于深入分析Certora Prover生成的验证报告和调用跟踪。通过仔细检查反例的初始状态和执行路径，识别模型中与真实系统不符的假设，然后有针对性地调整CVL规范。这种持续的细化过程是提高验证精度、减少假阳性并最终实现对智能合约高置信度安全保证的关键。
```

## 分析结论
${formattedAnalyses.join('\n\n')}

## 修复执行步骤

### 步骤1：逐一分析结论
- 仔细阅读上述 ${analyses.length} 个结论
- 识别每个结论中提到的具体问题

### 步骤2：制定修复计划
- 根据工作指南列出需要修复的具体问题清单
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
