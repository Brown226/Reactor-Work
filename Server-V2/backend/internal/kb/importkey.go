package kb

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// LoadImportSigningKey atomically creates an installation-specific secret. All
// backend roles must share the state directory (or an explicit environment key).
func LoadImportSigningKey(path string) (string, error) {
	read := func() (string, error) {
		info, err := os.Lstat(path)
		if err != nil {
			return "", err
		}
		// Windows 的 Go 运行时不保留 POSIX 权限位，文件模式通常为 0666；
		// 这里仍校验普通文件，但只在 POSIX 平台检查 0600 权限，避免 Reactor
		// 在 Windows 上无法启动。文件 ACL 由部署侧（用户数据目录）保证。
		if !info.Mode().IsRegular() || (runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0) {
			return "", errors.New("导入签名文件必须为仅当前用户可读写的普通文件")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		decoded, err := hex.DecodeString(string(data))
		if err != nil || len(decoded) != 32 {
			return "", errors.New("导入签名文件损坏")
		}
		return string(data), nil
	}
	if key, err := read(); !errors.Is(err, os.ErrNotExist) {
		return key, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return "", err
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".kb-import-key-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err = file.WriteString(hex.EncodeToString(raw)); err != nil {
		return "", err
	}
	if err = file.Sync(); err != nil {
		return "", err
	}
	if err = file.Close(); err != nil {
		return "", err
	}
	if err = os.Link(file.Name(), path); err != nil && !errors.Is(err, os.ErrExist) {
		return "", fmt.Errorf("保存导入签名文件: %w", err)
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return "", err
	}
	defer dir.Close()
	// Windows 不支持对目录句柄做 fsync（返回 Access is denied）；
	// 文件内容已 Sync，目录项在本地 NTFS 上无需额外持久化保证。
	if err = dir.Sync(); err != nil && runtime.GOOS != "windows" {
		return "", err
	}
	return read()
}
