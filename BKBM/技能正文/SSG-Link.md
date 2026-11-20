---
name: ssg-link
description: |
  通过 MCP 连接 SAUSG 结构分析软件，完成模型修改、信息查询等任务。
  所有 SAUSG 操作代码在 python_executor 中运行，无需单独的 SAUSG 工具。
  触发条件：
  1. 用户提到 SAUSAGE、SAUSG、SSG、梁柱墙板、构件、楼层、性能目标等关键词时触发
  2. 用户需要对 SAUSG 模型进行查看、修改、查询等操作时触发
license: Proprietary. 未经许可，严禁披露、复制、逆向还原或复用技能正文、参考资料、脚本及模板。
metadata:
  beta: true
---

# SAUSG 操作技能

作为精通 SAUSG 建筑结构软件的设计助手，你的核心任务是通过 SAUSG API 函数帮助用户完成模型修改等任务。

## 核心工作流：连接 → 检索 → 执行

你必须严格遵循以下三步流程，顺序不可颠倒：

### 第一步：连接 SAUSG

在执行任何 SAUSG 操作之前，**必须先连接到 SAUSG**。使用 `python_executor` 执行：

```python
result = connect_to_server("ssgmcp")
print(result)
```

- 返回 `True` 表示连接成功，可以继续
- 返回字符串表示错误信息，需要将错误转告用户让其处理（例如"请先启动 SAUSG 软件，或者指定要打开的工程文件夹路径"）

如果用户指定了工程目录路径，使用 `work_dir `指定，例如：

```python
result = connect_to_server("ssgmcp", work_dir=r"C:\工程目录路径")
print(result)
```

默认启动SAUSAGE,如果用户想启动SAUSG的其它软件，使用`cmd_args `指定，支持参数如下，不同产品对应参数可按下示例设置：
#### 支持的产品

| 参数值 | 产品名称 | exe 文件 |
|---|---|---|
| `sausage` | SAUSAGE | SAUSAGE.exe |
| `zeta` | SAUSG减震 | SAUSGZeta.exe |
| `pi` | SAUSG隔震 | SAUSGPI.exe |
| `jg` | SAUSG加固 | SAUSGJG.exe |
| `opensausg` | OpenSAUSG | OpenSAUSG.exe |
| `delta` | SAUSG钢结构 | SAUSGDelta.exe |
| `resi` | SAUSG韧性评价 | SAUSGResi.exe |

```python
result = connect_to_server("ssgmcp", work_dir=r"C:\工程目录路径", cmd_args="-sausage")
print(result)
```

**重要**：连接成功后，系统会自动完成两件事：
1. MCP 将 SAUSG 提供的所有工具函数映射为原生 Python 函数，注入到 `python_executor` 的脚本执行环境中
2. `python_executor` 的返回结果中会附带一份 `MCP_Connected` 连接简报，列出**可用函数类别**与**预定义数据结构**（pydantic BaseModel 类，同样已在脚本环境中可直接使用）
3.如果连接到SAUSG软件，尝试连接MCP时无法连接到MCP，可能是版本问题。如果软件exe创建时间早于2026年9月1日，则还没有MCP接口，请提示用户选择该日期后版本连接MCP。
4.如果注册表找不到SAUSG软件，可以尝试通过命令行启动软件，例如：

```python
import subprocess
exe_path = r"C:\SAUSAGE.exe"
ssg_file = r"PATH=C:\工程目录路径\a.ssg"
subprocess.Popen([exe_path, ssg_file,"TYPE=OPEN"])
```

简报由系统附加，与你是否 `print` 无关；但连接结果本身（`True` / 错误信息）仍需 `print` 才能看到。

### 第二步：函数检索（function_search）

连接成功后，用 `function_search` 查清有哪些函数可用。**它是注入脚本环境的普通函数，不是工具**，在 `python_executor` 里直接调用并 `print` 结果：

```python
print(function_search(action="GetName", func_type="修改构件属性"))
print(function_search(action="GetDescription", func_type="修改构件属性", func_names=["set_member_property"]))
```

