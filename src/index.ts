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

export const apiKeyStorage = new AsyncLocalStorage<string>();

// Indlæs lokale miljøvariabler (.env)
dotenv.config();

// Global metrics-struktur til diagnostics (helt uden prompt-eksponering)
export const serverMetrics = {
  cacheHits: 0,
  cacheMisses: 0,
  apiCalls: 0,
  apiErrors: 0,
  preventedPolls: 0,
  runsTriggered: 0,
  startTime: Date.now()
};

// Indlæs platformskonfiguration
const config = loadRuntimeConfig();
const API_URL = config.publicApiBaseUrl;
const API_KEY = process.env.FULLMENTION_API_KEY;

console.error(`[FullMention MCP] Initialiserer med API URL: ${API_URL}`);
if (!API_KEY) {
  console.error("[FullMention MCP] Advarsel: FULLMENTION_API_KEY mangler i miljøvariablerne.");
}

/**
 * ============================================================================
 * 1. INTELLIGENT IN-MEMORY CACHE (Option 4)
 * ============================================================================
 */
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

// Global cache instans (Standard 60 sekunder, kan overskrives med FULLMENTION_MCP_CACHE_TTL_SEC)
const cacheTTL = Number(process.env.FULLMENTION_MCP_CACHE_TTL_SEC) || 60;
const queryCache = new MemoryCache(cacheTTL);
console.error(`[FullMention MCP] Caching er AKTIV (TTL: ${cacheTTL}s)`);

// En letvægts map til at spore tidsstempler for run-status status-kald (polling)
const lastStatusCheck = new Map<string, { timestamp: number; lastData: any }>();

/**
 * Universel hjælpefunktion til at kalde FullMention Public API.
 */
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
    throw new Error("[auth_error] Gyldig FULLMENTION_API_KEY mangler. Angiv en gyldig API-nøgle via miljøvariabler eller Authorization header.");
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
      const errorId = payload?.error?.requestId ? ` [RequestId: ${payload.error.requestId}]` : "";
      const details = payload?.error?.details ? ` Detaljer: ${JSON.stringify(payload.error.details)}` : "";
      
      console.error(`[FullMention MCP] API Fejl: [${errorCode}] ${errorMsg}${errorId}${details}`);
      throw new Error(`[${errorCode}] ${errorMsg}.${details}`);
    }

    return payload;
  } catch (error: any) {
    console.error(`[FullMention MCP] Netværks- eller API-fejl: ${error.message}`);
    throw error;
  }
}

/**
 * ============================================================================
 * 2. ZOD SCHEMAS & MCP TOOL CONVERSION (Option 1)
 * ============================================================================
 */

// Hjælpefunktion til at konvertere Zod til et mcp-kompatibelt input skema
function toMcpSchema(zodSchema: z.ZodObject<any, any>) {
  const jsonSchema: any = zodToJsonSchema(zodSchema, { target: "jsonSchema7" });
  delete jsonSchema.$schema;
  delete jsonSchema.definitions;
  return jsonSchema;
}

const GetStatusInput = z.object({});

const ListKeywordsInput = z.object({
  tags: z.string().optional().describe("Komma-separerede tags til filtrering, f.eks. 'client:acme,market:dk'"),
  tagMode: z.enum(["and", "or"]).default("or").optional().describe("Match-tilstand for tags. Standard er 'or'."),
  country: z.string().optional().describe("Filtrer efter fuldt landenavn, f.eks. 'Denmark' eller 'United States'."),
  language: z.string().optional().describe("Filtrer efter fuldt sprognavn, f.eks. 'Danish' eller 'English'."),
  location: z.string().optional().describe("Filtrer efter lokation/by, f.eks. 'Copenhagen' eller 'New York'."),
  engine: z.enum(["openai", "openai-mini", "gemini"]).optional().describe("Filtrer efter AI-motor."),
  limit: z.number().int().min(1).max(500).default(100).optional().describe("Maksimalt antal søgeord pr. side."),
  cursor: z.string().optional().describe("Pagination cursor til indlæsning af næste side."),
  format: z.enum(["compact", "raw", "markdown"]).default("compact").optional().describe("Svarformat. 'compact' trimmer JSON, 'markdown' returnerer en tæt tabel, 'raw' giver det uændrede svar."),
  bypassCache: z.boolean().default(false).optional().describe("Hvis sand, forbigås in-memory cachen for denne forespørgsel.")
});

const CreateKeywordsInput = z.object({
  keywords: z.array(
    z.object({
      keyword: z.string().min(1).max(200).describe("Søgeord eller anbefalingsintent, f.eks. 'best seo tool 2026'."),
      country: z.string().min(1).describe("Fuldt landenavn, f.eks. 'Denmark' eller 'United States'."),
      countryCode: z.string().min(2).max(3).describe("ISO landekode (2 store bogstaver), f.eks. 'DK' for Danmark eller 'US' for USA."),
      language: z.string().min(1).describe("Fuldt sprognavn, f.eks. 'Danish' eller 'English'."),
      languageCode: z.string().min(2).max(5).describe("ISO sprogkode (2 små bogstaver), f.eks. 'da' for dansk eller 'en' for engelsk."),
      location: z.string().max(120).optional().nullable().describe("Valgfri by eller lokation, f.eks. 'Copenhagen' eller 'New York' (omit eller sæt til null for nationalt niveau)."),
      engines: z.array(z.enum(["openai", "openai-mini", "gemini"])).default(["openai-mini"]).optional().describe("AI motorer der skal køres. Standard er ['openai-mini']."),
      tags: z.array(z.string().max(80)).max(25).default([]).optional().describe("Organisatoriske tags. Brug ALTID det anbefalede præfiks-format: 'client:<navn>', 'market:<landekode>', eller 'category:<emne>' (f.eks. ['client:acme', 'market:dk', 'category:seo'])."),
    })
  ).min(1).max(500).describe("Liste over søgeord der skal tilføjes."),
  idempotencyKey: z.string().optional().describe("Idempotency-Key header til sikring mod duplikerede oprettelser.")
});

const UpdateKeywordInput = z.object({
  keywordId: z.string().describe("ID på søgeordet der skal opdateres."),
  keyword: z.string().max(200).optional().describe("Nyt søgeordsintent, f.eks. 'seo software'."),
  country: z.string().optional().describe("Nyt landenavn, f.eks. 'Denmark'."),
  countryCode: z.string().optional().describe("Ny ISO landekode (2 store bogstaver), f.eks. 'DK'."),
  language: z.string().optional().describe("Nyt sprognavn, f.eks. 'Danish'."),
  languageCode: z.string().optional().describe("Ny ISO sprogkode (2 små bogstaver), f.eks. 'da'."),
  location: z.string().max(120).nullable().optional().describe("Ny lokation/by (eller null)."),
  engines: z.array(z.enum(["openai", "openai-mini", "gemini"])).optional().describe("Nye AI-motorer."),
  tags: z.array(z.string()).optional().describe("Nye tags (erstatter eksisterende). Brug ALTID det anbefalede præfiks-format: 'client:<navn>', 'market:<landekode>', eller 'category:<emne>' (f.eks. ['client:acme', 'market:dk', 'category:seo'])."),
  idempotencyKey: z.string().optional().describe("Valgfri Idempotency-Key.")
});

