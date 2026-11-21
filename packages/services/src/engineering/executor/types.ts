/**
 * Python 执行器的共享类型。
 */

/** 单次 Python 执行的请求。 */
export interface PythonRunRequest {
  /** 要执行的 Python 代码。 */
  code: string;
  /** 执行通道 key，同 key 复用同一通道；缺省为 default。 */
  key?: string;
  /** 本次超时（毫秒），缺省 300 秒。 */
  timeoutMs?: number;
}

/** 单次执行的结果。失败也走这个结构，不抛异常。 */
export interface PythonRunResult {
  ok: boolean;
  /** 代码里 print 出来的内容；这是唯一返回给用户的部分。 */
  stdout: string;
  /** 进程 stderr，仅用于诊断。 */
  stderr: string;
  /** 失败原因；ok 为 true 时为空串。 */
  error: string;
  durationMs: number;
  /** 实际使用的执行通道 key。 */
  key: string;
}

/** worker 池的构造选项。 */
export interface PythonWorkerOptions {
  /** Python 解释器；缺省按平台取 python3 / python。 */
  interpreter?: string;
  /** 工作目录，注入为 worker 的 cwd。 */
  workDir?: string;
  /** 追加到子进程的环境变量。 */
  env?: Record<string, string>;
}
