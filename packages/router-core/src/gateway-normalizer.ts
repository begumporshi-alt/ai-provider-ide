/**
 * Gateway request normalizer (Phase 1 of gateway-flexibility plan).
 *
 * Sanitizes and normalizes every incoming request before it reaches the router core.
 * Pure functions — no I/O, fully testable.
 *
 * Pipeline (in order):
 *   1. Role normalization (developer->system, model->assistant, system->user for incompatible providers)
 *   2. Tool-call id safety (ensure every tool_call has an id)
 *   3. Tool response hygiene (fix missing tool responses, strip orphaned tool results)
 *   4. Tool schema sanitization (recursive JSON Schema cleanup)
 *   5. Message shape fixes (string->array content, input->messages promotion, etc.)
 *   6. Client-specific adaptations (Claude Code tool remapping, Codex Responses normalization, z.ai user-turn guarantee)
 *
 * Based on patterns from OmniRoute (https://github.com/diegosouzapw/OmniRoute).
 */

// ── Types ─────────────────────────────────────────────────────────────────

export interface NormalizeOptions {
  /** Detected client type from User-Agent / headers */
  clientHint?: "workbuddy" | "claude-code" | "codex" | "zcode" | "cursor" | "generic";
  /** Provider the request will be routed to (for provider-specific quirks) */
  targetProvider?: string;
  /** Model native id */
  targetModel?: string;
  /** Preserve OpenAI developer role (default: false for non-OpenAI providers) */
  preserveDeveloperRole?: boolean;
  /** Preserve cache_control markers (for Claude Code) */
  preserveCacheControl?: boolean;
}

export interface NormalizedMessage {
  role?: string;
  content?: unknown;
  name?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  [key: string]: unknown;
}

// ── Utilities ─────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type?: string; text?: string } =>
        !!part && typeof part === "object" && "type" in part && (part as { type?: string }).type === "text",
    )
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

// ── 1. Role Normalization ─────────────────────────────────────────────────

const PROVIDERS_WITHOUT_SYSTEM_ROLE = new Set(["duckduckgo-web", "ddgw"]);

const PROVIDERS_PRESERVING_DEVELOPER_ROLE = new Set(["openai", "azure-openai", "azure", "github"]);

function defaultPreserveDeveloperForProvider(provider: string): boolean {
  const id = provider.trim().toLowerCase();
  if (!id) return false;
  if (PROVIDERS_PRESERVING_DEVELOPER_ROLE.has(id)) return true;
  if (id.includes("openai")) return true;
  return false;
}

const MODELS_WITHOUT_SYSTEM_ROLE = ["ernie-"];

function isGlmWithoutSystemRole(modelLower: string): boolean {
  if (!modelLower.startsWith("glm")) return false;
  const match = modelLower.match(/glm-?(\d+)(?:[.p](\d+))?/);
  if (match) {
    const major = Number(match[1]);
    const minor = match[2] ? Number(match[2]) : 0;
    if (major > 5 || (major === 5 && minor >= 1)) return false;
  }
  return true;
}

function supportsSystemRole(provider: string, model: string): boolean {
  const providerLower = (provider || "").trim().toLowerCase();
  if (PROVIDERS_WITHOUT_SYSTEM_ROLE.has(providerLower)) return false;
  const modelLower = (model || "").toLowerCase();
  if (isGlmWithoutSystemRole(modelLower)) return false;
  for (const prefix of MODELS_WITHOUT_SYSTEM_ROLE) {
    if (modelLower.startsWith(prefix)) return false;
  }
  return true;
}

function normalizeDeveloperRole(
  messages: NormalizedMessage[],
  targetFormat: string,
  preserveDeveloperRole: boolean | undefined,
  provider: string,
): NormalizedMessage[] {
  if (targetFormat === "openai") {
    const effectivePreserve =
      preserveDeveloperRole !== undefined ? preserveDeveloperRole : defaultPreserveDeveloperForProvider(provider);
    if (effectivePreserve) return messages;
  }
  return messages.map((msg) => {
    if (!msg || typeof msg !== "object") return msg;
    const role = typeof msg.role === "string" ? msg.role : "";
    if (role.toLowerCase() === "developer") {
      return { ...msg, role: "system" };
    }
    return msg;
  });
}

