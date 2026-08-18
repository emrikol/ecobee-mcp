import { createHash } from "node:crypto";
import {
  fromJsonSchema,
  type AnyToolHandler,
  type Icon,
  type JsonSchemaType,
  type McpServer,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
} from "@modelcontextprotocol/server/runtime";
import type { EcobeeApiClient } from "./ecobee/api.js";
import type { EcobeeCache } from "./ecobee/cache.js";
import type { EcobeePlugin } from "./plugins/types.js";
import { registerAllTools } from "./tools/index.js";

export const CATALOG_FINGERPRINT_META_KEY =
  "io.github.emrikol/ecobee-mcp.catalogFingerprint";

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_SCHEMA_BYTES = 128 * 1024;
const MAX_CATALOG_BYTES = 192 * 1024;
const UNSUPPORTED_SCHEMA_KEYWORDS = [
  "$dynamicRef",
  "$ref",
  "$defs",
  "allOf",
  "contains",
  "dependentSchemas",
  "else",
  "if",
  "not",
  "oneOf",
  "patternProperties",
  "prefixItems",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
] as const;

export interface CatalogToolConfig {
  title?: string;
  description?: string;
  inputSchema: StandardSchemaWithJSON;
  outputSchema: StandardSchemaWithJSON;
  annotations: ToolAnnotations;
  icons?: Icon[];
  _meta?: Record<string, unknown>;
}

export type CatalogToolHandler = AnyToolHandler<StandardSchemaWithJSON>;

/** The deliberately narrow registration surface available during catalog build. */
export interface ToolCatalogRegistrar {
  registerTool(
    name: string,
    config: CatalogToolConfig,
    handler: CatalogToolHandler,
  ): void;
}

interface CollectedTool {
  name: string;
  config: CatalogToolConfig;
  handler: CatalogToolHandler;
  source: string;
}

interface CatalogTool extends CollectedTool {
  inputSchemaJson: Record<string, unknown>;
  outputSchemaJson: Record<string, unknown>;
  publishedMeta: Record<string, unknown>;
}

export interface ToolCatalogSnapshot {
  readonly fingerprint: string;
  readonly generation: number;
  readonly toolNames: readonly string[];
  readonly tools: readonly CatalogTool[];
}

export interface ToolCatalogInfo {
  fingerprint: string;
  generation: number;
  toolNames: readonly string[];
}

export interface CatalogReloadResult extends ToolCatalogInfo {
  accepted: boolean;
  changed: boolean;
  error?: string;
}

export type ToolCatalogLoader = () => Promise<readonly EcobeePlugin[]>;

export class CatalogValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogValidationError";
  }
}

/**
 * Owns the one live catalog pointer. JavaScript assignment is atomic: a server
 * factory either captures the complete old snapshot or the complete new one.
 */
export class ToolCatalogStore {
  private snapshotValue: ToolCatalogSnapshot;
  private reloadTail = Promise.resolve();

  private constructor(
    snapshot: ToolCatalogSnapshot,
    private readonly api: EcobeeApiClient,
    private readonly cache: EcobeeCache,
    private readonly loader: ToolCatalogLoader | undefined,
    private readonly notifyToolsChanged: () => void,
  ) {
    this.snapshotValue = snapshot;
  }

  static async create(
    api: EcobeeApiClient,
    cache: EcobeeCache,
    plugins: readonly EcobeePlugin[],
    loader: ToolCatalogLoader | undefined,
    notifyToolsChanged: () => void,
  ): Promise<ToolCatalogStore> {
    const initial = await buildToolCatalog(api, cache, plugins, 1);
    return new ToolCatalogStore(
      initial,
      api,
      cache,
      loader,
      notifyToolsChanged,
    );
  }

  capture(): ToolCatalogSnapshot {
    return this.snapshotValue;
  }

  info(): ToolCatalogInfo {
    const { fingerprint, generation, toolNames } = this.snapshotValue;
    return { fingerprint, generation, toolNames };
  }

