import { chromium } from 'playwright';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));  // Increase request body size limit to 100MB
app.use(express.urlencoded({ limit: '100mb', extended: true })); // Also increase form data limit

// Track the currently running child process (Codex or certoraRun)
let currentChild = null;
// Global abort flag for sequential fix flow
let globalFixAbort = false;
// Whether a sequential fix is currently running
let activeFixRunning = false;

// Process Codex output, extract only the final answer
function extractCodexAnswer(fullOutput) {
    // Trace back from the last "tokens used:" to find the most recent non-empty candidate block
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
        // Find the most recent timestamp line before t
        let s = -1;
        for (let i = t - 1; i >= 0; i--) {
            if (/^\[[\d\-T:\.Z]+\]/.test(lines[i])) { s = i; break; }
        }
        const slice = lines.slice(s + 1, t);
        const filtered = slice.filter(l => !isMetaLine(l)).join('\n').trim();
        if (filtered) return filtered;
    }

    // Try to extract from "Final answer:" marker
    const finalIdx = lines.findIndex(l => /^(Final answer|Final answer)\s*:/i.test(l));
    if (finalIdx !== -1) {
        return lines.slice(finalIdx + 1).join('\n').trim();
    }

    // Fallback: start from the last "User instructions:" and filter obvious system lines
    let userInstrIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].includes('User instructions:')) { userInstrIdx = i; break; }
    }
    let candidate = (userInstrIdx >= 0 ? lines.slice(userInstrIdx + 1) : lines)
        .filter(l => !isMetaLine(l) && !/tokens used:/i.test(l))
        .join('\n').trim();
    return candidate || fullOutput;
}

// Filter Codex output, remove prompt echo and system information
function filterCodexOutput(output) {
    const lines = output.split('\n');
    const filteredLines = [];
    let inSystemInfo = true;
    let inPromptSection = false;

    for (const line of lines) {
        // System info phase - keep all content before "User instructions:"
        if (inSystemInfo) {
            if (line.includes('User instructions:')) {
                inSystemInfo = false;
                inPromptSection = true;
                continue; // Skip the "User instructions:" line
            }
            // Keep system information
            filteredLines.push(line);
            continue;
        }

        // Detect prompt end, start actual analysis
        if (inPromptSection) {
            // Detect prompt end (usually where actual analysis begins)
            if (line.match(/^(Based on|According to|Analysis|This|Let me|First|## |### |\*\*|# )/)) {
                inPromptSection = false;
                filteredLines.push(line); // Include this analysis start line
            }
            // During prompt phase, skip all content
            continue;
        }

        // Skip other system info lines (like tokens used, etc.)
        if (line.includes('[') && line.includes(']') &&
            (line.includes('codex') || line.includes('tokens used'))) {
            continue;
        }

        // Keep actual analysis content
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

    // Original logic: collect all non-VERIFIED rules
    // if (status && status !== 'VERIFIED' && output.length > 0) {

    // New logic: only collect VIOLATED and SANITY_FAILED rules
    if (status && (status === 'VIOLATED' || status === 'SANITY_FAILED') && output.length > 0) {
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

// Main endpoint: analyze URL and return all JSON content (with real-time progress)
app.post('/analyze-and-fetch-stream', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'Please provide URL' });
    }

    // Set SSE response headers
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
        sendProgress(`Analyzing URL: ${url}`);
        console.log('Analyzing URL:', url);
        const runInfo = parseRunInfo(url);

        const browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        });
        const page = await context.newPage();

        let progressData = null;

        sendProgress('Accessing page...');

        page.on('response', async (response) => {
            try {
                const resUrl = response.url();
                const status = response.status();

                if (resUrl.includes('progress') && status === 200) {
                    const text = await response.text();
                    if (text && text.trim() !== '') {
                        try {
                            progressData = JSON.parse(text);
                            sendProgress('Found progress data');
                        } catch (parseError) {
                            console.log('Progress response parse failed:', parseError.message);
                        }
                    }
                }
            } catch (responseError) {
                console.log('Response processing error:', responseError.message);
            }
        });

        await page.goto(url, { waitUntil: 'networkidle' });
        await page.waitForTimeout(3000);

        if (!progressData) {
            sendProgress('Progress data not found', 'error');
            res.write(`data: ${JSON.stringify({ type: 'error', message: 'Progress data not found' })}\n\n`);
            res.end();
            await browser.close();
            return;
        }

        // Correctly pass empty array as path accumulator to avoid string concat/join errors
        const failedRules = collectFailedRuleOutputs(progressData, runInfo, [], []);
        sendProgress(`Found ${failedRules.length} rules to analyze (VIOLATED and SANITY_FAILED), fetching JSON content...`);

        const results = [];
        for (const rule of failedRules) {
            try {
                sendProgress(`Fetching ${rule.outputFile}...`);
                // Use node-fetch to directly request the constructed JSON URL (field name is url)
                const resp = await fetch(rule.url);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const jsonContent = await resp.json();
                results.push({ ...rule, content: jsonContent });
            } catch (jsonError) {
                console.log(`Failed to fetch ${rule.outputFile}:`, jsonError.message);
                results.push({ ...rule, content: null, error: jsonError.message });
            }
        }

        await browser.close();

        const response = {
            url,
            timestamp: new Date().toISOString(),
            totalRules: failedRules.length,
            rules: results
        };

        sendProgress('Analysis complete!', 'success');
        res.write(`data: ${JSON.stringify({ type: 'complete', data: response })}\n\n`);
        res.end();

    } catch (error) {
        console.error('Processing error:', error);
        sendProgress(`Error: ${error.message}`, 'error');
        res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
        res.end();
    }
});