function normalizeModelRole(messages: NormalizedMessage[]): NormalizedMessage[] {
  return messages.map((msg) => {
    if (!msg || typeof msg !== "object") return msg;
    const role = typeof msg.role === "string" ? msg.role : "";
    if (role.toLowerCase() === "model") {
      return { ...msg, role: "assistant" };
    }
    return msg;
  });
}

function normalizeSystemRole(messages: NormalizedMessage[], provider: string, model: string): NormalizedMessage[] {
  if (messages.length === 0) return messages;
  if (supportsSystemRole(provider, model)) return messages;

  const systemMessages = messages.filter((m) => m.role === "system" || m.role === "developer");
  if (systemMessages.length === 0) return messages;

  const systemContent = systemMessages
    .map((m) => extractTextFromContent(m.content))
    .filter(Boolean)
    .join("\n\n");

  if (!systemContent) {
    return messages.filter((m) => m.role !== "system" && m.role !== "developer");
  }

  const nonSystem = messages.filter((m) => m.role !== "system" && m.role !== "developer");
  const firstUserIdx = nonSystem.findIndex((m) => m.role === "user");
  if (firstUserIdx >= 0) {
    const userMsg = nonSystem[firstUserIdx]!;
    const userContent = extractTextFromContent(userMsg.content);
    nonSystem[firstUserIdx] = {
      ...userMsg,
      content: `[System Instructions]\n${systemContent}\n\n[User Message]\n${userContent}`,
    };
  } else {
    nonSystem.unshift({ role: "user", content: `[System Instructions]\n${systemContent}` });
  }
  return nonSystem;
}

function hoistLeadingSystemMessage(messages: NormalizedMessage[]): NormalizedMessage[] {
  const firstSystemIdx = messages.findIndex((m) => m.role === "system");
  if (firstSystemIdx <= 0) return messages;
  const [sys] = messages.splice(firstSystemIdx, 1);
  if (sys) messages.unshift(sys);
  return messages;
}

// ── 2. Tool-Call Id Safety ────────────────────────────────────────────────

function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function generateToolCallId(index: number, name: string, argsPrefix: string): string {
  const raw = `${index}:${name}:${argsPrefix}`;
  const h = simpleHash(raw);
  return `call_${h.toString(36).slice(0, 9)}`;
}

function normalizeTo9CharId(id: string): string {
  if (id.length === 9) return id;
  const h = simpleHash(id);
  return h.toString(36).slice(0, 9).padStart(9, "0");
}

export function ensureToolCallIds(
  body: Record<string, unknown>,
  options?: { use9CharId?: boolean },
): void {
  const messages = body.messages as NormalizedMessage[] | undefined;
  if (!Array.isArray(messages)) return;

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const tcs = msg.tool_calls;
    if (!Array.isArray(tcs)) continue;

    for (let i = 0; i < tcs.length; i++) {
      const tc = tcs[i];
      if (!isPlainObject(tc)) continue;
      if (!tc.id || typeof tc.id !== "string") {
        const name = isPlainObject(tc.function) ? String(tc.function.name || "") : "";
        const args = isPlainObject(tc.function) ? String(tc.function.arguments || "").slice(0, 32) : "";
        tc.id = generateToolCallId(i, name, args);
      }
      if (options?.use9CharId && typeof tc.id === "string") {
        tc.id = normalizeTo9CharId(tc.id);
      }
      // Ensure index is set
      if (!Number.isInteger(tc.index)) {
        tc.index = i;
      }
    }
  }
}

// ── 3. Tool Response Hygiene ──────────────────────────────────────────────

