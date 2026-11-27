// Package reactormember 提供开源服务端入口所需的成员/分组写入实现。
//
// 上游 monkeyai/backend 的开源入口默认注入 member.EmptyUserWriter / EmptyGroupWriter，
// 空库不会创建初始管理员，管理台创建用户也会返回 member_writer_unavailable。
// Reactor 需要一个可用的本地实现，因此在这里用 SQL 直接落到上游 schema，不绕过
// member.UserWriter / GroupWriter 接口。
package reactormember

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/chaitin/MonkeyCode/monkeyai/backend/member"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const userColumns = `id, name, email,
	coalesce(nullif(btrim(custom_avatar_url), ''), nullif(btrim(avatar_url), ''), '')::text,
	role, status, joined_at, last_login_at`

// Writers 同时实现 member.UserWriter 与 member.GroupWriter。
type Writers struct {
	pool *pgxpool.Pool
}

func NewWriters(pool *pgxpool.Pool) (member.UserWriter, member.GroupWriter, error) {
	if pool == nil {
		return nil, nil, errors.New("数据库连接池不可为空")
	}
	w := &Writers{pool: pool}
	return w, w, nil
}

func scanUser(row pgx.Row) (member.User, error) {
	var (
		user     member.User
		joinedAt time.Time
		last     *time.Time
	)
	err := row.Scan(&user.ID, &user.Name, &user.Email, &user.AvatarURL, &user.Role, &user.Status, &joinedAt, &last)
	user.JoinedAt = joinedAt
	user.LastLoginAt = last
	return user, err
}

func normalizeEmail(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func validRole(role string) bool {
	return role == "admin" || role == "user"
}

func validStatus(status string) bool {
	return status == "active" || status == "disabled"
}

// EnsureInitialAdmin 只在用户表为空时创建管理员；空邮箱/空密码表示未配置，直接跳过。
func (w *Writers) EnsureInitialAdmin(ctx context.Context, in member.InitialAdmin) error {
	email := normalizeEmail(in.Email)
	if email == "" || in.Password == "" {
		return nil
	}
	var exists bool
	if err := w.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users WHERE deleted_at IS NULL)`).Scan(&exists); err != nil {
		return fmt.Errorf("检查初始管理员: %w", err)
	}
	if exists {
		return nil
	}
	hash, err := member.HashPassword(in.Password)
	if err != nil {
		return fmt.Errorf("生成初始管理员密码: %w", err)
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		name = "Administrator"
	}
	_, err = w.pool.Exec(ctx, `
		INSERT INTO users (name, email, password_hash, role)
		VALUES ($1, $2, $3, 'admin')
		ON CONFLICT (lower(email)) WHERE deleted_at IS NULL DO NOTHING`,
		name, email, hash)
	if err != nil {
		return fmt.Errorf("创建初始管理员: %w", err)
	}
	return nil
}

