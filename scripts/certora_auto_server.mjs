import { chromium } from 'playwright';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
app.use(cors());
app.use(express.json());

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
        
        // 获取每个JSON文件的内容
        const rulesWithContent = [];
        for (const rule of sortedRules) {
            try {
                console.log(`获取 ${rule.outputFile}...`);
                const response = await fetch(rule.url);
                if (response.ok) {
                    const jsonContent = await response.json();
                    rulesWithContent.push({
                        ...rule,
                        content: jsonContent
                    });
                } else {
                    rulesWithContent.push({
                        ...rule,
                        content: null,
                        error: `HTTP ${response.status}`
                    });
                }
            } catch (error) {
                console.error(`获取 ${rule.outputFile} 失败:`, error.message);
                rulesWithContent.push({
                    ...rule,
                    content: null,
                    error: error.message
                });
            }
        }
        
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

const PORT = 3002;
app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════╗
║     Certora Auto Analyzer                 ║
║     服务运行在: http://localhost:${PORT}    ║
╚════════════════════════════════════════════╝
    `);
});