export function fixMissingToolResponses(body: Record<string, unknown>): void {
  const messages = body.messages as NormalizedMessage[] | undefined;
  if (!Array.isArray(messages)) return;

  const toolCallIds = new Set<string>();
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role !== "assistant") continue;
    for (const tc of msg.tool_calls ?? []) {
      if (isPlainObject(tc) && typeof tc.id === "string") {
        toolCallIds.add(tc.id);
      }
    }
  }

  const resultIds = new Set<string>();
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role === "tool" && typeof msg.tool_call_id === "string") {
      resultIds.add(msg.tool_call_id);
    }
  }

  // Insert empty tool results for missing ids
  const missing: NormalizedMessage[] = [];
  for (const id of toolCallIds) {
    if (!resultIds.has(id)) {
      missing.push({ role: "tool", tool_call_id: id, content: "" });
    }
  }
  if (missing.length > 0) {
    // Find the last assistant message with tool_calls and insert after it
    let insertIdx = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant" && Array.isArray(messages[i]?.tool_calls) && messages[i]!.tool_calls!.length > 0) {
        insertIdx = i + 1;
        break;
      }
    }
    messages.splice(insertIdx, 0, ...missing);
  }
}

export function stripOrphanedToolResults(body: Record<string, unknown>): void {
  const messages = body.messages as NormalizedMessage[] | undefined;
  if (!Array.isArray(messages)) return;

  // Collect all tool_call ids declared in assistant messages
  const validIds = new Set<string>();
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role !== "assistant") continue;
    for (const tc of msg.tool_calls ?? []) {
      if (isPlainObject(tc) && typeof tc.id === "string") {
        validIds.add(tc.id);
      }
    }
  }

  // Filter out tool results whose id is not in validIds
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    if (msg.role === "tool" && typeof msg.tool_call_id === "string" && !validIds.has(msg.tool_call_id)) {
      messages.splice(i, 1);
    }
  }
}

// ── 4. Tool Schema Sanitization ───────────────────────────────────────────

const MAX_SCHEMA_DEPTH = 32;

function sanitizeSchema(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > MAX_SCHEMA_DEPTH) return {};
  if (!isPlainObject(value)) return {};

  const result: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined) continue;

    if (k === "properties" && isPlainObject(v)) {
      const cleaned: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v)) {
        if (isPlainObject(pv)) {
          cleaned[pk] = sanitizeSchema(pv, depth + 1);
        } else if (typeof pv === "boolean") {
          cleaned[pk] = pv;
        } else {
          cleaned[pk] = {};
        }
      }
      result[k] = cleaned;
    } else if (k === "items") {
      if (Array.isArray(v)) {
        const firstObject = v.find(isPlainObject);
        result[k] = firstObject ? sanitizeSchema(firstObject, depth + 1) : {};
      } else if (isPlainObject(v)) {
        result[k] = sanitizeSchema(v, depth + 1);
      }
    } else if (k === "anyOf" || k === "oneOf" || k === "allOf") {
      if (Array.isArray(v)) {
        result[k] = v.map((s) => (isPlainObject(s) ? sanitizeSchema(s, depth + 1) : {}));
      }
    } else if (k === "additionalProperties") {
      if (isPlainObject(v)) {
        result[k] = sanitizeSchema(v, depth + 1);
      } else if (typeof v === "boolean") {
        result[k] = v;
      }
    } else if (k === "enum" && Array.isArray(v)) {
      result[k] = v.filter((e) => e !== null && e !== undefined);
    } else if (k === "required" && Array.isArray(v)) {
      result[k] = v.filter((r) => typeof r === "string");
    } else {
      result[k] = v;
    }
  }

  // Keep opaque object schemas open
  if (result.type === "object" || isPlainObject(result.properties)) {
    if (result.properties === undefined) {
      result.properties = {};
      if (!hasOwn(result, "additionalProperties")) result.additionalProperties = true;
    } else if (isPlainObject(result.properties) && Object.keys(result.properties).length === 0) {
      if (!hasOwn(result, "additionalProperties")) result.additionalProperties = true;
    }
  }

  // Filter required to existing properties keys
  if (Array.isArray(result.required) && isPlainObject(result.properties)) {
    const validKeys = new Set(Object.keys(result.properties));
    result.required = (result.required as string[]).filter((r) => validKeys.has(r));
  }

  return result;
}

