/** 模型目录：加载构建期生成的 catalog.zh.json，提供查询与参数说明。 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeModelId } from "./modelId.js";

export interface ParamSpec {
  name: string;
  type: string | null;
  required: boolean;
  enum?: (string | number | boolean)[];
  default?: unknown;
  description?: string;
  items?: string | null;
}

export interface CatalogEntry {
  file: string;
  operationId: string | null;
  method: string;
  path: string;
  title: string;
  summary: string | null;
  description: string | null;
  category: string;
  mediaType: string | null;
  models: string[];
  modelSource: "enum" | "const" | "default" | "none";
  requestContentTypes: string[];
  requiredParams: string[];
  params: string[];
  paramSpecs: ParamSpec[];
  registeredInDocsJson: boolean;
}

export interface Catalog {
  generatedAt: string;
  lang: string;
  specBaseUrl: string;
  specFileCount: number;
  entries: CatalogEntry[];
}

export type MediaType = "image" | "video" | "audio" | "document";

const CATALOG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "catalog",
  "catalog.zh.json",
);

let cached: Catalog | null = null;

export function loadCatalog(): Catalog {
  if (!cached) cached = JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as Catalog;
  return cached;
}

/** 仅返回 4 个生成端点的条目（image/video/audio/document）。 */
export function generationEntries(): CatalogEntry[] {
  return loadCatalog().entries.filter((e) => e.category === "generation");
}

/** 一个模型可能出现在多个 spec 文件（如系列文件 + 变体文件）；返回参数最丰富的那条。 */
export function findEntryByModel(model: string): CatalogEntry | undefined {
  const matches = generationEntries().filter((e) => e.models.includes(model));
  if (matches.length === 0) return undefined;
  return matches.sort((a, b) => b.params.length - a.params.length)[0];
}

/**
 * 为一个 live id 找参数说明：先精确匹配，再按归一化 family 匹配。
 *
 * 必须有 family 兜底——网关侧 17 个可调用 id 是 `veo-3.1[4k]`、`google/veo-3.1[fast]`
 * 这类变体命名，catalog 里只有裸名 `veo-3.1`，精确匹配一个都对不上。
 */
export function resolveEntry(
  modelId: string,
): { entry: CatalogEntry; catalogModel: string; match: "exact" | "family" } | undefined {
  const exact = findEntryByModel(modelId);
  if (exact) return { entry: exact, catalogModel: modelId, match: "exact" };

  const { base } = normalizeModelId(modelId);
  if (base === modelId) return undefined;
  const viaBase = findEntryByModel(base);
  if (viaBase) return { entry: viaBase, catalogModel: base, match: "family" };
  return undefined;
}

export interface ModelSummary {
  model: string;
  mediaType: string | null;
  title: string;
  summary: string | null;
  file: string;
}

/** 展开为「模型 → 摘要」列表（一个条目可含多个模型）。 */
export function listModelSummaries(opts: { mediaType?: MediaType; keyword?: string }): ModelSummary[] {
  const kw = opts.keyword?.toLowerCase();
  const seen = new Set<string>();
  const out: ModelSummary[] = [];
  for (const e of generationEntries()) {
    if (opts.mediaType && e.mediaType !== opts.mediaType) continue;
    for (const model of e.models) {
      if (seen.has(model)) continue;
      if (kw && !`${model} ${e.title} ${e.summary ?? ""}`.toLowerCase().includes(kw)) continue;
      seen.add(model);
      out.push({
        model,
        mediaType: e.mediaType,
        title: e.title,
        summary: e.summary,
        file: e.file,
      });
    }
  }
  return out.sort((a, b) => a.model.localeCompare(b.model));
}
