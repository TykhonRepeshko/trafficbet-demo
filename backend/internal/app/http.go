package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
)

type API struct {
	store             *Store
	cfg               Config
	logins            *loginLimiter
	registrations     *loginLimiter
	media             *MediaGateway
	dummyPasswordHash string
	operations        operationCounters
}

func NewAPI(store *Store, cfg Config) *API {
	dummy, _ := HashPassword("unused-account-timing-password")
	return &API{store: store, cfg: cfg, logins: &loginLimiter{buckets: make(map[string]loginBucket)}, registrations: &loginLimiter{buckets: make(map[string]loginBucket)}, media: NewMediaGateway(cfg.MediaAllowedHosts), dummyPasswordHash: dummy}
}

func (api *API) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", api.withCORS(api.handleHealth))
	mux.HandleFunc("/api/auth/login", api.withCORS(api.handleLogin))
	mux.HandleFunc("/api/auth/register", api.withCORS(api.handleRegister))
	mux.HandleFunc("/api/auth/logout", api.withCORS(api.handleLogout))
	mux.HandleFunc("/api/me", api.withCORS(api.requireAuth(api.handleMe)))
	mux.HandleFunc("/api/me/ledger", api.withCORS(api.requireAuth(api.handleMyLedger)))
	mux.HandleFunc("/api/me/security", api.withCORS(api.requireAuth(api.handleAccountSecurity)))
	mux.HandleFunc("/api/me/security/", api.withCORS(api.requireAuth(api.handleAccountSecurity)))
	mux.HandleFunc("/api/streams", api.withCORS(api.handleStreams))
	mux.HandleFunc("/api/streams/", api.withCORS(api.handleStreamByID))
	mux.HandleFunc("/api/media/streams/", api.withCORS(api.handleMedia))
	mux.HandleFunc("/api/bets", api.withCORS(api.requireAuth(api.handleBets)))
	mux.HandleFunc("/api/bets/my", api.withCORS(api.requireAuth(api.handleMyBets)))
	mux.HandleFunc("/api/admin/streams", api.withCORS(api.requireAdmin(api.handleAdminStreams)))
	mux.HandleFunc("/api/admin/streams/", api.withCORS(api.requireAdmin(api.handleAdminStreamByID)))
	mux.HandleFunc("/api/admin/markets", api.withCORS(api.requireAdmin(api.handleAdminMarkets)))
	mux.HandleFunc("/api/admin/markets/", api.withCORS(api.requireAdmin(api.handleAdminMarketByID)))
	mux.HandleFunc("/api/admin/round-schedules", api.withCORS(api.requireAdmin(api.handleRoundSchedules)))
	mux.HandleFunc("/api/admin/round-schedules/", api.withCORS(api.requireAdmin(api.handleRoundScheduleByID)))
	mux.HandleFunc("/api/admin/bets", api.withCORS(api.requireAdmin(api.handleAdminBets)))
	mux.HandleFunc("/api/admin/stake-volume", api.withCORS(api.requireAdmin(api.handleStakeVolume)))
	mux.HandleFunc("/api/admin/stake-volume/bets", api.withCORS(api.requireAdmin(api.handleStakeDetails)))
	mux.HandleFunc("/api/admin/users", api.withCORS(api.requireAdmin(api.handleAdminUsers)))
	mux.HandleFunc("/api/admin/preparation/", api.withCORS(api.requireAdmin(api.handleCountingPreparation)))
	mux.HandleFunc("/api/admin/source-health", api.withCORS(api.requireAdmin(api.handleSourceHealth)))
	mux.HandleFunc("/api/admin/round-review", api.withCORS(api.requireAdmin(api.handleReviewQueue)))
	mux.HandleFunc("/api/admin/round-review/", api.withCORS(api.requireAdmin(api.handleRoundReview)))
	mux.HandleFunc("/api/admin/audit", api.withCORS(api.requireAdmin(api.handleAuditDirectory)))
	mux.HandleFunc("/api/admin/evaluation", api.withCORS(api.requireAdmin(api.handleEvaluation)))
	mux.HandleFunc("/api/admin/evaluation/", api.withCORS(api.requireAdmin(api.handleEvaluation)))
	mux.HandleFunc("/api/admin/operations", api.withCORS(api.requireAdmin(api.handleOperations)))
	mux.HandleFunc("/api/admin/video-evidence", api.withCORS(api.requireAdmin(api.handleVideoEvidence)))
	mux.HandleFunc("/api/admin/video-evidence/", api.withCORS(api.requireAdmin(api.handleVideoEvidence)))
	mux.HandleFunc("/api/internal/streams/", api.withCORS(api.requireWorker(api.handleInternalStreamByID)))
	return api.observeHTTP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		mux.ServeHTTP(w, r.WithContext(ctx))
	}))
}

