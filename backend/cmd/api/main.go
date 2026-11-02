package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"trafficbet/backend/internal/app"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "healthcheck" {
		client := &http.Client{Timeout: 3 * time.Second}
		response, err := client.Get("http://127.0.0.1:8080/api/health")
		if err != nil {
			os.Exit(1)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		return
	}
	cfg := app.LoadConfig()
	if err := cfg.Validate(); err != nil {
		log.Fatalf("configuration: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := app.OpenDB(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("open database: %v", err)
	}
	defer pool.Close()

	if err := app.PrepareDatabase(ctx, pool); err != nil {
		log.Fatalf("run migrations: %v", err)
	}

	store := app.NewStore(pool)
	store.SetRoundStagger(cfg.RoundStagger)
	if cfg.SeedDemoData {
		if err := app.SeedDemoData(ctx, store, cfg); err != nil {
			log.Fatalf("seed demo data: %v", err)
		}
	}

	api := app.NewAPI(store, cfg)
	schedulerCtx, stopScheduler := context.WithCancel(context.Background())
	schedulerDone := make(chan struct{})
	go func() { defer close(schedulerDone); store.ServeRoundScheduler(schedulerCtx) }()
	observerDone := make(chan struct{})
	go func() { defer close(observerDone); api.ServeSourceObserver(schedulerCtx) }()
	evidenceDone := make(chan struct{})
	go func() { defer close(evidenceDone); api.ServeEvidenceCapture(schedulerCtx) }()
	automationDone := make(chan struct{})
	go func() { defer close(automationDone); api.ServeAutomaticSettlement(schedulerCtx) }()
	server := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           api.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}

	go func() {
		log.Printf("trafficbet api listening on %s", cfg.HTTPAddr)
		if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("http server: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	stopScheduler()
	<-schedulerDone
	<-observerDone
	<-evidenceDone
	<-automationDone

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("http shutdown: %v", err)
	}
}
