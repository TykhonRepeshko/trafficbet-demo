package app

import (
	"fmt"
	"math"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const maxStakeCredits int64 = 100000
const maxVehicleCount = 100000000
const maxOdds = 100.0
const minimumObservationLead = 30 * time.Second

func validObservationLead(market Market) bool {
	return !market.BettingClosesAt.IsZero() && !market.BettingClosesAt.After(market.WindowStart.Add(-minimumObservationLead))
}

func validVoidReason(reason string) bool {
	length := utf8.RuneCountInString(reason)
	return utf8.ValidString(reason) && length >= 5 && length <= 500 && strings.IndexFunc(reason, unicode.IsControl) < 0
}

func supportsLivePredictions(streamType string) bool {
	return streamType == StreamTypeHLS || streamType == StreamTypeYouTube || streamType == StreamTypeMJPEG
}

func validIdempotencyKey(key string) bool {
	if len(key) < 16 || len(key) > 128 {
		return false
	}
	for _, char := range key {
		if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '-' || char == '_' || char == '.') {
			return false
		}
	}
	return true
}

func validOdds(odds float64) bool {
	return !math.IsNaN(odds) && !math.IsInf(odds, 0) && odds >= 1 && odds <= maxOdds && math.Abs(odds*100-math.Round(odds*100)) < 0.000001
}
func payoutCredits(stake int64, odds float64) (int64, error) {
	if stake < 1 || stake > maxStakeCredits || !validOdds(odds) {
		return 0, fmt.Errorf("%w: stake or odds is outside permitted limits", ErrInvalid)
	}
	// Both factors are bounded; integer hundredths avoid floating-point payout drift.
	return (stake*int64(math.Round(odds*100)) + 50) / 100, nil
}
func checkBettingOpen(market Market, now time.Time) error {
	if !validObservationLead(market) {
		return fmt.Errorf("%w: betting must close at least 30 seconds before observation starts", ErrConflict)
	}
	if market.Status != MarketOpen {
		return fmt.Errorf("%w: market is not open", ErrConflict)
	}
	if !now.Before(market.BettingClosesAt) {
		return fmt.Errorf("%w: betting is closed", ErrConflict)
	}
	return nil
}
func checkSettlementAllowed(market Market, actualCount int, now time.Time) error {
	if actualCount < 0 || actualCount > maxVehicleCount {
		return fmt.Errorf("%w: actual count is outside permitted limits", ErrInvalid)
	}
	if market.Status != MarketOpen {
		return fmt.Errorf("%w: only an open market can be settled", ErrConflict)
	}
	if now.Before(market.WindowEnd) {
		return fmt.Errorf("%w: observation window has not ended", ErrConflict)
	}
	return nil
}
func validatePublicURL(value string, required bool) error {
	if value == "" && !required {
		return nil
	}
	if len(value) > 2048 {
		return fmt.Errorf("URL is too long")
	}
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Opaque != "" || u.Fragment != "" {
		return fmt.Errorf("URLs must use HTTPS and contain no credentials or fragment")
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if net.ParseIP(host) != nil {
		return fmt.Errorf("URL must use an approved public DNS hostname, not an IP address")
	}
	if !strings.Contains(host, ".") || strings.ContainsAny(host, "\\ %\t\r\n") {
		return fmt.Errorf("URL must use a public DNS hostname")
	}
	lastLabel := host[strings.LastIndex(host, ".")+1:]
	if _, err := strconv.ParseUint(lastLabel, 0, 64); err == nil {
		return fmt.Errorf("numeric IP address aliases are not allowed")
	}
	for _, suffix := range []string{".localhost", ".local", ".internal", ".lan", ".home", ".test", ".invalid"} {
		if strings.HasSuffix(host, suffix) {
			return fmt.Errorf("private or reserved hostname is not allowed")
		}
	}
	if port := u.Port(); port != "" && port != "443" {
		return fmt.Errorf("only the HTTPS default port is allowed")
	}
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return fmt.Errorf("URL hostname is invalid")
		}
		for _, char := range label {
			if !(char >= 'a' && char <= 'z' || char >= '0' && char <= '9' || char == '-') {
				return fmt.Errorf("URL hostname is invalid")
			}
		}
	}
	return nil
}
func validateStream(stream Stream) error {
	for _, value := range []string{stream.Title, stream.City, stream.Country, stream.LocationLabel, stream.SourceOwner} {
		if len(value) > 200 {
			return fmt.Errorf("stream labels cannot exceed 200 bytes")
		}
	}
	if len(stream.Description) > 4000 || len(stream.UsageNotes) > 4000 {
		return fmt.Errorf("description and usage notes cannot exceed 4000 bytes")
	}
	if stream.Latitude != nil && (math.IsNaN(*stream.Latitude) || math.IsInf(*stream.Latitude, 0) || *stream.Latitude < -90 || *stream.Latitude > 90) {
		return fmt.Errorf("latitude is invalid")
	}
	if stream.Longitude != nil && (math.IsNaN(*stream.Longitude) || math.IsInf(*stream.Longitude, 0) || *stream.Longitude < -180 || *stream.Longitude > 180) {
		return fmt.Errorf("longitude is invalid")
	}
	if err := validateStreamURL(stream.StreamURL); err != nil {
		return err
	}
	for _, value := range []string{stream.ThumbnailURL, stream.SourcePageURL, stream.TermsURL} {
		if err := validatePublicURL(value, false); err != nil {
			return err
		}
	}
	return nil
}

func validateStreamURL(value string) error {
	if strings.HasPrefix(value, "/media/") {
		u, err := url.Parse(value)
		if err != nil || u.Host != "" || u.RawQuery != "" || u.Fragment != "" || u.RawPath != "" || len(value) > 2048 {
			return fmt.Errorf("media path is invalid")
		}
		for _, segment := range strings.Split(strings.TrimPrefix(value, "/media/"), "/") {
			if segment == "" || segment == "." || segment == ".." {
				return fmt.Errorf("media path is invalid")
			}
			for _, char := range segment {
				if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '.' || char == '-' || char == '_') {
					return fmt.Errorf("media path is invalid")
				}
			}
		}
		return nil
	}
	return validatePublicURL(value, true)
}