func (api *API) withCORS(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		internal := strings.HasPrefix(r.URL.Path, "/api/internal/")
		mutation := r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions
		if (origin != "" && (internal || origin != api.cfg.FrontendOrigin)) || (mutation && !internal && origin == "") {
			writeError(w, http.StatusForbidden, "origin_rejected", "Request origin is not allowed.")
			return
		}
		w.Header().Add("Vary", "Origin")
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
		}
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next(w, r)
	}
}

func (api *API) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := sessionToken(r)
		if token == "" {
			writeError(w, http.StatusUnauthorized, "auth_required", "Login is required.")
			return
		}
		user, err := api.store.GetSessionUser(r.Context(), sessionHash(token))
		if err != nil {
			if !errors.Is(err, ErrNotFound) {
				writeError(w, http.StatusInternalServerError, "server_error", "Could not validate session.")
				return
			}
			writeError(w, http.StatusUnauthorized, "auth_required", "Login is required.")
			return
		}
		ctx := context.WithValue(r.Context(), userContextKey, user)
		next(w, r.WithContext(ctx))
	}
}

func (api *API) requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return api.requireAuth(func(w http.ResponseWriter, r *http.Request) {
		user, _ := currentUser(r.Context())
		if user.Role != RoleAdmin {
			writeError(w, http.StatusForbidden, "forbidden", "Admin role is required.")
			return
		}
		next(w, r)
	})
}

func (api *API) requireWorker(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actual := sha256.Sum256([]byte(r.Header.Get("X-Worker-Token")))
		expected := sha256.Sum256([]byte(api.cfg.WorkerToken))
		if api.cfg.WorkerToken == "" || subtle.ConstantTimeCompare(actual[:], expected[:]) != 1 {
			writeError(w, http.StatusUnauthorized, "worker_token_required", "Worker token is required.")
			return
		}
		next(w, r)
	}
}

func (api *API) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	if err := api.store.pool.Ping(r.Context()); err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "Database health check failed.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (api *API) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var input struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if len(input.Email) > 254 || len(input.Password) > 72 || input.Password == "" {
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "Email or password is incorrect.")
		return
	}
	if !api.logins.allow(r.RemoteAddr, input.Email, time.Now()) {
		w.Header().Set("Retry-After", "900")
		writeError(w, http.StatusTooManyRequests, "login_rate_limited", "Too many login attempts. Try again later.")
		return
	}
	user, passwordHash, err := api.store.GetUserByEmail(r.Context(), input.Email)
	if err != nil {
		CheckPassword(api.dummyPasswordHash, input.Password)
		if !errors.Is(err, ErrNotFound) {
			writeError(w, http.StatusInternalServerError, "server_error", "Login failed.")
			return
		}
	}
	if err != nil || !CheckPassword(passwordHash, input.Password) {
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "Email or password is incorrect.")
		return
	}
	token, err := newSessionToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "token_error", "Could not create session.")
		return
	}
	expires := time.Now().Add(sessionLifetime)
	if err := api.store.authenticatedSession(r.Context(), user, passwordHash, sessionHash(token), expires, sessionToken(r)); err != nil {
		if errors.Is(err, errUnauthorized) {
			writeError(w, 401, "invalid_credentials", "Email or password is incorrect.")
			return
		}
		writeError(w, http.StatusInternalServerError, "server_error", "Could not create session.")
		return
	}
	api.setSessionCookie(w, token, expires)
	api.logins.success(r.RemoteAddr, input.Email)
	writeJSON(w, http.StatusOK, map[string]any{"user": user})
}

