/**
 * M0 目录管道：从 mintlify 文档站源码的 openapi/zh/*.json 构建模型目录索引，
 * 并与 docs.json 的注册清单做交叉核对。
 *
 * 权威源是磁盘 spec 文件；docs.json 仅作导航映射核对（两者已知存在少量不一致）。
 *
 * 用法：MINTLIFY_DIR=/path/to/mintlify npm run build-catalog
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 不设默认值：仓库要公开分发，硬编码某台机器的私人路径既泄漏路径，
// 又会让其他人拿到一条指向不存在目录的 ENOENT，而不是「请设置 MINTLIFY_DIR」。
const MINTLIFY_DIR = process.env.MINTLIFY_DIR;
if (!MINTLIFY_DIR) {
  throw new Error(
    "需要 MINTLIFY_DIR：指向 aihubmax 文档站源码目录（其下应有 openapi/zh/*.json 与 docs.json）。\n" +
      "用法：MINTLIFY_DIR=/path/to/mintlify npm run build-catalog",
  );
}
const LANG = "zh";
const SPEC_DIR = join(MINTLIFY_DIR, "openapi", LANG);
const DOCS_JSON = join(MINTLIFY_DIR, "docs.json");
for (const [label, p] of [["openapi 目录", SPEC_DIR], ["docs.json", DOCS_JSON]] as const) {
  if (!existsSync(p)) throw new Error(`MINTLIFY_DIR 下找不到${label}：${p}`);
}
// 输出目录可覆盖：测试用临时目录跑，避免碰到仓库里的真实产物
const OUT_DIR =
  process.env.CATALOG_OUT_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "catalog");
const SPEC_BASE_URL = `https://docs.aihubmax.com/openapi/${LANG}/`;

type JsonObject = Record<string, unknown>;

interface ParamSpec {
  name: string;
  type: string | null;
  required: boolean;
  /** true 表示只在部分变体下必填。 */
  conditional?: boolean;
  enum?: (string | number | boolean)[];
  default?: unknown;
  description?: string;
  items?: string | null;
}

interface CatalogEntry {
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
  /** 仅在某些 oneOf/anyOf 变体下必填的参数（互斥项，不能同时照抄）。 */
  conditionalRequiredParams?: string[];
  params: string[];
  paramSpecs: ParamSpec[];
  registeredInDocsJson: boolean;
}

/** 端点 → 分类 / 媒体类型。生成端点与兼容接口按完整路径区分（注意 Suno 的 /v1/audio/generations 单数特例）。 */
function classify(method: string, path: string): { category: string; mediaType: string | null } {
  const p = path.toLowerCase();
  if (method === "POST") {
    if (p === "/v1/images/generations") return { category: "generation", mediaType: "image" };
    if (p === "/v1/videos/generations") return { category: "generation", mediaType: "video" };
    if (p === "/v1/audios/generations" || p === "/v1/audio/generations")
      return { category: "generation", mediaType: "audio" };
    if (p === "/v1/run/generations") return { category: "generation", mediaType: "document" };
    if (p.startsWith("/v1/llm/generations") || p.startsWith("/v1/llm_async/"))
      return { category: "llm-async", mediaType: "llm" };
    if (p.startsWith("/v1/files/upload/")) return { category: "files", mediaType: null };
    if (
      p === "/v1/chat/completions" ||
      p === "/v1/responses" ||
      p === "/v1/embeddings" ||
      p === "/v1/messages" ||
      p === "/v1/audio/transcriptions" ||
      p.startsWith("/v1beta/")
    )
      return { category: "compat", mediaType: null };
  }
  if (method === "GET") {
    if (p.startsWith("/v1/tasks/")) return { category: "task", mediaType: null };
    if (p.startsWith("/v1/account/")) return { category: "account", mediaType: null };
    if (p.startsWith("/v1/configs/")) return { category: "configs", mediaType: null };
    if (p.startsWith("/v1/llm/generations") || p.startsWith("/v1/llm_async/"))
      return { category: "llm-async", mediaType: "llm" };
  }
  return { category: "other", mediaType: null };
}

function resolveRef(spec: JsonObject, ref: string): JsonObject | null {
  if (!ref.startsWith("#/")) return null;
  let node: unknown = spec;
  for (const seg of ref.slice(2).split("/")) {
    if (typeof node !== "object" || node === null) return null;
    node = (node as JsonObject)[seg];
  }
  return typeof node === "object" && node !== null ? (node as JsonObject) : null;
}

/**
 * 展开 $ref / allOf / oneOf / anyOf，收集所有可能的请求体属性定义。
 *
 * 属性定义取并集（供参数说明），但 required 不能取并集——见下方 requiredSome/required 的处理。
 */
