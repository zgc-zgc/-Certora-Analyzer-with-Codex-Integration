import { chromium, request as pwRequest } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
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
        // Pattern: /output/<runId>/<outputId>
        if (parts[i] === 'output' && parts[i - 1] !== 'outputs') {
            runId = parts[i + 1];
            outputId = parts[i + 2];
            break;
        }
        // Pattern: /outputs/<runId>/output/<outputId>
        if (parts[i] === 'output' && parts[i - 1] === 'outputs') {
            runId = parts[i - 2];
            outputId = parts[i + 1];
            break;
        }
    }
    const anonymousKey = u.searchParams.get('anonymousKey') || '';
    return { origin: `${u.protocol}//${u.host}`, runId, outputId, anonymousKey };
}

async function ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true });
}

async function saveBuffer(filePath, data) {
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, data);
}

async function readJson(file) {
    try {
        const buf = await fs.readFile(file);
        return JSON.parse(buf.toString('utf-8'));
    } catch {
        return undefined;
    }
}

function collectCalltracesFromObject(node, keyPath = [], results = []) {
    const keyJoined = keyPath.join('.');
    if (node == null) return results;

    const isLikelyTraceKey = (key) =>
        /call.?trace|call\s*trace|traceText|trace_text|stack|textual.*trace|cexTrace|methodTrace|callTrace/i.test(
            key
        );

    if (typeof node === 'string') {
        if (/->| at |\.sol:\d+|function\s+|CALL|DELEGATECALL|STATICCALL|call\s*trace|CALLTRACE/i.test(node)) {
            results.push({ key: keyJoined, text: node });
        }
        return results;
    }

    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
            collectCalltracesFromObject(node[i], keyPath.concat(String(i)), results);
        }
        return results;
    }

    if (typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
            const newPath = keyPath.concat(k);
            if (isLikelyTraceKey(k) && typeof v === 'string') {
                results.push({ key: newPath.join('.'), text: v });
            }
            collectCalltracesFromObject(v, newPath, results);
        }
        return results;
    }

    return results;
}

async function aggregateCalltracesFromDirs(dirs, outDir) {
    const traces = [];
    for (const dir of dirs) {
        let files = [];
        try {
            files = await fs.readdir(dir);
        } catch {
            files = [];
        }

        for (const f of files) {
            if (!f.endsWith('.json')) continue;
            const filePath = path.join(dir, f);
            const json = await readJson(filePath);
            if (!json) continue;
            const found = collectCalltracesFromObject(json);
            if (found.length) {
                traces.push({ file: path.join(path.basename(dir), f), items: found });
            }
        }
    }

    if (!traces.length) return;

    const parts = [];
    parts.push('<!doctype html><meta charset="utf-8"><title>Calltrace Aggregation</title>');
    parts.push('<style>body{font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; padding:16px;} pre{white-space:pre-wrap; word-break:break-word; user-select:text;} h2{margin-top:24px;}</style>');
    parts.push('<h1>Calltrace Aggregation</h1>');
    for (const t of traces) {
        parts.push(`<h2>${t.file}</h2>`);
        for (const item of t.items) {
            parts.push(`<h3>${item.key}</h3>`);
            const esc = item.text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
            parts.push(`<pre>${esc}</pre>`);
        }
    }

    await saveBuffer(path.join(outDir, 'calltrace.html'), Buffer.from(parts.join('\n'), 'utf-8'));
}

async function collectRuleOutputFilesFromProgress(progressJson) {
    const files = new Set();
    const walk = (node) => {
        if (!node) return;
        if (Array.isArray(node)) {
            node.forEach(walk);
            return;
        }
        if (typeof node === 'object') {
            if (Array.isArray(node.output)) {
                node.output.forEach((o) => {
                    if (typeof o === 'string' && /^rule_output_\d+\.json$/.test(o)) files.add(o);
                });
            }
            Object.values(node).forEach(walk);
        }
    };
    walk(progressJson);
    return Array.from(files);
}

async function downloadRuleOutputs({ origin, runId, outputId, anonymousKey }, fileNames, api, outDir) {
    const base = `${origin}/outputs/${runId}/output/${outputId}`;
    const saveDir = path.join(outDir, 'rule_outputs');
    await ensureDir(saveDir);
    for (const name of fileNames) {
        const url = `${base}/${name}${anonymousKey ? `?anonymousKey=${encodeURIComponent(anonymousKey)}` : ''}`;
        const res = await api.get(url);
        if (!res.ok()) continue;
        const buf = await res.body();
        await saveBuffer(path.join(saveDir, name), buf);
    }
}

