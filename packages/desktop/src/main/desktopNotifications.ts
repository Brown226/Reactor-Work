import { app, BrowserWindow, Notification } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { TaskNotificationPayload } from "@zcode/shared";
import { formatZodError, PlatformChannels, taskNotificationPayloadSchema } from "@zcode/shared";

const TASK_NOTIFICATION_DEDUPE_WINDOW_MS = 3000;
const MAX_ACTIVE_TASK_NOTIFICATIONS = 100;
const recentTaskNotificationTimestamps = new Map<string, number>();
const activeTaskNotifications = new Set<Notification>();

function isAnyAppWindowFocused() {
  return BrowserWindow.getAllWindows().some(
    (window) => !window.isDestroyed() && window.isFocused(),
  );
}

function shouldSuppressDuplicateTaskNotification(
  taskId: string,
  status: TaskNotificationPayload["status"],
  requestId?: string,
) {
  const now = Date.now();

  for (const [key, timestamp] of recentTaskNotificationTimestamps) {
    if (now - timestamp > TASK_NOTIFICATION_DEDUPE_WINDOW_MS) {
      recentTaskNotificationTimestamps.delete(key);
    }
  }

  // elicitation_request 和 permission_request 一样代表一次具体的人机阻塞请求。
  // 如果仍按 taskId 去重，同一任务连续 AskUserQuestion/计划确认会在 3 秒内漏掉第二条通知。
  const dedupeTarget =
    status === "permission_request" || status === "elicitation_request"
      ? requestId?.trim() || taskId
      : taskId;
  const dedupeKey = `${status}:${dedupeTarget}`;
  const lastTimestamp = recentTaskNotificationTimestamps.get(dedupeKey);
  if (lastTimestamp != null && now - lastTimestamp < TASK_NOTIFICATION_DEDUPE_WINDOW_MS) {
    return true;
  }

  recentTaskNotificationTimestamps.set(dedupeKey, now);
  return false;
}

function retainTaskNotification(notification: Notification) {
  activeTaskNotifications.add(notification);

  if (activeTaskNotifications.size <= MAX_ACTIVE_TASK_NOTIFICATIONS) {
    return;
  }

  const oldestNotification = activeTaskNotifications.values().next().value;
  if (oldestNotification) {
    activeTaskNotifications.delete(oldestNotification);
  }
}

function releaseTaskNotification(notification: Notification) {
  activeTaskNotifications.delete(notification);
}

/**
 * 传入窗口的"待停止强调"状态。
 *
 * 参考 Namiwork `src/notify/notification-presenter.js`：Windows 用
 * `win.flashFrame(true)` 闪烁任务栏，macOS 用 `app.dock.bounce("informational")`
 * 弹跳 Dock；窗口获得焦点后停止。这里同一时刻只保留一个待停止项——
 * 通知本来就只在"任何窗口都没聚焦"时发出，语义一致。
 */
let pendingWindowAttention: { stop: () => void } | null = null;

function clearPendingWindowAttention() {
  if (!pendingWindowAttention) {
    return;
  }
  pendingWindowAttention.stop();
  pendingWindowAttention = null;
}

function startWindowAttention(win: BrowserWindow) {
  // 前一次强调未被聚焦消费（如再次后台任务完成）时先停掉旧的，避免闪烁/弹跳叠加。
  clearPendingWindowAttention();

  const onFocus = () => clearPendingWindowAttention();
  win.once("focus", onFocus);

  let bounceId = -1;
  if (process.platform === "win32") {
    if (typeof win.flashFrame === "function") {
      try {
        win.flashFrame(true);
      } catch {
        /* 闪烁失败不影响通知本身 */
      }
    }
  } else if (process.platform === "darwin") {
    const id = app.dock?.bounce("informational");
    bounceId = typeof id === "number" ? id : -1;
  }

  pendingWindowAttention = {
    stop: () => {
      win.removeListener("focus", onFocus);
      if (process.platform === "win32") {
        if (!win.isDestroyed() && typeof win.flashFrame === "function") {
          try {
            win.flashFrame(false);
          } catch {
            /* 停止闪烁失败可忽略 */
          }
        }
      } else if (process.platform === "darwin" && bounceId >= 0) {
        app.dock?.cancelBounce(bounceId);
      }
    },
  };
}

function focusTaskNotificationWindow(senderWindow: BrowserWindow) {
  if (senderWindow.isMinimized()) {
    senderWindow.restore();
  }

  if (!senderWindow.isVisible()) {
    senderWindow.show();
  }

  // macOS 点通知时如果窗口曾被隐藏/最小化，必须先恢复窗口，再激活 app，
  // 最后聚焦 BrowserWindow；否则 app.focus 抢到前台时没有可显示窗口，后续 focus 可能被系统忽略。
  if (process.platform === "darwin") {
    app.dock?.show();
    app.show();
    app.focus({ steal: true });
  }

  senderWindow.focus();
}

export function dispatchTaskNotification(options: {
  event: IpcMainEvent | IpcMainInvokeEvent;
  payload: unknown;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
}): boolean {
  const result = taskNotificationPayloadSchema.safeParse(options.payload);
  if (!result.success) {
    options.logger.warn("[show-task-notification] invalid payload:", formatZodError(result.error));
    return false;
  }

  if (!Notification.isSupported()) {
    options.logger.warn("[show-task-notification] notification is not supported on this platform");
    return false;
  }

  if (isAnyAppWindowFocused()) {
    return false;
  }

  const { taskId, status, requestId, title, body } = result.data;
  const notificationTitle = title.trim();
  const notificationBody = body.trim();
  if (!notificationTitle || !notificationBody) {
    // main process 没有 renderer 当前语言上下文，不能在这里兜底生成中文通知文案。
    // 通知文案必须由 renderer 侧按 i18n 生成后传入；缺失时直接拒绝展示，避免英文界面弹出中文硬编码。
    options.logger.warn("[show-task-notification] missing localized notification copy", {
      taskId,
      status,
      hasTitle: Boolean(notificationTitle),
      hasBody: Boolean(notificationBody),
    });
    return false;
  }

  if (shouldSuppressDuplicateTaskNotification(taskId, status, requestId)) {
    return false;
  }

  const senderWindow = BrowserWindow.fromWebContents(options.event.sender);
  const notification = new Notification({
    title: notificationTitle,
    body: notificationBody,
    silent: true,
  });

  // Electron 原生 Notification 如果只存在于函数局部变量里，系统通知仍能显示，
  // 但主进程 JS 对象可能在用户点击前被回收，导致 click listener 丢失。
  // 这里显式持有对象，等点击/关闭后释放，保证“有通知”与“点击可唤起”属于同一生命周期。
  retainTaskNotification(notification);

  notification.once("click", () => {
    releaseTaskNotification(notification);

    if (!senderWindow || senderWindow.isDestroyed()) {
      options.logger.warn("[show-task-notification] click ignored: sender window is gone", {
        taskId,
      });
      return;
    }

    focusTaskNotificationWindow(senderWindow);
    senderWindow.webContents.send(PlatformChannels.TaskNotificationClick, taskId);
    options.logger.info("[show-task-notification] notification click handled", {
      taskId,
      windowId: senderWindow.id,
    });
  });
  notification.once("close", () => {
    releaseTaskNotification(notification);
  });

  notification.show();
  // 系统通知可能被忽略；同时闪烁任务栏（Windows）/弹跳 Dock（macOS），窗口获焦后停止。
  if (senderWindow && !senderWindow.isDestroyed()) {
    startWindowAttention(senderWindow);
  }
  options.event.sender.send(PlatformChannels.TaskNotificationSound);
  return true;
}
