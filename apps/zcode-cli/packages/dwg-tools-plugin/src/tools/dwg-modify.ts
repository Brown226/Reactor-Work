/**
 * dwg_modify 工具：DWG 图纸读取与结构化修改。
 *
 * 引擎为 .NET sidecar（ACadSharp，MIT，反编译产物见 tools/dwg-sidecar），
 * 由 MCP server 以子进程调用（stdin/stdout 单发 JSON）。读模式输出契约与旧
 * parse_dwg（libredwg wasm）保持一致：layers/textEntities/dimensions/
 * standardRefs/metadata/text 字段名与语义不变，cadHandleId 同为十六进制。
 *
 * 安全语义（enforced by sidecar + 本层）：
 * - 写前 .bak 备份、写后读回校验（实体/图层数一致才落盘），任何一步失败原图不动；
 * - 支持 in_place（默认）或 output_path 外置输出；
 * - 操作单为结构化 ops：replace_text / rename_layer。
 */
import { z } from "zod";
import { assertReadableFile, wrapFileContent } from "../guard.js";
import { runSidecar } from "../dwg-sidecar.js";

export const DWG_MODIFY_DESCRIPTION = [
  "Read or modify a DWG drawing with the bundled offline engine (ACadSharp sidecar).",
  "Read mode: returns layers, TEXT/MTEXT entities, dimensions, and standard references",
  "(e.g. GB/T 14976-2012, 《...》（DL 5068-2014）) with CAD entity handles — use it for drawing",
  "review and standard-reference self-check. Modify mode: apply structured ops",
  "(replace_text / rename_layer) in place with a .bak backup and a read-back verification before",
  "the original file is replaced. Writing is gated by the tool permission dialog.",
].join(" ");

const replaceTextOpSchema = z.object({
  type: z.literal("replace_text"),
  match: z.string().min(1).describe("Text to match (substring); also the new text when handle is set."),
  replace: z.string().describe("New text; replaces the matched substring (whole text when whole=true)."),
  whole: z.boolean().optional().describe("Replace the whole text value instead of the matched substring."),
  handle: z.string().optional().describe("Restrict to one entity by CAD handle (then match is the new value)."),
});

const renameLayerOpSchema = z.object({
  type: z.literal("rename_layer"),
  from: z.string().min(1).describe("Existing layer name."),
  to: z.string().min(1).describe("New layer name."),
});

export const dwgModifyInputSchema = z.object({
  file_path: z.string().min(1).describe("Absolute path to the .dwg file to read or modify."),
  ops: z
    .array(z.discriminatedUnion("type", [replaceTextOpSchema, renameLayerOpSchema]))
    .min(1)
    .optional()
    .describe("Modification operations. Omit for read-only extraction."),
  in_place: z
    .boolean()
    .optional()
    .describe("Modify the file in place (default true; a .bak backup is kept)."),
  output_path: z
    .string()
    .optional()
    .describe("When in_place=false, write the modified drawing to this path."),
  max_text_entities: z
    .number()
    .int()
    .min(1)
    .max(20000)
    .optional()
    .describe("Cap on returned text entities (default 5000; truncated drawings get a note)."),
});

interface SidecarResponse {
  ok: boolean;
  error?: string;
}

interface DwgModifyOutput {
  status: "success" | "failed";
  /** 读取模式：整图文本（<file_content> 包裹）。 */
  text: string;
  layers: string[];
  layerDetails: Array<{ name: string; handle: string }>;
  textEntities: Array<{
    text: string;
    layer: string;
    entityType: string;
    handle: string;
  }>;
  dimensions: Array<{
    text: string;
    layer: string;
    entityType: string;
    handle: string;
    measurement: string | null;
  }>;
  standardRefs: Array<{
    standardNo: string;
    standardName: string;
    standardIdent: string;
    fullMatch: string;
    cadHandleId: string;
  }>;
  metadata: {
    version: string | null;
    layerCount: number;
    textCount: number;
    dimensionCount: number;
    entityCount: number;
  };
  note?: string;
  /** 修改模式附加信息。 */
  modify?: {
    outputPath: string;
    backupPath: string | null;
    modifiedHandles: string[];
    warnings: string[];
    verify: {
      reReadOk: boolean;
      entitiesBefore: number;
      entitiesAfter: number;
      layersBefore: number;
      layersAfter: number;
      writeMs: number;
    };
  };
}

function failedOutput(note: string): DwgModifyOutput {
  return {
    status: "failed",
    text: "",
    layers: [],
    layerDetails: [],
    textEntities: [],
    dimensions: [],
    standardRefs: [],
    metadata: { version: null, layerCount: 0, textCount: 0, dimensionCount: 0, entityCount: 0 },
    note,
  };
}

export async function dwgModify(input: z.infer<typeof dwgModifyInputSchema>) {
  if (!input.file_path.toLowerCase().endsWith(".dwg")) {
    return failedOutput(`不是 .dwg 文件：${input.file_path}`);
  }
  assertReadableFile(input.file_path);

  const request: Record<string, unknown> = { path: input.file_path };
  if (input.ops) {
    request.command = "modify";
    request.ops = input.ops;
    if (input.in_place !== undefined) request.inPlace = input.in_place;
    if (input.output_path) request.outputPath = input.output_path;
  } else {
    request.command = "read";
    if (input.max_text_entities !== undefined) {
      request.maxTextEntities = input.max_text_entities;
    }
  }

  const response = (await runSidecar(request)) as SidecarResponse &
    Partial<DwgModifyOutput> & {
      truncated?: boolean;
      outputPath?: string;
      backupPath?: string | null;
      modifiedHandles?: string[];
      warnings?: string[];
      verify?: DwgModifyOutput["modify"] extends undefined ? unknown : NonNullable<DwgModifyOutput["modify"]>["verify"];
    };
  if (!response.ok) {
    return failedOutput(response.error ?? "DWG sidecar 返回未知错误");
  }

  const rawText = typeof response.text === "string" ? response.text : "";
  // sidecar 的 modify 信息是平铺字段，这里收进嵌套 modify 契约。
  const modify: DwgModifyOutput["modify"] =
    input.ops && response.outputPath && response.verify
      ? {
          outputPath: response.outputPath,
          backupPath: response.backupPath ?? null,
          modifiedHandles: response.modifiedHandles ?? [],
          warnings: response.warnings ?? [],
          verify: response.verify,
        }
      : undefined;

  return {
    status: "success",
    text: wrapFileContent(rawText),
    layers: response.layers ?? [],
    layerDetails: response.layerDetails ?? [],
    textEntities: response.textEntities ?? [],
    dimensions: response.dimensions ?? [],
    standardRefs: response.standardRefs ?? [],
    metadata: response.metadata ?? {
      version: null,
      layerCount: 0,
      textCount: 0,
      dimensionCount: 0,
      entityCount: 0,
    },
    note: [response.truncated ? "文本实体超过上限，仅返回前若干条" : null]
      .filter(Boolean)
      .join("；") || undefined,
    modify,
  };
}
