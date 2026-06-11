import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as dotenv from "dotenv";
import { loadRuntimeConfig } from "@fullmention/config";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";

export const apiKeyStorage = new AsyncLocalStorage<string>();

dotenv.config();

export const serverMetrics = {
  cacheHits: 0,
  cacheMisses: 0,
  apiCalls: 0,
  apiErrors: 0,
  preventedPolls: 0,
  runsTriggered: 0,
  startTime: Date.now()
};

const config = loadRuntimeConfig();
const API_URL = config.publicApiBaseUrl;
const API_KEY = process.env.FULLMENTION_API_KEY;

console.error(`[FullMention MCP] Initializing with API URL: ${API_URL}`);
if (!API_KEY) {
  console.error("[FullMention MCP] Warning: FULLMENTION_API_KEY is missing from environment variables.");
}

class MemoryCache {
  private cache = new Map<string, { value: any; expiresAt: number }>();
  private ttlMs: number;

  constructor(ttlSeconds: number = 60) {
    this.ttlMs = ttlSeconds * 1000;
  }

  get(key: string): any | null {
    const entry = this.cache.get(key);
    if (!entry) {
      serverMetrics.cacheMisses++;
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      serverMetrics.cacheMisses++;
      return null;
    }
    serverMetrics.cacheHits++;
    return entry.value;
  }