func (api *API) handleLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if token := sessionToken(r); token != "" {
		if err := api.store.RevokeSession(r.Context(), sessionHash(token)); err != nil {
			writeError(w, http.StatusInternalServerError, "server_error", "Could not end session.")
			return
		}
	}
	api.setSessionCookie(w, "", time.Time{})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (api *API) handleMe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	user, _ := currentUser(r.Context())
	writeJSON(w, http.StatusOK, user)
}

func (api *API) handleStreams(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	streams, err := api.store.ListStreams(r.Context(), true)
	if err == nil {
		err = api.store.attachPublicCountingGuides(r.Context(), streams)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "streams_error", err.Error())
		return
	}
	for i := range streams {
		streams[i] = api.publicStream(streams[i])
	}
	writeJSON(w, http.StatusOK, streams)
}

func (api *API) handleStreamByID(w http.ResponseWriter, r *http.Request) {
	trimmed := strings.TrimPrefix(r.URL.Path, "/api/streams/")
	parts := strings.Split(strings.Trim(trimmed, "/"), "/")
	id, err := parseID(parts[0])
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_stream_id", "Stream id is invalid.")
		return
	}
	stream, err := api.store.GetStream(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if !stream.IsActive {
		writeStoreError(w, ErrNotFound)
		return
	}
	if len(parts) > 2 {
		http.NotFound(w, r)
		return
	}

	if len(parts) == 1 {
		if r.Method != http.MethodGet {
			methodNotAllowed(w)
			return
		}
		items := []Stream{stream}
		if err = api.store.attachPublicCountingGuides(r.Context(), items); err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, api.publicStream(items[0]))
		return
	}

	switch parts[1] {
	case "markets":
		if r.Method != http.MethodGet {
			methodNotAllowed(w)
			return
		}
		status := r.URL.Query().Get("status")
		markets, err := api.store.ListPublicMarkets(r.Context(), id, status)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, markets)
	case "metrics":
		if r.Method != http.MethodGet {
			methodNotAllowed(w)
			return
		}
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		metrics, err := api.store.ListStreamMetrics(r.Context(), id, limit)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "metrics_error", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, metrics)
	default:
		http.NotFound(w, r)
	}
}