// Main endpoint: analyze URL and return all JSON content
app.post('/analyze-and-fetch', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'Please provide URL' });
    }

    console.log('Analyzing URL:', url);
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
                            console.log('Found progress data');
                        }
                    } catch { }
                }
            }
        } catch { }
    });

    try {
        console.log('Accessing page...');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => { });
        await browser.close();

        if (!progressData) {
            return res.status(404).json({ error: 'Verification data not found' });
        }

        const roots = getProgressRoots(progressData);
        const failedRules = [];

        for (const root of roots) {
            collectFailedRuleOutputs(root, runInfo, failedRules);
        }

        // Deduplicate
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

        console.log(`Found ${sortedRules.length} rules to analyze (VIOLATED and SANITY_FAILED), fetching JSON content...`);

        // Function with retry: until success
        const fetchJsonWithRetry = async (rule, delayMs = 2000) => {
            let attempt = 0;
            // Infinite retry until success
            // Note: Add fixed wait to prevent too fast retry
            while (true) {
                attempt++;
                try {
                    console.log(`Fetching ${rule.outputFile} (attempt ${attempt})...`);
                    const response = await fetch(rule.url);
                    if (!response.ok) {
                        console.warn(`HTTP ${response.status} failed to fetch ${rule.outputFile}, retrying...`);
                    } else {
                        const jsonContent = await response.json();
                        // Simple validation
                        if (jsonContent && typeof jsonContent === 'object') {
                            return { ...rule, content: jsonContent };
                        }
                        console.warn(`Failed to parse ${rule.outputFile} JSON, retrying...`);
                    }
                } catch (e) {
                    console.warn(`Failed to fetch ${rule.outputFile}: ${e.message}, retrying...`);
                }
                // Wait then retry
                await new Promise(r => setTimeout(r, delayMs));
            }
        };

        // Concurrently fetch all JSON file contents (each has its own infinite retry)
        const rulesWithContent = await Promise.all(sortedRules.map(rule => fetchJsonWithRetry(rule)));

        // Return complete results
        res.json({
            url: url,
            runInfo: runInfo,
            timestamp: new Date().toISOString(),
            totalRules: rulesWithContent.length,
            rules: rulesWithContent
        });

    } catch (error) {
        console.error('Analysis error:', error);
        await browser.close();
        res.status(500).json({ error: error.message });
    }
});