  set(key: string, value: any): void {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  clear(): void {
    this.cache.clear();
  }
}

const cacheTTL = Number(process.env.FULLMENTION_MCP_CACHE_TTL_SEC) || 60;
const queryCache = new MemoryCache(cacheTTL);
console.error(`[FullMention MCP] Caching is ACTIVE (TTL: ${cacheTTL}s)`);

const lastStatusCheck = new Map<string, { timestamp: number; lastData: any }>();

async function callApi(options: {
  path: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: any;
  idempotencyKey?: string;
}) {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const activeApiKey = apiKeyStorage.getStore() ?? process.env.FULLMENTION_API_KEY;

  if (activeApiKey) {
    headers["Authorization"] = `Bearer ${activeApiKey}`;
  } else if (options.path !== "/status" && options.path !== "/health") {
    throw new Error("[auth_error] Valid FULLMENTION_API_KEY is missing. Provide a valid API key via environment variables or Authorization header. See documentation at https://api.fullmention.com/docs/ for setup instructions.");
  }

  if (options.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }

  const url = `${API_URL}${options.path}`;
  console.error(`[FullMention MCP] Kalder API: ${method} ${url}`);

  try {
    serverMetrics.apiCalls++;
    const response = await fetch(url, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    let payload: any = null;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      payload = await response.json();
    }

    if (!response.ok) {
      serverMetrics.apiErrors++;
      const errorMsg = payload?.error?.message ?? `API svarede med status ${response.status}`;
      const errorCode = payload?.error?.code ?? "api_error";
      const details = payload?.error?.details ? ` Detaljer: ${JSON.stringify(payload.error.details)}` : "";
      
      console.error(`[FullMention MCP] API Error: [${errorCode}] ${errorMsg}${details}`);
      throw new Error(`[${errorCode}] ${errorMsg}.${details} For guidelines and documentation, visit https://api.fullmention.com/docs/`);
    }

    return payload;
  } catch (error: any) {
    console.error(`[FullMention MCP] Network or API error: ${error.message}`);
    throw error;
  }
}

function toMcpSchema(zodSchema: z.ZodObject<any, any>) {
  const jsonSchema: any = zodToJsonSchema(zodSchema, { target: "jsonSchema7" });
  delete jsonSchema.$schema;
  delete jsonSchema.definitions;
  return jsonSchema;
}

const GetStatusInput = z.object({});

const GetQuotaInput = z.object({
  bypassCache: z.boolean().default(false).optional().describe("If true, bypasses the cache for this request.")
});

const TriggerRunInput = z.object({
  keywords: z.array(z.string().min(1).max(200)).min(1).max(500).describe("List of keywords to analyze (maximum 500)."),
  engines: z.array(z.enum(["openai", "openai-mini", "gemini"])).min(1).describe("AI search engines to target."),
  country: z.string().min(1).max(100).describe("Country context (e.g. 'Denmark' or 'United States')."),
  language: z.string().min(1).max(100).describe("Language context (e.g. 'Danish' or 'English')."),
  location: z.string().max(120).optional().nullable().describe("Optional specific city or location context, e.g. 'Copenhagen'."),
  fanout: z.boolean().default(false).optional().describe("Whether to perform web search fanout (+1 credit cost per keyword)."),
  webhookUrl: z.string().url().optional().nullable().describe("Optional fully qualified HTTP/S URL called back when run finishes."),
  metadata: z.string({ invalid_type_error: "Metadata must be a string." })
    .max(500, "Metadata field exceeds the maximum limit of 500 characters.")
    .optional()
    .nullable()
    .describe("Optional user-supplied custom metadata to associate with the run."),
  idempotencyKey: z.string().optional().describe("Optional Idempotency-Key header to prevent duplicate runs.")
});

const GetRunStatusInput = z.object({
  runId: z.string().describe("The ID of the run to check status/results for."),
  format: z.enum(["compact", "raw", "markdown"]).default("compact").optional().describe("Response format. 'markdown' returns a formatted markdown report, 'compact' trims JSON clutter, 'raw' returns the full JSON response."),
  bypassCache: z.boolean().default(false).optional().describe("If true, bypasses the in-memory status check cache.")
});

const GetFanoutSourcesInput = z.object({
  runId: z.string().describe("The ID of the batch run."),
  resultId: z.string().describe("The ID of the result snapshot."),
  limit: z.number().int().min(1).max(500).optional().describe("Maximum number of sources per page."),
  cursor: z.string().optional().describe("Pagination cursor.")
});

const GetShareOfVoiceInput = z.object({
  runId: z.string().describe("The ID of the completed stateless run."),
  brands: z.array(z.string()).optional().describe("Optional list of specific brand names to compare."),
  format: z.enum(["json", "markdown"]).default("markdown").optional().describe("Response format. Defaults to 'markdown'."),
  bypassCache: z.boolean().default(false).optional().describe("If true, bypasses the cache.")
});

const GetUsageStatsInput = z.object({
  bypassCache: z.boolean().default(false).optional().describe("If true, bypasses the cache.")
});

const server = new Server(
  {
    name: "fullmention-mcp",
    version: "2.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {
        templates: true,
      },
      prompts: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_status",
        description: "Get dynamic system and search engine status (e.g., operational, degraded etc. for OpenAI and Gemini integrations).",
        inputSchema: toMcpSchema(GetStatusInput),
      },
      {
        name: "get_quota",
        description: "Get available quota and credit details for the account (remaining credits, used, monthly limit, etc.).",
        inputSchema: toMcpSchema(GetQuotaInput),
      },
      {
        name: "trigger_run",
        description: "Trigger an asynchronous stateless simulation run for a list of keywords and selected engines.",
        inputSchema: toMcpSchema(TriggerRunInput),
      },
      {
        name: "get_run_status",
        description: "Retrieves details, progress, and results of an active asynchronous run using runId. The status field in response can be 'queued', 'processing', 'success' (completed successfully), or 'failed' (completed with failure). Poll until status is 'success' or 'failed'.",
        inputSchema: toMcpSchema(GetRunStatusInput),
      },
      {
        name: "get_fanout_sources",
        description: "Get full paginated web search sources (fanout) that influenced a specific AI recommendation result.",
        inputSchema: toMcpSchema(GetFanoutSourcesInput),
      },
      {
        name: "get_share_of_voice",
        description: "Automatically aggregates brand recommendations and calculates Share of Voice % and average ranking for a completed run.",
        inputSchema: toMcpSchema(GetShareOfVoiceInput),
      },
      {
        name: "get_usage_stats",
        description: "Retrieve detailed quota and credit usage statistics with budget warnings.",
        inputSchema: toMcpSchema(GetUsageStatsInput),
      },
    ],
  };
});

