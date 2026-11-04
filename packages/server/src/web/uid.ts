/** uid 白名单：首字符字母数字，其余限字母数字与 . _ -。天然排除路径分隔符与 `..`。 */
export const WEB_UID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidWebUid(uid: string): boolean {
  return WEB_UID_PATTERN.test(uid);
}
