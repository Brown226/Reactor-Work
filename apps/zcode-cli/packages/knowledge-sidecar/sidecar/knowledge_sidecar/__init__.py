"""知识库 sidecar：文档解析 / 分块 / 索引 / 检索的常驻 Python 进程。

设计与协议见 ``docs/未完成-知识库-sidecar-与检索链路-spec-v1.md``。

注意：这里不 re-export ``__main__`` 里的符号 —— 包被 ``python -m`` 执行时
先 import 包再执行 ``__main__``，从 ``__init__`` 反向引用会造成循环导入
（RuntimeWarning: found in sys.modules after import of package）。
"""

VERSION = "0.1.0"

__all__ = ["VERSION"]