  reload(): Promise<CatalogReloadResult> {
    const operation = this.reloadTail.then(() => this.reloadOnce());
    this.reloadTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async reloadOnce(): Promise<CatalogReloadResult> {
    const current = this.snapshotValue;
    if (!this.loader) {
      return {
        ...this.info(),
        accepted: false,
        changed: false,
        error: "Catalog reload is disabled.",
      };
    }

    let candidate: ToolCatalogSnapshot;
    try {
      const plugins = await this.loader();
      candidate = await buildToolCatalog(
        this.api,
        this.cache,
        plugins,
        current.generation + 1,
      );
    } catch {
      return {
        ...this.info(),
        accepted: false,
        changed: false,
        error: "Candidate catalog validation failed.",
      };
    }
    if (candidate.fingerprint === current.fingerprint) {
      // Handler code may have changed without changing its public contract.
      // Publish it, but do not invalidate client tool-list caches.
      this.snapshotValue = candidate;
      return { ...this.info(), accepted: true, changed: false };
    }

    this.snapshotValue = candidate;
    try {
      this.notifyToolsChanged();
    } catch {
      return {
        ...this.info(),
        accepted: true,
        changed: true,
        error: "Catalog published but change notification failed.",
      };
    }
    return { ...this.info(), accepted: true, changed: true };
  }
}

export async function buildToolCatalog(
  api: EcobeeApiClient,
  cache: EcobeeCache,
  plugins: readonly EcobeePlugin[],
  generation: number,
): Promise<ToolCatalogSnapshot> {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new CatalogValidationError("Invalid catalog generation.");
  }

  const collector = new CatalogCollector();
  collector.source = "built-in";
  registerAllTools(collector as unknown as McpServer, api, cache);

  const pluginNames = new Set<string>();
  for (const plugin of plugins) validatePlugin(plugin);
  for (const plugin of [...plugins].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (pluginNames.has(plugin.name)) {
      throw new CatalogValidationError("Duplicate plugin name.");
    }
    pluginNames.add(plugin.name);
    if (!plugin.registerTools) continue;
    collector.source = `plugin:${plugin.name}`;
    const result = plugin.registerTools(collector, api, cache) as unknown;
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(() => undefined);
      throw new CatalogValidationError(
        "Plugin tool registration must be synchronous.",
      );
    }
  }

  const materialized: CatalogTool[] = [];
  for (const tool of collector.tools) {
    materialized.push(await materializeTool(tool));
  }
  const fingerprintPayload = canonicalJson(
    [...materialized]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(fingerprintView),
  );
  if (Buffer.byteLength(fingerprintPayload, "utf8") > MAX_CATALOG_BYTES) {
    throw new CatalogValidationError("Tool catalog is too large.");
  }
  const fingerprint = createHash("sha256")
    .update(fingerprintPayload)
    .digest("hex");

  const tools = materialized.map((tool) => {
    const publishedMeta = deepFreeze({
      ...cloneJsonRecord(tool.config._meta ?? {}, `${tool.name}._meta`),
      [CATALOG_FINGERPRINT_META_KEY]: fingerprint,
    });
    return Object.freeze({ ...tool, publishedMeta });
  });
  const toolNames = Object.freeze(tools.map(({ name }) => name));
  return Object.freeze({
    fingerprint,
    generation,
    toolNames,
    tools: Object.freeze(tools),
  });
}

export function registerCatalogTools(
  server: McpServer,
  snapshot: ToolCatalogSnapshot,
): void {
  for (const tool of snapshot.tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.config.title,
        description: tool.config.description,
        inputSchema: tool.config.inputSchema,
        outputSchema: tool.config.outputSchema,
        annotations: tool.config.annotations,
        icons: tool.config.icons,
        _meta: tool.publishedMeta,
      },
      tool.handler,
    );
  }
}

class CatalogCollector implements ToolCatalogRegistrar {
  readonly tools: CollectedTool[] = [];
  private readonly names = new Set<string>();
  source = "unknown";

  registerTool(
    name: string,
    config: CatalogToolConfig,
    handler: CatalogToolHandler,
  ): void {
    if (this.names.has(name)) {
      throw new CatalogValidationError(`Tool name collision: ${name}`);
    }
    this.names.add(name);
    this.tools.push({ name, config, handler, source: this.source });
  }
}

