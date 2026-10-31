package app

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

type operationCounters struct {
	Requests         atomic.Uint64
	Failures         atomic.Uint64
	ObserverFailures atomic.Uint64
}
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	if w.status != 0 {
		return
	}
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}
func (w *statusWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(200)
	}
	return w.ResponseWriter.Write(body)
}
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func requestGroup(path string) string {
	for _, prefix := range []string{"/api/media/", "/api/admin/", "/api/auth/", "/api/me", "/api/internal/"} {
		if strings.HasPrefix(path, prefix) {
			return strings.Trim(prefix, "/")
		}
	}
	return "api/public"
}
func (api *API) observeHTTP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var raw [16]byte
		if _, err := rand.Read(raw[:]); err != nil {
			writeError(w, 503, "request_id_unavailable", "Please retry.")
			return
		}
		id := hex.EncodeToString(raw[:])
		w.Header().Set("X-Request-ID", id)
		record := &statusWriter{ResponseWriter: w}
		start := time.Now()
		next.ServeHTTP(record, r)
		api.operations.Requests.Add(1)
		if record.status >= 500 {
			api.operations.Failures.Add(1)
		}
		group := requestGroup(r.URL.Path)
		if group != "api/media" || record.status >= 400 {
			entry, _ := json.Marshal(map[string]any{"event": "http_request", "requestId": id, "group": group, "status": record.status, "durationMs": time.Since(start).Milliseconds()})
			log.Print(string(entry))
		}
	})
}
func (api *API) handleOperations(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	if r.URL.RawQuery != "" {
		writeStoreError(w, ErrInvalid)
		return
	}
	var mismatches, size, pending int64
	var checked *time.Time
	err := api.store.pool.QueryRow(r.Context(), `SELECT (SELECT count(*) FROM users u WHERE u.balance_credits<>COALESCE((SELECT sum(delta_credits) FROM credit_ledger WHERE user_id=u.id),0)),pg_database_size(current_database()),(SELECT count(*) FROM bet_markets WHERE status='open' AND window_end<=now()),(SELECT min(last_checked_at) FROM round_schedules WHERE enabled)`).Scan(&mismatches, &size, &pending, &checked)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"asOf": time.Now().UTC(), "ledgerMismatches": mismatches, "databaseBytes": size, "awaitingVerification": pending, "oldestScheduleCheck": checked, "httpRequestsSinceStart": api.operations.Requests.Load(), "httpFailuresSinceStart": api.operations.Failures.Load(), "observerFailuresSinceStart": api.operations.ObserverFailures.Load()})
}
