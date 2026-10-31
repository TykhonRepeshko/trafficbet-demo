package app

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

const settlementVerificationPolicy = "manual-capture-coverage-framing-v1"

func normalizeSettlementVerification(verification SettlementVerification) (SettlementVerification, error) {
	if !verification.CaptureTimeVerified || !verification.CoverageVerified || !verification.FramingVerified {
		return SettlementVerification{}, fmt.Errorf("%w: verify capture timestamps, complete interval coverage and an unchanged visible counting zone; otherwise void and refund the round", ErrInvalid)
	}
	// Check the original value before trimming so leading/trailing control
	// characters cannot be silently removed from an evidence note.
	if !utf8.ValidString(verification.EvidenceNote) || strings.IndexFunc(verification.EvidenceNote, unicode.IsControl) >= 0 {
		return SettlementVerification{}, fmt.Errorf("%w: evidence note must contain 20 to 2000 characters without control characters", ErrInvalid)
	}
	verification.EvidenceNote = strings.TrimSpace(verification.EvidenceNote)
	length := utf8.RuneCountInString(verification.EvidenceNote)
	if length < 20 || length > 2000 {
		return SettlementVerification{}, fmt.Errorf("%w: evidence note must contain 20 to 2000 characters without control characters", ErrInvalid)
	}
	return verification, nil
}
