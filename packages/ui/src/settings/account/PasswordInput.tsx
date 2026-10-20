/**
 * 密码输入框：默认遮蔽，右侧带「显示/隐藏」眼睛按钮。
 *
 * 与登录页（`ReactorServerLoginForm`）、模型设置 API Key（`ApiKeyInput`）同款交互：
 * 长口令可临时显示以便核对，避免用户因看不见输入而反复重试。
 * 桌面端两处改密表单（账号设置卡、强制改密弹窗）共用本组件，避免交互漂移。
 */
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function PasswordInput({
  value,
  onChange,
  placeholder,
  autoComplete,
  disabled = false,
  className,
  onKeyDown,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoComplete?: string;
  disabled?: boolean;
  className?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  const { intl } = useZCodeIntl();
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        type={visible ? "text" : "password"}
        className={className ? `${className} pr-10` : "pr-10"}
        placeholder={placeholder}
        autoComplete={autoComplete}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={disabled}
        className="absolute top-1/2 right-1.5 -translate-y-1/2"
        aria-label={intl.formatMessage({
          id: visible ? "settings.account.password.hide" : "settings.account.password.show",
        })}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
      </Button>
    </div>
  );
}
