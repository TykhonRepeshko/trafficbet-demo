package app

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
)

type contextKey string

const userContextKey contextKey = "user"
const sessionCookieName = "trafficbet_session"
const sessionLifetime = 12 * time.Hour

var errUnauthorized = errors.New("unauthorized")

// Apply one creation policy to registration, administrator provisioning and
// optional development seeding. Login still verifies historical hashes directly.
func ValidPassword(password string) bool {
	return len(password) <= 72 && utf8.ValidString(password) &&
		utf8.RuneCountInString(password) >= 12 && strings.TrimSpace(password) != ""
}
func HashPassword(password string) (string, error) {
	if !ValidPassword(password) {
		return "", errors.New("password must contain at least 12 characters, at most 72 UTF-8 bytes and a non-whitespace character")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	return string(hash), err
}
func CheckPassword(hash, password string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}
func newSessionToken() (string, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw[:]), nil
}
func sessionHash(token string) []byte { hash := sha256.Sum256([]byte(token)); return hash[:] }
func sessionToken(r *http.Request) string {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil || len(cookie.Value) != 43 {
		return ""
	}
	if raw, err := base64.RawURLEncoding.DecodeString(cookie.Value); err != nil || len(raw) != 32 {
		return ""
	}
	return cookie.Value
}
func (api *API) setSessionCookie(w http.ResponseWriter, token string, expires time.Time) {
	maxAge := int(sessionLifetime.Seconds())
	if token == "" {
		maxAge = -1
		expires = time.Unix(1, 0)
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookieName, Value: token, Path: "/api", HttpOnly: true, Secure: api.cfg.CookieSecure, SameSite: http.SameSiteStrictMode, MaxAge: maxAge, Expires: expires})
}
func currentUser(ctx context.Context) (User, bool) {
	user, ok := ctx.Value(userContextKey).(User)
	return user, ok
}

type loginBucket struct {
	attempts int
	expires  time.Time
}
type loginLimiter struct {
	mu      sync.Mutex
	buckets map[string]loginBucket
}

func loginKeys(remoteAddr, email string) (string, string) {
	ip, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		ip = remoteAddr
	}
	return "peer:" + ip, "account:" + ip + "\x00" + strings.ToLower(strings.TrimSpace(email))
}
func (l *loginLimiter) allow(remoteAddr, email string, now time.Time) bool {
	return l.allowLimited(remoteAddr, email, now, 100, 10)
}

// Each operation has its own limiter so registration does not reset or consume
// login budgets. Ignore forwarding headers: only the trusted peer is used.
func (l *loginLimiter) allowLimited(remoteAddr, email string, now time.Time, peerLimit, accountLimit int) bool {
	peerKey, accountKey := loginKeys(remoteAddr, email)
	l.mu.Lock()
	defer l.mu.Unlock()
	for key, bucket := range l.buckets {
		if !now.Before(bucket.expires) {
			delete(l.buckets, key)
		}
	}
	peer, peerExists := l.buckets[peerKey]
	account, accountExists := l.buckets[accountKey]
	if (!peerExists || !accountExists) && len(l.buckets) >= 9998 {
		return false
	}
	if peer.attempts >= peerLimit || account.attempts >= accountLimit {
		return false
	}
	if !peerExists {
		peer.expires = now.Add(15 * time.Minute)
	}
	if !accountExists {
		account.expires = now.Add(15 * time.Minute)
	}
	peer.attempts++
	account.attempts++
	l.buckets[peerKey] = peer
	l.buckets[accountKey] = account
	return true
}

func (l *loginLimiter) success(remoteAddr, email string) {
	peerKey, accountKey := loginKeys(remoteAddr, email)
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.buckets, accountKey)
	if peer, ok := l.buckets[peerKey]; ok {
		peer.attempts--
		if peer.attempts <= 0 {
			delete(l.buckets, peerKey)
		} else {
			l.buckets[peerKey] = peer
		}
	}
}