func (api *API) handleBets(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	user, _ := currentUser(r.Context())
	var input struct {
		MarketID     int64  `json:"marketId"`
		Side         string `json:"side"`
		StakeCredits int64  `json:"stakeCredits"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.MarketID <= 0 || !validBetSide(input.Side) || input.StakeCredits <= 0 || input.StakeCredits > maxStakeCredits {
		writeError(w, http.StatusBadRequest, "invalid_bet", "Market, side and stake are required.")
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if !validIdempotencyKey(key) {
		writeError(w, http.StatusBadRequest, "idempotency_key_required", "A valid Idempotency-Key is required.")
		return
	}
	bet, updatedUser, err := api.store.PlaceBet(r.Context(), user.ID, input.MarketID, input.Side, input.StakeCredits, key)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"bet": bet, "user": updatedUser})
}

func (api *API) handleMyBets(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	user, _ := currentUser(r.Context())
	bets, err := api.store.ListBetsForUser(r.Context(), user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "bets_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, bets)
}

func (api *API) handleAdminStreams(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		streams, err := api.store.ListStreams(r.Context(), false)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "streams_error", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, streams)
	case http.MethodPost:
		stream, ok := api.readStreamInput(w, r, 0)
		if !ok {
			return
		}
		created, err := api.store.CreateStream(r.Context(), stream)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "stream_create_error", err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, created)
	default:
		methodNotAllowed(w)
	}
}

func (api *API) handleAdminStreamByID(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/admin/streams/"), "/"), "/")
	id, err := parseID(parts[0])
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_stream_id", "Stream id is invalid.")
		return
	}
	if len(parts) == 2 && parts[1] == "restore" {
		if r.Method != http.MethodPatch {
			methodNotAllowed(w)
			return
		}
		var input struct{}
		if !decodeJSON(w, r, &input) {
			return
		}
		stream, err := api.store.RestoreStream(r.Context(), id)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, stream)
		return
	}
	if len(parts) != 1 {
		http.NotFound(w, r)
		return
	}
	switch r.Method {
	case http.MethodPut:
		stream, ok := api.readStreamInput(w, r, id)
		if !ok {
			return
		}
		updated, err := api.store.UpdateStream(r.Context(), stream)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, updated)
	case http.MethodDelete:
		if err := api.store.DeleteStream(r.Context(), id); err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
	default:
		methodNotAllowed(w)
	}
}

func (api *API) handleAdminMarkets(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		var streamID *int64
		if value := r.URL.Query().Get("streamId"); value != "" {
			parsed, err := parseID(value)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid_stream_id", "Stream id is invalid.")
				return
			}
			streamID = &parsed
		}
		status := r.URL.Query().Get("status")
		markets, err := api.store.ListMarkets(r.Context(), streamID, status)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "markets_error", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, markets)
	case http.MethodPost:
		var input struct {
			StreamID        int64   `json:"streamId"`
			Title           string  `json:"title"`
			Threshold       int     `json:"threshold"`
			WindowStart     string  `json:"windowStart"`
			WindowEnd       string  `json:"windowEnd"`
			BettingClosesAt string  `json:"bettingClosesAt"`
			OddsOver        float64 `json:"oddsOver"`
			OddsUnder       float64 `json:"oddsUnder"`
			Status          string  `json:"status"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		start, end, err := parseWindow(input.WindowStart, input.WindowEnd)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_window", err.Error())
			return
		}
		closes := start.Add(-minimumObservationLead)
		if input.BettingClosesAt != "" {
			closes, err = time.Parse(time.RFC3339, input.BettingClosesAt)
		}
		if err != nil || closes.After(start.Add(-minimumObservationLead)) {
			writeError(w, http.StatusBadRequest, "invalid_betting_close", "Betting must close at least 30 seconds before observation starts.")
			return
		}
		if input.StreamID <= 0 || strings.TrimSpace(input.Title) == "" || len(input.Title) > 200 || input.Threshold < 0 || input.Threshold > maxVehicleCount || !validOdds(input.OddsOver) || !validOdds(input.OddsUnder) {
			writeError(w, http.StatusBadRequest, "invalid_market", "Market fields are invalid.")
			return
		}
		status := input.Status
		if status == "" {
			status = MarketOpen
		}
		if status != MarketOpen && status != MarketDraft {
			writeError(w, http.StatusBadRequest, "invalid_market_status", "Market status is invalid.")
			return
		}
		if status == MarketOpen && !closes.After(time.Now()) {
			writeError(w, http.StatusBadRequest, "invalid_betting_close", "An open market must close in the future.")
			return
		}
		market, err := api.store.CreateMarket(r.Context(), Market{
			StreamID:        input.StreamID,
			Title:           strings.TrimSpace(input.Title),
			Threshold:       input.Threshold,
			WindowStart:     start,
			WindowEnd:       end,
			BettingClosesAt: closes,
			OddsOver:        input.OddsOver,
			OddsUnder:       input.OddsUnder,
			Status:          status,
		})
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, market)
	default:
		methodNotAllowed(w)
	}
}

