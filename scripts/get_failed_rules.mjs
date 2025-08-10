import { chromium } from 'playwright';
import crypto from 'node:crypto';

function hash(input) {
    return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function safeName(urlStr) {
    try {
        const u = new URL(urlStr);
        const pathname = u.pathname.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
        return (pathname.length ? pathname : 'root') + '_' + hash(u.search || '');
    } catch {
        return 'unknown_' + hash(urlStr);
    }
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
        if (parts[i] === 'output' && parts[i - 1] === 'outputs') {
            runId = parts[i - 2];
            outputId = parts[i + 1];
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
    
    // 如果状态不是VERIFIED且有output文件，收集rule_output_*.json文件
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
    
    // 递归处理子节点
    for (const child of children) {
        collectFailedRuleOutputs(child, runInfo, results, nextPath);
    }
    
    return results;
}

async function main() {
    const url = process.argv[2];
    
    if (!url) {
        console.error('用法: node scripts/get_failed_rules.mjs <URL>');
        process.exit(1);
    }
    
    const runInfo = parseRunInfo(url);
    console.log('解析URL信息:', runInfo);
    
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    });
    const page = await context.newPage();
    
    let progressData = null;
    
    // 拦截progress请求
    page.on('response', async (res) => {
        try {
            const resUrl = res.url();
            const status = res.status();
            if (status < 200 || status >= 300) return;
            
            const ct = (res.headers()['content-type'] || '').toLowerCase();
            const shouldCapture = ct.includes('application/json') || ct.includes('text/json');
            if (!shouldCapture) return;
            
            // 查找progress数据
            if (resUrl.includes('progress') || resUrl.includes(runInfo.outputId)) {
                const body = await res.text();
                try {
                    const json = JSON.parse(body);
                    if (json.verificationProgress || json.rules) {
                        progressData = json;
                        console.log('找到progress数据');
                    }
                } catch { }
            }
        } catch { }
    });
    
    console.log('正在访问页面...');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => { });
    
    await browser.close();
    
    if (!progressData) {
        console.error('未找到progress数据');
        process.exit(1);
    }
    
    console.log('\n=== 非VERIFIED规则的输出文件 ===');
    const roots = getProgressRoots(progressData);
    const failedRules = [];
    
    for (const root of roots) {
        collectFailedRuleOutputs(root, runInfo, failedRules);
    }
    
    if (failedRules.length === 0) {
        console.log('未找到非VERIFIED状态的规则输出文件');
    } else {
        // 去重：基于outputFile创建Map，保留第一个出现的规则
        const uniqueRules = new Map();
        for (const rule of failedRules) {
            if (!uniqueRules.has(rule.outputFile)) {
                uniqueRules.set(rule.outputFile, rule);
            }
        }
        
        // 按照rule_output_数字排序
        const sortedRules = Array.from(uniqueRules.values()).sort((a, b) => {
            const numA = parseInt(a.outputFile.match(/\d+/)?.[0] || '0');
            const numB = parseInt(b.outputFile.match(/\d+/)?.[0] || '0');
            return numA - numB;
        });
        
        for (const rule of sortedRules) {
            console.log(`规则名称: ${rule.ruleName}`);
            console.log(`状态: ${rule.status}`);
            console.log(`输出: ${rule.url}`);
            console.log('---');
        }
        console.log(`\n总计找到 ${sortedRules.length} 个唯一的非VERIFIED规则输出文件（已去重）`);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});