// New /analyze-rule-stream endpoint for streaming Codex analysis of individual rules
app.post('/analyze-rule-stream', async (req, res) => {
    const { content, type, projectPath } = req.body;

    if (!content || !type) {
        return res.status(400).json({
            success: false,
            error: 'Missing required parameters: content and type'
        });
    }

    // Set SSE response headers
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
            promptText = `Analyze the following Certora rule violation from CERTORA_OUTPUT and propose minimal, sound SPEC/CONF change suggestions . If necessary, also propose changes to the HARNESS CONTRACTS .THINK HARDER,ULTRAL THINK.

Output:
- Classification: real bug vs false positive (e.g., unreachable initial state, missing preconditions, over-broad summaries, env mismatch).
- Detalied summary: what failed and where (rule, method, invariant).
- Fixes Suggestions: concrete,minimal,SOUND  SPEC/CONF/HARNESS CONTRACTS change suggestions(e.g., requireInvariant,  method filters, new ghost).

Constraints:
- THE OVERRIDING PRINCIPLE FOR ALL RECOMMENDATIONS IS TO PRESERVE SOUNDNESS. THIS IS NON-NEGOTIABLE.BASED ON THIS, THE HIERARCHY OF PREFERENCE FOR FIXES IS:REQUIREINVARIANT >> HAVOC ASSUMING>FILTERED = REQUIRE

You have the ability to search the web to get any necessary information.

CERTORA_OUTPUT:
${content}
`;
        } else if (type === 'SANITY_FAILED') {
            promptText = `Analyze the following Certora SANITY_FAILED rule from CERTORA_OUTPUT and detemine whether this rule is meaningful and if it should be deleted or fixed.If it should be fixed propose minimal, sound SPEC/CONF change suggestions .THINK HARDER,ULTRAL THINK.

Output:
- Summary: whether this rule is meaningful and if it should be deleted or fixed
- IF meaningful and should be fixed: propose concrete,minimal,SOUND  SPEC/CONF/HARNESS CONTRACTS change suggestions(e.g., method filters, require).

Constraints:
- THE OVERRIDING PRINCIPLE FOR ALL RECOMMENDATIONS IS TO PRESERVE SOUNDNESS. THIS IS NON-NEGOTIABLE.BASED ON THIS, THE HIERARCHY OF PREFERENCE FOR FIXES IS:REQUIREINVARIANT >> HAVOC ASSUMING>FILTERED = REQUIRE

You have the ability to search the web to get any necessary information.

CERTORA_OUTPUT:
${content}`;
        }

        // Clean null bytes from prompt text
        const cleanPromptText = promptText.replace(/\0/g, '');

        sendProgress('Starting analysis...', 'info');
        if (projectPath && projectPath.trim()) {
            sendProgress(`Set working directory: ${projectPath.trim()}`, 'info');
        }

        // Analysis phase: read-only sandbox + never approve + high reasoning effort + detailed summary
        const codexArgs = [
            'exec',
            '--sandbox', 'read-only',
            '-c', 'approval_policy=never',
            '-c', 'model_reasoning_effort=high',
            '-c', 'model_reasoning_summary=detailed'
        ];
        if (projectPath && projectPath.trim()) {
            codexArgs.push('-C', projectPath.trim());
        }
        codexArgs.push(cleanPromptText);

        const analyzeCodexProcess = spawn('codex', codexArgs, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
            detached: true
        });

        // If client disconnects, terminate the child process
        let analyzeKilled = false;
        const killAnalyzeProc = () => {
            try {
                if (!analyzeKilled && analyzeCodexProcess && analyzeCodexProcess.pid) {
                    analyzeKilled = true;
                    try { analyzeCodexProcess.kill('SIGTERM'); } catch { }
                    try { process.kill(-analyzeCodexProcess.pid, 'SIGTERM'); } catch { }
                    setTimeout(() => {
                        try {
                            if (analyzeCodexProcess && analyzeCodexProcess.pid) {
                                try { analyzeCodexProcess.kill('SIGKILL'); } catch { }
                                try { process.kill(-analyzeCodexProcess.pid, 'SIGKILL'); } catch { }
                            }
                        } catch { }
                    }, 1200);
                }
            } catch { }
        };
        req.on('close', killAnalyzeProc);
        req.on('aborted', killAnalyzeProc);
        res.on('close', killAnalyzeProc);

        let fullOutput = '';
        let hasError = false;
        let outputBuffer = '';
        let bufferTimer = null;

        // Function to flush buffered output
        const flushBuffer = () => {
            if (outputBuffer) {
                sendProgress(outputBuffer, 'output');
                outputBuffer = '';
            }
            bufferTimer = null;
        };

        analyzeCodexProcess.stdout.on('data', (data) => {
            const chunk = data.toString();
            fullOutput += chunk;

            // Buffer output and send in batches for better performance
            outputBuffer += chunk;
            if (bufferTimer) clearTimeout(bufferTimer);
            // Send buffered data every 100ms or when buffer is large
            if (outputBuffer.length > 1000) {
                flushBuffer();
            } else {
                bufferTimer = setTimeout(flushBuffer, 100);
            }
        });

        analyzeCodexProcess.stderr.on('data', (data) => {
            const errorOutput = data.toString();
            sendProgress(errorOutput, 'error');
        });

        analyzeCodexProcess.on('error', (error) => {
            hasError = true;
            if (error.code === 'ENOENT') {
                console.error('Codex CLI not found, please ensure it is installed');
                sendProgress('Codex CLI not found, please install Codex CLI', 'error');
            } else if (error.code === 'EPIPE') {
                console.log('Process pipe closed (EPIPE) - this is usually normal');
            } else {
                console.error('Codex process error:', error);
                sendProgress(`Process error: ${error.message}`, 'error');
            }
        });

        analyzeCodexProcess.on('close', (code) => {
            // Flush any remaining buffered output
            if (bufferTimer) clearTimeout(bufferTimer);
            flushBuffer();
            
            console.log(`Codex process ended, exit code: ${code}`);
            if (code === 0 && !hasError) {
                // Extract final analysis and output only at the end
                const finalResult = extractCodexAnswer(fullOutput);
                sendProgress(finalResult, 'final');
                sendProgress('Analysis complete', 'success');
            } else {
                const errorMsg = `Process exited abnormally, code: ${code}`;
                console.error('Codex execution error:', errorMsg);
                sendProgress(errorMsg, 'error');
            }
            res.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
            res.end();
        });

    } catch (error) {
        console.error('Analysis error:', error);
        sendProgress(`Analysis error: ${error.message}`, 'error');
        res.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
        res.end();
    }
});


