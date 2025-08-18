# Certora Scraper (English Guide)

Tool suite for visualization analysis and automated repair with Certora Prover: scrape verification data, generate Markdown, trigger Codex analysis, sequential CVL/Conf repair, automatic certoraRun execution with closed-loop syntax error fixing, and URL extraction upon success.

## Key Features

- Visual UI (`certora_analyzer.html`): One-click verification data scraping, Markdown viewing, batch/individual Codex analysis.
- Sequential repair closed loop (built-in):
  - Use Codex to repair "analysis completed" conclusions one by one.
  - Automatically call bash to run `certoraRun` (not executed by Codex).
  - Detect syntax/compilation errors and automatically construct repair prompts for Codex, looping until success or manual stop.
  - Extract and display verification URL.
- Conf auto-discovery: Select `.conf` from dropdown sourced from `<workdir>/certora/conf`.
- Security constraints: Only modify `.cvl` and `.conf` files, prohibit changes to `.sol` under `src/`, `contract/`, `contracts/`.

## Quick Start

1) Install dependencies

```bash
npm install
```

2) Start service (provides backend API and Codex/Playwright execution)

```bash
node scripts/certora_auto_server.mjs
```

3) Open UI page and operate

- Double-click or open `certora_analyzer.html` in browser.
- Fill in "Solidity project path (workdir)" with your project root directory (absolute path).
- The "certoraRun configuration file" dropdown below will auto-load `.conf` from `<workdir>/certora/conf`, or click "Refresh".
- Fill in "Enter Certora URL" with your Certora Prover results page link, click "Get verification data".
- Click "Analyze" for desired rules or "Codex analyze all rules". Analysis results can be edited directly on the page.
- Click "Execute sequential fix":
  - Program will repair each edited analysis conclusion sequentially.
  - After completion, automatically run `certoraRun <selected conf>`; if syntax/compilation errors occur, automatically hand to Codex for repair and retry; display verification URL upon success.

Tip: UI top provides "Stop" button to safely abort current Codex processes and certoraRun retries; sequential repair flow won't accidentally end due to browser SSE disconnection.

## Usage Instructions (UI)

- Enter Certora URL: Paste `https://prover.certora.com/output/...`.
- Solidity project path (workdir): Used for backend working directory and auto-discovery of Conf.
- certoraRun configuration file: Dropdown select `.conf` from `<workdir>/certora/conf`; skip certoraRun if empty.
- Results table:
  - Markdown: View or copy auto-generated Markdown (Call Trace / Variables / Global State Diff / Warnings).
  - Codex Analysis Result:
    - Supports streaming analysis; text box can be directly edited after completion to fine-tune repair suggestions.
    - "Copy" button for one-click text copying.
- Execute sequential fix:
  - Only repairs items with "existing analysis text" (placeholders or in-progress won't be included).
  - After fixing all items, if `.conf` is selected, will auto-execute certoraRun with syntax error closed-loop repair.

## Backend API (Brief)

- POST `/analyze-and-fetch`: Scrape and aggregate verification data (non-streaming).
- POST `/analyze-and-fetch-stream`: Scrape and push progress in real-time (SSE).
- POST `/analyze-rule-stream`: Launch Codex streaming analysis for single rule (SSE).
- POST `/generate-fix-prompt`: Generate repair prompt text based on multiple analysis results.
- POST `/fix-sequential-stream`: Sequential repair + auto certoraRun + syntax error closed loop (SSE).
- POST `/kill-processes`: Terminate all Codex-related processes.
- GET `/list-conf?projectPath=<abs>`: List `.conf` files under `<projectPath>/certora/conf`.

## Directory and Files

- `certora_analyzer.html`: Main interface, get data / Codex analysis / sequential repair / certoraRun closed loop.
- `scripts/certora_auto_server.mjs`: Backend service, Playwright scraping, Codex and certoraRun scheduling, SSE output, conf auto-discovery.
- `scripts/certora_scrape.mjs`: Scraping helper script.
- `scripts/get_failed_rules.mjs`: Command-line get non-VERIFIED rules list.

## Constraints and Notes

- Strong constraint: Only allow modifying CVL/Conf, not Solidity source code (`src/`, `contract/`, `contracts/`).
- If Solidity changes are absolutely necessary (extreme cases), tool will prompt to explain reasoning first rather than directly making changes.
- certoraRun is called by program after repair completion, please don't run it yourself in Codex; URL or error info will auto-display in logs.

## Common Issues

- Dropdown doesn't show `.conf`
  - Ensure `workdir` is correct; `<workdir>/certora/conf` exists and contains `.conf`; click "Refresh".
- Fixed only one item then stopped
  - This issue has been fixed: sequential repair won't end due to SSE disconnection; black log box will show "Start item x/y, Complete item x/y, Next item" etc. checkpoints.
- certoraRun command not found
  - Please confirm Certora CLI is properly installed in environment and can execute `certoraRun` directly in `workdir`.

## Dependencies

- Node.js (recommend v18+)
- Playwright (for UI scraping)
- Express / CORS / node-fetch (service and HTTP)

## License

This repository follows the current project's license policy by default. Please communicate and confirm before making changes if modifications are needed.