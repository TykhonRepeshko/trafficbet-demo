package app

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

type UserPage struct {
	Items      []User `json:"items"`
	Total      int    `json:"total"`
	Page       int    `json:"page"`
	PageSize   int    `json:"pageSize"`
	TotalPages int    `json:"totalPages"`
}

type userListOptions struct {
	Page, PageSize int
	Query          string
}

func parseUserListOptions(r *http.Request) (userListOptions, error) {
	options := userListOptions{Page: 1, PageSize: 25}
	values := r.URL.Query()
	for _, field := range []string{"page", "pageSize", "q"} {
		if len(values[field]) > 1 {
			return options, fmt.Errorf("duplicate directory parameter")
		}
	}
	for key, target := range map[string]*int{"page": &options.Page, "pageSize": &options.PageSize} {
		if raw, present := values[key]; present {
			if raw[0] == "" || strings.IndexFunc(raw[0], func(c rune) bool { return c < '0' || c > '9' }) >= 0 {
				return options, fmt.Errorf("invalid directory parameter")
			}
			value, err := strconv.Atoi(raw[0])
			if err != nil || value < 1 || (key == "page" && value > 1000000) || (key == "pageSize" && value > 200) {
				return options, fmt.Errorf("directory parameter out of range")
			}
			*target = value
		}
	}
	rawQuery := values.Get("q")
	if !utf8.ValidString(rawQuery) || utf8.RuneCountInString(rawQuery) > 254 || strings.IndexFunc(rawQuery, unicode.IsControl) >= 0 {
		return options, fmt.Errorf("invalid search query")
	}
	options.Query = strings.TrimSpace(rawQuery)
	return options, nil
}

// Search is a literal substring, including apostrophes, % and _. Only bound
// values reach the fixed SQL; count and rows share one database snapshot.
func (s *Store) ListUsersPage(ctx context.Context, options userListOptions) (UserPage, error) {
	if options.Page < 1 || options.Page > 1000000 || options.PageSize < 1 || options.PageSize > 200 {
		return UserPage{}, ErrInvalid
	}
	page := UserPage{Items: []User{}, Page: options.Page, PageSize: options.PageSize, TotalPages: 1}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return page, err
	}
	defer tx.Rollback(ctx)
	const filter = ` WHERE $1='' OR strpos(lower(email),lower($1))>0 OR strpos(lower(display_name),lower($1))>0 OR id::text=$1`
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM users`+filter, options.Query).Scan(&page.Total); err != nil {
		return page, err
	}
	if page.Total > 0 {
		page.TotalPages = (page.Total-1)/page.PageSize + 1
	}
	if page.Page > page.TotalPages {
		page.Page = page.TotalPages
	}
	rows, err := tx.Query(ctx, `SELECT id,email,display_name,role,balance_credits,created_at FROM users`+filter+` ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`, options.Query, page.PageSize, (page.Page-1)*page.PageSize)
	if err != nil {
		return page, err
	}
	for rows.Next() {
		var user User
		if err := rows.Scan(&user.ID, &user.Email, &user.DisplayName, &user.Role, &user.BalanceCredits, &user.CreatedAt); err != nil {
			rows.Close()
			return page, err
		}
		page.Items = append(page.Items, user)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return page, err
	}
	return page, tx.Commit(ctx)
}