func (api *API) handleAdminMarketByID(w http.ResponseWriter, r *http.Request) {
	trimmed := strings.TrimPrefix(r.URL.Path, "/api/admin/markets/")
	parts := strings.Split(strings.Trim(trimmed, "/"), "/")
	id, err := parseID(parts[0])
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_market_id", "Market id is invalid.")
		return
	}
	if len(parts) == 2 && parts[1] == "void" {
		if r.Method != http.MethodPatch {
			methodNotAllowed(w)
			return
		}
		var input struct {
			Reason string `json:"reason"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		market, err := api.store.VoidMarket(r.Context(), id, input.Reason)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, market)
		return
	}
	if len(parts) == 2 && parts[1] == "settle" {
		if r.Method != http.MethodPatch {
			methodNotAllowed(w)
			return
		}
		var input struct {
			ActualCount  *int                   `json:"actualCount"`
			Verification SettlementVerification `json:"verification"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		if input.ActualCount == nil || *input.ActualCount < 0 || *input.ActualCount > maxVehicleCount {
			writeError(w, http.StatusBadRequest, "invalid_actual_count", "Actual count must be a whole number from 0 to 100,000,000.")
			return
		}
		market, err := api.store.SettleMarket(r.Context(), id, *input.ActualCount, input.Verification)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, market)
		return
	}
	http.NotFound(w, r)
}

func (api *API) handleAdminBets(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	var marketID *int64
	if value := r.URL.Query().Get("marketId"); value != "" {
		parsed, err := parseID(value)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_market_id", "Market id is invalid.")
			return
		}
		marketID = &parsed
	}
	bets, err := api.store.ListAllBets(r.Context(), marketID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "bets_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, bets)
}