func (w *Writers) CreateUser(ctx context.Context, in member.CreateUser) (member.User, error) {
	name := strings.TrimSpace(in.Name)
	email := normalizeEmail(in.Email)
	if name == "" || email == "" {
		return member.User{}, errors.New("姓名和邮箱不能为空")
	}
	if !validRole(in.Role) {
		return member.User{}, errors.New("角色无效")
	}
	hash, err := member.HashPassword(in.Password)
	if err != nil {
		return member.User{}, fmt.Errorf("生成密码哈希: %w", err)
	}
	tx, err := w.pool.Begin(ctx)
	if err != nil {
		return member.User{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	user, err := scanUser(tx.QueryRow(ctx, `
		INSERT INTO users (name, email, password_hash, role)
		VALUES ($1, $2, $3, $4)
		RETURNING `+userColumns, name, email, hash, in.Role))
	if err != nil {
		return member.User{}, err
	}
	actor := strings.TrimSpace(in.ActorID)
	if actor == "" {
		actor = user.ID
	}
	for _, groupID := range in.GroupIDs {
		groupID = strings.TrimSpace(groupID)
		if groupID == "" || groupID == member.RootGroupID {
			continue
		}
		if err := ensureGroup(ctx, tx, groupID); err != nil {
			return member.User{}, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO group_users (group_id, user_id, assigned_by_user_id)
			VALUES ($1, $2, $3)
			ON CONFLICT (group_id, user_id) WHERE removed_at IS NULL DO NOTHING`,
			groupID, user.ID, actor); err != nil {
			return member.User{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return member.User{}, err
	}
	return user, nil
}

func (w *Writers) UpdateUser(ctx context.Context, tx pgx.Tx, in member.UpdateUser) (member.User, error) {
	if strings.TrimSpace(in.ID) == "" {
		return member.User{}, errors.New("用户 ID 不能为空")
	}
	if in.Role != "" && !validRole(in.Role) {
		return member.User{}, errors.New("角色无效")
	}
	if in.Status != "" && !validStatus(in.Status) {
		return member.User{}, errors.New("状态无效")
	}
	user, err := scanUser(tx.QueryRow(ctx, `
		UPDATE users SET
			name = COALESCE(NULLIF($2, ''), name),
			role = COALESCE(NULLIF($3, ''), role),
			status = COALESCE(NULLIF($4, ''), status),
			disabled_at = CASE
				WHEN NULLIF($4, '') = 'disabled' THEN now()
				WHEN NULLIF($4, '') = 'active' THEN NULL
				ELSE disabled_at
			END,
			password_hash = COALESCE(NULLIF($5, ''), password_hash),
			updated_at = now()
		WHERE id = $1 AND deleted_at IS NULL
		RETURNING `+userColumns,
		in.ID, strings.TrimSpace(in.Name), in.Role, in.Status, in.PasswordHash))
	return user, err
}

func (w *Writers) RegisterEmailUser(ctx context.Context, tx pgx.Tx, email string) (member.User, error) {
	email = normalizeEmail(email)
	if email == "" {
		return member.User{}, errors.New("邮箱不能为空")
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO users (name, email, role)
		VALUES ($1, $2, 'user')
		ON CONFLICT (lower(email)) WHERE deleted_at IS NULL DO NOTHING`,
		email, email); err != nil {
		return member.User{}, err
	}
	user, err := scanUser(tx.QueryRow(ctx, `
		SELECT `+userColumns+` FROM users
		WHERE lower(email) = lower($1) AND deleted_at IS NULL`, email))
	if err != nil {
		return member.User{}, err
	}
	if user.Status != "active" {
		return member.User{}, member.ErrUserDisabled
	}
	return user, nil
}

func (w *Writers) UpsertIdentity(ctx context.Context, in member.OAuthIdentity) (member.User, error) {
	provider := strings.TrimSpace(in.Provider)
	issuer := strings.TrimSpace(in.Issuer)
	subject := strings.TrimSpace(in.Subject)
	if provider == "" || issuer == "" || subject == "" {
		return member.User{}, errors.New("上游身份缺少 provider/issuer/subject")
	}
	email := normalizeEmail(in.Email)
	tx, err := w.pool.Begin(ctx)
	if err != nil {
		return member.User{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// 1. 已有身份：直接复用，并刷新上游资料。
	user, err := scanUser(tx.QueryRow(ctx, `
		SELECT `+userColumns+`
		FROM users u
		JOIN user_identities i ON i.user_id = u.id
		WHERE i.provider = $1 AND i.issuer = $2 AND i.provider_subject = $3
			AND i.deleted_at IS NULL AND u.deleted_at IS NULL`,
		provider, issuer, subject))
	if err == nil {
		if err := validateIdentityUser(user, in.AdminOnly); err != nil {
			return member.User{}, err
		}
		if err := refreshIdentity(ctx, tx, user.ID, provider, issuer, subject, in); err != nil {
			return member.User{}, err
		}
		return user, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return member.User{}, err
	}

	// 2. 邮箱已存在：把身份绑到现有账号，不重复建号。
	if email != "" {
		user, err = scanUser(tx.QueryRow(ctx, `
			SELECT `+userColumns+` FROM users
			WHERE lower(email) = lower($1) AND deleted_at IS NULL`, email))
		if err == nil {
			if err := validateIdentityUser(user, in.AdminOnly); err != nil {
				return member.User{}, err
			}
			if err := insertIdentity(ctx, tx, user.ID, provider, issuer, subject, in); err != nil {
				return member.User{}, err
			}
			if err := refreshIdentity(ctx, tx, user.ID, provider, issuer, subject, in); err != nil {
				return member.User{}, err
			}
			return user, tx.Commit(ctx)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return member.User{}, err
		}
	}

	// 3. 新用户：尊重管理员入口与自动注册开关。
	if in.AdminOnly {
		return member.User{}, member.ErrAdminRoleRequired
	}
	if !in.AutoRegistrationEnabled {
		return member.User{}, member.ErrRegistrationClosed
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		name = strings.TrimSpace(in.Username)
	}
	if name == "" {
		name = email
	}
	if name == "" || email == "" {
		return member.User{}, errors.New("上游身份缺少姓名或邮箱")
	}
	user, err = scanUser(tx.QueryRow(ctx, `
		INSERT INTO users (name, email, avatar_url, role, last_login_at)
		VALUES ($1, $2, NULLIF($3, ''), 'user', now())
		RETURNING `+userColumns, name, email, in.AvatarURL))
	if err != nil {
		return member.User{}, err
	}
	if err := insertIdentity(ctx, tx, user.ID, provider, issuer, subject, in); err != nil {
		return member.User{}, err
	}
	return user, tx.Commit(ctx)
}

func validateIdentityUser(user member.User, adminOnly bool) error {
	if user.Status != "active" {
		return member.ErrUserDisabled
	}
	if adminOnly && user.Role != "admin" {
		return member.ErrAdminRoleRequired
	}
	return nil
}

func insertIdentity(ctx context.Context, tx pgx.Tx, userID, provider, issuer, subject string, in member.OAuthIdentity) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO user_identities (user_id, provider, issuer, provider_subject, username, email, avatar_url)
		VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''))
		ON CONFLICT (provider, issuer, provider_subject) WHERE deleted_at IS NULL DO NOTHING`,
		userID, provider, issuer, subject, in.Username, in.Email, in.AvatarURL)
	return err
}

func refreshIdentity(ctx context.Context, tx pgx.Tx, userID, provider, issuer, subject string, in member.OAuthIdentity) error {
	if _, err := tx.Exec(ctx, `
		UPDATE user_identities SET
			username = COALESCE(NULLIF($4, ''), username),
			email = COALESCE(NULLIF($5, ''), email),
			avatar_url = COALESCE(NULLIF($6, ''), avatar_url),
			updated_at = now()
		WHERE provider = $1 AND issuer = $2 AND provider_subject = $3 AND deleted_at IS NULL`,
		provider, issuer, subject, in.Username, in.Email, in.AvatarURL); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `
		UPDATE users SET
			name = COALESCE(NULLIF($2, ''), name),
			avatar_url = COALESCE(NULLIF($3, ''), avatar_url),
			last_login_at = now(),
			updated_at = now()
		WHERE id = $1 AND deleted_at IS NULL`,
		userID, in.Name, in.AvatarURL)
	return err
}

func (w *Writers) ResetPassword(ctx context.Context, tx pgx.Tx, in member.PasswordReset) (string, error) {
	var id string
	err := tx.QueryRow(ctx, `
		UPDATE users SET password_hash = $2, updated_at = now()
		WHERE lower(email) = lower($1) AND deleted_at IS NULL
		RETURNING id`, normalizeEmail(in.Email), in.PasswordHash).Scan(&id)
	return id, err
}

func (w *Writers) ResetUserPassword(ctx context.Context, tx pgx.Tx, userID, passwordHash string) error {
	tag, err := tx.Exec(ctx, `
		UPDATE users SET password_hash = $2, updated_at = now()
		WHERE id = $1 AND deleted_at IS NULL`, userID, passwordHash)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

func (w *Writers) TouchLogin(ctx context.Context, userID string) error {
	_, err := w.pool.Exec(ctx, `
		UPDATE users SET last_login_at = now(), updated_at = now()
		WHERE id = $1 AND deleted_at IS NULL`, userID)
	return err
}

func ensureGroup(ctx context.Context, tx pgx.Tx, groupID string) error {
	var exists bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM groups WHERE id = $1 AND deleted_at IS NULL)`,
		groupID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return member.ErrGroupUnavailable
	}
	return nil
}

func (w *Writers) SetMembers(ctx context.Context, tx pgx.Tx, in member.GroupMembers) error {
	if strings.TrimSpace(in.GroupID) == "" || in.GroupID == member.RootGroupID {
		return nil
	}
	if err := ensureGroup(ctx, tx, in.GroupID); err != nil {
		return err
	}
	actor := strings.TrimSpace(in.ActorID)
	if actor == "" {
		return errors.New("操作者不能为空")
	}

	keep := make(map[string]struct{}, len(in.UserIDs))
	for _, id := range in.UserIDs {
		keep[strings.TrimSpace(id)] = struct{}{}
	}
	rows, err := tx.Query(ctx, `
		SELECT user_id FROM group_users
		WHERE group_id = $1 AND removed_at IS NULL`, in.GroupID)
	if err != nil {
		return err
	}
	var remove []string
	for rows.Next() {
		var userID string
		if err := rows.Scan(&userID); err != nil {
			rows.Close()
			return err
		}
		if _, ok := keep[userID]; !ok {
			remove = append(remove, userID)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, userID := range remove {
		if _, err := tx.Exec(ctx, `
			UPDATE group_users SET removed_at = now()
			WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL`, in.GroupID, userID); err != nil {
			return err
		}
	}
	for userID := range keep {
		if userID == "" {
			continue
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO group_users (group_id, user_id, assigned_by_user_id)
			VALUES ($1, $2, $3)
			ON CONFLICT (group_id, user_id) WHERE removed_at IS NULL DO NOTHING`,
			in.GroupID, userID, actor); err != nil {
			return err
		}
	}
	return nil
}

func (w *Writers) MoveMembers(ctx context.Context, tx pgx.Tx, in member.MoveMembers) error {
	actor := strings.TrimSpace(in.ActorID)
	if actor == "" {
		return errors.New("操作者不能为空")
	}
	if in.TargetGroupID != nil {
		if err := ensureGroup(ctx, tx, *in.TargetGroupID); err != nil {
			return err
		}
	}
	for _, item := range in.Members {
		if item.SourceGroupID != nil {
			if _, err := tx.Exec(ctx, `
				UPDATE group_users SET removed_at = now()
				WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL`,
				*item.SourceGroupID, item.ID); err != nil {
				return err
			}
		}
		if in.TargetGroupID != nil {
			if _, err := tx.Exec(ctx, `
				INSERT INTO group_users (group_id, user_id, assigned_by_user_id)
				VALUES ($1, $2, $3)
				ON CONFLICT (group_id, user_id) WHERE removed_at IS NULL DO NOTHING`,
				*in.TargetGroupID, item.ID, actor); err != nil {
				return err
			}
		}
	}
	return nil
}

func (w *Writers) RemoveAllMembers(ctx context.Context, tx pgx.Tx, groupID string) error {
	if strings.TrimSpace(groupID) == "" || groupID == member.RootGroupID {
		return nil
	}
	_, err := tx.Exec(ctx, `
		UPDATE group_users SET removed_at = now()
		WHERE group_id = $1 AND removed_at IS NULL`, groupID)
	return err
}