async function fetchRuleOutputsInPage(page, { origin, runId, outputId, anonymousKey }, names, outDir) {
    const saveDir = path.join(outDir, 'rule_outputs');
    await ensureDir(saveDir);
    const base = `${origin}/outputs/${runId}/output/${outputId}`;
    const urls = names.map((n) => `${base}/${n}${anonymousKey ? `?anonymousKey=${encodeURIComponent(anonymousKey)}` : ''}`);

    // 在页面内使用同源 fetch，利用现有会话与匿名密钥
    const results = await page.evaluate(async (reqUrls) => {
        const out = [];
        for (const u of reqUrls) {
            try {
                const res = await fetch(u, { credentials: 'include' });
                if (!res.ok) {
                    out.push({ url: u, ok: false, status: res.status });
                    continue;
                }
                const text = await res.text();
                out.push({ url: u, ok: true, status: res.status, text });
            } catch (e) {
                out.push({ url: u, ok: false, status: 0 });
            }
        }
        return out;
    }, urls);

    for (const r of results) {
        if (!r.ok) continue;
        const urlStr = r.url;
        const name = urlStr.split('/').pop().split('?')[0];
        await saveBuffer(path.join(saveDir, name), Buffer.from(r.text, 'utf-8'));
    }
}

async function waitForRulesTab(page) {
    // 点击左侧 Rules
    try {
        const rulesBtn = page.getByText('Rules', { exact: true });
        if (await rulesBtn.count()) {
            await rulesBtn.first().click();
        } else {
            // 兜底：包含“Rules”的可点击元素
            const cand = page.locator('a:has-text("Rules"), button:has-text("Rules"), [role="button"]:has-text("Rules")');
            if (await cand.count()) await cand.first().click();
        }
    } catch { }
    // 等待加载完成的信号：Executed 或 Verification job finished 或 规则树
    await Promise.race([
        page.waitForSelector('text=Executed', { timeout: 30000 }).catch(() => { }),
        page.waitForSelector('text=Verification job finished', { timeout: 30000 }).catch(() => { }),
        page.waitForSelector('[role="tree"], .MuiTreeView-root, .ant-tree', { timeout: 30000 }).catch(() => { }),
    ]);
}

async function expandAllTreeLevels(page) {
    // 展开树：点击所有带有展开箭头的节点
    for (let round = 0; round < 5; round++) {
        const expanders = page.locator(
            'button[aria-label="expand"], [role="button"][aria-expanded="false"], .MuiTreeItem-iconContainer svg, .ant-tree-switcher'
        );
        const count = await expanders.count();
        if (!count) break;
        for (let i = 0; i < Math.min(count, 200); i++) {
            try { await expanders.nth(i).click({ delay: 10 }); } catch { }
        }
        await page.waitForTimeout(300);
    }
}

function isFailingLabel(text) {
    const t = text.toLowerCase();
    if (t.includes('verified') || t.includes('pass')) return false;
    return t.includes('violated') || t.includes('timeout') || t.includes('fail') || t.includes('warning') || t.includes('unsafe');
}

async function collectCandidateRuleItems(page) {
    // 常见树节点
    const selectors = [
        '[role="treeitem"]',
        '.MuiTreeItem-root',
        '.ant-tree-treenode',
        '[data-nodeid]',
        '.tree-item',
    ];
    for (const sel of selectors) {
        const loc = page.locator(sel);
        if (await loc.count()) {
            return loc;
        }
    }
    return page.locator('[role="button"]');
}

async function clickDeepAndCapture(page, item, outDir, index) {
    const name = (await item.innerText()).replace(/\s+/g, ' ').trim().slice(0, 120) || `rule_${index}`;
    try { await item.click({ delay: 20 }); } catch { }

    // 等待“未选择提示”消失或 Call Trace 出现
    await page.waitForTimeout(300);
    const noSel = page.locator('text=No item was selected');
    const callTraceHint = page.locator('text=To see the Call trace');
    const callTraceHeader = page.locator('text=Call trace, text=Call Trace');
    await Promise.race([
        callTraceHeader.first().waitFor({ timeout: 15000 }).catch(() => { }),
        noSel.first().waitFor({ state: 'detached', timeout: 15000 }).catch(() => { }),
        page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { }),
    ]);

    // 尝试展开 Call Trace（基础版）
    await expandCallTracePaneBasic(page);

    // 抓取中间面板（Call Trace）文本与HTML
    await saveCallTracePane(page, outDir, name);
}