async function materializeTool(tool: CollectedTool): Promise<CatalogTool> {
  if (typeof tool.name !== "string" || !TOOL_NAME.test(tool.name)) {
    throw new CatalogValidationError("Invalid tool name.");
  }
  if (!isRecord(tool.config) || typeof tool.handler !== "function") {
    throw new CatalogValidationError("Malformed tool registration.");
  }
  if (
    !isRecord(tool.config.annotations) ||
    typeof tool.config.annotations.readOnlyHint !== "boolean"
  ) {
    throw new CatalogValidationError(
      "Every tool must explicitly declare readOnlyHint.",
    );
  }
  validateAnnotations(tool.config.annotations);
  if (
    (tool.config.title !== undefined &&
      typeof tool.config.title !== "string") ||
    (tool.config.description !== undefined &&
      typeof tool.config.description !== "string")
  ) {
    throw new CatalogValidationError("Tool text metadata is malformed.");
  }
  if (tool.config._meta !== undefined && !isRecord(tool.config._meta)) {
    throw new CatalogValidationError("Tool _meta is malformed.");
  }
  if (
    tool.config._meta !== undefined &&
    Object.hasOwn(tool.config._meta, CATALOG_FINGERPRINT_META_KEY)
  ) {
    throw new CatalogValidationError("Tool _meta uses a reserved key.");
  }
  if (tool.config.icons !== undefined && !Array.isArray(tool.config.icons)) {
    throw new CatalogValidationError("Tool icons are malformed.");
  }
  if (tool.config.icons !== undefined) validateIcons(tool.config.icons);

  const inputSchemaJson = schemaJson(
    tool.config.inputSchema,
    "input",
    `${tool.name}.inputSchema`,
  );
  const outputSchemaJson = schemaJson(
    tool.config.outputSchema,
    "output",
    `${tool.name}.outputSchema`,
  );
  validateBoundedObjectSchema(inputSchemaJson, `${tool.name}.inputSchema`);
  validateBoundedObjectSchema(outputSchemaJson, `${tool.name}.outputSchema`);

  // Built-ins are generated by the local schema builder and covered by the
  // stable-schema suite. Plugin schemas also receive a real SDK compilation
  // before they can enter the live snapshot.
  const publishedInputSchema =
    tool.source === "built-in"
      ? tool.config.inputSchema
      : await compileCandidateSchema(inputSchemaJson);
  const publishedOutputSchema =
    tool.source === "built-in"
      ? tool.config.outputSchema
      : await compileCandidateSchema(outputSchemaJson);

  if (
    Buffer.byteLength(canonicalJson(inputSchemaJson), "utf8") >
      MAX_SCHEMA_BYTES ||
    Buffer.byteLength(canonicalJson(outputSchemaJson), "utf8") >
      MAX_SCHEMA_BYTES
  ) {
    throw new CatalogValidationError("Tool schema is too large.");
  }

  const config = Object.freeze({
    ...tool.config,
    inputSchema: publishedInputSchema,
    outputSchema: publishedOutputSchema,
    annotations: deepFreeze(
      cloneJsonRecord(tool.config.annotations, `${tool.name}.annotations`),
    ) as ToolAnnotations,
    ...(tool.config.icons === undefined
      ? {}
      : {
          icons: deepFreeze(
            cloneJsonValue(tool.config.icons, `${tool.name}.icons`),
          ) as Icon[],
        }),
    ...(tool.config._meta === undefined
      ? {}
      : {
          _meta: deepFreeze(
            cloneJsonRecord(tool.config._meta, `${tool.name}._meta`),
          ),
        }),
  });
  return {
    ...tool,
    config,
    inputSchemaJson: deepFreeze(cloneJsonRecord(inputSchemaJson, "schema")),
    outputSchemaJson: deepFreeze(cloneJsonRecord(outputSchemaJson, "schema")),
    publishedMeta: {},
  };
}

function validatePlugin(plugin: EcobeePlugin): void {
  if (
    !isRecord(plugin) ||
    typeof plugin.name !== "string" ||
    !plugin.name.trim()
  ) {
    throw new CatalogValidationError("Malformed plugin.");
  }
  if (
    plugin.registerTools !== undefined &&
    typeof plugin.registerTools !== "function"
  ) {
    throw new CatalogValidationError("Malformed plugin tool registrar.");
  }
}