function ensureRootObjectType(schema: Record<string, unknown>): void {
  if (hasOwn(schema, "type")) return;
  if (hasOwn(schema, "anyOf") || hasOwn(schema, "oneOf") || hasOwn(schema, "allOf")) return;
  schema.type = "object";
  if (!isPlainObject(schema.properties)) {
    schema.properties = {};
    if (!hasOwn(schema, "additionalProperties")) schema.additionalProperties = true;
  }
}

function normalizeParameters(parameters: unknown): Record<string, unknown> {
  if (isPlainObject(parameters)) {
    const sanitized = sanitizeSchema(parameters);
    ensureRootObjectType(sanitized);
    return sanitized;
  }
  if (parameters === null || parameters === undefined) {
    return { type: "object", properties: {}, additionalProperties: true };
  }
  return { type: "object", properties: {}, additionalProperties: true };
}

export function sanitizeOpenAITool(tool: unknown): unknown {
  if (!isPlainObject(tool)) return tool;
  const t = { ...tool };

  if (isPlainObject(t.function)) {
    const f = { ...t.function };
    f.parameters = normalizeParameters(f.parameters);
    t.function = f;
  } else if (t.type === "function") {
    // Responses API format: no `function` wrapper
    t.parameters = normalizeParameters(t.parameters);
  }

  return t;
}

export function sanitizeOpenAITools(tools: unknown): unknown {
  if (!Array.isArray(tools)) return tools;
  return tools.map(sanitizeOpenAITool);
}

// ── 5. Message Shape Fixes ────────────────────────────────────────────────

function promoteInputToMessages(body: Record<string, unknown>): void {
  if (body.input == null && Array.isArray(body.messages)) return;
  if (Array.isArray(body.messages) && body.input == null) return;

  if (body.input != null && !Array.isArray(body.messages)) {
    const input = body.input;
    if (typeof input === "string") {
      body.messages = [{ role: "user", content: input }];
    } else if (Array.isArray(input)) {
      body.messages = input;
    } else if (isPlainObject(input)) {
      body.messages = [input];
    }
    delete body.input;
  }
}

function ensureArrayContent(messages: NormalizedMessage[]): void {
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if (typeof msg.content === "string") {
      msg.content = [{ type: "text", text: msg.content }];
    }
  }
}

function ensureUserTurnAfterToolCalls(messages: NormalizedMessage[]): void {
  // Some providers require a user turn after tool results before the next assistant turn
  if (messages.length === 0) return;
  const last = messages[messages.length - 1];
  if (!last || typeof last !== "object") return;
  if (last.role === "tool") {
    // Check if next-to-last is also tool — if so, the sequence is assistant -> tools, which is fine
    // But if the last is tool and there's no trailing user, some providers 400
    // Insert an empty user placeholder
    messages.push({ role: "user", content: "" });
  }
}

// ── 6. Client-Specific Adaptations ────────────────────────────────────────