function flattenSchemas(spec: JsonObject, schema: unknown, depth = 0): JsonObject[] {
  if (depth > 6 || typeof schema !== "object" || schema === null) return [];
  const s = schema as JsonObject;
  if (typeof s.$ref === "string") {
    const target = resolveRef(spec, s.$ref);
    return target ? flattenSchemas(spec, target, depth + 1) : [];
  }
  const variants = [s.oneOf, s.anyOf].filter(Array.isArray).flat();
  if (variants.length > 0) return variants.flatMap((v) => flattenSchemas(spec, v, depth + 1));
  if (Array.isArray(s.allOf)) {
    const merged: JsonObject = { properties: {}, required: [] };
    for (const part of [...s.allOf.flatMap((p) => flattenSchemas(spec, p, depth + 1)), s]) {
      Object.assign(merged.properties as JsonObject, (part.properties as JsonObject) ?? {});
      (merged.required as unknown[]).push(...((part.required as unknown[]) ?? []));
    }
    return [merged];
  }
  return [s];
}

function extractModels(schemas: JsonObject[]): { models: string[]; source: CatalogEntry["modelSource"] } {
  const models = new Set<string>();
  let source: CatalogEntry["modelSource"] = "none";
  for (const s of schemas) {
    const model = ((s.properties as JsonObject) ?? {})["model"];
    if (typeof model !== "object" || model === null) continue;
    const m = model as JsonObject;
    if (Array.isArray(m.enum)) {
      for (const v of m.enum) if (typeof v === "string") models.add(v);
      source = "enum";
    } else if (typeof m.const === "string") {
      models.add(m.const);
      if (source === "none") source = "const";
    } else if (typeof m.default === "string") {
      models.add(m.default);
      if (source === "none") source = "default";
    }
  }
  return { models: [...models].sort(), source };
}

// ---- main ----

const specFiles = readdirSync(SPEC_DIR).filter((f) => f.endsWith(".json")).sort();

