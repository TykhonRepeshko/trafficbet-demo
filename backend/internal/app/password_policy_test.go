package app

import (
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func TestPasswordCreationPolicy(t *testing.T) {
	for _, tc := range []struct {
		name, password string
		valid          bool
	}{
		{"ASCII minimum", "twelve-chars", true},
		{"Unicode minimum", strings.Repeat("я", 12), true},
		{"bcrypt byte maximum", strings.Repeat("я", 36), true},
		{"spaces in passphrase", "twelve words are allowed", true},
		{"short ASCII", "short", false},
		{"short Unicode with 12 bytes", strings.Repeat("я", 6), false},
		{"three emoji with 12 bytes", strings.Repeat("🚗", 3), false},
		{"bcrypt byte overflow", strings.Repeat("я", 37), false},
		{"ASCII whitespace only", strings.Repeat(" ", 12), false},
		{"Unicode whitespace only", strings.Repeat("\u2003", 12), false},
		{"invalid UTF-8", "twelve-characters-" + string([]byte{0xff}), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := ValidPassword(tc.password); got != tc.valid {
				t.Fatalf("creation policy accepted=%v, expected=%v", got, tc.valid)
			}
			if !tc.valid {
				if hash, err := HashPassword(tc.password); err == nil || hash != "" {
					t.Fatal("rejected password could still be provisioned")
				}
			}
		})
	}
	password := "twelve words are allowed"
	hash, err := HashPassword(password)
	if err != nil || !CheckPassword(hash, password) || CheckPassword(hash, password+"different") {
		t.Fatal("valid passphrase hashing or verification failed")
	}
}

func TestHistoricalPasswordLoginCompatibility(t *testing.T) {
	// Tightening creation must not lock out an account that was provisioned by
	// an older CLI. Existing bcrypt verification remains independent of policy.
	legacy := strings.Repeat(" ", 12)
	hash, err := bcrypt.GenerateFromPassword([]byte(legacy), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	if ValidPassword(legacy) || !CheckPassword(string(hash), legacy) {
		t.Fatal("creation policy and historical login verification were conflated")
	}
}