// Claude Code tool name remapping
const CLAUDE_TOOL_RENAME_MAP: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  task: "Task",
  agent: "Agent",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  todowrite: "TodoWrite",
  todoread: "TodoRead",
  question: "Question",
  askuserquestion: "AskUserQuestion",
  skill: "Skill",
  slashcommand: "SlashCommand",
  multiedit: "MultiEdit",
  notebook: "Notebook",
  notebookedit: "NotebookEdit",
  notebookread: "NotebookRead",
  lsp: "Lsp",
  apply_patch: "ApplyPatch",
  applypatch: "ApplyPatch",
  bashoutput: "BashOutput",
  killshell: "KillShell",
  killbash: "KillBash",
  enterplanmode: "EnterPlanMode",
  exitplanmode: "ExitPlanMode",
  enterworktree: "EnterWorktree",
  exitworktree: "ExitWorktree",
  artifact: "Artifact",
  designsync: "DesignSync",
  monitor: "Monitor",
  sendmessage: "SendMessage",
  listagents: "ListAgents",
  pushnotification: "PushNotification",
  reportfindings: "ReportFindings",
  schedulewakeup: "ScheduleWakeup",
  croncreate: "CronCreate",
  crondelete: "CronDelete",
  cronlist: "CronList",
  taskoutput: "TaskOutput",
  taskstop: "TaskStop",
  taskcreate: "TaskCreate",
  taskupdate: "TaskUpdate",
  tasklist: "TaskList",
  taskget: "TaskGet",
  workflow: "Workflow",
};

const CLAUDE_REVERSE_MAP: Record<string, string> = {};
for (const [k, v] of Object.entries(CLAUDE_TOOL_RENAME_MAP)) {
  CLAUDE_REVERSE_MAP[v] = k;
}

function getRequestToolNameMap(body: Record<string, unknown>): Map<string, string> {
  const existing = body._toolNameMap instanceof Map ? (body._toolNameMap as Map<string, string>) : new Map<string, string>();
  Object.defineProperty(body, "_toolNameMap", {
    value: existing,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return existing;
}

function trackToolName(body: Record<string, unknown>, titleCaseName: string, originalName: string): void {
  getRequestToolNameMap(body).set(titleCaseName, originalName);
}

function remapClaudeToolNamesInRequest(body: Record<string, unknown>): void {
  const tools = body.tools as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (!tool || typeof tool !== "object") continue;
      // Chat Completions shape: { type: "function", function: { name, parameters } }
      // Responses API shape: { type: "function", name, parameters }
      let name: string | undefined;
      let namePath: "name" | "function.name" = "name";
      if (isPlainObject(tool.function) && typeof tool.function.name === "string") {
        name = tool.function.name;
        namePath = "function.name";
      } else if (typeof tool.name === "string") {
        name = tool.name;
        namePath = "name";
      }
      if (name) {
        const mapped = CLAUDE_TOOL_RENAME_MAP[name];
        if (mapped) {
          if (namePath === "function.name") {
            (tool.function as Record<string, unknown>).name = mapped;
          } else {
            tool.name = mapped;
          }
          trackToolName(body, mapped, name);
        }
      }
    }
  }

  const messages = body.messages as NormalizedMessage[] | undefined;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (!msg || typeof msg !== "object") continue;
      const content = msg.content as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === "tool_use" && typeof block.name === "string") {
          const mapped = CLAUDE_TOOL_RENAME_MAP[block.name];
          if (mapped) {
            const original = block.name;
            block.name = mapped;
            trackToolName(body, mapped, original);
          }
        }
      }
    }
  }

  const toolChoice = body.tool_choice as Record<string, unknown> | undefined;
  if (toolChoice?.type === "tool" && typeof toolChoice.name === "string") {
    const mapped = CLAUDE_TOOL_RENAME_MAP[toolChoice.name];
    if (mapped) {
      const original = toolChoice.name;
      toolChoice.name = mapped;
      trackToolName(body, mapped, original);
    }
  }
}