// docs.json 注册清单：对原文做正则提取，规避其内部结构差异
const docsJsonRaw = readFileSync(DOCS_JSON, "utf8");
const registered = new Set(
  [...docsJsonRaw.matchAll(/openapi\/zh\/([^"\s]+?\.json)/g)].map((m) => m[1]!),
);

const entries: CatalogEntry[] = [];
const parseFailures: string[] = [];

for (const file of specFiles) {
  let spec: JsonObject;
  try {
    spec = JSON.parse(readFileSync(join(SPEC_DIR, file), "utf8")) as JsonObject;
  } catch {
    parseFailures.push(file);
    continue;
  }
  const title = String(((spec.info as JsonObject) ?? {}).title ?? file);
  const paths = (spec.paths as JsonObject) ?? {};
  for (const [path, opsRaw] of Object.entries(paths)) {
    const ops = (opsRaw ?? {}) as JsonObject;
    for (const [methodLower, opRaw] of Object.entries(ops)) {
      if (!["get", "post", "put", "patch", "delete"].includes(methodLower)) continue;
      const op = (opRaw ?? {}) as JsonObject;
      const method = methodLower.toUpperCase();
      const content = (((op.requestBody as JsonObject) ?? {}).content as JsonObject) ?? {};
      const requestContentTypes = Object.keys(content);
      const schemas = requestContentTypes.flatMap((ct) =>
        flattenSchemas(spec, ((content[ct] as JsonObject) ?? {}).schema),
      );
      const { models, source } = extractModels(schemas);
      const params = new Set<string>();
      for (const s of schemas) {
        for (const k of Object.keys((s.properties as JsonObject) ?? {})) params.add(k);
      }
      /*
       * oneOf/anyOf 的语义是「N 选一」，各变体的必填项通常互斥（如 text-to-video 必填
       * prompt、image-to-video 必填 image_url）。跨变体取并集会把互斥项全标成必填，
       * describe_model 的示例就会同时塞两个，提交必然 422。
       * 因此区分：required = 所有变体都必填（照抄安全）；conditional = 仅某些变体必填。
       */
      const perVariantRequired = schemas.map(
        (s) => new Set(((s.required as unknown[]) ?? []).filter((r): r is string => typeof r === "string")),
      );
      const requiredSome = new Set(perVariantRequired.flatMap((s) => [...s]));
      const required = new Set([...requiredSome].filter((r) => perVariantRequired.every((s) => s.has(r))));
      const conditionalRequired = [...requiredSome].filter((r) => !required.has(r)).sort();
      // 合并各变体的属性定义为一份参数 Schema（同名属性取首个非空定义）
      const propDefs = new Map<string, JsonObject>();
      for (const s of schemas) {
        for (const [k, v] of Object.entries((s.properties as JsonObject) ?? {})) {
          if (typeof v === "object" && v !== null && !propDefs.has(k))
            propDefs.set(k, v as JsonObject);
        }
      }
      const paramSpecs: ParamSpec[] = [...propDefs.entries()].map(([name, def]) => {
        const items = def.items as JsonObject | undefined;
        const enumVals = (def.enum ?? (typeof def.const !== "undefined" ? [def.const] : undefined)) as
          | (string | number | boolean)[]
          | undefined;
        const desc = typeof def.description === "string" ? def.description.trim() : undefined;
        return {
          name,
          type: typeof def.type === "string" ? def.type : null,
          required: required.has(name),
          ...(conditionalRequired.includes(name) ? { conditional: true as const } : {}),
          ...(enumVals ? { enum: enumVals } : {}),
          ...(typeof def.default !== "undefined" ? { default: def.default } : {}),
          ...(desc ? { description: desc.length > 300 ? desc.slice(0, 300) + "…" : desc } : {}),
          ...(items ? { items: typeof items.type === "string" ? items.type : null } : {}),
        };
      });
      paramSpecs.sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name));

      const { category, mediaType } = classify(method, path);
      const desc = op.description;
      entries.push({
        file,
        operationId: typeof op.operationId === "string" ? op.operationId : null,
        method,
        path,
        title,
        summary: typeof op.summary === "string" ? op.summary : null,
        description: typeof desc === "string" ? desc.trim().slice(0, 500) : null,
        category,
        mediaType,
        models,
        modelSource: source,
        requestContentTypes,
        requiredParams: [...required].sort(),
        ...(conditionalRequired.length ? { conditionalRequiredParams: conditionalRequired } : {}),
        params: [...params].sort(),
        paramSpecs,
        registeredInDocsJson: registered.has(file),
      });
    }
  }
}

const filesOnDisk = new Set(specFiles);
/*
 * 同一个 model 名跨 mediaType / path 出现，会让运行时的两个假设同时失效：
 * genIndex().byModel 只留一条（另一条被无声吞掉），generate_* 的媒体类型拦截会误伤，
 * 且端点可能选错。当前数据是 0 冲突，这里只做告警上报，便于第一时间发现。
 */
const modelHomes = new Map<string, Set<string>>();
for (const e of entries) {
  if (e.category !== "generation") continue;
  for (const m of e.models) {
    const k = `${e.mediaType ?? "?"} ${e.path}`;
    (modelHomes.get(m) ?? modelHomes.set(m, new Set()).get(m)!).add(k);
  }
}
const ambiguousModels = [...modelHomes.entries()]
  .filter(([, homes]) => homes.size > 1)
  .map(([model, homes]) => ({ model, homes: [...homes].sort() }));

const crossCheck = {
  unregisteredOnDisk: specFiles.filter((f) => !registered.has(f)),
  registeredButMissing: [...registered].filter((f) => !filesOnDisk.has(f)).sort(),
  ambiguousModels,
};

mkdirSync(OUT_DIR, { recursive: true });
const catalog = {
  generatedAt: new Date().toISOString(),
  lang: LANG,
  specBaseUrl: SPEC_BASE_URL,
  sourceDir: SPEC_DIR,
  specFileCount: specFiles.length,
  entries,
  crossCheck,
  parseFailures,
};
const outFile = join(OUT_DIR, `catalog.${LANG}.json`);
writeFileSync(outFile, JSON.stringify(catalog, null, 2) + "\n");

// ---- 报告 ----
const byCategory = new Map<string, number>();
for (const e of entries) byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + 1);
const allModels = new Set(entries.flatMap((e) => e.models));
const genNoModel = entries.filter((e) => e.category === "generation" && e.models.length === 0);
const otherEntries = entries.filter((e) => e.category === "other");

console.log(`spec 文件: ${specFiles.length} 个 → 端点条目: ${entries.length} 条 → ${outFile}`);
console.log(`分类分布: ${[...byCategory.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);
console.log(`去重后模型数（enum/const/default 提取）: ${allModels.size}`);
if (parseFailures.length) console.log(`⚠️ JSON 解析失败: ${parseFailures.join(", ")}`);
if (genNoModel.length)
  console.log(`⚠️ 生成类但未提取到 model 的文件: ${genNoModel.map((e) => e.file).join(", ")}`);
if (otherEntries.length)
  console.log(
    `⚠️ 未识别分类(other): ${otherEntries.map((e) => `${e.file}[${e.method} ${e.path}]`).join(", ")}`,
  );
console.log(`交叉核对 — 磁盘存在但 docs.json 未注册 (${crossCheck.unregisteredOnDisk.length}): ${crossCheck.unregisteredOnDisk.join(", ") || "无"}`);
console.log(`交叉核对 — docs.json 注册但磁盘缺失 (${crossCheck.registeredButMissing.length}): ${crossCheck.registeredButMissing.join(", ") || "无"}`);
if (ambiguousModels.length) {
  console.log(`⚠️  同名 model 跨 mediaType/path 出现 (${ambiguousModels.length})——运行时会无声取其一，请核对：`);
  for (const a of ambiguousModels) console.log(`    ${a.model}: ${a.homes.join(" | ")}`);
}