// New endpoint: /generate-fix-prompt to generate fix prompt
app.post('/generate-fix-prompt', async (req, res) => {
    const { analyses } = req.body;

    if (!analyses || !Array.isArray(analyses) || analyses.length === 0) {
        return res.status(400).json({
            success: false,
            error: 'Missing analysis results'
        });
    }

    console.log(`Generating fix prompt, ${analyses.length} analysis results`);

    try {
        // Normalize input: support string array or object array { text, ruleName }
        const items = analyses.map((a) => {
            if (a && typeof a === 'object') {
                // Support different field names
                const text = a.text ?? a.analysis ?? '';
                const ruleName = a.ruleName ?? a.name ?? a.rule ?? '';
                return { text: String(text || ''), ruleName: String(ruleName || '') };
            }
            return { text: String(a || ''), ruleName: '' };
        });

        // Format analyses (inject rule name into header)
        const formattedAnalyses = items.map((item, index) => {
            const headerTitle = item.ruleName
                ? `Analysis Conclusion ${index + 1} · Rule: ${item.ruleName}`
                : `Analysis Conclusion ${index + 1}`;
            return `╔═══════════════════════════════════════════════════════════════════════════════════╗
║ ${headerTitle}


${item.text}

║                           Analysis Conclusion ${index + 1} End                           ║
╚═══════════════════════════════════════════════════════════════════════════════════╝`;
        });

        const promptText = `Implement fixes for the items below by editing SPEC/CONF/HARNESS CONTRACTS only:

        Constraints:
- THE OVERRIDING PRINCIPLE FOR ALL RECOMMENDATIONS IS TO PRESERVE SOUNDNESS. THIS IS NON-NEGOTIABLE.BASED ON THIS, THE HIERARCHY OF PREFERENCE FOR FIXES IS:REQUIREINVARIANT >> HAVOC ASSUMING>FILTERED = REQUIRE.
- NEVER MODIFY any Solidity files (.sol) in the following directories: src/, contract/, contracts/.
- You MAY ONLY modify CVL specification files (.spec) , Certora configuration files (.conf) , HARNESS CONTRACTS (.sol) in the following directories: certora/harness when necessary.
- DO NOT RUN certoraRun command yourself

For each item:
- Apply minimal, targeted changes.
- If edits are needed, output exact file edits; otherwise, explain briefly.
- Do not run certoraRun yourself.
- Do not edit Solidity in the following directories: src/, contract/, contracts/.

You have the ability to search the web to get any necessary information.

Work items:
${formattedAnalyses.join('\\n\\n')} `;

        res.json({
            success: true,
            prompt: promptText
        });

    } catch (error) {
        console.error('Generate prompt error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// New: sequential fix + certoraRun loop
app.post('/fix-sequential-stream', async (req, res) => {
    const { basePrompt, analyses, projectPath, confPath } = req.body || {};

    if (!analyses || !Array.isArray(analyses) || analyses.length === 0) {
        return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            success: false,
            error: 'Missing analysis results (analyses)'
        }));
    }

    // SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control'
    });

    const send = (message, type = 'output') => {
        try {
            res.write(`data: ${JSON.stringify({ type, message })}\n\n`);
        } catch { }
    };

    // reset abort flag and mark the flow active
    globalFixAbort = false;
    let clientDisconnected = false; // client disconnects but do not abort fix flow
    currentChild = null;
    activeFixRunning = true;
    const killCurrent = () => {
        try {
            if (currentChild && currentChild.pid) {
                try { currentChild.kill('SIGTERM'); } catch { }
                try { process.kill(-currentChild.pid, 'SIGTERM'); } catch { }
                setTimeout(() => {
                    try {
                        if (currentChild && currentChild.pid) {
                            try { currentChild.kill('SIGKILL'); } catch { }
                            try { process.kill(-currentChild.pid, 'SIGKILL'); } catch { }
                        }
                    } catch { }
                }, 1500);
            }
        } catch { }
    };
    req.on('close', () => { clientDisconnected = true; killCurrent(); });

    const spawnCodexOnce = async (promptText, ruleName = 'Fix Task') => {
        const { spawn } = await import('child_process');

        return new Promise((resolve) => {
            if (globalFixAbort) {
                send('Abort requested before spawning Codex', 'info');
                return resolve(false);
            }
            const args = [
                'exec',
                '--sandbox', 'workspace-write',
                '-c', 'approval_policy=never',
                '-c', 'model_reasoning_effort=high',
                '-c', 'model_reasoning_summary=detailed'
            ];
            if (projectPath && String(projectPath).trim()) {
                args.push('-C', String(projectPath).trim());
                send(`Set working directory: ${String(projectPath).trim()}`, 'info');
            }
            args.push(String(promptText || '').replace(/\0/g, ''));

            send(`Starting Codex fix: ${ruleName}`, 'info');
            // Avoid detached to keep process tied to request lifecycle (prevents early SSE end)
            currentChild = spawn('codex', args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });

            currentChild.stdout.on('data', (d) => send(d.toString(), 'output'));
            currentChild.stderr.on('data', (d) => send(d.toString(), 'error'));
            currentChild.on('error', (e) => {
                send(`Process error: ${e.message}`, 'error');
                try { currentChild && currentChild.kill('SIGTERM'); } catch { }
                currentChild = null;
                return resolve(false);
            });
            currentChild.on('close', (code) => {
                currentChild = null;
                send(`Codex exited: ${code}`, code === 0 ? 'success' : 'error');
                resolve(code === 0);
            });
        });
    };

    const runCertora = async () => {
        if (!confPath || !String(confPath).trim()) {
            send('No conf path provided, skipping certoraRun', 'info');
            return { success: false, url: '', output: '' };
        }

        const { spawn } = await import('child_process');
        return new Promise((resolve) => {
            const cmd = 'certoraRun';
            const args = [String(confPath).trim()];
            const spawnOpts = { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } };
            if (projectPath && String(projectPath).trim()) spawnOpts.cwd = String(projectPath).trim();

            send(`Running: certoraRun ${args.join(' ')}`, 'info');
            // Do not use detached, keep same lifecycle as request
            currentChild = spawn(cmd, args, spawnOpts);
            let out = '';
            let err = '';
            currentChild.stdout.on('data', (d) => { const s = d.toString(); out += s; send(s, 'output'); });
            currentChild.stderr.on('data', (d) => { const s = d.toString(); err += s; send(s, 'output'); });
            currentChild.on('error', (e) => {
                send(`certoraRun process error: ${e.message}`, 'error');
            });
            currentChild.on('close', () => {
                currentChild = null;
                const combined = `${out}\n${err}`;
                const urlMatches = combined.match(/https:\/\/prover\.certora\.com\/output\/[^\s]+/g);
                const url = urlMatches && urlMatches.length ? urlMatches[urlMatches.length - 1] : '';
                if (url) {
                    send(url, 'url');
                    send('certoraRun successful, verification URL obtained', 'success');
                    resolve({ success: true, url, output: combined });
                } else {
                    send('certoraRun did not return verification URL, considered as failure', 'error');
                    resolve({ success: false, url: '', output: combined });
                }
            });
        });
    };

    try {
        send(`Starting sequential fix, ${analyses.length} items total`, 'info');

        // Normalize input
        const items = analyses.map((a, i) => {
            if (a && typeof a === 'object') {
                const text = a.text ?? a.analysis ?? '';
                const ruleName = a.ruleName ?? a.name ?? a.rule ?? `Item ${i + 1}`;
                return { text: String(text || ''), ruleName: String(ruleName || `Item ${i + 1}`) };
            }
            return { text: String(a || ''), ruleName: `Item ${i + 1}` };
        });

        // Debug: log each item's rule name
        send(`📋 List of items to fix:`, 'info');
        items.forEach((item, index) => {
            send(`  ${index + 1}. ${item.ruleName}`, 'info');
        });

        // Fix items sequentially
        for (let i = 0; i < items.length; i++) {
            if (globalFixAbort) {
                send(`⚠️ Abort signal detected, stopping fix`, 'info');
                break;
            }
            const item = items[i];
            // Cleaner section headers
            send(`➡️ Start ${i + 1}/${items.length}: ${item.ruleName}`, 'info');
            send(`
===== [Start ${i + 1}/${items.length}] ${item.ruleName} =====\n`, 'output');

            const perPrompt = `${String(basePrompt || '')}
Rule: ${item.ruleName}
Details:
${item.text}`;

            send(`🔧 Invoking Codex to fix item ${i + 1}...`, 'info');
            const ok = await spawnCodexOnce(perPrompt, item.ruleName);
            send(`📋 Result ${i + 1}: ${ok ? 'Success' : 'Failure'}`, 'info');
            send(`===== [Done  ${i + 1}/${items.length}] ${ok ? 'Success' : 'Failure'} =====\n`, 'output');

            if (!ok) {
                if (globalFixAbort) {
                    send(`⚠️ Abort signal detected during fix`, 'info');
                    break;
                }
                send(`❌ Fix ${i + 1} failed, continue to next`, 'error');
                // continue to next item
            } else {
                send(`✅ Fix ${i + 1} completed`, 'success');
            }
            if (i + 1 < items.length) {
                send(`⏭️ Next ${i + 2}/${items.length}`, 'info');
                send(`⏭️ Next ${i + 2}/${items.length}\n`, 'output');
            }
            // Reduced noisy loop-state logs to keep UI clean
        }

        send(`🏁 Fix loop finished, processed ${items.length} items`, 'info');
        send(`🏁 Fix loop finished, processed ${items.length} items\n`, 'output');

        if (globalFixAbort) {
            send('Sequential fix aborted by user', 'status');
            res.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
            activeFixRunning = false;
            return res.end();
        }

        // After fixes, run certoraRun (if confPath provided)
        if (confPath && String(confPath).trim()) {
            send('✅ All fixes completed, running certoraRun for syntax check...', 'info');
            send('✅ Running certoraRun for syntax check...\n', 'output');

            let attempt = 0;
            // Retry until success or aborted; only auto-fix syntax-class errors
            while (!globalFixAbort) {
                attempt++;
                send(`🔄 certoraRun attempt ${attempt}`, 'info');
                send(`🔄 certoraRun attempt ${attempt}\n`, 'output');

                const result = await runCertora();

                if (result.success) {
                    send('✅ certoraRun succeeded! Verification URL obtained', 'success');
                    break;
                }

                // Analyze error type
                const lower = result.output.toLowerCase();
                const hasSyntaxError = lower.includes('syntax error') || lower.includes('parse error') || lower.includes('compilation error');

                if (hasSyntaxError) {
                    send('❌ certoraRun detected syntax errors; sending to Codex to fix...', 'error');
                    send('❌ certoraRun syntax errors; delegating to Codex\n', 'output');

                    const failurePrompt = `Resolve SPEC/CONF/HARNESS CONTRACTS  syntax/parse/compilation errors shown in the log tail by making the minimal edits required.

 Constraints:
- NEVER MODIFY any Solidity files (.sol) in the following directories: src/, contract/, contracts/.
- You MAY ONLY modify CVL specification files (.spec) , Certora configuration files (.conf) , HARNESS CONTRACTS (.sol) in the following directories: certora/harness when necessary.
- DO NOT RUN certoraRun command yourself

You have the ability to search the web to get any necessary information. 

Error log tail:
${result.output.slice(-9000)}
`;

                    const fixOk = await spawnCodexOnce(failurePrompt, 'Syntax Error Fix');
                    if (!fixOk) {
                        if (globalFixAbort) break;
                        // Continue loop: try certoraRun again (until abort or success)
                        send('❌ Codex failed to fix syntax errors; will retry certoraRun', 'error');
                        send('❌ Codex failed to fix syntax errors; will retry certoraRun\n', 'output');
                    } else {
                        send('✅ Codex attempted to fix syntax errors', 'success');
                        send('✅ Codex attempted to fix syntax errors\n', 'output');
                    }
                    // Continue loop, run next certoraRun to verify fix
                    continue;
                }

                // Non-syntax errors: logic, constraints, timeouts; avoid infinite loop
                send('⚠️ certoraRun failed (non-syntax). See logs for details', 'error');
                send(result.output.slice(-2000), 'output');
                break;
            }
        } else {
            send('⚠️ No conf path provided; skipping certoraRun', 'info');
            send('⚠️ No conf path provided; skipping certoraRun\n', 'output');
        }

        send('Sequential fix flow completed', 'success');
        res.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
        activeFixRunning = false;
        res.end();

    } catch (e) {
        send(`Sequential fix error: ${e.message}`, 'error');
        if (e && e.stack) send(e.stack, 'output');
        res.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
        activeFixRunning = false;
        res.end();
    }
});


