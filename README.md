# @fullmention/mcp-server

[![npm version](https://img.shields.io/npm/v/@fullmention/mcp-server.svg)](https://www.npmjs.com/package/@fullmention/mcp-server)
[![License](https://img.shields.io/npm/l/@fullmention/mcp-server.svg)](https://github.com/riisager/fullmention)

The **FullMention MCP Server** provides a secure, high-performance gateway that allows Large Language Models (LLMs) and AI agents (such as Claude Desktop, Cursor, or custom agent networks) to interact directly with the FullMention Public API. 

By exposing FullMention’s stateless simulation runs as native MCP tools and structured resources, your AI models can trigger batch analysis runs, track progress, fetch results, and analyze visibility metrics seamlessly.

---

> [!NOTE]
> ### 📊 Explicit Ranking System
> AI recommendation results in FullMention utilize flat ranking lists (`brandRankings`, `websiteRankings`, `productRankings`).
> * **Position Order:** Each item in these lists includes a `position` property starting at 1. Position 1 represents the top recommendation / most prominent suggestion within the LLM context, followed sequentially by lower rankings.
> * **Rule:** The elements in these lists are strictly ordered by relevance and visibility prominence. Do **not** sort these arrays alphabetically, as doing so discards valuable visibility intelligence!

---

## Quickstart: Connect your AI Client (Local Desktop)

To connect the FullMention MCP Server to your local editor or chat client, configure your client using the configurations below.

### 1. Claude Desktop Setup
Add the following configuration to your `claude_desktop_config.json` (typically located at `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS or `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "fullmention": {
      "command": "npx",
      "args": ["-y", "@fullmention/mcp-server"],
      "env": {
        "FULLMENTION_API_KEY": "your_fm_live_key_here"
      }
    }
  }
}
```

> [!TIP]
> **Version Pinning:** To prevent breaking changes from affecting your production workflows, consider pinning a specific SemVer version when starting via npx:
> `"args": ["-y", "@fullmention/mcp-server@2.0.0"]`

### 2. Cursor Setup
1. Open Cursor Settings and go to **Features** -> **MCP**.
2. Click **+ Add New MCP Server**.
3. Fill in the configuration:
   - **Name:** `FullMention`
   - **Type:** `stdio`
   - **Command:** `npx -y @fullmention/mcp-server`
4. Set the environment variable `FULLMENTION_API_KEY` to your API key.
5. Click **Save**.

---

## Core Architecture & Smart Shielding

The FullMention MCP Server is designed from the ground up to be **AI-safe** and **highly resource-efficient**, shielding your API quotas and credit budgets automatically:

* 🛡️ **In-Memory Query Shielding:** Caches query responses (60-second TTL) to protect your external API rate limits from redundant agent loops.
* 🚦 **Status Polling Guardrails:** Detects rapid-succession polling of active batch-run statuses. If an AI agent polls the server within **8 seconds**, the server intercepts the network call and returns cached state with a `[POLLED_TOO_FAST_CACHED_WARNING]`, saving network overhead and API stress.
* 📊 **Server-Side Share of Voice:** Automates brand-visibility calculation server-side with `get_share_of_voice` to completely prevent mathematical hallucinations in LLMs.
* 🚀 **Server-Side Token Optimization:** Supports a `format: "markdown"` parameter. Instead of sending raw verbose JSON to the LLM, the MCP server automatically compiles your data into **highly compressed, dense Markdown tables**, saving massive token overhead and drastically reducing your LLM input cost.

---

## Exponentiate with Cloud Deployment (SSE Mode)

For SaaS and cloud architectures, the FullMention MCP Server supports **SSE (Server-Sent Events) HTTP Transport** dynamically out of the box. 

### Launching in SSE Mode:
To spin up the HTTP gateway on port `3000` (or configured `PORT` / `FULLMENTION_MCP_PORT`):
```bash
npx -y @fullmention/mcp-server --sse
```

### 100% Secure Metrics Endpoint
When hosted in SSE mode, you can inspect diagnostics and live caching performance metrics via:
```bash
curl http://localhost:3000/diagnostics
```

---

## Detailed Tool & Parameter Reference

FullMention MCP server exposes **7 dedicated tools**. Below is the complete parameter schema and response shape for each tool:

### 📊 System & Quota Tools

#### 1. `get_status`
Retrieve dynamic system and engine status from the FullMention platform.
* **Parameters:** None.
* **Response (JSON):**
  ```json
  {
    "status": "operational",
    "engines": {
      "openai": "operational",
      "openaiMini": "operational",
      "gemini": "operational"
    }
  }
  ```

#### 2. `get_quota`
Retrieve account quota limits and current usage.
* **Parameters:**
  * `bypassCache` *(boolean, optional)*: If set to `true`, bypasses the cache.
* **Response (JSON):**
  ```json
  {
    "limit": 10000,
    "used": 2350,
    "extra": 0,
    "remaining": 7650
  }
  ```

#### 3. `get_usage_stats`
Retrieve detailed quota and credit statistics with budget warnings.
* **Parameters:**
  * `bypassCache` *(boolean, optional)*: If set to `true`, bypasses the cache.
* **Response:** Markdown summary of remaining credits, monthly limit, and the current credit pricing matrix.

---

### 🚦 Simulations & Runs

#### 4. `trigger_run`
Trigger an asynchronous stateless simulation run.
* **Parameters:**
  * `keywords` *(array of strings, required)*: List of keywords to simulate (maximum 500).
  * `engines` *(array of strings, required)*: AI search engines to target (e.g. `["openai", "openai-mini", "gemini"]`).
  * `country` *(string, required)*: Country context (e.g., `"Denmark"` or `"United States"`).
  * `language` *(string, required)*: Language context (e.g., `"Danish"` or `"English"`).
  * `location` *(string, optional, nullable)*: Optional specific city context (e.g., `"Copenhagen"`).
  * `fanout` *(boolean, optional)*: Enable web search fanout (adds 1 credit cost per keyword).
  * `webhookUrl` *(string, optional, nullable)*: Optional fully qualified HTTP/S URL to call back when the run finishes.
  * `idempotencyKey` *(string, optional)*: Unique string to prevent duplicate runs.
* **Response (JSON):**
  ```json
  {
    "id": "run_987abc",
    "status": "queued",
    "progress": {
      "status": "queued",
      "totalRequests": 10,
      "completedRequests": 0,
      "failedRequests": 0,
      "percentage": 0
    },
    "estimatedCredits": 10,
    "createdAt": "2026-06-10T22:00:00.000Z",
    "completedAt": null,
    "expiresAt": "2026-06-11T22:00:00.000Z",
    "statusUrl": "https://api.fullmention.com/v1/runs/run_987abc"
  }
  ```

#### 5. `get_run_status`
Retrieve details, progress, and results of a run using runId.
* **Parameters:**
  * `runId` *(string, required)*: The ID of the run.
  * `format` *("compact" | "raw" | "markdown", optional, default: "compact")*: Response format.
  * `bypassCache` *(boolean, optional)*: If `true`, bypasses cache.
* **Response:** A dense Markdown table (if `format: "markdown"`) or a trimmed JSON representation of the run and results.

#### 6. `get_fanout_sources`
Retrieve full paginated web sources and search queries for a specific recommendation result.
* **Parameters:**
  * `runId` *(string, required)*: The ID of the batch run.
  * `resultId` *(string, required)*: The result snapshot ID.
  * `limit` *(number, optional)*.
  * `cursor` *(string, optional)*.
* **Response (JSON):**
  ```json
  {
    "data": [
      {
        "domain": "ahrefs.com",
        "url": "https://ahrefs.com/blog/best-seo-tools/",
        "title": "Best SEO Tools for 2026",
        "snippet": "Read our comprehensive review of top SEO suites...",
        "crawledAt": "2026-06-10T22:05:00.000Z"
      }
    ],
    "meta": {
      "nextCursor": "eyJza2lwIjoxfQ=="
    }
  }
  ```

#### 7. `get_share_of_voice`
Calculate Share of Voice % and average ranking server-side for a completed run.
* **Parameters:**
  * `runId` *(string, required)*: Completed run ID to analyze.
  * `brands` *(array of strings, optional)*: Specific target brands for comparison.
  * `format` *("json" | "markdown", optional, default: "markdown")*.
  * `bypassCache` *(boolean, optional)*.
* **Response:** Markdown table report or aggregated JSON with visibility percentages.

---

## Exposed Native Resources

AI models can query data directly using these structured, native resources:

* `fullmention://schema/openapi` — Machine-readable API contract.
* `fullmention://runs/{runId}` — Summarized markdown report for a specific completed run.

---

## AI-Guided Prompts

Predefined agent templates included in the MCP server:
* `brand-analysis`: Analyzes competitor occurrences in the results of a completed run.
* `credit-optimization`: Advises on credit costs for a planned run based on keyword and engine counts.
* `gap-analysis`: Analyzes keyword gaps where competitors are visible but your own brand is missing in a run.
* `citation-coverage`: Maps domains and web sources for a run.
* `category-dominance`: Shows category dominance based on AI recommendations in a run.
* `executive-digest`: Generates weekly executive KPI summary from a run.
