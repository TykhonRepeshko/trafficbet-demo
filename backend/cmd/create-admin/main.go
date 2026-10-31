package main

import (
	"context"
	"errors"
	"log"
	"net/mail"
	"os"
	"strings"
	"time"

	"trafficbet/backend/internal/app"
)

// Run in the deployment environment; credentials are read from environment,
// never command arguments, and existing accounts are never silently promoted.
func main() {
	cfg := app.LoadConfig()
	if err := cfg.Validate(); err != nil {
		log.Fatalf("configuration: %v", err)
	}
	email := strings.ToLower(strings.TrimSpace(os.Getenv("ADMIN_EMAIL")))
	address, err := mail.ParseAddress(email)
	if err != nil || address.Address != email || len(email) > 254 {
		log.Fatal("ADMIN_EMAIL must be a valid email address")
	}
	password := os.Getenv("ADMIN_PASSWORD")
	if !app.ValidPassword(password) {
		log.Fatal("ADMIN_PASSWORD must contain at least 12 characters, at most 72 UTF-8 bytes and a non-whitespace character")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := app.OpenDB(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatal("could not open database")
	}
	defer pool.Close()
	if err := app.RunMigrations(ctx, pool); err != nil {
		log.Fatal("database migrations failed; inspect API startup diagnostics")
	}
	store := app.NewStore(pool)
	if _, _, err := store.GetUserByEmail(ctx, email); !errors.Is(err, app.ErrNotFound) {
		log.Fatal("account already exists or could not be checked; no changes made")
	}
	hash, err := app.HashPassword(password)
	if err != nil {
		log.Fatal("could not hash password")
	}
	if err := store.CreateUserIfMissing(ctx, email, hash, "Administrator", app.RoleAdmin, 0); err != nil {
		log.Fatal("could not create administrator")
	}
	created, storedHash, err := store.GetUserByEmail(ctx, email)
	if err != nil || created.Role != app.RoleAdmin || storedHash != hash {
		log.Fatal("account creation conflicted with another request; existing account was not changed")
	}
	log.Print("administrator created with zero test credits")
}
