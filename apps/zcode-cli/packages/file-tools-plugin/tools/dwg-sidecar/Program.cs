// DWG sidecar：ACadSharp（.NET，MIT）读写桥。由 file-tools MCP server 以子进程方式调用。
// 协议：stdin 读一行 JSON 请求，stdout 回一行 JSON 响应；退出码 0 正常、2 错误。
//
// 请求：
//   {"command":"read","path":"...","maxTextEntities":5000}
//   {"command":"modify","path":"...","ops":[...],"inPlace":true,"outputPath":"..."}
//   {"command":"graph","path":"...","maxSymbols":20000,"maxSegments":20000}
//
// 替换 libredwg-web（wasm）的原因：DWG 写入能力 libredwg 仅到 r2004 且 R2010+ CRC 错误，
// 本 sidecar 实测同一张核桃审 fixture（AC1018）读→改→写→读校验全通，实体/图层零丢失。
// 输出契约（layers/textEntities/dimensions/standardRefs/metadata/text）与旧 parse_dwg
// 保持一致，审查板块 §4.4.3 的消费方无需改动；handle 从 libredwg 十六进制串改为
// ACadSharp 数值 handle 的十六进制表示（同样全局唯一）。
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using ACadSharp;
using ACadSharp.Entities;
using ACadSharp.IO;
using ACadSharp.Tables;

static class Program
{
    static readonly JsonSerializerOptions JsonOpts = new() { WriteIndented = false };
    static readonly List<string> ReadNotes = new();
    static readonly List<string> WriteNotes = new();
    /// graph 响应的文本实体上限：融合侧按空间邻近取 tag，需要全量文本坐标。
    static readonly int GraphTextCap = 20000;

