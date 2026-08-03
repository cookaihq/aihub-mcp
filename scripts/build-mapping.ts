/**
 * 构建 catalog（spec 派生 model id）↔ live（GET /v1/models 可调用 id）映射表。
 *
 * 目的：明确「文档里的模型」与「当前 Key 实际能调用的模型」的对应关系，
 * 并把无法精确对齐的变体命名（如 google/veo-3.1[fast|audio]）诚实标记为待核实，
 * 不臆造映射。产物：catalog/mapping.json + docs/model-mapping.md。
 *
 * 用法：AIHUB_API_KEY=sk-... tsx scripts/build-mapping.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeModelId } from "../src/modelId.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(readFileSync(join(root, "catalog", "catalog.zh.json"), "utf8")) as {
  entries: { file: string; models: string[]; mediaType: string | null; category: string; title: string }[];
};
const key = process.env.AIHUB_API_KEY;
if (!key) throw new Error("需要 AIHUB_API_KEY 才能拉取 /v1/models");

const baseUrl = process.env.AIHUB_BASE_URL ?? "https://api.aihubmax.com";

// catalog 侧：生成端点的 model → 条目
const genEntries = catalog.entries.filter((e) => e.category === "generation");
const catalogModels = new Map<string, { file: string; mediaType: string | null; title: string }>();
for (const e of genEntries) {
  for (const model of e.models) {
    if (!catalogModels.has(model)) catalogModels.set(model, { file: e.file, mediaType: e.mediaType, title: e.title });
  }
}
// family → catalog models（用归一化 base 索引，供近似匹配）
const catalogByBase = new Map<string, string[]>();
for (const model of catalogModels.keys()) {
  const { base } = normalizeModelId(model);
  const arr = catalogByBase.get(base) ?? [];
  arr.push(model);
  catalogByBase.set(base, arr);
}

const res = await fetch(`${baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
// 必须查状态：401/500 的响应体没有 data 字段，会静默变成空表并覆盖掉已提交的产物
if (!res.ok) {
  throw new Error(
    `拉取 ${baseUrl}/v1/models 失败：HTTP ${res.status}。响应前 200 字符：${(await res.text()).slice(0, 200)}`,
  );
}
const liveJson = (await res.json()) as { data?: { id: string }[] };
const liveIds = (liveJson.data ?? []).map((m) => m.id).sort();
if (liveIds.length === 0) {
  throw new Error("/v1/models 返回 0 个模型，拒绝用空表覆盖 catalog/mapping.json 与 docs/model-mapping.md。");
}

type MatchType = "exact" | "family" | "none";
interface Row {
  live: string;
  catalogModel: string | null;
  catalogFile: string | null;
  mediaType: string | null;
  matchType: MatchType;
  note?: string;
}

const rows: Row[] = [];
for (const live of liveIds) {
  if (catalogModels.has(live)) {
    const c = catalogModels.get(live)!;
    rows.push({ live, catalogModel: live, catalogFile: c.file, mediaType: c.mediaType, matchType: "exact" });
    continue;
  }
  const { base, variants } = normalizeModelId(live);
  const famModels = catalogByBase.get(base);
  if (famModels && famModels.length > 0) {
    const c = catalogModels.get(famModels[0]!)!;
    rows.push({
      live,
      catalogModel: famModels.length === 1 ? famModels[0]! : null,
      catalogFile: c.file,
      mediaType: c.mediaType,
      matchType: "family",
      note:
        `归一化到 catalog family "${base}"` +
        (variants.length ? `，变体 [${variants.join("|")}] 的参数映射需与网关侧核对` : "") +
        (famModels.length > 1 ? `；该 family 在 catalog 有多个变体文件：${famModels.join(", ")}` : ""),
    });
  }
  // matchType none：不放入 rows（多为 chat 模型，与生成端点无关）
}

// catalog 有但 live 没有的（文档存在、当前 Key 未开通）
const liveSet = new Set(liveIds);
const catalogOnly = [...catalogModels.entries()]
  .filter(([m]) => !liveSet.has(m))
  .map(([m, c]) => ({ model: m, file: c.file, mediaType: c.mediaType }));

const exact = rows.filter((r) => r.matchType === "exact");
const family = rows.filter((r) => r.matchType === "family");

const mapping = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  liveModelCount: liveIds.length,
  catalogGenerationModelCount: catalogModels.size,
  summary: {
    exactMatches: exact.length,
    familyMatches: family.length,
    catalogOnly: catalogOnly.length,
  },
  exact,
  family,
  catalogOnly,
};
writeFileSync(join(root, "catalog", "mapping.json"), JSON.stringify(mapping, null, 2) + "\n");

// 人类可读摘要
const md: string[] = [
  "# catalog ↔ live 模型映射表",
  "",
  `> 由 \`scripts/build-mapping.ts\` 生成。live 侧为某个 \`sk-\` key 的 \`GET /v1/models\`（可用性随 key 分组变化）。`,
  "",
  `- live 模型总数（含 chat）：**${liveIds.length}**`,
  `- catalog 生成模型数：**${catalogModels.size}**`,
  `- 精确匹配（可直接调用）：**${exact.length}**`,
  `- family 近似匹配（变体命名待核实）：**${family.length}**`,
  `- catalog 有但当前 key 未开通：**${catalogOnly.length}**`,
  "",
  "## 精确匹配（live id == catalog model，可直接用）",
  "",
  "| live / catalog model | media | spec 文件 |",
  "|---|---|---|",
  ...exact.map((r) => `| \`${r.live}\` | ${r.mediaType ?? ""} | ${r.catalogFile} |`),
  "",
  "## family 近似匹配（需与网关侧核对变体参数映射）",
  "",
  "| live id | 归一化 family | catalog 文件 | 备注 |",
  "|---|---|---|---|",
  ...family.map((r) => `| \`${r.live}\` | \`${normalizeModelId(r.live).base}\` | ${r.catalogFile} | ${r.note ?? ""} |`),
  "",
  "## catalog 有、当前 key 未开通（文档可见但不可调用）",
  "",
  "| catalog model | media | spec 文件 |",
  "|---|---|---|",
  ...catalogOnly.map((r) => `| \`${r.model}\` | ${r.mediaType ?? ""} | ${r.file} |`),
  "",
];
writeFileSync(join(root, "docs", "model-mapping.md"), md.join("\n"));

console.log(
  `映射表已生成：catalog/mapping.json + docs/model-mapping.md\n` +
    `  精确匹配 ${exact.length} | family 近似 ${family.length} | catalog-only ${catalogOnly.length}`,
);
console.log("family 近似匹配样本（前 12）：");
for (const r of family.slice(0, 12)) console.log("  ", r.live, "→", r.catalogFile);