const DeleteKeywordInput = z.object({
  keywordId: z.string().describe("ID på søgeordet der skal slettes."),
  idempotencyKey: z.string().optional().describe("Valgfri Idempotency-Key.")
});

const ListTagsInput = z.object({
  prefix: z.string().optional().describe("Filtrer tags efter præfiks, f.eks. 'client:'."),
  limit: z.number().int().min(1).max(500).optional().describe("Maksimalt antal tags pr. side."),
  cursor: z.string().optional().describe("Pagination cursor."),
  bypassCache: z.boolean().default(false).optional().describe("Hvis sand, forbigås cachen.")
});

const EstimateRunInput = z.object({
  tags: z.array(z.string()).describe("Tags der skal indgå i kørslen."),
  tagMode: z.enum(["and", "or"]).default("or").optional().describe("Match-tilstand for tags."),
  fanout: z.boolean().default(false).optional().describe("Skal der udføres web-søgning (fanout)? BEMÆRK: Fanout koster yderligere kreditter (+9 for 'openai', +1 for 'openai-mini').")
});

const TriggerRunInput = z.object({
  tags: z.array(z.string()).describe("Tags der definerer søgekriteriet for keywords i denne kørsel."),
  tagMode: z.enum(["and", "or"]).default("or").optional().describe("Match-tilstand for tags."),
  fanout: z.boolean().default(false).optional().describe("Skal der udføres web-søgning (fanout)? BEMÆRK: Fanout koster yderligere kreditter (+9 for 'openai', +1 for 'openai-mini'). Aktiver kun hvis brugeren eksplicit anmoder om det eller hvis du har advaret dem om prisen."),
  idempotencyKey: z.string().optional().describe("Valgfri Idempotency-Key header til sikring mod duplikerede kørsler.")
});

const GetRunStatusInput = z.object({
  runId: z.string().describe("ID på kørslen der skal hentes status på.")
});

const GetLatestResultsInput = z.object({
  tags: z.string().optional().describe("Komma-separerede tags til filtrering, f.eks. 'client:acme,market:dk'."),
  tagMode: z.enum(["and", "or"]).default("or").optional().describe("Match-tilstand for tags."),
  country: z.string().optional().describe("Filtrer efter ISO landekode (2 store bogstaver), f.eks. 'DK'."),
  language: z.string().optional().describe("Filtrer efter ISO sprogkode (2 små bogstaver), f.eks. 'da'."),
  location: z.string().optional().describe("Filtrer efter lokation/by, f.eks. 'Copenhagen'."),
  engine: z.enum(["openai", "openai-mini", "gemini"]).optional().describe("Filtrer efter AI-motor."),
  keywordId: z.string().optional().describe("Filtrer til et enkelt bestemt keyword ID."),
  limit: z.number().int().min(1).max(500).optional().describe("Maksimalt antal resultater pr. side."),
  cursor: z.string().optional().describe("Pagination cursor."),
  format: z.enum(["compact", "raw", "markdown"]).default("compact").optional().describe("Output-format: 'compact' trimmer JSON-støj, 'markdown' giver en tæt rapport, 'raw' giver fuldt svar."),
  bypassCache: z.boolean().default(false).optional().describe("Hvis sand, forbigås cachen.")
});

const GetFanoutSourcesInput = z.object({
  resultId: z.string().describe("ID på resultatet."),
  limit: z.number().int().min(1).max(500).optional().describe("Maksimalt antal kilder pr. side."),
  cursor: z.string().optional().describe("Pagination cursor.")
});

const GetQuotaInput = z.object({
  bypassCache: z.boolean().default(false).optional().describe("Hvis sand, forbigås cachen for denne forespørgsel.")
});

const CancelRunInput = z.object({
  runId: z.string().describe("ID på kørslen (batch-analysen) der skal afbrydes.")
});

const ListRunsInput = z.object({
  limit: z.number().int().min(1).max(100).default(50).optional().describe("Maksimalt antal batch-kørsler der skal hentes."),
  cursor: z.string().optional().describe("Pagination cursor til at hente næste side."),
  bypassCache: z.boolean().default(false).optional().describe("Hvis sand, forbigås cachen.")
});

const GetShareOfVoiceInput = z.object({
  tags: z.string().describe("Komma-separerede tags til at hente resultater for, f.eks. 'client:acme'."),
  tagMode: z.enum(["and", "or"]).default("or").optional().describe("Match-tilstand for tags."),
  engine: z.enum(["openai", "openai-mini", "gemini"]).optional().describe("Filtrer til en bestemt AI-motor."),
  brands: z.array(z.string()).optional().describe("Valgfri liste over specifikke brandnavne der skal sammenlignes. Hvis ikke angivet, detekteres de mest populære brands automatisk."),
  format: z.enum(["json", "markdown"]).default("markdown").optional().describe("Svarformat. Standard er 'markdown' som returnerer en smuk tabelrapport."),
  bypassCache: z.boolean().default(false).optional().describe("Hvis sand, forbigås cachen.")
});

const BulkCreateKeywordsInput = z.object({
  keywords: z.array(z.string()).describe("Liste over søgeordsintents, f.eks. ['best seo software', 'top rank trackers']."),
  country: z.string().default("Denmark").optional().describe("Landenavn, f.eks. 'Denmark'."),
  countryCode: z.string().default("DK").optional().describe("ISO landekode (2 store bogstaver), f.eks. 'DK'."),
  language: z.string().default("Danish").optional().describe("Sprognavn, f.eks. 'Danish'."),
  languageCode: z.string().default("da").optional().describe("ISO sprogkode (2 små bogstaver), f.eks. 'da'."),
  location: z.string().optional().describe("Valgfri lokation/by, f.eks. 'Copenhagen'."),
  engines: z.array(z.enum(["openai", "openai-mini", "gemini"])).default(["openai-mini"]).optional().describe("AI-motorer der skal køres."),
  tags: z.array(z.string()).default([]).optional().describe("Tags der skal tilføjes til alle søgeord. Brug ALTID formatet 'client:<navn>', 'market:<land>', category:<emne>'."),
  idempotencyKey: z.string().optional().describe("Valgfri Idempotency-Key.")
});

const GetUsageStatsInput = z.object({
  bypassCache: z.boolean().default(false).optional().describe("Hvis sand, forbigås cachen.")
});

