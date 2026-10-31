// migrate is the short-lived privileged container step, never the HTTP runtime.
package main

import (
	"context"
	"log"
	"os"
	"time"
	"trafficbet/backend/internal/app"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool, err := app.OpenDB(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal("migration database configuration is unavailable")
	}
	defer pool.Close()
	if err = app.RunMigrations(ctx, pool); err != nil {
		log.Fatal("migration failed; inspect database logs privately")
	}
	if err = app.ConfigureRuntimeRole(ctx, pool, os.Getenv("RUNTIME_DATABASE_USER"), os.Getenv("RUNTIME_DATABASE_PASSWORD")); err != nil {
		log.Fatal("runtime database role preparation failed")
	}
	log.Print("migrations applied and restricted runtime grants prepared")
}
