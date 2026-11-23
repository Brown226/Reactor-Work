# 读取与统计数据

## 读入

表格在应用中开着，或要读用户未保存的修改时，经 ExcelSession 读：

```python
target = ExcelSession(r"C:\work\构件用钢量.xlsx")
ws = target.wb.Worksheets("明细")
rows = values(data_range(ws))
header, data = rows[0], rows[1:]
print(header, len(data))
```

要分组、筛选、比对时转成 pandas 的 DataFrame：

```python
import pandas as pd

df = pd.DataFrame(data, columns=header)
```

pandas 可能没装：import 报 ModuleNotFoundError 时，用 shell 执行 `pip install pandas`，装好后继续。读 .xlsx 文件还要 openpyxl，缺时同样安装。

没在应用中开着的文件直接读磁盘，不必打开应用：

```python
sheets = pd.read_excel(r"C:\work\构件用钢量.xlsx", sheet_name=None)   # {表名: DataFrame}；只要一张表时写表名
detail = sheets["明细"]
```

- 公式单元格读到的是上次保存时的计算结果。文件在应用中开着、有未保存的修改时，磁盘上还是旧内容：改用 ExcelSession 读，或请用户先保存。
- .xls 要 xlrd，没装时用 ExcelSession 读。
- .csv：`pd.read_csv(路径, encoding="utf-8-sig")`，报 UnicodeDecodeError 时改用 `encoding="gbk"`（国内软件导出的多为 GBK）。
- 不要用 pandas 的 `to_excel` 或 openpyxl 的 `save` 写回已有的表格：前者整个文件重写，后者会丢掉图表、图片和形状。写回用 write（见下）。

## 清洗

表格常见的问题：表头不在第一行、多行表头、中间夹着空行和小计行、数存成了文字。先看清再处理：

```python
print(rows[:5])                                            # 看表头在哪一行、有没有多行表头
df = df.dropna(how="all")                                  # 去掉整行为空的行
df = df[~df["构件"].astype(str).str.contains("小计|合计")]   # 去掉小计、合计行
df["用钢量(t)"] = pd.to_numeric(df["用钢量(t)"], errors="coerce")   # 文字转成数，转不了的成为 NaN
print(df[df["用钢量(t)"].isna()])                          # 转不了的行打印出来核对，不要悄悄丢掉
```

多行表头多是合并单元格，值只在左上角：先把上一行的值向右补齐，再与下一行拼成列名，如“梁 / 用钢量(t)”。

## 统计

```python
summary = df.groupby("类型")["用钢量(t)"].agg(["count", "sum", "max"]).reset_index()
summary.columns = ["类型", "构件数", "用钢量合计(t)", "单件最大(t)"]
print(summary)
```

## 写回

结果写回表格时，能用公式的写公式：数据一改结果就跟着变，别人也能核对。

```python
out = target.wb.Worksheets.Add(None, target.wb.Worksheets(target.wb.Worksheets.Count))
out.Name = "汇总"
kinds = sorted(df["类型"].unique())
write(out.Range("A1"), [["类型", "构件数", "用钢量合计(t)"]] + [[k] for k in kinds])
n = len(kinds) + 1
out.Range(f"B2:B{n}").Formula = "=COUNTIFS(明细!$B:$B,A2)"
out.Range(f"C2:C{n}").Formula = "=SUMIFS(明细!$C:$C,明细!$B:$B,A2)"
print(values(out.Range(f"A1:C{n}")))
print(check_formulas(target.wb))
```

公式难以表达的结果，把 DataFrame 整块写入：

```python
write(out.Range("E1"), [list(summary.columns)] + summary.values.tolist())
```

## 多个文件

```python
from pathlib import Path

frames = []
for p in sorted(Path(r"C:\work\各楼用钢量").glob("*.xlsx")):
    if p.name.startswith("~$"):                  # 应用打开文件时生成的临时文件
        continue
    one = pd.read_excel(p, sheet_name="明细")
    one.insert(0, "楼号", p.stem)
    frames.append(one)
total = pd.concat(frames, ignore_index=True)
print(total.groupby("楼号")["用钢量(t)"].sum())
```

- 读之前先打印各文件的表名和表头，确认格式一致；不一致的单独处理，交付时说明。
- 汇总结果按“写回”写入目标工作簿：用 `ExcelSession.new` 新建，或用 ExcelSession 打开已有的汇总表。
