# 批注与修订

批注直接写入文件；修订标记只能由应用记录，要在 `with target.open() as doc:` 中做。view 中批注位置显示为 `{批注N}`，内容列在“批注N”下；插入的文字显示为 `{增}…{/增}`，删除的为 `{删 …}`。

## 批注

python-docx 的 `f.doc.add_comment(runs, text="", author="", initials="")` → 批注：`runs` 为批注所指的 run 或 run 列表，用 `isolate` 取得；批注整段时传 `p.runs`。

```python
runs = isolate(p, "C30")                         # 批注所指的文字拆成单独的 run
f.doc.add_comment(runs, text="应为 C35，见计算书第 4 章", author="PKPM Agent", initials="PA")
```

- 已有批注的内容可用 `f.at("批注N")` 取。
- 删除、回复批注在应用中做：`doc.Comments(i).Delete()`，多条时从后往前删。

## 修订

打开修订后在应用中改，改动会记为修订：

```python
with target.open() as doc:
    doc.TrackRevisions = True
    doc.Content.Find.Execute("C30", True, False, False, False, False, True, 0, False, "C35", 2)
    doc.TrackRevisions = False
f = DocxFile(target.path)                        # 之后还要改文件时重新读入
```

- `Find.Execute` 的参数依次为：查找文字、区分大小写、全字匹配、通配符、同音、所有词形、向下、到末尾时（0 停止）、带格式、替换文字、替换方式（2 全部替换）。
- 处理已有修订：`doc.AcceptAllRevisions()`、`doc.RejectAllRevisions()`；逐条用 `doc.Revisions(i)`，读 `Author`、`Type`（1 插入、2 删除）、`Range.Text`，再 `Accept()` 或 `Reject()`，多条时从后往前处理。
- 含修订的段落不能用 `set_text` 整段改写，改用 `replace_text`，或先处理修订。
- 做完后重新读入，在 view 中核对每处改动都在 `{增}`、`{删}` 中。