function schemaJson(
  schema: StandardSchemaWithJSON,
  direction: "input" | "output",
  label: string,
): Record<string, unknown> {
  if (!isRecord(schema) || !isRecord(schema["~standard"])) {
    throw new CatalogValidationError(`${label} is not a Standard Schema.`);
  }
  const converter = schema["~standard"].jsonSchema?.[direction];
  if (typeof converter !== "function") {
    throw new CatalogValidationError(`${label} has no JSON Schema converter.`);
  }
  let converted: unknown;
  try {
    converted = converter({ target: "draft-2020-12" });
  } catch {
    throw new CatalogValidationError(`${label} conversion failed.`);
  }
  if (!isRecord(converted)) {
    throw new CatalogValidationError(`${label} must be a JSON Schema object.`);
  }
  return converted;
}

async function compileCandidateSchema(
  schema: Record<string, unknown>,
): Promise<StandardSchemaWithJSON> {
  try {
    const candidate = fromJsonSchema(schema as JsonSchemaType);
    await candidate["~standard"].validate({});
    return candidate;
  } catch {
    throw new CatalogValidationError("Plugin schema compilation failed.");
  }
}

function validateBoundedObjectSchema(
  schema: Record<string, unknown>,
  path: string,
): void {
  if (schema.type !== "object") {
    throw new CatalogValidationError(`${path} must have object type.`);
  }
  validateSchemaNode(schema, path, new Set<object>());
}

function validateSchemaNode(
  schema: Record<string, unknown>,
  path: string,
  ancestors: Set<object>,
): void {
  if (ancestors.has(schema)) {
    throw new CatalogValidationError(`${path} contains a cycle.`);
  }
  ancestors.add(schema);
  try {
    for (const keyword of UNSUPPORTED_SCHEMA_KEYWORDS) {
      if (keyword in schema) {
        throw new CatalogValidationError(
          `${path} uses unsupported keyword ${keyword}.`,
        );
      }
    }
    if (
      schema.type === undefined &&
      schema.anyOf === undefined &&
      schema.enum === undefined &&
      schema.const === undefined
    ) {
      throw new CatalogValidationError(`${path} is unconstrained.`);
    }
    if (
      schema.type !== undefined &&
      ![
        "object",
        "array",
        "string",
        "number",
        "integer",
        "boolean",
        "null",
      ].includes(String(schema.type))
    ) {
      throw new CatalogValidationError(`${path} has an invalid type.`);
    }
    if (schema.pattern !== undefined) {
      if (typeof schema.pattern !== "string") {
        throw new CatalogValidationError(`${path}.pattern must be a string.`);
      }
      try {
        new RegExp(schema.pattern);
      } catch {
        throw new CatalogValidationError(`${path}.pattern is invalid.`);
      }
    }
    if (
      schema.type === "string" &&
      schema.enum === undefined &&
      schema.const === undefined &&
      !isNonNegativeInteger(schema.maxLength)
    ) {
      throw new CatalogValidationError(`${path} has an unbounded string.`);
    }
    if (schema.type === "array") {
      if (!isNonNegativeInteger(schema.maxItems) || !isRecord(schema.items)) {
        throw new CatalogValidationError(`${path} has an unbounded array.`);
      }
      validateSchemaNode(schema.items, `${path}.items`, ancestors);
    }
    if (schema.type === "number" || schema.type === "integer") {
      if (
        typeof schema.minimum !== "number" ||
        !Number.isFinite(schema.minimum) ||
        typeof schema.maximum !== "number" ||
        !Number.isFinite(schema.maximum)
      ) {
        throw new CatalogValidationError(`${path} has an unbounded number.`);
      }
    }
    if (schema.type === "object") {
      if (schema.required !== undefined) {
        if (
          !Array.isArray(schema.required) ||
          !schema.required.every((name) => typeof name === "string") ||
          new Set(schema.required).size !== schema.required.length
        ) {
          throw new CatalogValidationError(`${path}.required is malformed.`);
        }
      }
      if (schema.propertyNames !== undefined) {
        if (!isRecord(schema.propertyNames)) {
          throw new CatalogValidationError(
            `${path}.propertyNames is malformed.`,
          );
        }
        validateSchemaNode(
          schema.propertyNames,
          `${path}.propertyNames`,
          ancestors,
        );
      }
      if (schema.properties !== undefined) {
        if (!isRecord(schema.properties)) {
          throw new CatalogValidationError(`${path}.properties is malformed.`);
        }
        if (schema.additionalProperties !== false) {
          throw new CatalogValidationError(
            `${path} must reject unknown properties.`,
          );
        }
        for (const [name, property] of Object.entries(schema.properties)) {
          if (!isRecord(property)) {
            throw new CatalogValidationError(`${path}.${name} is malformed.`);
          }
          validateSchemaNode(property, `${path}.${name}`, ancestors);
        }
      } else if (isRecord(schema.additionalProperties)) {
        if (!isNonNegativeInteger(schema.maxProperties)) {
          throw new CatalogValidationError(`${path} has unbounded properties.`);
        }
        validateSchemaNode(
          schema.additionalProperties,
          `${path}.additionalProperties`,
          ancestors,
        );
      } else if (schema.additionalProperties !== false) {
        throw new CatalogValidationError(`${path} is an unbounded object.`);
      }
    }
    if (schema.anyOf !== undefined) {
      if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
        throw new CatalogValidationError(`${path}.anyOf is malformed.`);
      }
      schema.anyOf.forEach((child, index) => {
        if (!isRecord(child)) {
          throw new CatalogValidationError(`${path}.anyOf is malformed.`);
        }
        validateSchemaNode(child, `${path}.anyOf[${index}]`, ancestors);
      });
    }
  } finally {
    ancestors.delete(schema);
  }
}

