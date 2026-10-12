import assert from "node:assert/strict";
import test from "node:test";
import {
  CREDENTIAL_DECRYPT_ERROR_CODE,
  isCredentialDecryptError,
} from "../src/oauth.js";

/**
 * isCredentialDecryptError 的识别面。
 *
 * 关键场景是**字符串错误**：错误跨进程/RPC 边界后常被 String(err) 拍成纯字符串，
 * UI 侧的 error state 就是字符串。早年只认 Error 实例与 { message } 对象，
 * 导致「本机凭据解不开」在登录页被当成未知错误反复上浮给用户。
 */
test("isCredentialDecryptError：认字符串、Error 与稳定 code 三种形态", () => {
  const message = "凭据解密失败：凭据无法解密（系统钥匙串密钥不可用或已更换），请重新登录";

  // 字符串（跨边界后被 String(err) 拍平的形式）
  assert.equal(isCredentialDecryptError(message), true);

  // Error 实例
  assert.equal(isCredentialDecryptError(new Error(message)), true);

  // 携带稳定 code 的对象（新错误的优先形态）
  assert.equal(
    isCredentialDecryptError({ code: CREDENTIAL_DECRYPT_ERROR_CODE, message: "anything" }),
    true,
  );

  // 负例：其它错误绝不误判，否则真正的故障会被静默吞掉
  assert.equal(isCredentialDecryptError(new Error("企业登录已过期，请重新登录")), false);
  assert.equal(isCredentialDecryptError({ code: "OTHER", message }), false);
  assert.equal(isCredentialDecryptError(undefined), false);
});
