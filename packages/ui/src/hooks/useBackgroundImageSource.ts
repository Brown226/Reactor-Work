/**
 * 自定义背景图片的读取：路径变化时读一次文件，成功后把 URL 回填 store 并应用到文档根。
 *
 * 为什么读成 data URL，而不复用 `zcode-media://` 预览链路：
 * 共享的媒体预览注册表（`packages/shared/src/media-preview.ts`）只认音频/视频，把图片
 * 扩进去会同时改变 `codeViewer.inferMediaPreview` 的判定，影响文件预览的分支；
 * 而 `fileService.readMediaPreview` 本来就能按路径读任意文件（上限 8 MB，与背景图上限一致），
 * 正好符合"用户自选一张图"的体量。
 *
 * 在应用根节点挂一次即可：路径存在时每次启动都会重新读盘（授权/数据都不跨进程存活），
 * 文件被移动或删除时回落到预置背景，并把原因写进 `backgroundImage.error`。
 */
import { useEffect } from "react";
import { MAX_BACKGROUND_IMAGE_BYTES } from "@/lib/backgroundTheme.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeStore } from "@/store/StoreProvider.js";

export function useBackgroundImageSource(): void {
  const services = useServices();
  const imagePath = useZCodeStore((state) => state.backgroundTheme.imagePath);
  const setBackgroundImage = useZCodeStore((state) => state.setBackgroundImage);
  const applyCurrentBackgroundTheme = useZCodeStore((state) => state.applyCurrentBackgroundTheme);

  useEffect(() => {
    if (!imagePath) {
      setBackgroundImage({ status: "idle", url: null, error: null });
      applyCurrentBackgroundTheme(null);
      return;
    }

    let cancelled = false;
    setBackgroundImage({ status: "loading", url: null, error: null });

    void (async () => {
      try {
        const preview = await services.fileService.readMediaPreview({
          path: imagePath,
          maxBytes: MAX_BACKGROUND_IMAGE_BYTES,
        });
        if (cancelled) {
          return;
        }
        const url = `data:${preview.mediaType};base64,${preview.dataBase64}`;
        setBackgroundImage({ status: "ready", url, error: null });
        applyCurrentBackgroundTheme(url);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setBackgroundImage({
          status: "error",
          url: null,
          error: error instanceof Error ? error.message : String(error),
        });
        // 图片不可用时回落到预置背景，界面不留空白。
        applyCurrentBackgroundTheme(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [applyCurrentBackgroundTheme, imagePath, services, setBackgroundImage]);
}