func (api *API) handleInternalStreamByID(w http.ResponseWriter, r *http.Request) {
	trimmed := strings.TrimPrefix(r.URL.Path, "/api/internal/streams/")
	parts := strings.Split(strings.Trim(trimmed, "/"), "/")
	if len(parts) != 2 || parts[1] != "metrics" {
		http.NotFound(w, r)
		return
	}
	streamID, err := parseID(parts[0])
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_stream_id", "Stream id is invalid.")
		return
	}
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var input struct {
		VehicleCount  *int   `json:"vehicleCount"`
		IntervalStart string `json:"intervalStart"`
		IntervalEnd   string `json:"intervalEnd"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	start, end, err := parseWindow(input.IntervalStart, input.IntervalEnd)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_interval", err.Error())
		return
	}
	if input.VehicleCount == nil || *input.VehicleCount < 0 || *input.VehicleCount > maxVehicleCount || end.After(time.Now()) {
		writeError(w, http.StatusBadRequest, "invalid_vehicle_count", "Vehicle count must be positive.")
		return
	}
	metric, err := api.store.CreateStreamMetric(r.Context(), StreamMetric{
		StreamID:      streamID,
		Source:        "ai",
		VehicleCount:  *input.VehicleCount,
		IntervalStart: start,
		IntervalEnd:   end,
	})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, metric)
}

func (api *API) readStreamInput(w http.ResponseWriter, r *http.Request, id int64) (Stream, bool) {
	var input Stream
	if !decodeJSON(w, r, &input) {
		return Stream{}, false
	}
	input.ID = id
	input.Title = strings.TrimSpace(input.Title)
	input.City = strings.TrimSpace(input.City)
	input.Country = strings.TrimSpace(input.Country)
	input.LocationLabel = strings.TrimSpace(input.LocationLabel)
	input.StreamType = strings.TrimSpace(input.StreamType)
	input.StreamURL = strings.TrimSpace(input.StreamURL)
	input.ThumbnailURL = strings.TrimSpace(input.ThumbnailURL)
	input.SourceOwner = strings.TrimSpace(input.SourceOwner)
	input.SourcePageURL = strings.TrimSpace(input.SourcePageURL)
	input.TermsURL = strings.TrimSpace(input.TermsURL)
	input.UsageNotes = strings.TrimSpace(input.UsageNotes)
	if input.Title == "" || input.City == "" || input.Country == "" || input.LocationLabel == "" || input.StreamURL == "" {
		writeError(w, http.StatusBadRequest, "invalid_stream", "Title, city, country, location and URL are required.")
		return Stream{}, false
	}
	if !validStreamType(input.StreamType) {
		writeError(w, http.StatusBadRequest, "invalid_stream_type", "Stream type is invalid.")
		return Stream{}, false
	}
	if err := validateStream(input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_stream", err.Error())
		return Stream{}, false
	}
	return input, true
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	defer r.Body.Close()
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "json_required", "Content-Type must be application/json.")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "body_too_large", "Request body is too large.")
		return false
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || trimmed[0] != '{' || !uniqueJSONKeys(trimmed) {
		writeError(w, http.StatusBadRequest, "invalid_json", "Request must be a JSON object without duplicate fields.")
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "Request body is invalid JSON.")
		return false
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeError(w, http.StatusBadRequest, "invalid_json", "Request body must contain one JSON value.")
		return false
	}
	return true
}

// encoding/json accepts duplicate fields by default; reject ambiguous bodies.
func uniqueJSONKeys(body []byte) bool {
	decoder := json.NewDecoder(bytes.NewReader(body))
	depth := 0
	var visit func() bool
	visit = func() bool {
		token, err := decoder.Token()
		if err != nil {
			return false
		}
		delim, ok := token.(json.Delim)
		if !ok {
			return true
		}
		depth++
		if depth > 64 {
			return false
		}
		defer func() { depth-- }()
		switch delim {
		case '{':
			seen := make(map[string]bool)
			for decoder.More() {
				key, err := decoder.Token()
				if err != nil {
					return false
				}
				name, ok := key.(string)
				name = foldJSONName(name)
				if !ok || seen[name] {
					return false
				}
				seen[name] = true
				if !visit() {
					return false
				}
			}
		case '[':
			for decoder.More() {
				if !visit() {
					return false
				}
			}
		default:
			return false
		}
		_, err = decoder.Token()
		return err == nil
	}
	if !visit() {
		return false
	}
	_, err := decoder.Token()
	return err == io.EOF
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func foldJSONName(name string) string {
	return strings.Map(func(char rune) rune {
		minimum := char
		for folded := unicode.SimpleFold(char); folded != char; folded = unicode.SimpleFold(folded) {
			if folded < minimum {
				minimum = folded
			}
		}
		return minimum
	}, name)
}

func publicStream(stream Stream) Stream {
	if !strings.HasPrefix(stream.StreamURL, "/media/") || validateStreamURL(stream.StreamURL) != nil {
		stream.StreamURL = ""
	}
	stream.ThumbnailURL = ""
	return stream
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	if status >= 500 {
		// Driver and upstream errors can include credentials, signed source URLs
		// or SQL values. Keep shared application logs safe as well as responses.
		log.Printf("request failed (status=%d code=%s)", status, code)
		message = "The server could not complete the request."
	}
	writeJSON(w, status, map[string]any{
		"error": map[string]string{
			"code":    code,
			"message": message,
		},
	})
}

func writeStoreError(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "Resource was not found.")
		return
	}
	if errors.Is(err, ErrConflict) {
		writeError(w, http.StatusConflict, "conflict", err.Error())
		return
	}
	if errors.Is(err, ErrInvalid) {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	writeError(w, http.StatusInternalServerError, "server_error", err.Error())
}

func methodNotAllowed(w http.ResponseWriter) {
	writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method is not allowed.")
}

func parseID(value string) (int64, error) {
	id, err := strconv.ParseInt(strings.Trim(value, "/"), 10, 64)
	if err != nil || id <= 0 {
		return 0, fmt.Errorf("invalid id")
	}
	return id, nil
}

func parseWindow(startValue, endValue string) (time.Time, time.Time, error) {
	start, err := time.Parse(time.RFC3339, startValue)
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("start must be RFC3339")
	}
	end, err := time.Parse(time.RFC3339, endValue)
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("end must be RFC3339")
	}
	if !end.After(start) {
		return time.Time{}, time.Time{}, fmt.Errorf("end must be after start")
	}
	return start, end, nil
}

func validStreamType(value string) bool {
	switch value {
	case StreamTypeHLS, StreamTypeYouTube, StreamTypeIFrame, StreamTypeRTSP, StreamTypeImage, StreamTypeMJPEG, StreamTypeMP4:
		return true
	default:
		return false
	}
}

func validMarketStatus(value string) bool {
	switch value {
	case MarketDraft, MarketOpen, MarketVoid:
		return true
	default:
		return false
	}
}

func validBetSide(value string) bool {
	return value == BetSideOver || value == BetSideUnder
}
