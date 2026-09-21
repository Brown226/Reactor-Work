/**
 * 用户级数据目录名：唯一事实源。
 *
 * 产品身份的第三层（P3）——应用在用户 HOME 下使用的隐藏目录。原先硬编码为
 * `.zcode` 散落在 40+ 个文件中，此处收口为一处，改名只需改这个常量。
 *
 * 值**包含前导点**，与磁盘上的实际目录名一致，使所有引用点都是从 `.zcode`
 * 到本常量的 1:1 替换（`join(home, USER_DATA_DIR_NAME)`）。
 *
 * 约定：
 * - **用户级目录**（本常量）：会话、凭据、provider 配置、遥测状态、CLI 日志等，
 *   位于 `{dataBaseDir}/{USER_DATA_DIR_NAME}`。
 * - **工作区级 `.zcode` 目录**（工作区内的 `AGENTS.md`、`agents/`、`workflows/`、
 *   `config.json` 等）是项目配置的产品语义，**不使用本常量**，保持字面量 `.zcode`。
 *
 * 当前值 `reactor-ds`：本机已有旧项目占用 `~/.reactor`，待其彻底退役后改回
 * `~/.reactor`（即把本常量改为 `".reactor"`）。仅改此处即可让全仓用户级路径迁移。
 *
 * `apps/zcode-cli/packages/{telemetry,debug}` 各有一份同值副本（那两个包刻意不依赖
 * 本包），改名时需一并同步。
 */
export const USER_DATA_DIR_NAME = ".reactor-ds";

/** 目录名的去掉前导点的展示形式，用于日志与诊断文案。 */
export const USER_DATA_DIR_DISPLAY_NAME = USER_DATA_DIR_NAME.replace(/^\./, "");