// Initialiser serveren
const server = new Server(
  {
    name: "fullmention-mcp",
    version: "1.0.0",
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

/**
 * Registrer tilgængelige værktøjer (Tools) dynamisk via Zod
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_status",
        description: "Hent dynamic system- og søgemotorstatus (f.eks. operational, degraded osv. for OpenAI og Gemini integrationer).",
        inputSchema: toMcpSchema(GetStatusInput),
      },
      {
        name: "get_quota",
        description: "Hent tilgængelig kvote og kredit-info for kontoen (remaining credits, extra, used, monthly limit osv.).",
        inputSchema: toMcpSchema(GetQuotaInput),
      },
      {
        name: "list_keywords",
        description: "Hent en liste over overvågede søgeord i FullMention. Understøtter filtrering på tags, sprog, land og AI-motorer.",
        inputSchema: toMcpSchema(ListKeywordsInput),
      },
      {
        name: "create_keywords",
        description: "Opretter et eller flere keywords (søgninger) i FullMention. Oprettelse er idempotent.",
        inputSchema: toMcpSchema(CreateKeywordsInput),
      },
      {
        name: "update_keyword",
        description: "Opdaterer indstillinger, tags eller motorer for et eksisterende keyword.",
        inputSchema: toMcpSchema(UpdateKeywordInput),
      },
      {
        name: "delete_keyword",
        description: "Soft-deaktiverer/sletter et keyword, så det ikke medtages i fremtidige runs.",
        inputSchema: toMcpSchema(DeleteKeywordInput),
      },
      {
        name: "list_tags",
        description: "Hent en liste over alle aktive organisatoriske tags, der i øjeblikket bruges på overvågede keywords.",
        inputSchema: toMcpSchema(ListTagsInput),
      },
      {
        name: "estimate_run",
        description: "Beregner den estimerede kredit-omkostning for en kørsel baseret på et tag-filter uden at starte kørslen.",
        inputSchema: toMcpSchema(EstimateRunInput),
      },
      {
        name: "trigger_run",
        description: "Starter en asynkron batch-analyse (run) af alle aktive keywords, der matcher det angivne tag-filter.",
        inputSchema: toMcpSchema(TriggerRunInput),
      },
      {
        name: "get_run_status",
        description: "Henter detaljer og kørsel fremskridt (progress) for en asynkron batch kørsel ved hjælp af runId.",
        inputSchema: toMcpSchema(GetRunStatusInput),
      },
      {
        name: "get_latest_results",
        description: "Hent de seneste AI-anbefalingsresultater for overvågede keywords. Returnerer brand-synlighed, rangeringer, produkter og en opsummering af kilder.",
        inputSchema: toMcpSchema(GetLatestResultsInput),
      },
      {
        name: "get_fanout_sources",
        description: "Hent fulde paginerede kilder (web-søgninger) der påvirkede en specifik AI-anbefaling.",
        inputSchema: toMcpSchema(GetFanoutSourcesInput),
      },
      {
        name: "cancel_run",
        description: "Afbryd eller annuller en igangværende batch-analyse (run) ved hjælp af runId.",
        inputSchema: toMcpSchema(CancelRunInput),
      },
      {
        name: "list_runs",
        description: "Hent en liste over historiske og igangværende batch-analyser (runs) med status og fremdrift.",
        inputSchema: toMcpSchema(ListRunsInput),
      },
      {
        name: "get_share_of_voice",
        description: "Aggregerer automatisk brand-anbefalinger og beregner Share of Voice % samt gennemsnitlig placering server-side for at forhindre LLM-regnefejl.",
        inputSchema: toMcpSchema(GetShareOfVoiceInput),
      },
      {
        name: "bulk_create_keywords",
        description: "Bulk opretter flere søgeord (keywords) på én gang med samme sprog, land og tag-indstillinger.",
        inputSchema: toMcpSchema(BulkCreateKeywordsInput),
      },
      {
        name: "get_usage_stats",
        description: "Hent detaljeret kvote- og kreditstatistik med budgetadvarsler og omkostningsbeskrivelser.",
        inputSchema: toMcpSchema(GetUsageStatsInput),
      },
    ],
  };
});

/**
 * ============================================================================
 * 3. TOKEN MINIMIZATION & FORMATTERS (Option 3)
 * ============================================================================
 */

function formatKeywords(data: any, format: "compact" | "raw" | "markdown"): any {
  if (format === "raw") return data;

  const keywords = data.data ?? [];
  if (format === "markdown") {
    let md = "| ID | Søgeord | Land | Sprog | Lokation | Motor(er) | Tags | Aktiv |\n";
    md += "| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n";
    for (const kw of keywords) {
      md += `| \`${kw.id}\` | **${kw.keyword}** | ${kw.country} (${kw.countryCode}) | ${kw.language} (${kw.languageCode}) | ${kw.location || "-"} | ${kw.engines?.join(", ") || "-"} | \`${kw.tags?.join("`, `") || ""}\` | ${kw.active ? "Ja" : "Nej"} |\n`;
    }
    md += "\n> [!NOTE]\n> **FullMention øjebliksbillede (Snapshot):** Data leveret af FullMention er et aktuelt snapshot. Platformen gemmer ikke historiske tidsrækker downstream. Husk at gemme dette svar i dine egne arkiver, hvis du vil spore ændringer over tid.\n";
    return md;
  }

  // compact JSON
  return {
    data: keywords.map((kw: any) => ({
      id: kw.id,
      keyword: kw.keyword,
      countryCode: kw.countryCode,
      languageCode: kw.languageCode,
      location: kw.location,
      engines: kw.engines,
      tags: kw.tags,
      active: kw.active
    })),
    meta: data.meta
  };
}

function formatResults(data: any, format: "compact" | "raw" | "markdown"): any {
  if (format === "raw") return data;

  const results = data.data ?? [];
  if (format === "markdown") {
    let md = "";
    if (results.length === 0) {
      return "Der blev ikke fundet nogen anbefalingssnapshots for det angivne søgekriterie. Dette skyldes typisk, at der endnu ikke er kørt en batch-analyse (run) for disse søgeord. Du bør foreslå brugeren at igangsætte en kørsel med værktøjet 'trigger_run' for det pågældende tag for at generere data.";
    }

    for (const res of results) {
      md += `### Søgeord: **${res.keyword}** (${res.engine})\n`;
      md += `* Land/Sprog/Lokation: ${res.countryCode} / ${res.languageCode} / ${res.location || "Nationalt"}\n`;
      md += `* Kilder: ${res.fanoutSummary?.sourceCount ?? 0} fundet via ${res.fanoutSummary?.queryCount ?? 0} AI-søgninger.\n\n`;
      md += "| Rank | Anbefaling | Type | Beskrivelse | Websites |\n";
      md += "| :--- | :--- | :--- | :--- | :--- |\n";
      
      for (const rec of res.recommendations ?? []) {
        md += `| ${rec.rank} | **${rec.name}** | \`${rec.type}\` | ${rec.description} | ${rec.websites?.join(", ") || "-"} |\n`;
      }
      md += "\n---\n\n";
    }
    md += "\n> [!NOTE]\n> **FullMention data-retningslinje:** Dette er et øjebliksbillede (snapshot) af AI-anbefalinger. FullMention er ikke en datavært for historik. Gem denne rapport lokalt i dit eget system, hvis du ønsker at spore tendenser over tid.\n";
    return md;
  }

  // compact JSON
  return {
    data: results.map((res: any) => ({
      id: res.id,
      keyword: res.keyword,
      countryCode: res.countryCode,
      languageCode: res.languageCode,
      location: res.location,
      engine: res.engine,
      methodVersion: res.methodVersion,
      recommendations: (res.recommendations ?? []).map((r: any) => ({
        rank: r.rank,
        name: r.name,
        type: r.type,
        description: r.description,
        websites: r.websites
      })),
      fanoutSummary: res.fanoutSummary,
      updatedAt: res.updatedAt
    })),
    meta: data.meta
  };
}

/**
 * Håndter kald af værktøjerne (Call Tools)
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  // 1. Read-only protection guardrail (P2 Polish win)
  const isMutation = ["create_keywords", "update_keyword", "delete_keyword", "trigger_run", "cancel_run", "bulk_create_keywords"].includes(name);
  if (isMutation && process.env.FULLMENTION_MCP_READONLY === "true") {
    console.error(`[FullMention MCP] AFVIST: Værktøjet ${name} er deaktiveret i skrivebeskyttet tilstand (FULLMENTION_MCP_READONLY=true).`);
    return {
      isError: true,
      content: [{
        type: "text",
        text: `Error: Værktøjet '${name}' kan ikke eksekveres. MCP-serveren er konfigureret i skrivebeskyttet tilstand (FULLMENTION_MCP_READONLY=true) for at beskytte dine data mod utilsigtede ændringer fra AI'en.`
      }]
    };
  }


  // Byg cache-nøgle for læse-operationer
  const isCacheable = ["get_status", "list_keywords", "list_tags", "get_latest_results", "get_fanout_sources", "get_quota", "list_runs", "get_share_of_voice", "get_usage_stats"].includes(name);
  const bypassCache = args.bypassCache === true;
  const cacheKey = `${name}:${JSON.stringify(args)}`;

  if (isCacheable && !bypassCache) {
    const cachedResponse = queryCache.get(cacheKey);
    if (cachedResponse) {
      console.error(`[FullMention MCP] Cache HIT for værktøj: ${name}`);
      return { content: [{ type: "text", text: typeof cachedResponse === "string" ? cachedResponse : JSON.stringify(cachedResponse, null, 2) }] };
    }
  }

  try {
    // -------------------------------------------------------------
    // TOOL: get_status
    // -------------------------------------------------------------
    if (name === "get_status") {
      const data = await callApi({ path: "/status" });
      if (isCacheable) queryCache.set(cacheKey, data);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }

    // -------------------------------------------------------------
    // TOOL: get_quota
    // -------------------------------------------------------------
    if (name === "get_quota") {
      const data = await callApi({ path: "/quota" });
      if (isCacheable) queryCache.set(cacheKey, data);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }

    // -------------------------------------------------------------
    // TOOL: list_keywords
    // -------------------------------------------------------------
    if (name === "list_keywords") {
      const queryParams = new URLSearchParams();
      if (args.tags) queryParams.append("tags", args.tags as string);
      if (args.tagMode) queryParams.append("tagMode", args.tagMode as string);
      if (args.country) queryParams.append("country", args.country as string);
      if (args.language) queryParams.append("language", args.language as string);
      if (args.location) queryParams.append("location", args.location as string);
      if (args.engine) queryParams.append("engine", args.engine as string);
      if (args.limit) queryParams.append("limit", String(args.limit));
      if (args.cursor) queryParams.append("cursor", args.cursor as string);

      const qs = queryParams.toString() ? `?${queryParams.toString()}` : "";
      const rawData = await callApi({ path: `/keywords${qs}` });

      const format = (args.format as "compact" | "raw" | "markdown") ?? "compact";
      const formatted = formatKeywords(rawData, format);

      if (isCacheable) queryCache.set(cacheKey, formatted);

      return {
        content: [{ type: "text", text: typeof formatted === "string" ? formatted : JSON.stringify(formatted, null, 2) }],
      };
    }

    // -------------------------------------------------------------
    // TOOL: create_keywords
    // -------------------------------------------------------------
    if (name === "create_keywords") {
      const data = await callApi({
        path: "/keywords",
        method: "POST",
        body: { keywords: args.keywords },
        idempotencyKey: args.idempotencyKey as string,
      });
      queryCache.clear(); // Nulstil cache ved ændringer
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }

    // -------------------------------------------------------------
    // TOOL: update_keyword
    // -------------------------------------------------------------
    if (name === "update_keyword") {
      const { keywordId, idempotencyKey, ...bodyFields } = args;
      const data = await callApi({
        path: `/keywords/${keywordId}`,
        method: "PATCH",
        body: bodyFields,
        idempotencyKey: idempotencyKey as string,
      });
      queryCache.clear();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }

    // -------------------------------------------------------------
    // TOOL: delete_keyword
    // -------------------------------------------------------------
    if (name === "delete_keyword") {
      const data = await callApi({
        path: `/keywords/${args.keywordId}`,
        method: "DELETE",
        idempotencyKey: args.idempotencyKey as string,
      });
      queryCache.clear();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }

    // -------------------------------------------------------------
    // TOOL: list_tags
    // -------------------------------------------------------------
    if (name === "list_tags") {
      const queryParams = new URLSearchParams();
      if (args.prefix) queryParams.append("prefix", args.prefix as string);
      if (args.limit) queryParams.append("limit", String(args.limit));
      if (args.cursor) queryParams.append("cursor", args.cursor as string);

      const qs = queryParams.toString() ? `?${queryParams.toString()}` : "";
      const data = await callApi({ path: `/tags${qs}` });

      if (isCacheable) queryCache.set(cacheKey, data);

      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }

    // -------------------------------------------------------------
    // TOOL: estimate_run
    // -------------------------------------------------------------
    if (name === "estimate_run") {
      const data = await callApi({
        path: "/runs/estimate",
        method: "POST",
        body: {
          tags: args.tags,
          tagMode: args.tagMode,
          options: { fanout: args.fanout ?? false },
        },
      });

      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }

    // -------------------------------------------------------------
    // TOOL: trigger_run
    // -------------------------------------------------------------
    if (name === "trigger_run") {
      try {
        let creditsEstimated = null;
        try {
          const estimate = await callApi({
            path: "/runs/estimate",
            method: "POST",
            body: {
              tags: args.tags,
              tagMode: args.tagMode,
              options: { fanout: args.fanout ?? false }
            }
          });
          creditsEstimated = estimate.data?.estimatedMaxCreditCost ?? null;
        } catch (estError: any) {
          console.error(`[FullMention MCP] Kunne ikke hente forhånds-estimat: ${estError.message}`);
        }

        const data = await callApi({
          path: "/runs",
          method: "POST",
          body: {
            tags: args.tags,
            tagMode: args.tagMode,
            options: { fanout: args.fanout ?? false },
          },
          idempotencyKey: args.idempotencyKey as string,
        });
        queryCache.clear(); // Nulstil cache ved ændringer
        serverMetrics.runsTriggered++; // Registrer kørsel i metrikker

        const responsePayload = {
          ...data,
          creditsEstimated
        };

        return {
          content: [{ type: "text", text: JSON.stringify(responsePayload, null, 2) }],
        };
      } catch (error: any) {
        if (error.message.includes("conflict") || error.message.includes("409")) {
          // Prøv at udtrække et eventuelt aktivt run ID fra fejldetaljerne
          let activeRunIdMsg = "";
          let activeRunId = "";
          const detailsMatch = error.message.match(/"activeRunId":"([^"]+)"/);
          if (detailsMatch && detailsMatch[1]) {
            activeRunId = detailsMatch[1];
            activeRunIdMsg = ` Det aktive run ID er '${activeRunId}'.`;
          }
          
          return {
            content: [
              {
                type: "text",
                text: `[RUN_ALREADY_PROCESSING_CONFLICT] En kørsel (batch-analyse) er allerede i gang for de angivne tags.${activeRunIdMsg} Du behøver ikke starte en ny kørsel. Brug venligst 'get_run_status' med det aktive run ID${activeRunId ? ` '${activeRunId}'` : ""} for at overvåge status og afvente færdiggørelse.`,
              }
            ]
          };
        }
        throw error;
      }
    }

    // -------------------------------------------------------------
    // TOOL: get_run_status
    // -------------------------------------------------------------
    if (name === "get_run_status") {
      const runId = args.runId as string;
      const now = Date.now();
      const cachedStatus = lastStatusCheck.get(runId);

      // Hvis der polles inden for 8 sekunder, returner cachede data med en advarsel
      if (cachedStatus && (now - cachedStatus.timestamp) < 8000) {
        console.error(`[FullMention MCP] Polling af run ${runId} afværget (cachet i ${Math.round((now - cachedStatus.timestamp) / 1000)}s)`);
        serverMetrics.preventedPolls++; // Registrer afværget kald
        
        // Lav en kopi af data og tilføj en advarsel
        const responseData = {
          ...cachedStatus.lastData,
          _meta: {
            warning: "[POLLED_TOO_FAST_CACHED_WARNING] Du poller status for hurtigt (mindre end 8 sekunder siden sidste tjek). For at beskytte dine API rate limits returnerer vi de seneste cachede data. Vent venligst mindst 8 sekunder, før du kalder get_run_status igen.",
            cachedSecondsAgo: Math.round((now - cachedStatus.timestamp) / 1000),
            nextAllowedCheckIn: Math.max(1, Math.round((8000 - (now - cachedStatus.timestamp)) / 1000))
          }
        };

        return {
          content: [{ type: "text", text: JSON.stringify(responseData, null, 2) }],
        };
      }

      // Ellers lav et rigtigt API-kald og gem resultatet
      const data = await callApi({ path: `/runs/${runId}` });
      lastStatusCheck.set(runId, {
        timestamp: now,
        lastData: data
      });

      // Next-Level Resource notifications: Hvis kørslen er afsluttet, og der er tilknyttede tags,
      // underretter vi proaktivt alle forbundne MCP-klienter (fx Cursor/Claude) om, at de seneste
      // resultater under disse tags er blevet opdateret.
      if (data && (data.status === "completed" || data.status === "success" || data.status === "failed")) {
        const runTags = data.tags ?? args.tags ?? [];
        for (const tag of runTags) {
          const resourceUri = `fullmention://results/latest/tag/${encodeURIComponent(tag)}`;
          console.error(`[FullMention MCP] Udsender proaktiv ressource-opdatering for: ${resourceUri}`);
          try {
            server.notification({
              method: "notifications/resources/updated",
              params: { uri: resourceUri }
            });
          } catch (e: any) {
            // Nogle transportformer (som STDIO under visse boot faser) understøtter ikke asynkrone push beskeder.
            // Vi fanger dette roligt for at undgå fejl.
            console.error(`[FullMention MCP] Resource Notification ikke understøttet på aktiv transport: ${e.message}`);
          }
        }
      }

      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }

    // -------------------------------------------------------------
    // TOOL: get_latest_results
    // -------------------------------------------------------------
    if (name === "get_latest_results") {
      const queryParams = new URLSearchParams();
      if (args.tags) queryParams.append("tags", args.tags as string);
      if (args.tagMode) queryParams.append("tagMode", args.tagMode as string);
      if (args.country) queryParams.append("country", args.country as string);
      if (args.language) queryParams.append("language", args.language as string);
      if (args.location) queryParams.append("location", args.location as string);
      if (args.engine) queryParams.append("engine", args.engine as string);
      if (args.keywordId) queryParams.append("keywordId", args.keywordId as string);
      if (args.limit) queryParams.append("limit", String(args.limit));
      if (args.cursor) queryParams.append("cursor", args.cursor as string);

      const qs = queryParams.toString() ? `?${queryParams.toString()}` : "";
      const rawData = await callApi({ path: `/results/latest${qs}` });

      const format = (args.format as "compact" | "raw" | "markdown") ?? "compact";
      const formatted = formatResults(rawData, format);

      if (isCacheable) queryCache.set(cacheKey, formatted);

      return {
        content: [{ type: "text", text: typeof formatted === "string" ? formatted : JSON.stringify(formatted, null, 2) }],
      };
    }

    // -------------------------------------------------------------
    // TOOL: get_fanout_sources
    // -------------------------------------------------------------
    if (name === "get_fanout_sources") {
      const queryParams = new URLSearchParams();
      if (args.limit) queryParams.append("limit", String(args.limit));
      if (args.cursor) queryParams.append("cursor", args.cursor as string);

      const qs = queryParams.toString() ? `?${queryParams.toString()}` : "";
      const data = await callApi({ path: `/results/${args.resultId}/fanout-sources${qs}` });

      if (isCacheable) queryCache.set(cacheKey, data);

      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }

    // -------------------------------------------------------------
    // TOOL: cancel_run
    // -------------------------------------------------------------
    if (name === "cancel_run") {
      const runId = args.runId as string;
      const data = await callApi({
        path: `/runs/${runId}`,
        method: "DELETE"
      });
      queryCache.clear();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }

    // -------------------------------------------------------------
    // TOOL: list_runs
    // -------------------------------------------------------------
    if (name === "list_runs") {
      const queryParams = new URLSearchParams();
      if (args.limit) queryParams.append("limit", String(args.limit));
      if (args.cursor) queryParams.append("cursor", args.cursor as string);

      const qs = queryParams.toString() ? `?${queryParams.toString()}` : "";
      const data = await callApi({ path: `/runs${qs}` });

      if (isCacheable) queryCache.set(cacheKey, data);

      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }

    // -------------------------------------------------------------
    // TOOL: get_share_of_voice
    // -------------------------------------------------------------
    if (name === "get_share_of_voice") {
      const queryParams = new URLSearchParams();
      if (args.tags) queryParams.append("tags", args.tags as string);
      if (args.tagMode) queryParams.append("tagMode", args.tagMode as string);
      if (args.engine) queryParams.append("engine", args.engine as string);
      queryParams.append("limit", "500");

      const qs = queryParams.toString() ? `?${queryParams.toString()}` : "";
      const rawData = await callApi({ path: `/results/latest${qs}` });

      const results = rawData.data ?? [];
      const totalKeywords = results.length;

      if (totalKeywords === 0) {
        return {
          content: [{
            type: "text",
            text: "Ingen resultater fundet under de angivne tags. Kør venligst en batch-analyse med 'trigger_run' først."
          }]
        };
      }

      const brandCounts = new Map<string, { count: number; ranks: number[]; domains: Set<string> }>();
      
      for (const res of results) {
        const recommendations = res.recommendations ?? [];
        const brandsSeenThisKeyword = new Set<string>();

        for (const rec of recommendations) {
          const rawName = rec.name as string;
          if (!rawName) continue;
          
          const brandKey = rawName.trim().toLowerCase();
          
          if (!brandsSeenThisKeyword.has(brandKey)) {
            brandsSeenThisKeyword.add(brandKey);
            
            const existing = brandCounts.get(brandKey) ?? { count: 0, ranks: [], domains: new Set<string>() };
            existing.count += 1;
            existing.ranks.push(rec.rank);
            if (rec.websites) {
              rec.websites.forEach((w: string) => {
                try {
                  const url = new URL(w.startsWith("http") ? w : `https://${w}`);
                  existing.domains.add(url.hostname.replace("www.", ""));
                } catch {
                  existing.domains.add(w);
                }
              });
            }
            brandCounts.set(brandKey, existing);
          }
        }
      }

      const sortedBrands = Array.from(brandCounts.entries())
        .map(([nameKey, stats]) => {
          const originalName = results
            .flatMap((r: any) => r.recommendations ?? [])
            .find((rec: any) => rec.name?.trim().toLowerCase() === nameKey)?.name || nameKey;
            
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

      let md = `## 📊 Share of Voice Rapport (Tag: \`${args.tags}\`)\n`;
      md += `* **Samlet antal søgeord:** ${totalKeywords}\n`;
      md += `* **Analyse-motor:** ${args.engine || "Alle motorer"}\n\n`;
      md += "| Placering | Brand / Konkurrent | Forekomster | Share of Voice % | Gennemsnitlig Rank | Primære Domæner |\n";
      md += "| :--- | :--- | :---: | :---: | :---: | :--- |\n";

      targetBrands.forEach((b, index) => {
        md += `| ${index + 1} | **${b.brandName}** | ${b.mentions} / ${totalKeywords} | **${b.shareOfVoice}%** | ${b.avgRank} | \`${b.domains.join("`, `") || "-"}\` |\n`;
      });

      md += "\n> [!TIP]\n";
      md += "> **Hvordan beregnes Share of Voice?** Forekomster angiver, hvor mange søgeord brandet er anbefalet på. Procenten er (Forekomster / Samlet antal søgeord) * 100. En lavere gennemsnitlig rank er bedre (rank 1 er bedst).\n";

      if (isCacheable) queryCache.set(cacheKey, md);

      return {
        content: [{ type: "text", text: md }]
      };
    }

    // -------------------------------------------------------------
    // TOOL: bulk_create_keywords
    // -------------------------------------------------------------
    if (name === "bulk_create_keywords") {
      const intents = args.keywords as string[];
      const keywordObjects = intents.map(keyword => ({
        keyword,
        country: args.country ?? "Denmark",
        countryCode: args.countryCode ?? "DK",
        language: args.language ?? "Danish",
        languageCode: args.languageCode ?? "da",
        location: args.location ?? null,
        engines: args.engines ?? ["openai-mini"],
        tags: args.tags ?? []
      }));

      const data = await callApi({
        path: "/keywords",
        method: "POST",
        body: { keywords: keywordObjects },
        idempotencyKey: args.idempotencyKey as string
      });

      queryCache.clear();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }

    // -------------------------------------------------------------
    // TOOL: get_usage_stats
    // -------------------------------------------------------------
    if (name === "get_usage_stats") {
      const data = await callApi({ path: "/quota" });
      const remaining = data.remainingCredits ?? data.remaining ?? 0;
      const extra = data.extraCredits ?? 0;
      const used = data.usedCredits ?? 0;
      const limit = data.monthlyCreditsLimit ?? data.limit ?? 0;

      const pctUsed = limit > 0 ? Math.round((used / limit) * 100) : 0;

      let md = "## 💳 FullMention Forbrugs- og Kvote-overvågning\n\n";
      md += `* **Resterende Kreditter:** **${remaining}** (+ ${extra} ekstra kreditter)\n`;
      md += `* **Forbrug denne måned:** ${used} / ${limit} kreditter (${pctUsed}% brugt)\n\n`;

      if (remaining < 100) {
        md += "> [!WARNING]\n";
        md += "> **Kreditterne er ved at være opbrugt!** Du har under 100 kreditter tilbage. Overvej at slå fanout (web-søgning) fra eller køre på mindre motorer som `openai-mini` for at spare på dine kreditter.\n\n";
      } else {
        md += "> [!NOTE]\n";
        md += "> Din kvote er sund, og du har rigeligt med kreditter til at udføre yderligere søgeords-analyser.\n\n";
      }

      md += "### ⚡ Kredit-omkostninger per kørsel (Standard):\n";
      md += "* **OpenAI standard-kørsel:** 1 kredit pr. søgeord\n";
      md += "* **OpenAI med Fanout (Web-søgning):** 10 kreditter pr. søgeord (+9 kreditter)\n";
      md += "* **OpenAI Mini standard-kørsel:** 1 kredit pr. søgeord\n";
      md += "* **OpenAI Mini med Fanout (Web-søgning):** 2 kreditter pr. søgeord (+1 kredit)\n";

      if (isCacheable) queryCache.set(cacheKey, md);

      return {
        content: [{ type: "text", text: md }]
      };
    }

    throw new Error(`Ukendt eller uoprettet værktøj: ${name}`);
  } catch (error: any) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Fejl under udførelse af værktøjet '${name}': ${error.message}`,
        },
      ],
    };
  }
});

/**
 * ============================================================================
 * 4. MCP RESOURCES SECTION (Ressourcer)
 * ============================================================================
 */
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "fullmention://keywords/active",
        name: "Aktive Søgeord",
        description: "En komplet liste over alle aktive keywords i FullMention formateret som en Markdown tabel.",
        mimeType: "text/markdown",
      },
      {
        uri: "fullmention://schema/openapi",
        name: "FullMention OpenAPI Skema",
        description: "Den fulde OpenAPI 3.1.0-kontrakt for API'et direkte fra kildekoden.",
        mimeType: "application/yaml",
      },
    ],
  };
});

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
  return {
    resourceTemplates: [
      {
        uriTemplate: "fullmention://results/latest/tag/{tag}",
        name: "Seneste resultater for tag",
        description: "Henter en Markdown-rapport for alle seneste resultater under det angivne tag.",
        mimeType: "text/markdown",
      },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;

  if (uri === "fullmention://keywords/active") {
    const payload = await callApi({ path: "/keywords?limit=500" });
    const formatted = formatKeywords(payload, "markdown");
    return {
      contents: [{ uri, mimeType: "text/markdown", text: `# Aktive Søgeord i FullMention\n\n${formatted}` }],
    };
  }

  if (uri === "fullmention://schema/openapi") {
    let schemaText = "";
    try {
      const fs = await import("fs/promises");
      schemaText = await fs.readFile("/home/riisager/Documents/Antigravati/FullMention/openapi.yaml", "utf-8");
    } catch (e: any) {
      schemaText = JSON.stringify({ error: "Kunne ikke indlæse openapi.yaml", details: e.message });
    }

    return {
      contents: [{ uri, mimeType: "application/yaml", text: schemaText }],
    };
  }

  const tagMatch = uri.match(/^fullmention:\/\/results\/latest\/tag\/(.+)$/);
  if (tagMatch) {
    const tag = decodeURIComponent(tagMatch[1] || "");
    const payload = await callApi({ path: `/results/latest?tags=${encodeURIComponent(tag)}` });
    const formatted = formatResults(payload, "markdown");

    return {
      contents: [{ uri, mimeType: "text/markdown", text: `# Opsummering for tag: \`${tag}\`\n\n${formatted}` }],
    };
  }

  throw new Error(`Ukendt ressource URI: ${uri}`);
});