// New: endpoint to terminate all Codex processes
app.post('/kill-processes', async (req, res) => {
    try {
        console.log('Received manual process termination request');

        // Set global abort flag for sequential fix to observe and exit soon
        globalFixAbort = true;

        // Only terminate currently running (tracked) child process/group
        if (currentChild && currentChild.pid) {
            try {
                try { currentChild.kill('SIGTERM'); } catch { }
                try { process.kill(-currentChild.pid, 'SIGTERM'); } catch { }
                console.log(`Sent SIGTERM to current child process group: ${currentChild.pid}`);
            } catch (e) {
                console.log(`Failed to terminate current child process: ${e.message}`);
            }
            // After short wait, send SIGKILL if still alive
            setTimeout(() => {
                try {
                    if (currentChild && currentChild.pid) {
                        try { currentChild.kill('SIGKILL'); } catch { }
                        try { process.kill(-currentChild.pid, 'SIGKILL'); } catch { }
                        console.log(`Sent SIGKILL to current child process group: ${currentChild.pid}`);
                    }
                } catch { }
            }, 800);
        } else {
            console.log('No current child process to terminate');
        }

        // Return confirmation; frontend can mark as stopped immediately
        res.json({ success: true, message: 'Requested stop of current fix process', activeFixRunning });
    } catch (error) {
        console.error('Manual process termination error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = 3002;
app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════╗
║     Certora Auto Analyzer                 ║
║     Server running: http://localhost:${PORT}  ║
╚════════════════════════════════════════════╝
        `);
});
// New: list .conf files under <projectPath>/certora/conf
app.get('/list-conf', async (req, res) => {
    try {
        const projectPath = String(req.query.projectPath || '').trim();
        if (!projectPath) {
            return res.status(400).json({ success: false, error: 'Missing projectPath' });
        }

        const baseDir = path.resolve(projectPath, 'certora', 'conf');
        const result = [];

        const walk = (dir, depth = 0, maxDepth = 3) => {
            if (depth > maxDepth) return;
            let entries = [];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const ent of entries) {
                const full = path.join(dir, ent.name);
                if (ent.isDirectory()) {
                    walk(full, depth + 1, maxDepth);
                } else if (ent.isFile() && ent.name.endsWith('.conf')) {
                    result.push({
                        name: ent.name,
                        relPath: path.relative(projectPath, full),
                        fullPath: full
                    });
                }
            }
        };

        walk(baseDir);

        return res.json({ success: true, baseDir, count: result.length, files: result });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});