function validateAnnotations(annotations: Record<string, unknown>): void {
  if (
    annotations.title !== undefined &&
    typeof annotations.title !== "string"
  ) {
    throw new CatalogValidationError("Tool annotation title is malformed.");
  }
  for (const hint of [
    "readOnlyHint",
    "destructiveHint",
    "idempotentHint",
    "openWorldHint",
  ]) {
    if (
      annotations[hint] !== undefined &&
      typeof annotations[hint] !== "boolean"
    ) {
      throw new CatalogValidationError(`Tool annotation ${hint} is malformed.`);
    }
  }
}

function validateIcons(icons: unknown[]): void {
  for (const icon of icons) {
    if (
      !isRecord(icon) ||
      typeof icon.src !== "string" ||
      icon.src.length === 0 ||
      (icon.mimeType !== undefined && typeof icon.mimeType !== "string") ||
      (icon.theme !== undefined &&
        icon.theme !== "light" &&
        icon.theme !== "dark") ||
      (icon.sizes !== undefined &&
        (!Array.isArray(icon.sizes) ||
          !icon.sizes.every((size) => typeof size === "string")))
    ) {
      throw new CatalogValidationError("Tool icon is malformed.");
    }
  }
}

function fingerprintView(tool: CatalogTool): Record<string, unknown> {
  return {
    name: tool.name,
    ...(tool.config.title === undefined ? {} : { title: tool.config.title }),
    ...(tool.config.description === undefined
      ? {}
      : { description: tool.config.description }),
    inputSchema: tool.inputSchemaJson,
    outputSchema: tool.outputSchemaJson,
    annotations: tool.config.annotations,
    ...(tool.config.icons === undefined ? {} : { icons: tool.config.icons }),
    ...(tool.config._meta === undefined ? {} : { _meta: tool.config._meta }),
  };
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CatalogValidationError("Catalog contains a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new CatalogValidationError("Catalog contains a non-JSON value.");
  }
  if (ancestors.has(value)) {
    throw new CatalogValidationError("Catalog contains a cycle.");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((child) => canonicalJson(child, ancestors)).join(",")}]`;
    }
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(object[key], ancestors)}`,
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function cloneJsonRecord(
  value: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  try {
    return JSON.parse(canonicalJson(value)) as Record<string, unknown>;
  } catch {
    throw new CatalogValidationError(`${label} is not JSON serializable.`);
  }
}

function cloneJsonValue<T>(value: T, label: string): T {
  try {
    return JSON.parse(canonicalJson(value)) as T;
  } catch {
    throw new CatalogValidationError(`${label} is not JSON serializable.`);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