function formatResults(data: any, format: "compact" | "raw" | "markdown"): any {
  if (format === "raw") return data;

  const results = data.results ?? data.data ?? [];
  if (format === "markdown") {
    let md = "";
    if (results.length === 0) {
      return `Run Status: ${data.status || "processing"} (Progress: ${data.progress?.percentage ?? 0}%). No results are available yet. Poll again when the run is completed.`;
    }

    for (const res of results) {
      md += `### Keyword: **${res.keyword}** (${res.engine})\n`;
      md += `* Country/Language/Location: ${res.country} / ${res.language} / ${res.location || "National"}\n`;
      md += `* Description: ${res.description || "-"}\n`;
      md += `* Categories: ${res.categorySuggestions?.join(", ") || "-"}\n`;
      md += `* Sources: ${res.fanout?.totalSourcesFound ?? 0} found via ${res.fanout?.queryCount ?? 0} AI search queries.\n\n`;

      if (res.brandRankings?.length > 0) {
        md += "#### Brand Rankings:\n";
        md += "| Position | Brand Name |\n";
        md += "| :---: | :--- |\n";
        for (const b of res.brandRankings) {
          md += `| ${b.position} | **${b.name}** |\n`;
        }
        md += "\n";
      }

      if (res.websiteRankings?.length > 0) {
        md += "#### Recommended Websites:\n";
        md += "| Position | Domain |\n";
        md += "| :---: | :--- |\n";
        for (const w of res.websiteRankings) {
          md += `| ${w.position} | ${w.domain} |\n`;
        }
        md += "\n";
      }

      if (res.productRankings?.length > 0) {
        md += "#### Product/Service Rankings:\n";
        md += "| Position | Product / Service |\n";
        md += "| :---: | :--- |\n";
        for (const p of res.productRankings) {
          md += `| ${p.position} | ${p.name} |\n`;
        }
        md += "\n";
      }

      md += "\n---\n\n";
    }
    md += "\n> [Slim Note]\n> **FullMention Data Directive:** This is a snapshot of AI recommendations. The order of elements in returned arrays is based on Explicit Ranking (position 1 is the highest) and must not be re-sorted. FullMention does not host historical data. Save this report locally in your own system if you want to track trends over time.\n";
    return md;
  }

  // compact JSON
  return {
    id: data.id,
    status: data.status,
    progress: data.progress,
    estimatedCredits: data.estimatedCredits,
    results: results.map((res: any) => ({
      id: res.id,
      keyword: res.keyword,
      country: res.country,
      language: res.language,
      location: res.location,
      engine: res.engine,
      description: res.description,
      categorySuggestions: res.categorySuggestions,
      brandRankings: res.brandRankings,
      websiteRankings: res.websiteRankings,
      productRankings: res.productRankings,
      fanout: res.fanout ? {
        queryCount: res.fanout.queryCount,
        totalSourcesFound: res.fanout.totalSourcesFound
      } : undefined,
      updatedAt: res.updatedAt
    })),
    createdAt: data.createdAt,
    completedAt: data.completedAt,
    expiresAt: data.expiresAt
  };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  const isMutation = ["trigger_run"].includes(name);
  if (isMutation && process.env.FULLMENTION_MCP_READONLY === "true") {
    console.error(`[FullMention MCP] REJECTED: Tool ${name} is disabled in read-only mode (FULLMENTION_MCP_READONLY=true).`);
    return {
      isError: true,
      content: [{
        type: "text",
        text: `Error: Tool '${name}' cannot be executed. The MCP server is configured in read-only mode (FULLMENTION_MCP_READONLY=true) to protect your data from accidental modifications.`
      }]
    };
  }

  const isCacheable = ["get_status", "get_quota", "get_run_status", "get_fanout_sources", "get_share_of_voice", "get_usage_stats"].includes(name);
  const bypassCache = args.bypassCache === true;
  const cacheKey = `${name}:${JSON.stringify(args)}`;

  if (isCacheable && !bypassCache) {
    const cachedResponse = queryCache.get(cacheKey);
    if (cachedResponse) {
      console.error(`[FullMention MCP] Cache HIT for tool: ${name}`);
      return { content: [{ type: "text", text: typeof cachedResponse === "string" ? cachedResponse : JSON.stringify(cachedResponse, null, 2) }] };
    }
  }

  try {
    if (name === "get_status") {
      const data = await callApi({ path: "/status" });
      if (isCacheable) queryCache.set(cacheKey, data);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }

    if (name === "get_quota") {
      const data = await callApi({ path: "/quota" });
      if (isCacheable) queryCache.set(cacheKey, data);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }

    if (name === "trigger_run") {
      const { idempotencyKey, fanout, ...runParams } = args;
      const effectiveIdempotencyKey = (idempotencyKey as string) || randomUUID();
      const data = await callApi({
        path: "/runs",
        method: "POST",
        body: {
          ...runParams,
          options: { fanout: fanout ?? false }
        },
        idempotencyKey: effectiveIdempotencyKey,
      });
      queryCache.clear();
      serverMetrics.runsTriggered++;

      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }

    if (name === "get_run_status") {
      const runId = args.runId as string;
      const now = Date.now();
      const cachedStatus = lastStatusCheck.get(runId);

      if (cachedStatus && (now - cachedStatus.timestamp) < 8000) {
        console.error(`[FullMention MCP] Polling of run ${runId} prevented (cached for ${Math.round((now - cachedStatus.timestamp) / 1000)}s)`);
        serverMetrics.preventedPolls++;
        
        const responseData = {
          ...cachedStatus.lastData,
          _meta: {
            warning: "[POLLED_TOO_FAST_CACHED_WARNING] You are polling status too quickly (less than 8 seconds since the last check). To protect your API rate limits, we return the latest cached data. Please wait at least 8 seconds before calling get_run_status again.",
            cachedSecondsAgo: Math.round((now - cachedStatus.timestamp) / 1000),
            nextAllowedCheckIn: Math.max(1, Math.round((8000 - (now - cachedStatus.timestamp)) / 1000))
          }
        };

        return {
          content: [{ type: "text", text: JSON.stringify(responseData, null, 2) }],
        };
      }

      const data = await callApi({ path: `/runs/${runId}` });
      lastStatusCheck.set(runId, {
        timestamp: now,
        lastData: data
      });

      const format = (args.format as "compact" | "raw" | "markdown") ?? "compact";
      const formatted = formatResults(data, format);

      return {
        content: [{ type: "text", text: typeof formatted === "string" ? formatted : JSON.stringify(formatted, null, 2) }],
      };
    }

    if (name === "get_fanout_sources") {
      const queryParams = new URLSearchParams();
      if (args.limit) queryParams.append("limit", String(args.limit));
      if (args.cursor) queryParams.append("cursor", args.cursor as string);

      const qs = queryParams.toString() ? `?${queryParams.toString()}` : "";
      const data = await callApi({ path: `/runs/${args.runId}/results/${args.resultId}/fanout-sources${qs}` });

      if (isCacheable) queryCache.set(cacheKey, data);

      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }

    if (name === "get_share_of_voice") {
      const runId = args.runId as string;
      const data = await callApi({ path: `/runs/${runId}` });

      const results = data.results ?? [];
      const totalKeywords = results.length;

      if (totalKeywords === 0) {
        return {
          content: [{
            type: "text",
            text: "No results found for this run. Please ensure the run status is completed."
          }]
        };
      }

      const brandCounts = new Map<string, { count: number; ranks: number[]; domains: Set<string> }>();
      
      for (const res of results) {
        const brandRankings = res.brandRankings ?? [];
        const brandsSeenThisKeyword = new Set<string>();

        for (const brandRank of brandRankings) {
          const rawName = brandRank.name as string;
          if (!rawName) continue;
          
          const brandKey = rawName.trim().toLowerCase();
          
          if (!brandsSeenThisKeyword.has(brandKey)) {
            brandsSeenThisKeyword.add(brandKey);
            
            const existing = brandCounts.get(brandKey) ?? { count: 0, ranks: [], domains: new Set<string>() };
            existing.count += 1;
            existing.ranks.push(brandRank.position);

            const matchedWebsite = (res.websiteRankings ?? []).find((w: any) => {
              const domain = String(w.domain).toLowerCase();
              return domain.includes(brandKey) || brandKey.includes(domain.split(".")[0] || "");
            });
            if (matchedWebsite) {
              existing.domains.add(matchedWebsite.domain);
            }

            brandCounts.set(brandKey, existing);
          }
        }
      }

      const sortedBrands = Array.from(brandCounts.entries())
        .map(([nameKey, stats]) => {
          const originalName = results
            .flatMap((r: any) => r.brandRankings ?? [])
            .find((br: any) => br.name?.trim().toLowerCase() === nameKey)?.name || nameKey;
            
          const sov = (stats.count / totalKeywords) * 100;
          const avgRank = stats.ranks.reduce((a, b) => a + b, 0) / stats.ranks.length;
          
          return {
            brandName: originalName,
            mentions: stats.count,
            shareOfVoice: Math.round(sov * 10) / 10,
            avgRank: Math.round(avgRank * 10) / 10,
            domains: Array.from(stats.domains).slice(0, 3)
          };
        })
        .sort((a, b) => b.shareOfVoice - a.shareOfVoice);

      let targetBrands = sortedBrands;
      if (args.brands && Array.isArray(args.brands)) {
        const filterSet = new Set(args.brands.map(b => b.trim().toLowerCase()));
        targetBrands = sortedBrands.filter(b => filterSet.has(b.brandName.toLowerCase()));
      }

      const format = (args.format as "json" | "markdown") ?? "markdown";
      if (format === "json") {
        const payload = { totalKeywords, brands: targetBrands };
        if (isCacheable) queryCache.set(cacheKey, payload);
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
        };
      }

      let md = `## 📊 Share of Voice Report (Run ID: \`${runId}\`)\n`;
      md += `* **Total keywords:** ${totalKeywords}\n\n`;
      md += "| Position | Brand / Competitor | Mentions | Share of Voice % | Average Rank | Primary Domains |\n";
      md += "| :--- | :--- | :---: | :---: | :---: | :--- |\n";

      targetBrands.forEach((b, index) => {
        md += `| ${index + 1} | **${b.brandName}** | ${b.mentions} / ${totalKeywords} | **${b.shareOfVoice}%** | ${b.avgRank} | \`${b.domains.join("`, `") || "-"}\` |\n`;
      });

      md += "\n> [!TIP]\n";
      md += "> **How is Share of Voice calculated?** Mentions indicate the number of keywords where the brand is recommended. The percentage is (Mentions / Total keywords) * 100. A lower average rank is better (rank 1 is best).\n";

      if (isCacheable) queryCache.set(cacheKey, md);

      return {
        content: [{ type: "text", text: md }]
      };
    }

    if (name === "get_usage_stats") {
      const data = await callApi({ path: "/quota" });
      const remaining = data.remainingCredits ?? data.remaining ?? 0;
      const extra = data.extraCredits ?? 0;
      const used = data.usedCredits ?? 0;
      const limit = data.monthlyCreditsLimit ?? data.limit ?? 0;

      const pctUsed = limit > 0 ? Math.round((used / limit) * 100) : 0;

      let md = "## 💳 FullMention Usage and Quota Monitoring\n\n";
      md += `* **Remaining Credits:** **${remaining}** (+ ${extra} extra credits)\n`;
      md += `* **Usage this month:** ${used} / ${limit} credits (${pctUsed}% used)\n\n`;

      if (remaining < 100) {
        md += "> [!WARNING]\n";
        md += "> **Credits are almost exhausted!** You have under 100 credits remaining.\n\n";
      } else {
        md += "> [!NOTE]\n";
        md += "> Your quota is healthy.\n\n";
      }

      md += "### ⚡ Credit Costs per Run (Standard):\n";
      md += "* **OpenAI standard run:** 1 credit per keyword\n";
      md += "* **OpenAI with Fanout (Web search):** 10 credits per keyword (+9 credits)\n";
      md += "* **OpenAI Mini standard run:** 1 credit per keyword\n";
      md += "* **OpenAI Mini with Fanout (Web search):** 2 credits per keyword (+1 credit)\n";

      if (isCacheable) queryCache.set(cacheKey, md);

      return {
        content: [{ type: "text", text: md }]
      };
    }

    throw new Error(`Unknown or unregistered tool: ${name}`);
  } catch (error: any) {
    let errorCode = "execution_error";
    let message = error.message;

    const codeMatch = error.message.match(/^\[([a-zA-Z0-9_]+)\]\s*(.*)/);
    if (codeMatch) {
      errorCode = codeMatch[1];
      message = codeMatch[2];
    }

    if (!message.includes("https://api.fullmention.com/docs/")) {
      message = `${message}. Refer to the API documentation at https://api.fullmention.com/docs/ for details.`;
    }

    const errorResponse = {
      error: {
        tool: name,
        code: errorCode,
        message,
        docs: "https://api.fullmention.com/docs/"
      }
    };

    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(errorResponse, null, 2),
        },
      ],
    };
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "fullmention://schema/openapi",
        name: "FullMention OpenAPI Schema",
        description: "The full OpenAPI 3.1.0 contract for the API directly from the source code.",
        mimeType: "application/yaml",
      },
    ],
  };
});

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
  return {
    resourceTemplates: [
      {
        uriTemplate: "fullmention://runs/{runId}",
        name: "Results for run",
        description: "Retrieves a Markdown report for all results under the specified runId.",
        mimeType: "text/markdown",
      },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;

  if (uri === "fullmention://schema/openapi") {
    let schemaText = "";
    try {
      const fs = await import("fs/promises");
      schemaText = await fs.readFile("/home/riisager/Documents/Antigravati/FullMention/openapi.yaml", "utf-8");
    } catch (e: any) {
      schemaText = JSON.stringify({ error: "Could not load openapi.yaml", details: e.message });
    }

    return {
      contents: [{ uri, mimeType: "application/yaml", text: schemaText }],
    };
  }

  const runMatch = uri.match(/^fullmention:\/\/runs\/(.+)$/);
  if (runMatch) {
    const runId = decodeURIComponent(runMatch[1] || "");
    const payload = await callApi({ path: `/runs/${runId}` });
    const formatted = formatResults(payload, "markdown");

    return {
      contents: [{ uri, mimeType: "text/markdown", text: `# Results for run: \`${runId}\`\n\n${formatted}` }],
    };
  }

  throw new Error(`Unknown resource URI: ${uri}`);
});

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [
      {
        name: "brand-analysis",
        description: "Retrieves the recommendation snapshots for a run and checks occurrences of a specific brand.",
        arguments: [
          {
            name: "brandName",
            description: "The name of the brand you want to investigate (e.g. 'Semrush')",
            required: true,
          },
          {
            name: "runId",
            description: "The completed run ID to retrieve results for",
            required: true,
          },
        ],
      },
      {
        name: "credit-optimization",
        description: "Helps the AI analyze account quotas and plan runs in the most credit-effective way.",
        arguments: [
          {
            name: "keywordCount",
            description: "The number of keywords to run",
            required: true,
          },
          {
            name: "engineCount",
            description: "The number of engines to target (allowed: 1, 2, or 3)",
            required: true,
          },
          {
            name: "fanout",
            description: "Whether to enable web search fanout (true/false)",
            required: true,
          }
        ]
      },
      {
        name: "gap-analysis",
        description: "Analyzes keyword gaps where competitors are visible in AI responses but your own brand is missing in a run.",
        arguments: [
          {
            name: "targetBrand",
            description: "Your own brand name to track absence (e.g. 'Ahrefs')",
            required: true,
          },
          {
            name: "competitorBrands",
            description: "Comma-separated competitors for comparison (e.g. 'Semrush,Moz')",
            required: true,
          },
          {
            name: "runId",
            description: "The run ID to analyze",
            required: true,
          }
        ]
      },
      {
        name: "citation-coverage",
        description: "Maps domains and web sources (fanout) that support AI recommendations under a run.",
        arguments: [
          {
            name: "runId",
            description: "The run ID to retrieve results for",
            required: true,
          }
        ]
      },
      {
        name: "category-dominance",
        description: "Shows who dominates which cluster categories based on AI recommendations in a run.",
        arguments: [
          {
            name: "runId",
            description: "The run ID to analyze",
            required: true,
          }
        ]
      },
      {
        name: "executive-digest",
        description: "Generates a weekly KPI summary for management from a completed run.",
        arguments: [
          {
            name: "runId",
            description: "The run ID to analyze",
            required: true,
          }
        ]
      }
    ],
  };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  if (name === "brand-analysis") {
    const brandName = args.brandName ?? "[Brand]";
    const runId = args.runId ?? "[RunId]";

    return {
      description: `Perform brand occurrence analysis for ${brandName}`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Hello! Please analyze occurrences of the brand "${brandName}" in the results for run "${runId}".
 
Follow these steps:
1. Call the 'get_run_status' tool with runId='${runId}' and format='markdown'.
2. Summarize which keywords the brand is recommended for, the rank it achieved, and which competing brands and websites appear in the same snapshots.
3. Always point out that FullMention is a 'snapshot-first' API and does not store history downstream, and remind me to save this report to a local file if I want to compare and track trends over time.`,
          },
        },
      ],
    };
  }

  if (name === "credit-optimization") {
    const keywordCount = Number(args.keywordCount) || 1;
    const engineCount = Number(args.engineCount) || 1;
    const fanout = args.fanout === "true";

    const baseCost = keywordCount * engineCount;
    const fanoutCost = fanout ? keywordCount : 0;
    const totalCost = baseCost + fanoutCost;

    return {
      description: `Plan a credit-optimized run`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Hello! I want to run a stateless simulation for ${keywordCount} keywords across ${engineCount} engines with fanout=${fanout}.
 
Please follow these steps to advise me:
1. Call 'get_quota' to check my remaining monthly credits.
2. Note that the cost calculation for this request is ${keywordCount} * ${engineCount} + ${fanout ? keywordCount : 0} = ${totalCost} credits.
3. Advise me on whether I have enough credits to perform this run, and remind me that once we trigger the run using 'trigger_run', we must save the results locally.
4. Finally, ask me for permission before calling 'trigger_run'.`,
          },
        },
      ],
    };
  }

  if (name === "gap-analysis") {
    const targetBrand = args.targetBrand ?? "[YourBrand]";
    const competitorBrands = args.competitorBrands ?? "[Competitors]";
    const runId = args.runId ?? "[RunId]";

    return {
      description: `Perform Gap analysis for brand ${targetBrand} against competitors ${competitorBrands} in run ${runId}`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Hello! Please perform a Gap analysis for our own brand "${targetBrand}" compared to the competitors "${competitorBrands}" in run "${runId}".
 
Follow these steps carefully:
1. Call the 'get_run_status' tool with runId='${runId}' and format='markdown' to retrieve the results.
2. Identify all keywords where our own brand "${targetBrand}" is missing, but where one or more competitors ("${competitorBrands}") are present.
3. Calculate a 'pressure score' for each gap based on competitor rankings (formula: sum of 1/rank for each competing brand per keyword).
4. Sort and present these gap keywords in a clean table sorted by 'pressure score' (highest priority at the top).
5. Suggest concrete actions to close these gaps, and remind me to save this gap analysis locally in a 'gap-analysis.md' file since the data is snapshot-first and not stored historically.`,
          },
        },
      ],
    };
  }

  if (name === "citation-coverage") {
    const runId = args.runId ?? "[RunId]";

    return {
      description: `Map Citation Coverage and domains for run ${runId}`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Hello! Please map the Citation Coverage for our keywords in run "${runId}" to see which domains dominate and influence the AI recommendations.
 
Follow these steps:
1. Call 'get_run_status' with runId='${runId}' and format='markdown' to retrieve the visibility data.
2. Extract and compile all domains from the recommendations under the run.
3. If web search fanout was performed, call 'get_fanout_sources' for the key results to retrieve the underlying web sources.
4. Calculate the citation strength for each domain (based on occurrences and coverage) and rank them in a clean table.
5. Summarize whether the niche is 'highly concentrated' (a few domains control everything) or 'fragmented', and explain what this means for our SEO/PR efforts.
6. Save the results locally in a 'citation-coverage.md' report to preserve the history.`,
          },
        },
      ],
    };
  }

  if (name === "category-dominance") {
    const runId = args.runId ?? "[RunId]";

    return {
      description: `Analyze Category Dominance in run ${runId}`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Hello! Please analyze Category Dominance in run "${runId}" to see which brands dominate the specific cluster categories (niches).
 
Follow these steps:
1. Call 'get_run_status' with runId='${runId}' and format='markdown' to retrieve the results.
2. Group recommendations under their canonical categories (using categorySuggestions or keyword text).
3. Calculate the rank-weighted brand score per category (sum of 1/rank for each brand recommendation in that category).
4. Calculate the percentage market share (SOV) per brand within each category.
5. Present a clean overview of categories, their dominance class (strong dominance, moderate, or fragmented), and the top 5 brands per category.
6. Save this report locally in a 'category-dominance.md' file for future reference.`,
          },
        },
      ],
    };
  }

  if (name === "executive-digest") {
    const runId = args.runId ?? "[RunId]";

    return {
      description: `Generate a weekly Executive Digest for run ${runId}`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Hello! Please generate a weekly Executive Digest (KPI report for management) based on run "${runId}".
 
Follow these steps to create a sharp report:
1. Call 'get_run_status' with runId='${runId}' and format='markdown' to retrieve the data.
2. Check if a previously saved report or snapshot exists in my local workspace to compare changes in Share of Voice (SOV) or rankings.
3. Calculate key KPI changes (SOV changes, top ranking wins/losses, volatile keywords).
4. Summarize the results in a concise, professional executive format:
   - **Headline** (max 1 line)
   - **KPI dashboard** (table showing changes)
   - **Top 3 Wins** and **Top 3 Risks**
   - **Concrete Next Steps (30-day action plan)**
5. Keep the report brief, precise, and directly action-oriented (max 150 words in the body text), and save it locally in an 'executive-digest.md' file.`,
          },
        },
      ],
    };
  }

  throw new Error(`Unknown prompt: ${name}`);
});

