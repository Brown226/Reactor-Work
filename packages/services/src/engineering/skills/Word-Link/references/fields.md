# 目录、题注与引用

目录、题注编号、页码、交叉引用都是域：文件中写入域代码和一个临时结果，再在 `with target.open() as doc:` 中 `refresh_fields(doc)`，由应用按实际版面算出结果。view 中域显示为 `{域 代码}结果{/域}`，书签为 `{书签 名称}`，超链接为 `{链接 地址}文字{/链接}`。

## 辅助函数

**`insert_toc(anchor, *, levels="1-3", title="目录", before=False, placeholder="（打开文档后更新目录）")`** → 目录段落

- 在段落或表格 `anchor` 之后（`before=True` 时之前）插入目录标题和目录域；`title` 为 None 时不加标题。
- `levels`：收录的标题级别，如 `"1-2"`；条目来自标题样式或大纲级别，更新域后生成。

**`add_caption(anchor, label, text, *, before=True, like=None)`** → 题注段落

- 在表格或图片段落 `anchor` 之前（`before=False` 时之后）插入题注“标签 编号  文字”，编号为 SEQ 域。
- `label`：如 `"表"`、`"图"`、`"Table"`；同一标签的全部题注随即按文中顺序重新编号，不更新域也显示正确。
- `like`：参照段落（如已有题注），沿用其格式；省略时居中。题注与表格或图片排在同一页。

**`add_field(paragraph, code, result="", *, after_text=None)`** → 段落：在段末（或 `after_text` 所在 run 之后）插入域；`code` 为域代码，`result` 为更新前显示的结果。沿用段落首个 run 的字体。

**`add_bookmark(paragraph, name)`** → 段落：给整段加书签；`name` 以字母或汉字开头，只含字母、数字、下划线和汉字，不超过 40 字符。

**`add_hyperlink(paragraph, text, *, url=None, bookmark=None)`** → 段落：在段末加入显示为 `text` 的超链接；`url` 为外部地址，`bookmark` 为文档内的书签名，两者给一个。

**`add_footnote(f, paragraph, text, *, after_text=None)`** → 脚注编号：在段末（或 `after_text` 之后）加脚注，内容为 `text`。

## 示例

```python
insert_toc(f.at("正文3"))                                   # 在正文3之后插入目录；只收两级 levels="1-2"
add_caption(f.at("表2"), "表", "框架柱配筋")                  # 表题在表上方
add_caption(f.at("正文15"), "图", "结构平面布置", before=False)  # 图题在图片段落下方

add_bookmark(f.at("正文40"), "sec_load")                     # 交叉引用：先给目标段落加书签
p = f.at("正文52")
add_field(p, r"REF sec_load \h", "4.2 荷载", after_text="见")  # 显示书签处的文字
add_field(p, r"PAGEREF sec_load \h", "12")                  # 显示书签所在的页码

add_hyperlink(p, "规范原文", url="https://…")                 # 外部链接；链到书签用 bookmark="sec_load"
add_footnote(f, p, "数据取自 2024 年现场检测报告。", after_text="实测值")
add_field(p, "NUMPAGES")                                    # 总页数；页码用 layout.md 的 add_page_number
add_field(p, r'DATE \@ "yyyy年M月d日"')                      # 日期
```

## 注意

- 目录条目、题注编号、引用文字不要直接改：改标题、题注正文或书签处的内容，再更新域。
- 书签所在的段落用 `set_text` 整段改写时书签保留；删除该段则书签一起删除，引用它的域更新后显示“未定义书签”的错误，交付前在页面图或 `doc.Content.Text` 中查找这类提示。
- 正文中手写的“见表 3”“如图 2 所示”不是域，表图增删后要逐个核对改正；新写的引用用 REF 域。
