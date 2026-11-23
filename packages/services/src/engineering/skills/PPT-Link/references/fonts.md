# 字体

## 规则

- **只用 Windows 自带的字体**，即下面“可用字体”中的字体。演示文稿里不带字体文件，换到没有该字体的电脑上，文字会被换成别的字体，西文甚至显示成乱码。用户指定的字体可以用，交付时提醒：放映的电脑上也要装这个字体。
- **名称完全一致**：大小写、空格与下表相同，中文字体写中文名。本机没装的字体，view 开头的字体行列为“未安装”。
- **中西文分开设**：`set_font(…, latin=西文字体, east_asia=中文字体)`，主题字体 `set_theme(…, heading=(西文, 中文))`。只设一种时，另一种文字落到默认字体上。
- **字重**：有单独名称的字重直接写名称，如 `latin="Segoe UI Semibold"`、`east_asia="微软雅黑 Light"`；其余只有常规和 `bold=True` 两档。
- 宋体、黑体、仿宋、楷体没有粗体字形，`bold=True` 由软件把笔画描粗，字形发糊；要粗的标题用微软雅黑，或加大字号。
- 设计系统和场景指南中写的字体都在下表中，照用。模板或原文件中本机没有的字体，在下表中选风格相近的换上。
- 图标字体 Segoe MDL2 Assets、Segoe UI Symbol 的用法见 graphics.md 的“图标”。
- 不要用 Bahnschrift、Sitka、Segoe UI Variable：它们的字重和字宽在 WPS 中显示不对（字距被拉开、粗细不符）；Segoe UI Variable 在 Windows 10 上也没有。

## 可用字体

中文：

| 字体名 | 风格 | 字重 | 适合 |
|---|---|---|---|
| 微软雅黑 | 黑体，字面大、清楚 | 微软雅黑 Light、常规、粗 | 默认的标题和正文 |
| 等线 | 黑体，笔画细、字面略小 | 等线 Light、常规、粗 | 清淡、现代的版面 |
| 黑体 | 黑体，笔画粗重 | 常规 | 公文、醒目的标题 |
| 宋体 | 宋体 | 常规 | 人文、学术类的正文和引文 |
| 仿宋 | 仿宋 | 常规 | 公文正文、引文、注释 |
| 楷体 | 楷书 | 常规 | 引言、题记、有书卷气的标题 |

西文：

| 字体名 | 风格 | 字重 | 适合 |
|---|---|---|---|
| Segoe UI | 无衬线，现代、中性 | Segoe UI Light、Segoe UI Semilight、常规、Segoe UI Semibold、粗、Segoe UI Black | 默认的标题、正文和数字 |
| Arial | 无衬线，中性 | 常规、粗；特粗用 Arial Black | 正文、数据 |
| Calibri | 无衬线，人文、圆润 | Calibri Light、常规、粗 | 正文 |
| Tahoma、Verdana | 无衬线，为屏幕上的小字设计；Verdana 字宽大 | 常规、粗 | 小字号的标注、表格 |
| Franklin Gothic Medium | 无衬线，粗壮 | 常规 | 新闻式标题 |
| Impact | 窄体特粗 | 常规 | 海报式大标题、大数字 |
| Georgia | 衬线，稳重 | 常规、粗 | 衬线标题、正文 |
| Palatino Linotype | 古典衬线 | 常规、粗 | 人文、典雅的标题和正文 |
| Constantia | 衬线，清秀 | 常规、粗 | 衬线标题 |
| Cambria | 衬线，屏幕上清楚 | 常规、粗 | 衬线正文、数据 |
| Times New Roman | 衬线 | 常规、粗 | 学术文献、公式旁的文字 |
| Trebuchet MS | 人文无衬线，略带个性 | 常规、粗 | 标题、编号、标签 |
| Corbel、Candara | 人文无衬线 | Corbel Light、常规、粗 | 柔和的正文 |
| Consolas | 等宽 | 常规、粗 | 代码、编号、仿打字机的标注 |

Georgia、Constantia、Corbel、Candara 的数字高低不齐（旧式数字），适合正文，不适合大数字和表格数据；数据用 Segoe UI、Arial、Calibri、Cambria 或 Palatino Linotype。
