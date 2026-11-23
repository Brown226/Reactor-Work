# 公式

公式用 LaTeX 写，转为 Word 原生公式，Word 与 WPS 都能显示和再编辑。view 中公式显示为 `{公式 …}`。

## 辅助函数

**`add_equation(paragraph, latex, *, display=True, number=None)`** → 段落；带编号时为表格

- `display=True`：`paragraph` 应为空段，公式独占一段并居中。`display=False`：行内公式，接在段落已有文字之后。
- `number`：编号文字，如 `"(6.2.10-1)"`；给出时在该空段处生成无框的 1×3 表格，公式居中、编号右对齐，返回该表格。编号不要直接接在段中公式后面：那样公式会变成行内公式，分式按小号显示。
- 支持：`\frac` 分式，`_` `^` 上下标，`\sqrt`、`\sqrt[3]` 根式，`\sum` `\prod` `\int` `\oint` 及其上下限，`\lim` `\max` 下方的条件，`\left( … \right)` 等伸缩括号，`pmatrix` `bmatrix` `vmatrix` 矩阵，`cases` 分段，`aligned` 多行对齐（`&` 对齐、`\\` 换行），希腊字母，`\hat` `\bar` `\vec` `\dot` `\tilde` 上标记号，`\overline`，`\text{…}` `\mathrm{…}` 正体文字，`\le` `\ge` `\ne` `\approx` `\pm` `\times` `\cdot` 等符号。

## 示例

```python
p = insert_paragraph(f.at("正文20"))                  # 独立公式放在新插入的空段中
add_equation(p, r"M_u = \alpha_1 f_{\mathrm{c}} b x \left(h_0 - \frac{x}{2}\right)")

add_equation(f.at("正文21"), r"\gamma_0 S_{\mathrm{d}}", display=False)    # 行内公式接在段落文字之后

p = insert_paragraph(f.at("正文22"))
t = add_equation(p, r"\sigma = \frac{N}{A} \le f", number="(6.2.10-1)")   # 带编号，返回表格

p = f.at("正文30")                                    # 改已有公式：删掉原公式再加入
for m in p._p.xpath("./m:oMathPara | ./m:oMath"):
    p._p.remove(m)
add_equation(p, r"N \le 0.9 \varphi f_{\mathrm{c}} A")
```

## 注意

- 变量为斜体；数字、`\text` 与 `\mathrm` 中的文字、`\sin` `\max` 等函数名为正体。单位和下标中表示含义的字母（如 `f_{\mathrm{c}}` 中表示混凝土的 c）用 `\mathrm`。