    static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        Console.InputEncoding = Encoding.UTF8;
        try
        {
            using var docIn = JsonDocument.Parse(Console.In.ReadToEnd());
            var root = docIn.RootElement;
            var command = root.GetProperty("command").GetString() ?? "read";
            var path = root.GetProperty("path").GetString() ?? "";
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
            {
                return Fail($"文件不存在或不可读：{path}");
            }

            return command switch
            {
                "read" => Ok(BuildReadResponse(path, root)),
                "modify" => Ok(BuildModifyResponse(path, root)),
                "graph" => Ok(BuildGraphResponse(path, root)),
                _ => Fail($"未知命令：{command}"),
            };
        }
        catch (Exception ex)
        {
            return Fail($"{ex.GetType().Name}: {ex.Message}");
        }
    }

    static int Ok(object payload)
    {
        Console.WriteLine(JsonSerializer.Serialize(payload, JsonOpts));
        return 0;
    }

    static int Fail(string error)
    {
        Console.WriteLine(JsonSerializer.Serialize(new { ok = false, error }, JsonOpts));
        return 2;
    }

    // ── 读取 ──────────────────────────────────────────────────────────────

    static object BuildReadResponse(string path, JsonElement root)
    {
        var maxTexts = root.TryGetProperty("maxTextEntities", out var mt) ? mt.GetInt32() : 5000;
        ReadNotes.Clear();
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var doc = OpenDwg(path);
        sw.Stop();
        return Extract(path, doc, maxTexts, sw.ElapsedMilliseconds, ReadNotes.Count);
    }

    static CadDocument OpenDwg(string path)
    {
        return DwgReader.Read(path, (_, e) => ReadNotes.Add(e.Message ?? ""));
    }

    static object Extract(
        string path,
        CadDocument doc,
        int maxTexts,
        long ms,
        int notes)
    {
        var layers = new List<object>();
        foreach (var layer in EnumerateLayers(doc))
        {
            layers.Add(new { name = layer.Name, handle = HandleHex(layer.Handle) });
        }

        // 文本与尺寸拆两趟收集：语义与旧 parse_dwg 完全一致（Dimension 不实现 IText，
        // 拆分不改变输出内容与顺序），文本收集逻辑由 read 与 graph 共用。
        var (textEntities, textContents, truncated) = CollectTextEntities(doc, maxTexts);
        var dimensions = new List<object>();
        foreach (var entity in doc.Entities)
        {
            if (entity is not Dimension dim) continue;
            var layerName = entity.Layer?.Name ?? "0";
            var handle = HandleHex(entity.Handle);
            var dimText = SafeString(dim, "Text");
            var measurement = SafeString(dim, "Measurement");
            // 口径与旧 parse_dwg 一致：""/"<>" 用测量值；" " 抑制。
            if (!string.IsNullOrEmpty(dimText) && dimText != " " && dimText != "<>")
            {
                dimensions.Add(new { text = dimText, layer = layerName, entityType = "DIMENSION", handle, measurement = measurement });
            }
            else if (dimText == "" || dimText == "<>")
            {
                dimensions.Add(new { text = measurement ?? "", layer = layerName, entityType = "DIMENSION", handle, measurement = measurement });
            }
        }

        var refs = ExtractStandardRefs(textContents);
        // 回填 cadHandleId：忽略空白差异比较（标准号可能带上跨实体捕获的换行）。
        foreach (var reference in refs)
        {
            var noKey = StripWs(reference.standardNo);
            var fmKey = StripWs(reference.fullMatch);
            foreach (var item in textEntities.Cast<dynamic>())
            {
                var t = StripWs((string)item.text);
                if (t.Contains(noKey) || t.Contains(fmKey))
                {
                    reference.cadHandleId = item.handle;
                    break;
                }
            }
        }

        return new
        {
            ok = true,
            command = "read",
            version = doc.Header.Version.ToString(),
            ms,
            notes,
            truncated,
            text = string.Join("\n", textContents),
            layers = layers.Select(l => ((dynamic)l).name).ToArray(),
            layerDetails = layers,
            textEntities,
            dimensions,
            standardRefs = refs,
            metadata = new
            {
                version = doc.Header.Version.ToString(),
                layerCount = layers.Count,
                textCount = textEntities.Count,
                dimensionCount = dimensions.Count,
                entityCount = doc.Entities.Count,
            },
        };
    }

    // ── 图元几何（graph 命令，M5） ─────────────────────────────────────────

    static object BuildGraphResponse(string path, JsonElement root)
    {
        var maxSymbols = root.TryGetProperty("maxSymbols", out var ms) ? ms.GetInt32() : 20000;
        var maxSegments = root.TryGetProperty("maxSegments", out var mg) ? mg.GetInt32() : 20000;
        ReadNotes.Clear();
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var doc = OpenDwg(path);
        sw.Stop();
        return ExtractGraph(doc, maxSymbols, maxSegments, sw.ElapsedMilliseconds, ReadNotes.Count);
    }

    /// 只取融合拓扑所需的原始行：INSERT 符号（块名/坐标/旋转/缩放）与 LINE/多段线段点；
    /// 文本实体供 TS 侧做 tag 空间邻近关联。圆弧/圆/椭圆与块属性（ATTRIB）v1 不收
    /// （集成方案 §1 非目标）；散落图元绘制的符号不在本命令覆盖范围。
    static object ExtractGraph(CadDocument doc, int maxSymbols, int maxSegments, long ms, int notes)
    {
        var symbols = new List<object>();
        var segments = new List<object>();
        var truncated = false;
        foreach (var entity in doc.Entities)
        {
            var layerName = entity.Layer?.Name ?? "0";
            var handle = HandleHex(entity.Handle);
            switch (entity)
            {
                case Insert ins:
                    if (symbols.Count < maxSymbols)
                    {
                        symbols.Add(new
                        {
                            block = ins.Block?.Name ?? "",
                            layer = layerName,
                            handle,
                            insert = new { x = ins.InsertPoint.X, y = ins.InsertPoint.Y },
                            rotation = ins.Rotation,
                            scaleX = ins.XScale,
                            scaleY = ins.YScale,
                        });
                    }
                    else truncated = true;
                    break;
                case Line ln:
                    if (segments.Count < maxSegments)
                    {
                        segments.Add(new
                        {
                            kind = "LINE",
                            layer = layerName,
                            handle,
                            points = new[]
                            {
                                new { x = ln.StartPoint.X, y = ln.StartPoint.Y },
                                new { x = ln.EndPoint.X, y = ln.EndPoint.Y },
                            },
                        });
                    }
                    else truncated = true;
                    break;
                case Polyline2D pl:
                    if (segments.Count < maxSegments)
                    {
                        segments.Add(new { kind = "POLYLINE2D", layer = layerName, handle, points = PolylinePoints(pl.Vertices) });
                    }
                    else truncated = true;
                    break;
                case Polyline3D pl:
                    if (segments.Count < maxSegments)
                    {
                        segments.Add(new { kind = "POLYLINE3D", layer = layerName, handle, points = PolylinePoints(pl.Vertices) });
                    }
                    else truncated = true;
                    break;
            }
        }

        var (textEntities, _, _) = CollectTextEntities(doc, GraphTextCap);
        return new
        {
            ok = true,
            command = "graph",
            version = doc.Header.Version.ToString(),
            ms,
            notes,
            truncated,
            symbols,
            segments,
            textEntities,
            metadata = new
            {
                version = doc.Header.Version.ToString(),
                symbolCount = symbols.Count,
                segmentCount = segments.Count,
                textCount = textEntities.Count,
                entityCount = doc.Entities.Count,
            },
        };
    }

    /// 文本实体收集（read 与 graph 共用）：cap 截断语义与旧 parse_dwg 一致。
    static (List<object> entities, List<string> contents, bool truncated) CollectTextEntities(CadDocument doc, int maxTexts)
    {
        var entities = new List<object>();
        var contents = new List<string>();
        var truncated = false;
        foreach (var entity in doc.Entities)
        {
            if (entity is not IText it || string.IsNullOrWhiteSpace(it.Value)) continue;
            if (entities.Count < maxTexts)
            {
                entities.Add(new
                {
                    text = it.Value,
                    layer = entity.Layer?.Name ?? "0",
                    entityType = entity is MText ? "MTEXT" : "TEXT",
                    handle = HandleHex(entity.Handle),
                    insert = new { x = it.InsertPoint.X, y = it.InsertPoint.Y, z = it.InsertPoint.Z },
                });
                contents.Add(it.Value);
            }
            else
            {
                truncated = true;
            }
        }
        return (entities, contents, truncated);
    }

    static object[] PolylinePoints(IEnumerable<Vertex2D> vertices) =>
        vertices.Select(v => new { x = v.Location.X, y = v.Location.Y }).ToArray();

    static object[] PolylinePoints(IEnumerable<Vertex3D> vertices) =>
        vertices.Select(v => new { x = v.Location.X, y = v.Location.Y }).ToArray();

    // ── 修改 ──────────────────────────────────────────────────────────────

    static object BuildModifyResponse(string path, JsonElement root)
    {
        var inPlace = !root.TryGetProperty("inPlace", out var ip) || ip.GetBoolean();
        var outputPath = root.TryGetProperty("outputPath", out var opProp) ? opProp.GetString() : null;
        if (!inPlace && string.IsNullOrWhiteSpace(outputPath))
        {
            outputPath = Path.ChangeExtension(path, ".modified.dwg");
        }
        var finalPath = inPlace ? path : outputPath!;

        ReadNotes.Clear();
        WriteNotes.Clear();
        var doc = OpenDwg(path);
        var entitiesBefore = doc.Entities.Count;
        var layersBefore = EnumerateLayers(doc).Count();

        var ops = root.TryGetProperty("ops", out var opsEl) ? opsEl : default;
        var modifiedHandles = new List<string>();
        var warnings = new List<string>();
        if (opsEl.ValueKind == JsonValueKind.Array)
        {
            foreach (var op in opsEl.EnumerateArray())
            {
                var type = op.GetProperty("type").GetString();
                switch (type)
                {
                    case "replace_text":
                        ApplyReplaceText(doc, op, modifiedHandles, warnings);
                        break;
                    case "rename_layer":
                        ApplyRenameLayer(doc, op, warnings);
                        break;
                    default:
                        warnings.Add($"未知操作类型：{type}");
                        break;
                }
            }
        }
        else
        {
            return Fail("modify 需要 ops 数组（为空表示无需修改）");
        }

        if (modifiedHandles.Count == 0 && warnings.Count > 0)
        {
            return new { ok = false, error = "所有操作均未生效", warnings };
        }

        // 写临时文件 → 读回校验 → 满意才落盘。任何一步失败都不动原图。
        var tempPath = finalPath + ".tmp.dwg";
        var sw = System.Diagnostics.Stopwatch.StartNew();
        using (var writer = new DwgWriter(tempPath, doc))
        {
            writer.OnNotification += (_, e) => WriteNotes.Add(e.Message ?? "");
            writer.Write();
        }
        sw.Stop();

        var verifyNotes = new List<string>();
        var verifyDoc = DwgReader.Read(tempPath, (_, e) => verifyNotes.Add(e.Message ?? ""));
        var entitiesAfter = verifyDoc.Entities.Count;
        var layersAfter = EnumerateLayers(verifyDoc).Count();
        if (entitiesAfter != entitiesBefore)
        {
            File.Delete(tempPath);
            return new
            {
                ok = false,
                error = $"写后校验失败：实体数 {entitiesBefore} → {entitiesAfter}，已放弃落盘（原图未动）",
                warnings,
            };
        }

        string? backupPath = null;
        if (inPlace && File.Exists(path))
        {
            backupPath = path + ".bak";
            File.Copy(path, backupPath, overwrite: true);
        }
        if (File.Exists(finalPath)) File.Delete(finalPath);
        File.Move(tempPath, finalPath);

        // 读回最终文件，返回与旧 parse_dwg 同构的抽取（审点消费方可直接继续用）。
        var summary = (dynamic)Extract(finalPath, verifyDoc, int.MaxValue, sw.ElapsedMilliseconds, verifyNotes.Count);

        return new
        {
            ok = true,
            command = "modify",
            outputPath = finalPath,
            backupPath,
            modifiedHandles,
            warnings,
            version = summary.version,
            metadata = summary.metadata,
            text = summary.text,
            layers = summary.layers,
            layerDetails = summary.layerDetails,
            textEntities = summary.textEntities,
            dimensions = summary.dimensions,
            standardRefs = summary.standardRefs,
            writeNotes = WriteNotes.Count,
            verify = new
            {
                reReadOk = true,
                entitiesBefore,
                entitiesAfter,
                layersBefore,
                layersAfter,
                writeMs = sw.ElapsedMilliseconds,
            },
        };
    }

    static void ApplyReplaceText(CadDocument doc, JsonElement op, List<string> modifiedHandles, List<string> warnings)
    {
        var match = op.GetProperty("match").GetString() ?? "";
        var replace = op.GetProperty("replace").GetString() ?? "";
        var whole = op.TryGetProperty("whole", out var w) && w.GetBoolean();
        var handle = op.TryGetProperty("handle", out var h) ? h.GetString() : null;
        if (string.IsNullOrEmpty(match) && string.IsNullOrEmpty(handle))
        {
            warnings.Add("replace_text 需要 match 或 handle");
            return;
        }
        if (string.IsNullOrEmpty(match))
        {
            warnings.Add("replace_text 需要 match（按 handle 修改时 match 作为新文本，whole 强制为 true）");
            return;
        }

        var hits = 0;
        foreach (var entity in doc.Entities)
        {
            if (entity is not IText text) continue;
            if (handle != null && HandleHex(entity.Handle) != handle) continue;
            if (!text.Value.Contains(match)) continue;
            var updated = whole || handle != null ? replace : text.Value.Replace(match, replace);
            if (updated == text.Value) continue;
            text.Value = updated;
            modifiedHandles.Add(HandleHex(entity.Handle));
            hits++;
        }
        if (hits == 0) warnings.Add($"replace_text 未命中：{(handle != null ? $"handle={handle}" : $"match={match}")}");
    }

    static void ApplyRenameLayer(CadDocument doc, JsonElement op, List<string> warnings)
    {
        var from = op.GetProperty("from").GetString() ?? "";
        var to = op.GetProperty("to").GetString() ?? "";
        if (string.IsNullOrWhiteSpace(from) || string.IsNullOrWhiteSpace(to))
        {
            warnings.Add("rename_layer 需要 from 与 to");
            return;
        }
        foreach (var layer in EnumerateLayers(doc))
        {
            if (layer.Name == from)
            {
                var setter = typeof(Layer).GetProperty("Name");
                if (setter?.CanWrite == true)
                {
                    setter.SetValue(layer, to);
                }
                else
                {
                    warnings.Add("ACadSharp 的 Layer.Name 不可写，图层改名未生效");
                }
                return;
            }
        }
        warnings.Add($"rename_layer 未找到图层：{from}");
    }

    // ── 标准引用（正则移植自旧 parse_dwg / 核审通口径） ─────────────────────

    static readonly Regex StandardRefPattern = new("《.*?》\\s*[(（]?\\s*([A-Za-z/]+)\\s?(\\d+[-/.]?\\d*([-/.:]\\d+)*)[)）]?([(（].*[)）])?");
    static readonly Regex CodeOnlyPattern = new("[(（]?(GB|GB/T|NB|NB/T|HJ|DL|DL/T|CECS|HAF|EJ|EJ/T|JGJ|CJJ|JG|HG|SH|SY|YY|QB|SL|TB|JT|YB|DB|DBJ|QX|GBJ|TJ|BJG|GYJ)\\s?(\\d+[-/.]?\\d*([-/.:]\\d+)*)[)）]?([(（].*[)）」])?");

    static string GetStandardIdent(string standardNo)
    {
        if (string.IsNullOrEmpty(standardNo)) return "";
        var ident = "";
        foreach (var c in standardNo)
        {
            if (c == '/') { ident += c; continue; }
            if (char.IsLetter(c)) ident += char.ToUpperInvariant(c);
            else break;
        }
        return ident;
    }

    sealed class RefRow
    {
        public string standardNo { get; set; } = "";
        public string standardName { get; set; } = "";
        public string standardIdent { get; set; } = "";
        public string fullMatch { get; set; } = "";
        public string cadHandleId { get; set; } = "";
    }

    static List<RefRow> ExtractStandardRefs(List<string> texts)
    {
        var results = new List<RefRow>();
        var seen = new HashSet<string>();
        var seenNos = new HashSet<string>();
        var allText = string.Join("\n", texts);

        foreach (Match m in StandardRefPattern.Matches(allText))
        {
            var full = m.Value;
            if (!seen.Add(full)) continue;
            var bookEnd = full.IndexOf('》');
            var standardNo = "";
            var standardName = "";
            if (bookEnd >= 0)
            {
                var bookStart = full.IndexOf('《');
                standardName = full[(bookStart + 1)..bookEnd].Trim();
                standardNo = full[(bookEnd + 1)..].Trim();
            }
            else
            {
                standardNo = full.Trim();
            }
            standardNo = Regex.Replace(standardNo, @"^[\s(（]+|[\s)）]+$", "");
            // 归一化内部空白：跨实体捕获可能带上 join 注入的换行，下游标准库按「GB/T 17395-2008」口径匹配。
            standardNo = Regex.Replace(standardNo, @"\s+", " ").Trim();
            // 标准号需含 4 位年份，过滤「VN0.5m³」这类编号后数字的误匹配。
            if (standardNo.Length == 0 || !Regex.IsMatch(standardNo, @"\d{4}")) continue;
            seenNos.Add(standardNo);
            results.Add(new RefRow
            {
                standardNo = standardNo,
                standardName = standardName,
                standardIdent = GetStandardIdent(standardNo),
                fullMatch = full,
            });
        }

        foreach (Match m in CodeOnlyPattern.Matches(allText))
        {
            var full = m.Value;
            if (!seen.Add(full)) continue;
            var standardNo = Regex.Replace(full.Trim(), @"^[\s(（]+|[\s)）]+$", "");
            standardNo = Regex.Replace(standardNo, @"\s+", " ").Trim();
            if (standardNo.Length == 0 || !Regex.IsMatch(standardNo, @"\d{4}")) continue;
            if (seenNos.Contains(standardNo)) continue;
            seenNos.Add(standardNo);
            results.Add(new RefRow
            {
                standardNo = standardNo,
                standardName = "",
                standardIdent = GetStandardIdent(standardNo),
                fullMatch = full,
            });
        }
        return results;
    }

    // ── 工具 ──────────────────────────────────────────────────────────────

    static IEnumerable<Layer> EnumerateLayers(CadDocument doc)
    {
        foreach (var layer in doc.Layers)
        {
            if (layer is Layer l) yield return l;
        }
    }

    static string StripWs(string s)
    {
        return Regex.Replace(s, @"\s+", "");
    }

    static string HandleHex(ulong handle)
    {
        return handle.ToString("X");
    }

    static string? SafeString(object o, string prop)
    {
        var p = o.GetType().GetProperty(prop);
        var v = p?.GetValue(o);
        return v?.ToString();
    }
}