// Codex / Responses API normalization
function normalizeCodexRequest(body: Record<string, unknown>): void {
  // Promote reasoning_effort -> reasoning: { effort }
  if (body.reasoning_effort !== undefined && body.reasoning === undefined) {
    const effort = body.reasoning_effort;
    if (typeof effort === "string" || typeof effort === "number") {
      body.reasoning = { effort: String(effort) };
    }
    delete body.reasoning_effort;
  }

  // Map max_completion_tokens / max_tokens -> max_output_tokens
  if (body.max_output_tokens == null) {
    if (typeof body.max_completion_tokens === "number") {
      body.max_output_tokens = body.max_completion_tokens;
      delete body.max_completion_tokens;
    } else if (typeof body.max_tokens === "number") {
      body.max_output_tokens = body.max_tokens;
      delete body.max_tokens;
    }
  } else {
    delete body.max_tokens;
    delete body.max_completion_tokens;
  }

  // Map response_format -> text.format
  if (body.response_format != null && body.text == null) {
    body.text = { format: body.response_format };
    delete body.response_format;
  } else if (body.response_format != null) {
    delete body.response_format;
  }

  // Normalize input shape
  if (body.input != null && !Array.isArray(body.messages)) {
    const input = body.input;
    if (typeof input === "string") {
      body.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }];
    } else if (Array.isArray(input)) {
      body.input = input.map((item: unknown) => {
        if (typeof item === "string") {
          return { type: "message", role: "user", content: [{ type: "input_text", text: item }] };
        }
        if (isPlainObject(item) && !item.type) {
          return { type: "message", ...item };
        }
        return item;
      });
    }
  }
}

// z.ai / GLM family: ensure at least one user turn
function ensureUserTurnForZai(body: Record<string, unknown>): void {
  const messages = body.messages as NormalizedMessage[] | undefined;
  if (!Array.isArray(messages)) return;
  const hasUser = messages.some((m) => m?.role === "user");
  if (!hasUser) {
    messages.push({ role: "user", content: "" });
  }
}

// ── 7. Main Pipeline ──────────────────────────────────────────────────────

export function normalizeGatewayRequest(
  body: Record<string, unknown>,
  opts: NormalizeOptions = {},
): Record<string, unknown> {
  // Deep clone to avoid mutating caller's object
  const result: Record<string, unknown> = JSON.parse(JSON.stringify(body));

  const clientHint = opts.clientHint ?? "generic";
  const targetProvider = (opts.targetProvider ?? "").trim().toLowerCase();
  const targetModel = (opts.targetModel ?? "").trim().toLowerCase();
  const preserveDeveloperRole = opts.preserveDeveloperRole;

  // Phase A: Codex / Responses shape normalization (before role normalization)
  if (clientHint === "codex" || result.input != null) {
    normalizeCodexRequest(result);
  }

  // Promote input -> messages if needed
  promoteInputToMessages(result);

  // Phase B: Role normalization
  if (Array.isArray(result.messages)) {
    let messages = result.messages as NormalizedMessage[];
    messages = normalizeModelRole(messages);
    messages = normalizeDeveloperRole(messages, "openai", preserveDeveloperRole, targetProvider);
    messages = normalizeSystemRole(messages, targetProvider, targetModel);
    messages = hoistLeadingSystemMessage(messages);
    result.messages = messages;
  }

  // Phase C: Tool-call id safety
  ensureToolCallIds(result, { use9CharId: false });

  // Phase D: Tool response hygiene
  fixMissingToolResponses(result);
  stripOrphanedToolResults(result);

  // Phase E: Tool schema sanitization
  if (result.tools !== undefined) {
    result.tools = sanitizeOpenAITools(result.tools);
  }

  // Phase F: Message shape fixes
  if (Array.isArray(result.messages)) {
    ensureArrayContent(result.messages as NormalizedMessage[]);
    ensureUserTurnAfterToolCalls(result.messages as NormalizedMessage[]);
  }

  // Phase G: Client-specific adaptations
  if (clientHint === "claude-code") {
    remapClaudeToolNamesInRequest(result);
  }

  if (clientHint === "zcode" || targetProvider.includes("zhipu") || targetProvider.includes("glm") || /glm|zhipu|z-ai/i.test(targetModel)) {
    ensureUserTurnForZai(result);
  }

  // Final pass: ensure tool-call ids again (after any client remapping)
  ensureToolCallIds(result, { use9CharId: false });
  fixMissingToolResponses(result);
  stripOrphanedToolResults(result);

  return result;
}