async function run() {
  if (process.argv.includes("--inspect")) {
    console.log("\n==================================================");
    console.log("🔍 FULLMENTION MCP SERVER INSPECTION (V2 STATELESS)");
    console.log("==================================================");
    
    const apiKey = process.env.FULLMENTION_API_KEY;
    if (apiKey) {
      console.log(`🔑 Authentication: ACTIVE [Key found: ${apiKey.substring(0, 10)}...]`);
    } else {
      console.log("❌ Authentication: MISSING [Warning: FULLMENTION_API_KEY environment variable is not set!]");
    }
    
    const isReadOnly = process.env.FULLMENTION_MCP_READONLY === "true";
    console.log(`🛡️ Read-Only Protection: ${isReadOnly ? "ENABLED (trigger_run is blocked)" : "DISABLED"}`);
    
    const useSSE = process.argv.includes("--sse") || process.env.FULLMENTION_MCP_TRANSPORT === "sse";
    console.log(`🌐 Transport Layer: ${useSSE ? "SSE (Server-Sent Events HTTP Web Server)" : "STDIO (Standard I/O Streams)"}`);
    
    console.log("\n🛠️  Registered MCP Tools:");
    const tools = [
      { name: "get_status", desc: "Get dynamic system and engine status" },
      { name: "get_quota", desc: "Get account quota and remaining credits" },
      { name: "trigger_run", desc: "Trigger an asynchronous stateless simulation run" },
      { name: "get_run_status", desc: "Track status, progress, and results of a batch run" },
      { name: "get_fanout_sources", desc: "Get complete search sources per result" },
      { name: "get_share_of_voice", desc: "Calculate brand recommendations and Share of Voice % server-side for a run" },
      { name: "get_usage_stats", desc: "Get detailed quota budget and stats" }
    ];
    tools.forEach(t => {
      console.log(`  • ${t.name.padEnd(20)} - ${t.desc}`);
    });
    
    console.log("\n📝 Registered MCP Prompts:");
    console.log("  • brand-analysis       - Summarizes rankings and competitor benchmarks for a brand in a run");
    console.log("  • credit-optimization  - Advises on credit usage and costs for a planned run");
    console.log("  • gap-analysis         - Analyzes keyword gaps where competitors are visible in a run");
    console.log("  • citation-coverage    - Maps domains and web sources for a run");
    console.log("  • category-dominance   - Shows category dominance based on AI recommendations in a run");
    console.log("  • executive-digest     - Generates weekly executive KPI summary from a run");
    
    console.log("==================================================\n");
    process.exit(0);
  }

  const useSSE = process.argv.includes("--sse") || process.env.FULLMENTION_MCP_TRANSPORT === "sse";

  if (useSSE) {
    const { createServer } = await import("http");
    const { parse: parseUrl } = await import("url");
    const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");

    const activeTransports = new Map<string, any>();

    const sseHttpServer = createServer(async (req, res) => {
      const parsedUrl = parseUrl(req.url || "", true);
      const path = parsedUrl.pathname;

      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (path === "/status" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "operational",
          service: "fullmention-mcp",
          transport: "sse",
          apiBaseUrl: API_URL
        }));
        return;
      }

      if (path === "/diagnostics" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          service: "fullmention-mcp",
          transport: "sse",
          apiBaseUrl: API_URL,
          uptimeSeconds: Math.round((Date.now() - serverMetrics.startTime) / 1000),
          metrics: {
            cacheHits: serverMetrics.cacheHits,
            cacheMisses: serverMetrics.cacheMisses,
            totalApiCalls: serverMetrics.apiCalls,
            apiErrors: serverMetrics.apiErrors,
            preventedPolls: serverMetrics.preventedPolls,
            runsTriggered: serverMetrics.runsTriggered
          },
          caching: {
            cacheTTLSeconds: cacheTTL,
            statusPollingRateLimitSeconds: 8
          }
        }, null, 2));
        return;
      }

      if (path === "/sse" && req.method === "GET") {
        console.error("[FullMention MCP] SSE handshake started...");
        
        const queryToken = (parsedUrl.query.apiKey as string) || (parsedUrl.query.token as string);
        const authHeader = (req.headers["authorization"] as string) || "";
        const headerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
        const token = headerToken || queryToken || "";

        const transport = new SSEServerTransport("/message", res);
        
        transport.onclose = () => {
          console.error(`[FullMention MCP] SSE transport lukket for session ${transport.sessionId}`);
          activeTransports.delete(transport.sessionId);
        };

        activeTransports.set(transport.sessionId, { transport, token });

        await apiKeyStorage.run(token, async () => {
          await server.connect(transport);
        });
        return;
      }

      if (path === "/message" && req.method === "POST") {
        const querySessionId = parsedUrl.query.sessionId as string;
        if (!querySessionId) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Missing sessionId parameter.");
          return;
        }

        const session = activeTransports.get(querySessionId);
        if (session) {
          const queryToken = (parsedUrl.query.apiKey as string) || (parsedUrl.query.token as string);
          const authHeader = (req.headers["authorization"] as string) || "";
          const headerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
          const token = headerToken || queryToken || session.token || "";

          await apiKeyStorage.run(token, async () => {
            await session.transport.handlePostMessage(req, res);
          });
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end(`Active session '${querySessionId}' was not found.`);
        }
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    });

    const port = Number(process.env.FULLMENTION_MCP_PORT) || Number(process.env.PORT) || 3000;
    console.error(`[FullMention MCP] Starting Node HTTP SSE server on port ${port}...`);
    
    sseHttpServer.listen(port);
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[FullMention MCP] Server is fully connected and listening on STDIO.");
  }
}

run().catch((error) => {
  console.error("[FullMention MCP] Critical error during server startup:", error);
  process.exit(1);
});