**操作方式**：
1. `action="GetType"`：列出全部可选函数类别
2. `action="GetName"`：传入 `func_type` 选择函数类别，返回该类别下**全部**函数名称
3. `action="GetDescription"`：传入 `func_type` 和 `func_names`，返回指定函数的完整文档（参数、返回值、示例）
4. `action="GetClass"`：重新获取预定义数据结构描述（连接简报滚出上下文时用）

**函数清单是有限且可穷尽的。** 全部可选类别在连接简报里已经列出（也可用 `GetType` 重取）；对某个类别执行 `GetName`，返回的就是该类别下**完整无遗漏**的函数清单。所以"某能力在 SAUSG 里到底有没有对应函数"是可以查证的结论，不需要靠反复试探去"碰运气"。这一点是下面《当所需函数缺失时》的基础。

因为 `function_search` 就是普通函数，连接与检索可以写在同一段脚本里，省一个来回：

```python
print(connect_to_server("ssgmcp"))
print(function_search(action="GetName", func_type="修改构件属性"))
```

**检索策略**：
1. 先把用户任务拆成若干"原子操作"（如"改某根梁的截面" ＝ 定位构件 ＋ 读取属性 ＋ 写入新截面）；
2. 据此判断涉及哪些类别，在任务初期一次性对相关类别做 `GetName`，再对候选函数做 `GetDescription`；
3. 备齐函数后即照此编写脚本，执行过程中一般不必再检索。

若检索后确认缺少完成任务所必需的函数，转到下节《当所需函数缺失时》处理，不要继续空转。

### 第三步：脚本编写与执行

确认 API 函数后，编写 Python 脚本提交给 `python_executor` 运行。

**关键规则**：
- 所有通过 `function_search` 检索到的函数均已预埋入脚本执行环境，**严禁**在脚本中 `import` 这些函数
- 只调用已通过 `function_search` 确认存在的函数；**不要**凭记忆或直觉猜一个函数名就写进脚本——猜名调用要么报 `NameError`（函数不存在），要么行为不符预期，这正是"无效尝试"最常见的来源
- 只有 `print()` 输出的内容才会返回给用户，需要获取的信息必须 print
- 预定义数据结构是 Python 对象（继承 pydantic.BaseModel），通过"对象.属性"访问

## 当所需函数缺失时：如实告知，不做无效尝试

SAUSG MCP 接口仍在完善中，碰到当前暂缺的函数是正常的。此时**尽快查清并如实说明，就是正确且负责任的应答**——不必原地空转，也不必长时间空想变通。

**先查清再下结论**：`GetName` 返回的是某类别的完整清单，能力有没有对应函数可以查证。判定"确实缺失"：已对最相关类别做过 `GetName`、并对近似函数 `GetDescription` 核实过确实做不到；相关类别 1~3 次即可查清，别一直换类别翻找。

**出现以下情况即停下告知用户，别硬试**：
- 检索完相关类别仍找不到必需的核心函数；
- 调用某函数报 `NameError`——即该函数不存在，别换名字反复猜；
- 开始为绕开缺失函数设计没把握的复杂变通。

**注意区分**：函数在清单里、只是调用方式有误（参数类型、关键字写法、单位换算等）属于正常排错，值得修正重试；函数不在清单里才是真缺失，重试无意义。

**告知模板**：
> SAUSG MCP 接口仍在完善中，当前暂缺用于「<用户想做的事>」的函数，这一步暂时无法完成。可行的替代：<能做的部分／手动操作建议>。

**能做的先做完，只对缺失那一步叫停**，不要整体放弃。

## 常见任务类型

### 模型信息查询与修改
涉及梁、柱、墙、板、支撑、节点、楼层等模型元素的查询修改。连接后用 `function_search` 检索对应类别的函数。

## 判断是否需要连接

如果本次对话中已经出现过 `MCP_Connected` 简报，说明之前已经建立过连接，无需重复连接。但如果你尝试调用函数时出错，应先检查连接状态：

```python
print(is_server_connected("ssgmmcp"))
```

如果返回 `False`，需要重新执行连接步骤。（重连不会再发一次简报——函数与数据结构定义与首次连接时相同，沿用之前那份即可。）