async function expandCallTracePaneBasic(page) {
    // 点击可能的“Expand/展开/Show more/Load more/Expand all”等
    const btnSel = [
        'button:has-text("Expand")',
        'button:has-text("Expand all")',
        'button:has-text("展开")',
        'button:has-text("Show more")',
        'button:has-text("Load more")',
        '[role="button"]:has-text("Expand")',
    ];
    for (const s of btnSel) {
        const btns = page.locator(s);
        const c = await btns.count();
        for (let i = 0; i < Math.min(c, 50); i++) {
            try { await btns.nth(i).click({ delay: 10 }); } catch { }
        }
    }
    // 展开所有 <details>
    try {
        await page.evaluate(() => {
            document.querySelectorAll('details').forEach(d => { try { d.open = true; } catch (e) { } });
        });
    } catch { }
    // 滚动以触发懒加载
    await page.evaluate(async () => {
        const elem = document.scrollingElement || document.body;
        for (let i = 0; i < 10; i++) {
            elem.scrollTo({ top: elem.scrollHeight, behavior: 'instant' });
            await new Promise(r => setTimeout(r, 150));
        }
    }).catch(() => { });
}

async function saveCallTracePane(page, outDir, baseName) {
    const paneDir = path.join(outDir, 'calltrace_pages');
    await ensureDir(paneDir);
    // 选取中间主要内容区域：优先包含“Call trace”字样的容器，否则取主内容区
    const containers = [
        'section:has-text("Call trace"), section:has-text("Call Trace")',
        '[data-testid*="calltrace" i]',
        'main',
        '#root',
        'body'
    ];
    let html = '', text = '';
    for (const sel of containers) {
        const loc = page.locator(sel).first();
        if (await loc.count()) {
            try {
                html = await loc.evaluate(el => el.innerHTML || '');
                text = await loc.evaluate(el => el.innerText || '');
                if (text && text.trim().length > 0) break;
            } catch { }
        }
    }
    if (!text) {
        // 退化为全页面
        text = await page.evaluate(() => document.body.innerText || '');
        html = await page.evaluate(() => document.body.innerHTML || '');
    }
    const safe = baseName.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'trace';
    await saveBuffer(path.join(paneDir, `${safe}.txt`), Buffer.from(text, 'utf-8'));
    const wrapper = `<!doctype html><meta charset="utf-8"><title>${safe}</title><style>body{font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; padding:16px;} pre{white-space:pre-wrap; word-break:break-word;}</style><div>${html}</div>`;
    await saveBuffer(path.join(paneDir, `${safe}.html`), Buffer.from(wrapper, 'utf-8'));
}

async function traverseAndCaptureFailures(page, outDir, limit = 30) {
    await expandAllTreeLevels(page);
    const items = await collectCandidateRuleItems(page);
    const count = await items.count();
    let captured = 0;
    for (let i = 0; i < Math.min(count, 200); i++) {
        if (captured >= limit) break;
        const it = items.nth(i);
        let label = '';
        try { label = (await it.innerText()).trim(); } catch { }
        if (!label) continue;
        if (!isFailingLabel(label)) continue;

        // 点击该项
        await clickDeepAndCapture(page, it, outDir, i);
        captured++;
    }
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
    // Fallbacks
    if (pj && pj.rules) return Array.isArray(pj.rules) ? pj.rules : [pj.rules];
    if (Array.isArray(pj)) return pj;
    if (pj && pj.children) return Array.isArray(pj.children) ? pj.children : [pj.children];
    return roots;
}

function collectStatusNodes(node, out = [], ancestry = []) {
    if (!node) return out;
    const cur = {
        name: node.name || '',
        status: node.status || '',
        nodeType: node.nodeType || '',
        highestNotificationLevel: node.highestNotificationLevel || '',
        duration: node.duration,
        output: Array.isArray(node.output) ? node.output.slice() : [],
        jumpToDefinition: node.jumpToDefinition || null,
        path: ancestry.map(a => a.name).concat(node.name || '')
    };
    if (cur.status && cur.status.toUpperCase() !== 'VERIFIED') {
        out.push(cur);
    }
    const children = Array.isArray(node.children) ? node.children : [];
    for (const ch of children) {
        collectStatusNodes(ch, out, ancestry.concat({ name: node.name || '' }));
    }
    return out;
}

