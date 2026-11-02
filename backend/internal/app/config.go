package app

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Config struct {
	SourceObserverEnabled bool
	AutomaticSettlement   bool
	RoundStagger          bool
	VideoEvidenceEnabled  bool
	HTTPAddr              string
	DatabaseURL           string
	WorkerToken           string
	FrontendOrigin        string
	AppEnv                string
	CookieSecure          bool
	SeedDemoData          bool
	DemoAdminPassword     string
	DemoPlayerPassword    string
	MediaAllowedHosts     []string
	parseError            error
}

func LoadConfig() Config {
	cfg := Config{
		SourceObserverEnabled: true,
		HTTPAddr:              env("HTTP_ADDR", ":8080"),
		DatabaseURL:           os.Getenv("DATABASE_URL"),
		WorkerToken:           os.Getenv("WORKER_TOKEN"),
		FrontendOrigin:        env("FRONTEND_ORIGIN", "http://localhost:4200"),
		AppEnv:                env("APP_ENV", "development"),
		DemoAdminPassword:     os.Getenv("DEMO_ADMIN_PASSWORD"),
		DemoPlayerPassword:    os.Getenv("DEMO_PLAYER_PASSWORD"),
		MediaAllowedHosts:     parseMediaAllowedHosts(os.Getenv("MEDIA_ALLOWED_HOSTS")),
	}
	for key, target := range map[string]*bool{"COOKIE_SECURE": &cfg.CookieSecure, "SEED_DEMO_DATA": &cfg.SeedDemoData, "SOURCE_OBSERVER_ENABLED": &cfg.SourceObserverEnabled, "AUTOMATIC_SETTLEMENT_ENABLED": &cfg.AutomaticSettlement, "ROUND_STAGGER": &cfg.RoundStagger, "VIDEO_EVIDENCE_ENABLED": &cfg.VideoEvidenceEnabled} {
		if value := os.Getenv(key); value != "" {
			parsed, err := strconv.ParseBool(value)
			if err != nil {
				cfg.parseError = fmt.Errorf("%s must be a boolean", key)
			} else {
				*target = parsed
			}
		}
	}
	return cfg
}

func (cfg Config) Validate() error {
	if cfg.parseError != nil {
		return cfg.parseError
	}
	if err := validateMediaAllowedHosts(cfg.MediaAllowedHosts); err != nil {
		return err
	}
	if cfg.AppEnv != "development" && cfg.AppEnv != "production" {
		return fmt.Errorf("APP_ENV must be development or production")
	}
	if strings.TrimSpace(cfg.DatabaseURL) == "" {
		return fmt.Errorf("DATABASE_URL is required")
	}
	if _, err := pgxpool.ParseConfig(cfg.DatabaseURL); err != nil {
		return fmt.Errorf("DATABASE_URL is invalid")
	}
	if len(cfg.WorkerToken) < 32 || strings.Contains(strings.ToLower(cfg.WorkerToken), "change-me") {
		return fmt.Errorf("WORKER_TOKEN must contain at least 32 random characters")
	}
	u, err := url.Parse(cfg.FrontendOrigin)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return fmt.Errorf("FRONTEND_ORIGIN must be one exact http(s) origin without a path")
	}
	if cfg.AppEnv == "production" {
		if !cfg.CookieSecure || u.Scheme != "https" {
			return fmt.Errorf("production requires COOKIE_SECURE=true and an HTTPS FRONTEND_ORIGIN")
		}
		if cfg.SeedDemoData {
			return fmt.Errorf("SEED_DEMO_DATA is not permitted in production; use create-admin")
		}
	}
	if cfg.SeedDemoData {
		if !ValidPassword(cfg.DemoAdminPassword) || !ValidPassword(cfg.DemoPlayerPassword) || cfg.DemoAdminPassword == cfg.DemoPlayerPassword {
			return fmt.Errorf("demo accounts require distinct DEMO_ADMIN_PASSWORD and DEMO_PLAYER_PASSWORD of at least 12 characters, at most 72 UTF-8 bytes and a non-whitespace character")
		}
	}
	return nil
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
