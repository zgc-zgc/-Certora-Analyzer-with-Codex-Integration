# Certora Scraper

A comprehensive automation toolkit for Certora Prover verification workflows, featuring intelligent analysis, automated repair, and streamlined verification management.

## Overview

Certora Scraper simplifies and automates the Certora Prover verification process by providing:
- **Automated Data Extraction**: Scrape verification results directly from Certora Prover URLs
- **AI-Powered Analysis**: Generate detailed analysis reports using Codex integration  
- **Intelligent Repair System**: Automatically fix CVL and configuration issues with closed-loop error handling
- **Web-Based Interface**: User-friendly GUI for managing verification workflows

## Key Features

### 🔍 **Verification Data Scraping**
- Extract verification results from Certora Prover URLs
- Generate structured Markdown reports with call traces, variables, and state diffs
- Real-time progress tracking with Server-Sent Events (SSE)

### 🤖 **AI-Powered Analysis** 
- Integrated Codex analysis for verification failures
- Streaming analysis results with editable output
- Batch processing for multiple rules

### 🔧 **Automated Repair System**
- Sequential repair workflow for failed verification rules
- Automatic `certoraRun` execution after repairs
- Closed-loop syntax error detection and fixing
- Success URL extraction and display

## Installation & Setup

### Prerequisites
- Codex (npm i -g @openai/codex)

### Installation

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Start the Backend Service**
   ```bash
   node scripts/certora_auto_server.mjs
   ```
   This launches the backend API server that handles scraping, analysis, and repair operations.

3. **Open the Web Interface**
   - Open `certora_analyzer.html` in your web browser
   - The interface provides all tools needed for verification management

## Usage Guide

### Web Interface Workflow

1. **Configure Project Settings**
   - **Solidity Project Path**: Enter the absolute path to your project root directory
   - **Configuration File**: Select a `.conf` file from the auto-populated dropdown (sourced from `<workdir>/certora/conf`)
   - Click "Refresh" if configuration files don't appear

2. **Import Verification Data**
   - **Certora URL**: Paste your Certora Prover results URL (`https://prover.certora.com/output/...`)
   - Click "Get verification data" to extract and process verification results

3. **Analyze Results**
   - **Individual Analysis**: Click "Analyze" for specific failed rules
   - **Batch Analysis**: Use "Codex analyze all rules" for all failed rules
   - **Edit Results**: Analysis outputs can be directly edited in the interface for fine-tuning

4. **Execute Automated Repairs**
   - Click "Execute sequential fix" to start the automated repair process
   - The system will:
     - Process each analysis result sequentially
     - Apply fixes to .spec and .conf
     - Automatically run `certoraRun` with the selected configuration
     - Handle syntax errors with closed-loop repair attempts
     - Display the verification URL upon successful completion

### Interface Features

- **Real-time Progress**: Server-Sent Events (SSE) provide live updates during operations
- **Safe Termination**: Use the "Stop" button to safely abort running processes
- **Markdown Export**: View and copy auto-generated reports including call traces, variables, and state differences
- **Error Handling**: Robust error detection with automatic retry mechanisms

## API Reference

The backend service exposes several REST endpoints for programmatic access:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/analyze-and-fetch` | POST | Extract verification data (synchronous) |
| `/analyze-and-fetch-stream` | POST | Extract verification data with real-time progress (SSE) |
| `/analyze-rule-stream` | POST | Stream Codex analysis for individual rules (SSE) |
| `/generate-fix-prompt` | POST | Generate repair prompts from analysis results |
| `/fix-sequential-stream` | POST | Execute sequential repair workflow (SSE) |
| `/kill-processes` | POST | Terminate all running processes |
| `/list-conf` | GET | List available `.conf` files (`?projectPath=<absolute_path>`) |

## Project Structure

```
certora-scraper/
├── certora_analyzer.html          # Main web interface
├── scripts/
│   ├── certora_auto_server.mjs    # Backend API server
│   ├── certora_scrape.mjs         # Scraping utilities  
│   └── get_failed_rules.mjs       # CLI tool for failed rules
└── package.json                   # Dependencies and scripts
```

### File Descriptions

- **`certora_analyzer.html`**: Interactive web interface for verification management
- **`certora_auto_server.mjs`**: Core backend service handling API requests, Playwright scraping, and process orchestration
- **`certora_scrape.mjs`**: Specialized scraping functions and utilities
- **`get_failed_rules.mjs`**: Command-line utility for extracting non-VERIFIED rules

## Troubleshooting

### Common Issues

| Problem | Solution |
|---------|----------|
| **Configuration dropdown empty** | Ensure `<workdir>/certora/conf` exists and contains `.conf` files. Click "Refresh" button. |
| **Analysis fails to start** | Check that the backend service is running and the Certora URL is valid and accessible. |
| **Analysis results take too long to appear** | Try manually stopping the current analysis using the "Stop" button, then restart the analysis process. This can resolve stuck or slow analysis tasks. |