function renderStatusTreeHtml(statusNodes) {
    const root = { name: '__root__', children: new Map() };
    for (const n of statusNodes) {
        let cur = root;
        for (const seg of n.path) {
            const key = seg || '(unnamed)';
            if (!cur.children.has(key)) cur.children.set(key, { name: key, children: new Map(), items: [] });
            cur = cur.children.get(key);
        }
        cur.items.push(n);
    }

    const esc = (x) => String(x || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const statusClass = (s) => {
        const t = (s || '').toLowerCase();
        if (t.includes('timeout')) return 's-timeout';
        if (t.includes('violat')) return 's-violated';
        if (t.includes('warning')) return 's-warning';
        if (t.includes('unsafe')) return 's-unsafe';
        return 's-other';
    };

    const lines = [];
    lines.push('<!doctype html><meta charset="utf-8"><title>Calltrace Status Tree</title>');
    lines.push(`<style>
  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    min-height: 100vh;
    padding: 20px;
  }
  .container {
    max-width: 1400px;
    margin: 0 auto;
    background: rgba(255, 255, 255, 0.95);
    border-radius: 20px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    padding: 30px;
    backdrop-filter: blur(10px);
  }
  .header {
    text-align: center;
    margin-bottom: 40px;
    padding-bottom: 20px;
    border-bottom: 2px solid #f0f0f0;
  }
  h1 {
    font-size: 2.5rem;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    margin-bottom: 10px;
  }
  .subtitle {
    color: #6b7280;
    font-size: 1.1rem;
  }
  ul {
    list-style: none;
    padding-left: 20px;
    margin: 8px 0;
  }
  details {
    margin: 8px 0;
    background: white;
    border-radius: 10px;
    border: 1px solid #e5e7eb;
    transition: all 0.3s ease;
  }
  details:hover {
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
    transform: translateY(-2px);
  }
  summary {
    cursor: pointer;
    padding: 12px 16px;
    font-size: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
    user-select: none;
    transition: background 0.2s ease;
  }
  summary:hover {
    background: #f9fafb;
  }
  summary::marker {
    content: '';
  }
  summary::before {
    content: '▶';
    display: inline-block;
    width: 20px;
    transition: transform 0.3s ease;
    color: #9ca3af;
  }
  details[open] summary::before {
    transform: rotate(90deg);
  }
  .status {
    font-weight: 600;
    color: #1f2937;
    flex: 1;
  }
  .tag {
    display: inline-block;
    padding: 4px 12px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .s-timeout {
    background: linear-gradient(135deg, #fbbf24, #f59e0b);
    color: white;
    box-shadow: 0 2px 6px rgba(245, 158, 11, 0.3);
  }
  .s-violated {
    background: linear-gradient(135deg, #ef4444, #dc2626);
    color: white;
    box-shadow: 0 2px 6px rgba(239, 68, 68, 0.3);
  }
  .s-warning {
    background: linear-gradient(135deg, #f59e0b, #d97706);
    color: white;
    box-shadow: 0 2px 6px rgba(217, 119, 6, 0.3);
  }
  .s-unsafe {
    background: linear-gradient(135deg, #f87171, #ef4444);
    color: white;
    box-shadow: 0 2px 6px rgba(248, 113, 113, 0.3);
  }
  .s-other {
    background: linear-gradient(135deg, #60a5fa, #3b82f6);
    color: white;
    box-shadow: 0 2px 6px rgba(59, 130, 246, 0.3);
  }
  .meta {
    color: #6b7280;
    font-size: 12px;
    margin-left: 8px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .path {
    color: #9ca3af;
    font-size: 12px;
    margin: 8px 16px 12px 16px;
    padding: 8px 12px;
    background: #f9fafb;
    border-radius: 6px;
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
  }
  code {
    background: #f3f4f6;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 11px;
    color: #6366f1;
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
  }
  .item {
    animation: fadeIn 0.5s ease-out;
  }
  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  .container > ul > li > details {
    background: linear-gradient(to right, #f9fafb, white);
    border-left: 4px solid #6366f1;
    margin: 12px 0;
  }
  .container > ul > li > details summary {
    font-size: 16px;
    padding: 16px 20px;
  }
  strong {
    color: #1f2937;
    font-weight: 600;
  }
  </style>`);

    lines.push('<div class="container">');
    lines.push('<div class="header">');
    lines.push('<h1>Calltrace Status Tree</h1>');
    lines.push('<div class="subtitle">验证结果分析报告</div>');
    lines.push('</div>');

    function renderItem(it) {
        const cls = statusClass(it.status);
        const dur = (it.duration != null ? ` · ${it.duration}s` : '');
        const notif = it.highestNotificationLevel ? ` · ${esc(it.highestNotificationLevel)}` : '';
        const type = it.nodeType ? ` · ${esc(it.nodeType)}` : '';
        const outs = (it.output && it.output.length) ? (' · outputs: ' + it.output.map(o => `<code>${esc(o)}</code>`).join(', ')) : '';
        const path = esc(it.path.join(' > '));
        lines.push(`<li class="item">
      <details open>
        <summary><span class="status">${esc(it.name || '(unnamed)')}</span><span class="tag ${cls}">${esc(it.status)}</span><span class="meta">${type}${notif}${dur}${outs}</span></summary>
        <div class="path">${path}</div>
      </details>
    </li>`);
    }

    function renderContainer(key, node) {
        // 去重：若唯一子项名称与容器同名，则不额外渲染标题，直接渲染该项并把子容器放进去
        const hasChildren = node.children && node.children.size > 0;
        const singleSameItem = node.items && node.items.length === 1 && node.items[0].name === key;
        if (singleSameItem && hasChildren) {
            // 渲染该项为容器
            const it = node.items[0];
            const cls = statusClass(it.status);
            const dur = (it.duration != null ? ` · ${it.duration}s` : '');
            const notif = it.highestNotificationLevel ? ` · ${esc(it.highestNotificationLevel)}` : '';
            const type = it.nodeType ? ` · ${esc(it.nodeType)}` : '';
            const outs = (it.output && it.output.length) ? (' · outputs: ' + it.output.map(o => `<code>${esc(o)}</code>`).join(', ')) : '';
            const path = esc(it.path.join(' > '));
            lines.push(`<li class="item">
        <details open class="container">
          <summary><span class="status">${esc(it.name || '(unnamed)')}</span><span class="tag ${cls}">${esc(it.status)}</span><span class="meta">${type}${notif}${dur}${outs}</span></summary>
          <div class="path">${path}</div>
          <ul>`);
            // 其余同级 items（若有）
            if (node.items.length > 1) {
                node.items.slice(1).forEach(renderItem);
            }
            // 子容器
            for (const [ck, ch] of node.children) {
                renderContainer(ck, ch);
            }
            lines.push(`</ul></details></li>`);
            return;
        }

        // 常规容器：有 items 或 children 就渲染
        const childCount = (node.items ? node.items.length : 0) + (node.children ? node.children.size : 0);
        if (!childCount) return;
        lines.push(`<li class="container"><details open><summary><strong>${esc(key)}</strong></summary><ul>`);
        if (node.items && node.items.length) {
            node.items.forEach(renderItem);
        }
        if (node.children && node.children.size) {
            for (const [ck, ch] of node.children) {
                renderContainer(ck, ch);
            }
        }
        lines.push(`</ul></details></li>`);
    }

    lines.push('<ul>');
    for (const [k, ch] of root.children) {
        renderContainer(k, ch);
    }
    lines.push('</ul>');
    lines.push('</div>');

    return lines.join('\n');
}

async function writeStatusTree(progressJson, outDir) {
    try {
        const roots = getProgressRoots(progressJson);
        const all = [];
        for (const r of roots) collectStatusNodes(r, all, []);
        const html = renderStatusTreeHtml(all);
        await saveBuffer(path.join(outDir, 'calltrace_status_tree.html'), Buffer.from(html, 'utf-8'));
    } catch { }
}

function collectFailingLeafPaths(node, currentPath = [], out = []) {
    if (!node) return out;
    const status = (node.status || '').toUpperCase();
    const name = node.name || '';
    const children = Array.isArray(node.children) ? node.children : [];
    const nextPath = currentPath.concat(name);
    const isBad = status && status !== 'VERIFIED';
    const hasChildren = children.length > 0;
    const hasOutputs = Array.isArray(node.output) && node.output.length > 0;
    if (isBad && (!hasChildren || hasOutputs)) {
        out.push(nextPath);
    }
    for (const ch of children) collectFailingLeafPaths(ch, nextPath, out);
    return out;
}

function buildFailingLeafPathsFromProgress(progressJson) {
    const roots = getProgressRoots(progressJson);
    const paths = [];
    for (const r of roots) collectFailingLeafPaths(r, [], paths);
    // 去重
    const seen = new Set();
    const uniq = [];
    for (const p of paths) {
        const key = p.join('>');
        if (!seen.has(key)) { seen.add(key); uniq.push(p); }
    }
    // 按路径长度排序（深的优先）
    uniq.sort((a, b) => b.length - a.length);
    return uniq;
}

async function findTreeItemByText(page, text) {
    const candidates = [
        `[role="treeitem"]:has-text("${cssEscape(text)}")`,
        `.MuiTreeItem-root:has-text("${cssEscape(text)}")`,
        `.ant-tree-treenode:has-text("${cssEscape(text)}")`,
        `li:has-text("${cssEscape(text)}")`,
    ];
    for (const sel of candidates) {
        const loc = page.locator(sel).first();
        if (await loc.count()) return loc;
    }
    // 最后兜底：任意可点击
    return page.getByText(text).first();
}

function cssEscape(s) {
    return s.replace(/"/g, '\\"');
}

async function openPathInRules(page, pathSegs) {
    // 逐段点击左树节点；尝试展开父层
    for (let i = 0; i < pathSegs.length; i++) {
        const seg = (pathSegs[i] || '').trim();
        if (!seg) continue;
        const item = await findTreeItemByText(page, seg);
        try {
            await item.scrollIntoViewIfNeeded();
        } catch { }
        try {
            await item.click({ timeout: 5000 });
        } catch { }
        // 等待一点渲染
        await page.waitForTimeout(200);
        // 展开可能的箭头
        try {
            const parent = item.locator('xpath=ancestor-or-self::*[self::li or @role="treeitem"][1]');
            const expandBtn = parent.locator('[aria-expanded="false"],[aria-label="expand"],.ant-tree-switcher');
            if (await expandBtn.count()) {
                try { await expandBtn.first().click({ timeout: 1000 }); } catch { }
            }
        } catch { }
    }
}

async function clickAndCaptureByPaths(page, outDir, paths, limit = 50) {
    let captured = 0;
    for (const p of paths) {
        if (captured >= limit) break;
        await openPathInRules(page, p);
        // 等待中间区 Call Trace 加载
        await waitForCallTraceLoaded(page);
        // 展开并保存
        await expandCallTracePaneBasic(page);
        const fname = p.join(' __ ');
        await saveCallTracePane(page, outDir, fname);
        captured++;
    }
}

async function waitForCallTraceLoaded(page) {
    // 等待“未选择提示”消失或 Call Trace 出现
    const noSel = page.locator('text=No item was selected');
    const callTraceHeader = page.locator('text=Call trace, text=Call Trace');
    await Promise.race([
        callTraceHeader.first().waitFor({ timeout: 15000 }).catch(() => { }),
        noSel.first().waitFor({ state: 'detached', timeout: 15000 }).catch(() => { }),
        page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { }),
    ]);
}

// 加强 call trace 面板内的全量展开点击
async function expandCallTracePane(page) {
    const container = await getCallTraceContainer(page);
    // 多轮点击所有可展开元素
    for (let round = 0; round < 6; round++) {
        // 按钮类
        const btns = container.locator('button, [role="button"], summary');
        const cnt = await btns.count();
        let clicked = 0;
        for (let i = 0; i < Math.min(cnt, 300); i++) {
            const b = btns.nth(i);
            const txt = (await b.innerText().catch(() => ''))?.toLowerCase() || '';
            if (/expand|展开|show more|load more|更多|trace|call|details/.test(txt)) {
                try { await b.click({ delay: 10, timeout: 300 }); clicked++; } catch { }
            }
        }
        // aria-expanded=false 的节点
        const toggles = container.locator('[aria-expanded="false"]');
        const tcnt = await toggles.count();
        for (let i = 0; i < Math.min(tcnt, 300); i++) {
            try { await toggles.nth(i).click({ timeout: 200 }); clicked++; } catch { }
        }
        if (!clicked) break;
        await page.waitForTimeout(250);
    }
    // 展开所有 <details>
    try {
        await page.evaluate((sel) => {
            const root = document.querySelector(sel) || document.body;
            root.querySelectorAll('details').forEach(d => { try { d.open = true; } catch (e) { } });
        }, await container.evaluate(el => el.tagName ? el.tagName : 'body'));
    } catch { }
    // 滚动触发懒加载
    await page.evaluate((sel) => {
        const root = document.querySelector(sel) || document.documentElement;
        for (let i = 0; i < 12; i++) {
            root.scrollTo({ top: root.scrollHeight, behavior: 'instant' });
        }
    }, 'html').catch(() => { });
}

async function getCallTraceContainer(page) {
    const sels = [
        'section:has-text("Call trace"), section:has-text("Call Trace")',
        '[data-testid*="calltrace" i]',
        '[data-testid*="trace" i]',
        'main',
        '#root',
        'body'
    ];
    for (const s of sels) {
        const loc = page.locator(s).first();
        if (await loc.count()) return loc;
    }
    return page.locator('body');
}

async function main() {
    const url = process.argv[2];
    const baseOut = process.argv[3] || path.resolve(process.cwd(), 'output');

    if (!url) {
        console.error('用法: node scripts/certora_scrape.mjs <URL> [OUT_DIR]');
        process.exit(1);
    }

    const runInfo = parseRunInfo(url);
    const outDir = path.join(baseOut, safeName(url));
    const responsesDir = path.join(outDir, 'responses');
    await ensureDir(outDir);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    });
    const page = await context.newPage();

    page.on('response', async (res) => {
        try {
            const status = res.status();
            if (status < 200 || status >= 300) return;
            const ct = (res.headers()['content-type'] || '').toLowerCase();
            const shouldSave =
                ct.includes('application/json') ||
                ct.includes('text/json') ||
                ct.includes('application/problem+json') ||
                ct.includes('text/plain');
            if (!shouldSave) return;
            const body = await res.body();
            const base = safeName(res.url());
            const filename = base.endsWith('.json') ? base : base + '.json';
            const filePath = path.join(responsesDir, filename);
            await saveBuffer(filePath, body);
        } catch { }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForLoadState('networkidle', { timeout: 180000 }).catch(() => { });

    await page.addStyleTag({
        content: `
      *, *::before, *::after { user-select: text !important; }
      pre, code { user-select: text !important; }
    `,
    }).catch(() => { });

    await page.evaluate(() => {
        document.querySelectorAll('details').forEach((d) => {
            try { d.open = true; } catch { }
        });
    }).catch(() => { });

    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => { });
    await page.waitForTimeout(400);

    // 进入 Rules 页
    await waitForRulesTab(page);

    // 解析 progress，构建失败叶子路径并逐个点击加载 Call Trace
    let progressJson;
    try {
        const files = await fs.readdir(responsesDir);
        let progressFile = files.find(
            (f) => f.startsWith(`_progress_${runInfo.runId}_${runInfo.outputId}_`) && f.endsWith('.json')
        );
        if (!progressFile) progressFile = files.find((f) => f.startsWith('_progress_') && f.includes(runInfo.outputId));
        if (!progressFile) progressFile = files.find((f) => f.startsWith('_progress_') && f.endsWith('.json'));
        if (progressFile) progressJson = await readJson(path.join(responsesDir, progressFile));
    } catch { }

    if (progressJson) {
        const failingPaths = buildFailingLeafPathsFromProgress(progressJson);
        await clickAndCaptureByPaths(page, outDir, failingPaths, 80).catch(() => { });
    }

    const html = await page.content();
    await saveBuffer(path.join(outDir, 'page.html'), Buffer.from(html, 'utf-8'));

    // 下载 rule_output_*.json（如可用）并写状态树
    if (progressJson) {
        const names = await collectRuleOutputFilesFromProgress(progressJson);
        if (names.length) {
            try { await fetchRuleOutputsInPage(page, runInfo, names, outDir); } catch { }
            try {
                const api = await pwRequest.newContext();
                try { await downloadRuleOutputs(runInfo, names, api, outDir); } finally { await api.dispose(); }
            } catch { }
        }
        await writeStatusTree(progressJson, outDir).catch(() => { });
    }

    await browser.close();

    const extraDirs = [responsesDir, path.join(outDir, 'rule_outputs')];
    await aggregateCalltracesFromDirs(extraDirs, outDir).catch(() => { });

    console.log(`完成。输出目录: ${outDir}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
}); 