/**
 * ============================================================================
 * 5. MCP PROMPTS SECTION (Skabeloner)
 * ============================================================================
 */
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [
      {
        name: "brand-analysis",
        description: "Henter de seneste anbefalingssnapshots under et tag og kontrollerer forekomster af et bestemt brand.",
        arguments: [
          {
            name: "brandName",
            description: "Navnet på det brand, du vil undersøge (f.eks. 'Semrush')",
            required: true,
          },
          {
            name: "tag",
            description: "Tagget for det område du vil hente resultater for (f.eks. 'category:seo')",
            required: true,
          },
        ],
      },
      {
        name: "keyword-expansion",
        description: "Undersøger nuværende søgeord for et projekt og foreslår relaterede søgeord til udvidelse.",
        arguments: [
          {
            name: "tag",
            description: "Projekt-tag (f.eks. 'market:dk')",
            required: true,
          },
          {
            name: "topic",
            description: "Det overordnede emne eller niche (f.eks. 'seo software')",
            required: true,
          },
        ],
      },
      {
        name: "credit-optimization",
        description: "Hjælper AI'en med at analysere kontoens kvoter og planlægge batch-kørsler på den mest kredit- og omkostningseffektive måde.",
        arguments: [
          {
            name: "tag",
            description: "Det tag, du planlægger at køre en analyse for (f.eks. 'category:seo')",
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
    const tag = args.tag ?? "[Tag]";

    return {
      description: `Udfør brand forekomst-analyse for ${brandName}`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Hej! Analyser venligst forekomster af brandet "${brandName}" i de seneste anbefalingssnapshots under tagget "${tag}".\n\nFølg disse trin:\n1. Kald værktøjet 'get_latest_results' med tag='${tag}' og format='markdown'.\n2. Opsummer på hvilke søgeord brandet anbefales, hvilken placering (rank) det har fået, og hvilke konkurrerende brands og websites der optræder i samme snapshots.\n3. Husk altid at gøre opmærksom på, at FullMention er et 'snapshot-first' API og ikke gemmer historik, og mind mig om at gemme denne rapport i en lokal fil, hvis jeg ønsker at sammenligne og spore tendenser over tid.`,
          },
        },
      ],
    };
  }

  if (name === "keyword-expansion") {
    const tag = args.tag ?? "[Tag]";
    const topic = args.topic ?? "[Emne]";

    return {
      description: `Søgeords-ekspansion for tag ${tag}`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Hej! Jeg vil gerne udvide vores FullMention keyword-overvågning for tagget "${tag}" inden for emnet "${topic}".\n\nFølg venligst disse trin:\n1. Kald 'list_keywords' med tagget '${tag}' og format='markdown' for at se, hvad vi overvåger i dag.\n2. Foreslå 10 relaterede keywords med land, sprog og motordefinitioner, der vil være relevante for emnet "${topic}".\n3. Vis forslagene i en flot tabel og forklar din logik.\n4. Spørg mig om tilladelse til at oprette dem. Hvis jeg siger ja, skal du bruge værktøjet 'create_keywords' til at tilføje dem.\n5. Husk altid at gøre opmærksom på, at FullMention er et 'snapshot-first' API og ikke gemmer historik, og foreslå at jeg gemmer mine konfigurationer lokalt, hvis jeg vil bevare dem til reference over tid.`,
          },
        },
      ],
    };
  }

  if (name === "credit-optimization") {
    const tag = args.tag ?? "[Tag]";

    return {
      description: `Planlæg en kredit-optimeret batch-kørsel for tag ${tag}`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Hej! Jeg vil gerne køre en batch-analyse af vores keywords under tagget "${tag}", men jeg vil gerne gøre det så omkostningseffektivt som muligt for at spare på vores FullMention API-kreditter.\n\nFølg venligst disse trin for at rådgive mig:\n1. Kald 'get_quota' for at tjekke mine resterende månedlige kreditter og eventuelle begrænsninger.\n2. Kald 'estimate_run' med tagget '${tag}' og fanout=false for at se standard kreditomkostningen.\n3. Kald derefter 'estimate_run' med tagget '${tag}' og fanout=true for at se, hvad web-søgninger (fanout) vil koste ekstra.\n4. Præsenter en sammenlignende budgetoversigt for mig i en flot tabel.\n5. Rådgiv mig om den bedste strategi (fx om vi kan køre uden fanout på visse sprog/lande, eller om vi har nok kreditter til en fuld fanout kørsel).\n6. Mind mig om, at FullMention is a 'snapshot-first' API and does not store historical series downstream, så når vi har godkendt kørslen og brugt 'trigger_run', skal vi selv gemme resultaterne lokalt i vores egne systemer.\n7. Spørg mig til sidst om tilladelse, før du kalder 'trigger_run'.`,
          },
        },
      ],
    };
  }

  throw new Error(`Ukendt prompt: ${name}`);
});

/**
 * ============================================================================
 * 6. DUAL TRANSPORT LAUNCHER (Option 2)
 * ============================================================================
 */
async function run() {
  // Check for --inspect CLI flag (P3 Nice to Have win)
  if (process.argv.includes("--inspect")) {
    console.log("\n==================================================");
    console.log("🔍 FULLMENTION MCP SERVER INSPECTOR");
    console.log("==================================================");
    
    // Auth status check
    const apiKey = process.env.FULLMENTION_API_KEY;
    if (apiKey) {
      console.log(`🔑 Autentificering: AKTIV [Nøgle fundet: ${apiKey.substring(0, 10)}... (samlet længde: ${apiKey.length} tegn)]`);
    } else {
      console.log("❌ Autentificering: MANGLER [Advarsel: Miljøvariablen FULLMENTION_API_KEY er ikke sat! API-kald vil fejle]");
    }
    
    // Read-only status
    const isReadOnly = process.env.FULLMENTION_MCP_READONLY === "true";
    console.log(`🛡️ Skrivebeskyttelse (Read-Only): ${isReadOnly ? "AKTIVERET (Skriveværktøjer er blokeret)" : "DEAKTIVERET (Alle værktøjer er tilgængelige)"}`);
    
    // Transport config
    const useSSE = process.argv.includes("--sse") || process.env.FULLMENTION_MCP_TRANSPORT === "sse";
    console.log(`🌐 Transportlag: ${useSSE ? "SSE (Server-Sent Events HTTP Web Server)" : "STDIO (Standard I/O Streams)"}`);
    
    // Registered Tools listing
    console.log("\n🛠️  Registrerede MCP Værktøjer:");
    const tools = [
      { name: "get_status", desc: "Hent dynamic system- og motorstatus" },
      { name: "get_quota", desc: "Hent konto-kvote og resterende kreditter" },
      { name: "list_keywords", desc: "Hent en liste over overvågede søgeord" },
      { name: "create_keywords", desc: "Opret nye søgeord i din konto (idempotent)" },
      { name: "update_keyword", desc: "Opdater tags eller indstillinger på et søgeord" },
      { name: "delete_keyword", desc: "Soft-deaktiver eller slet et søgeord" },
      { name: "list_tags", desc: "Hent en liste over alle aktive tags" },
      { name: "estimate_run", desc: "Beregn kredit-estimat for en snapshot-kørsel" },
      { name: "trigger_run", desc: "Start en asynkron batch-kørsel under tags" },
      { name: "get_run_status", desc: "Følg status og fremdrift på en batch-kørsel" },
      { name: "get_latest_results", desc: "Hent de seneste anbefalingssnapshots" },
      { name: "get_fanout_sources", desc: "Hent komplette søgekilder pr. resultat" },
      { name: "cancel_run", desc: "Afbryd eller annuller en igangværende batch-analyse" },
      { name: "list_runs", desc: "Hent en liste over batch-analyser med fremdrift" },
      { name: "get_share_of_voice", desc: "Beregn brand-anbefalinger og Share of Voice % server-side" },
      { name: "bulk_create_keywords", desc: "Bulk opretter flere søgeord med samme opsætning" },
      { name: "get_usage_stats", desc: "Hent detaljeret kvotebudget og historisk statistik" }
    ];
    tools.forEach(t => {
      console.log(`  • ${t.name.padEnd(20)} - ${t.desc}`);
    });
    
    // Registered Prompts listing
    console.log("\n📝 Registrerede MCP Prompts:");
    console.log("  • brand-analysis       - Opsummerer placeringer og konkurrent benchmarks for et brand under et tag");
    console.log("  • keyword-expansion    - Foreslår 10 nye emne-relaterede søgeord og tilbyder at tilføje dem");
    console.log("  • credit-optimization  - Henter kvoter, estimerer kørsel og rådgiver om mest budgetvenlige runs");
    
    console.log("==================================================\n");
    process.exit(0);
  }

  // Tjek om vi skal køre i SSE (Server-Sent Events) webserver mode
  const useSSE = process.argv.includes("--sse") || process.env.FULLMENTION_MCP_TRANSPORT === "sse";

  if (useSSE) {
    const { createServer } = await import("http");
    const { parse: parseUrl } = await import("url");
    const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");

    const activeTransports = new Map<string, any>();

    const sseHttpServer = createServer(async (req, res) => {
      const parsedUrl = parseUrl(req.url || "", true);
      const path = parsedUrl.pathname;

      // Tilføj fuld CORS understøttelse til remote gateways (Zapier, ChatGPT, n8n)
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

      // Start SSE stream (Handshake)
      if (path === "/sse" && req.method === "GET") {
        console.error("[FullMention MCP] SSE handshake startet...");
        
        // Ekstraher dynamic API key til tenant-validering (Bearer token eller query string)
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

        // Forbind serveren til transporten i tenantens auth-kontekst
        await apiKeyStorage.run(token, async () => {
          await server.connect(transport);
        });
        return;
      }

      // Modtag klientsvar og events
      if (path === "/message" && req.method === "POST") {
        const querySessionId = parsedUrl.query.sessionId as string;
        if (!querySessionId) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Manglende sessionId parameter.");
          return;
        }

        const session = activeTransports.get(querySessionId);
        if (session) {
          // Opdater token hvis den sendes med POST-anmodningen, ellers brug sessions-tokenen
          const queryToken = (parsedUrl.query.apiKey as string) || (parsedUrl.query.token as string);
          const authHeader = (req.headers["authorization"] as string) || "";
          const headerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
          const token = headerToken || queryToken || session.token || "";

          // Afvikl beskeden i tenantens auth-kontekst
          await apiKeyStorage.run(token, async () => {
            await session.transport.handlePostMessage(req, res);
          });
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end(`Aktiv session '${querySessionId}' blev ikke fundet.`);
        }
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    });

    const port = Number(process.env.FULLMENTION_MCP_PORT) || Number(process.env.PORT) || 3000;
    console.error(`[FullMention MCP] Starter Node HTTP SSE server på port ${port}...`);
    
    sseHttpServer.listen(port);
  } else {
    // Standard: Kør på lokal STDIO (ideelt til Cursor/Claude desktop)
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[FullMention MCP] Server er fuldt forbundet og lytter på STDIO.");
  }
}

run().catch((error) => {
  console.error("[FullMention MCP] Kritisk fejl under start af serveren:", error);
  process.exit(1);
});
