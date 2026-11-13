import { z } from "zod";
import { remoteHostIdFromWorkspaceIdentity } from "@zcode/shared";
import type { DatabaseSync } from "node:sqlite";
import type { GroupTaskFact, GroupTaskRef, ITaskGroupService } from "#src/task-groups/contract.js";
import { TaskGroupRepository, groupTaskKey } from "#src/task-groups/repository.js";
export { TaskGroupRepository, groupTaskKey } from "#src/task-groups/repository.js";
export { ITaskGroupService } from "#src/task-groups/contract.js";
export type {
  TaskGroup,
  TaskGroupColor,
  TaskGroupStructure,
  GroupTaskRef,
  GroupNode,
  MoveGroupNode,
  GroupTaskFact,
} from "#src/task-groups/contract.js";

const taskSchema = z
  .object({
    hostId: z.string().min(1),
    workspacePath: z.string().min(1),
    workspaceIdentity: z.string().trim().min(1).optional(),
    taskId: z.string().min(1),
  })
  .strict()
  .refine((task) => {
    // hostId 与 workspaceIdentity 必须同源推导。带 identity 时按 identity 校验；
    // 不带 identity 说明任务是本机 workspace，此时 hostId 必须是 "local"。
    //
    // [本地定制] 独立 Server（Lite HTTP 入口）上，前端会把 hostId 记成
    // "remote:server:<id>"（数据目录隔离键），但 workspace 就在服务端本进程内，
    // 没有远端 identity 可推导。此前这里直接判不一致，导致每次首发消息都报
    // 「分组操作失败」——会话能建、消息能发，唯独任务入组失败。
    // 归一规则：identity 缺失时，把本机 server 形态的 hostId 视同 local。
    if (!task.workspaceIdentity) return task.hostId === "local" || task.hostId.startsWith("remote:server:");
    return remoteHostIdFromWorkspaceIdentity(task.workspaceIdentity) === task.hostId;
  }, "task-group.host-identity-mismatch");
const nodeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("group"), groupId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("task"), task: taskSchema }).strict(),
]);
export function createTaskGroupService(options: {
  database(): Promise<DatabaseSync>;
  resolveTasks(tasks: GroupTaskRef[]): Promise<GroupTaskFact[]>;
  afterChange(): Promise<void>;
}): ITaskGroupService {
  const repository = async () => new TaskGroupRepository(await options.database());
  const changed = async (run: (repo: TaskGroupRepository) => void) => {
    const repo = await repository();
    run(repo);
    await options.afterChange();
  };
  return {
    read: async () => (await repository()).read(),
    async save(input) {
      const parsed = z
        .object({
          id: z.string().min(1).optional(),
          title: z.string().trim().min(1).max(200).optional(),
          color: z.enum(["gray", "red", "orange", "yellow", "green", "blue", "purple"]).optional(),
        })
        .strict()
        .parse(input);
      const result = (await repository()).save(parsed);
      await options.afterChange();
      return result;
    },
    async ungroup(id) {
      await changed((repo) => repo.ungroup(z.string().min(1).parse(id)));
    },
    async move(input) {
      const parsed = z
        .object({
          node: nodeSchema,
          sourceGroupId: z.string().min(1).nullable(),
          groupId: z.string().min(1).nullable(),
          anchor: z
            .object({ node: nodeSchema, side: z.enum(["before", "after"]) })
            .strict()
            .optional(),
        })
        .strict()
        .parse(input);
      const refs = [parsed.node, parsed.anchor?.node].flatMap((node) =>
        node?.type === "task" ? [node.task] : [],
      );
      const facts = await options.resolveTasks(refs);
      if (
        facts.length !== refs.length ||
        refs.some(
          (ref) =>
            !facts.some(
              (task) =>
                groupTaskKey(task) === groupTaskKey(ref) &&
                task.hostId === ref.hostId &&
                task.workspacePath === ref.workspacePath &&
                !task.deleted &&
                !task.archived,
            ),
        )
      )
        throw new Error("task-group.task-unavailable");
      await changed((repo) => repo.move(parsed));
    },
    async admit(input) {
      const parsed = z
        .object({
          tasks: z.array(taskSchema).max(10000),
          placement: z
            .object({
              task: taskSchema,
              groupId: z.string().min(1).nullable(),
              creationId: z.string().min(1),
            })
            .strict()
            .optional(),
        })
        .strict()
        .parse(input);
      const facts = await options.resolveTasks(parsed.tasks);
      if (
        parsed.placement &&
        !facts.some(
          (task) =>
            groupTaskKey(task) === groupTaskKey(parsed.placement!.task) &&
            task.hostId === parsed.placement!.task.hostId &&
            task.workspacePath === parsed.placement!.task.workspacePath &&
            !task.deleted,
        )
      )
        throw new Error("task-group.created-task-unavailable");
      const db = await options.database();
      const before = db.prepare("SELECT total_changes() AS n").get()?.n;
      new TaskGroupRepository(db).admit(facts, parsed.placement);
      if (db.prepare("SELECT total_changes() AS n").get()?.n !== before)
        await options.afterChange();
    },
  };
}
