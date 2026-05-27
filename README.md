# @fullmention/mcp-server

[![npm version](https://img.shields.io/npm/v/@fullmention/mcp-server.svg)](https://www.npmjs.com/package/@fullmention/mcp-server)
[![License](https://img.shields.io/npm/l/@fullmention/mcp-server.svg)](https://github.com/riisager/fullmention)

The **FullMention Model Context Protocol (MCP) Server** is a secure, high-performance gateway that allows Large Language Models (LLMs) and AI agents (such as Claude Desktop, Cursor, or custom agent networks) to interact directly with the [FullMention](https://www.fullmention.com) Public API.

By exposing FullMention’s stateless recommendation snapshots as native MCP tools and structured resources, your AI models can seamlessly monitor AI visibility, manage keywords, estimate credit costs, and trigger batch analysis runs.

---

> [!WARNING]
> ### ⚠️ Crucial: Tag-Prefix Sensitivity
> FullMention uses a prefix-based tag hierarchy to keep things organized (e.g., `client:<name>`, `market:<country>`, or `category:<topic>`).
> 
> * **Exact Matches Only:** If a keyword is registered with the tag `client:acme`, querying or filtering by `acme` **will NOT** match. The prefix is part of the tag name.
> * **Best Practice:** Always instruct your AI models to use the fully qualified, prefixed tag name (e.g., `client:acme` instead of just `acme`) when creating keywords, triggering runs, or calculating Share of Voice.

---

## 🚀 Quickstart: Connect your AI Client (Local Desktop)

Since the server is published as a zero-install NPM package, you can connect it instantly using `npx`.

### 1. Claude Desktop Setup
Add the following configuration to your `claude_desktop_config.json` (typically located at `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS or `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "fullmention": {
      "command": "npx",
      "args": ["-y", "@fullmention/mcp-server"],
      "env": {
        "FULLMENTION_API_KEY": "your_fm_live_or_test_key_here"
      }
    }
  }
}
```

> [!TIP]
> **Version Pinning:** To prevent breaking changes from affecting your production workflows, consider pinning a specific SemVer version when starting via npx:
> `"args": ["-y", "@fullmention/mcp-server@0.1.0"]`

### 2. Cursor Setup
1. Open Cursor Settings and navigate to **Features** -> **MCP**.
2. Click **+ Add New MCP Server**.
3. Fill in the server parameters:
   - **Name:** `FullMention`
   - **Type:** `stdio`
   - **Command:** `npx -y @fullmention/mcp-server`
4. Add the environment variable `FULLMENTION_API_KEY` and paste your key.
5. Click **Save**.

---

## 🛡️ Core Architecture & Smart Shielding

Designed from the ground up to be **AI-safe** and **highly resource-efficient**, automatically shielding your API quotas and credit budgets:

* 🛡️ **In-Memory Query Shielding:** Caches query responses (60-second TTL) to protect your external API rate limits from redundant agent loops.
* 🚦 **Status Polling Guardrails:** Detects rapid-succession polling of active batch-run statuses. If an AI agent polls the server within **8 seconds**, the server intercepts the network call and returns cached state with a `[POLLED_TOO_FAST_CACHED_WARNING]`, saving network overhead and API stress.
* ⚡ **Conflict Safety:** Gracefully handles `409 Conflict` scenarios if a run is already active under specific tag filters, automatically extracting the active `runId` and returning `[RUN_ALREADY_PROCESSING_CONFLICT]` to guide the AI model without crashing.
* 📊 **Server-Side Share of Voice:** Automates brand-visibility calculation server-side with `get_share_of_voice` to completely prevent mathematical hallucinations in LLMs.
* 🚀 **Server-Side Token Optimization:** Supports a `format: "markdown"` parameter. Instead of sending raw verbose JSON to the LLM, the MCP server automatically compiles your data into **highly compressed, dense Markdown tables**, saving massive token overhead and drastically reducing your LLM input cost.

---

## 🌐 Exponentiate with Cloud Deployment (SSE Mode)

For SaaS and cloud architectures, the FullMention MCP Server supports **SSE (Server-Sent Events) HTTP Transport** dynamically out of the box. 

### Launching in SSE Mode:
To spin up the HTTP gateway on port `3000` (or configured `PORT` / `FULLMENTION_MCP_PORT`):
```bash
npx -y @fullmention/mcp-server --sse
```

### Read-Only Security Mode
For public gateways or shared team environments, you can configure the MCP server in a strictly read-only mode by passing `FULLMENTION_MCP_READONLY=true`. This blocks all mutating actions (such as triggering runs, creating or deleting keywords):
```bash
PORT=3000 FULLMENTION_MCP_READONLY=true npx -y @fullmention/mcp-server --sse
```

### 100% Secure Metrics Endpoint
When hosted in SSE mode, you can inspect diagnostics and live caching performance metrics via:
```bash
curl http://localhost:3000/diagnostics
```

---

## 📋 Detailed Tool & Parameter Reference

FullMention MCP server exposes **17 dedicated tools**. Below is the complete parameter schema and response shape for each tool:

### 📊 System & Quota Tools

#### 1. `get_status`
Retrieve dynamic system and search engine status.
* **Parameters:** None.
* **Return (JSON):**
  ```json
  {
    "status": "operational",
    "engines": {
      "openai": "operational",
      "gemini": "operational"
    }
  }
  ```

#### 2. `get_quota`
Retrieve account quota limits and current usage.
* **Parameters:**
  * `bypassCache` *(boolean, optional)*: If `true`, bypasses in-memory caching.
* **Return (JSON):**
  ```json
  {
    "monthlyLimit": 10000,
    "remaining": 7450,
    "reserved": 200,
    "used": 2350
  }
  ```

#### 3. `get_usage_stats`
Retrieve detailed credit usage stats and pricing matrix.
* **Parameters:**
  * `bypassCache` *(boolean, optional)*: If `true`, bypasses in-memory caching.
* **Return:** Detailed Markdown summary including remaining credits, monthly limit, and the active cost matrix.

---

### 🗃️ Keyword Management

#### 4. `list_keywords`
List all monitored keywords in FullMention with pagination.
* **Parameters:**
  * `tags` *(string, optional)*: Comma-separated tags to filter by (e.g., `"client:acme,market:dk"`).
  * `tagMode` *("and" | "or", optional, default: "or")*: Match mode for tag filter.
  * `country` *(string, optional)*: Country name filter (e.g., `"Denmark"`).
  * `language` *(string, optional)*: Language name filter (e.g., `"Danish"`).
  * `location` *(string, optional)*: City level location (e.g., `"Copenhagen"`).
  * `engine` *("openai" | "openai-mini" | "gemini", optional)*: AI search engine.
  * `limit` *(number, optional, default: 100)*: Limit keywords per page.
  * `cursor` *(string, optional)*: Cursor for pagination.
  * `format` *("compact" | "raw" | "markdown", optional, default: "compact")*: Return payload format.
  * `bypassCache` *(boolean, optional)*: If `true`, pulls live data.

#### 5. `create_keywords`
Create one or more keywords idempotent.
* **Parameters:**
  * `keywords` *(array of objects, required)*:
    * `keyword` *(string, required)*: Search query intent (e.g., `"best running shoes"`).
    * `country` *(string, required)*: Country name (e.g., `"Denmark"`).
    * `countryCode` *(string, required)*: ISO 2-letter code (e.g., `"DK"`).
    * `language` *(string, required)*: Language name (e.g., `"Danish"`).
    * `languageCode` *(string, required)*: ISO 2-letter code (e.g., `"da"`).
    * `location` *(string, optional, nullable)*: City/local level (e.g., `"Copenhagen"`).
    * `engines` *(array of strings, optional, default: `["openai-mini"]`)*.
    * `tags` *(array of strings, optional)*: Prefixed tags.
  * `idempotencyKey` *(string, optional)*: Unique UUID to prevent double-creation.

#### 6. `bulk_create_keywords`
Bulk-create keywords using a simple string array with shared geographical parameters.
* **Parameters:**
  * `keywords` *(array of strings, required)*: Intents to create.
  * `country` / `countryCode` / `language` / `languageCode` / `location` *(optional)*: Shared config.
  * `engines` *(optional, default: `["openai-mini"]`)*: Target AI engines.
  * `tags` *(optional)*: Shared tags.
  * `idempotencyKey` *(string, optional)*.

#### 7. `update_keyword`
Update settings or tags for an existing keyword.
* **Parameters:**
  * `keywordId` *(string, required)*: The target keyword ID.
  * `keyword` / `country` / `countryCode` / `language` / `languageCode` / `location` / `engines` / `tags` *(optional)*.
  * `idempotencyKey` *(string, optional)*.

#### 8. `delete_keyword`
Deactivate or soft-delete a keyword.
* **Parameters:**
  * `keywordId` *(string, required)*: Keyword ID.
  * `idempotencyKey` *(string, optional)*.

---

### 🚦 Tags & Runs (Batch Analysis)

#### 9. `list_tags`
List active tags currently utilized across your keywords.
* **Parameters:**
  * `prefix` *(string, optional)*: Prefix filter (e.g., `"client:"`).
  * `limit` / `cursor` / `bypassCache` *(optional)*.

#### 10. `estimate_run`
Pre-estimate credit consumption prior to starting a batch analysis.
* **Parameters:**
  * `tags` *(array of strings, required)*: Tag filters determining keywords.
  * `tagMode` *("and" | "or", optional)*: Match mode.
  * `fanout` *(boolean, optional)*: Enable web search search.
* **Return (JSON):**
  ```json
  {
    "estimatedCredits": 25,
    "keywordCount": 25,
    "insufficientCredits": false
  }
  ```

#### 11. `trigger_run`
Trigger an asynchronous batch analysis (run) on all matching keywords.
* **Parameters:**
  * `tags` *(array of strings, required)*: Target tags.
  * `tagMode` *("and" | "or", optional)*.
  * `fanout` *(boolean, optional)*: Enabling search query fanout costs extra credits.
  * `idempotencyKey` *(string, optional)*.

#### 12. `get_run_status`
Fetch progress and active status of a batch run.
* **Parameters:**
  * `runId` *(string, required)*: Run ID.

#### 13. `cancel_run`
Cancel an active batch analysis run and release remaining reserved quota.
* **Parameters:**
  * `runId` *(string, required)*: Run ID.

#### 14. `list_runs`
List recent batch runs with timestamps and status logs.
* **Parameters:**
  * `limit` / `cursor` / `bypassCache` *(optional)*.

---

### 📈 Results & Analytics

#### 15. `get_latest_results`
Retrieve the latest AI search visibility recommendations.
* **Parameters:**
  * `tags` *(string, optional)*: Comma-separated tag filter.
  * `tagMode` / `country` / `language` / `location` / `engine` / `keywordId` *(optional)*.
  * `limit` / `cursor` / `bypassCache` *(optional)*.
  * `format` *("compact" | "raw" | "markdown", optional, default: "compact")*.

#### 16. `get_share_of_voice`
Calculate brand Share of Voice % and average placements server-side.
* **Parameters:**
  * `tags` *(string, required)*: Target tags for calculation.
  * `tagMode` *("and" | "or", optional)*.
  * `engine` *(optional)*: Specific search engine filter.
  * `brands` *(array of strings, optional)*: Brands to isolate.
  * `format` *("json" | "markdown", optional, default: "markdown")*.
  * `bypassCache` *(boolean, optional)*.
* **Return:** Compiles a dense Markdown table reporting visibility share percentages and rank metrics.

#### 17. `get_fanout_sources`
Retrieve the underlying web query search sources that influenced a recommendation.
* **Parameters:**
  * `resultId` *(string, required)*.
  * `limit` / `cursor` *(optional)*.

---

## 🧩 Exposed Native Resources

Your AI models can consume structured datasets directly using these resource URIs:
* `fullmention://keywords/active` — Real-time markdown table containing all active keywords.
* `fullmention://schema/openapi` — The complete machine-readable OpenAPI spec.
* `fullmention://results/latest/tag/{tag}` — Live markdown recommendation summaries for a given tag.

---

## ⚠️ Known Issues

* **Engine Filter 500 Bug:** Filtering results or list endpoints strictly by `engine` (specifically `gemini` since Gemini does not support web search fanout) can occasionally return a `500 Internal Server Error` from the backend API.
  * *Workaround:* Omit the `engine` parameter to fallback safely to the default `openai-mini` pipeline.
