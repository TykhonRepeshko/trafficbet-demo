package app

import "time"

const (
	RoleAdmin = "admin"
	RoleUser  = "user"

	StreamTypeHLS     = "hls"
	StreamTypeYouTube = "youtube"
	StreamTypeIFrame  = "iframe"
	StreamTypeRTSP    = "rtsp"
	StreamTypeImage   = "image"
	StreamTypeMJPEG   = "mjpeg"
	StreamTypeMP4     = "mp4"

	MarketDraft   = "draft"
	MarketOpen    = "open"
	MarketSettled = "settled"
	MarketVoid    = "void"

	BetPending = "pending"
	BetWon     = "won"
	BetLost    = "lost"
	BetVoid    = "void"

	BetSideOver  = "over"
	BetSideUnder = "under"
	BetSideRange = "range"
)

type User struct {
	ID             int64     `json:"id"`
	Email          string    `json:"email"`
	DisplayName    string    `json:"displayName"`
	Role           string    `json:"role"`
	BalanceCredits int64     `json:"balanceCredits"`
	CreatedAt      time.Time `json:"createdAt"`
}

type Stream struct {
	CountingGuide *PublicCountingGuide `json:"countingGuide,omitempty"`
	// Why automation paused this camera's rounds (no readable clock, no line yet).
	AutomationPause string    `json:"automationPause,omitempty"`
	ID              int64     `json:"id"`
	Title           string    `json:"title"`
	City            string    `json:"city"`
	Country         string    `json:"country"`
	LocationLabel   string    `json:"locationLabel"`
	Description     string    `json:"description"`
	StreamType      string    `json:"streamType"`
	StreamURL       string    `json:"streamUrl"`
	ThumbnailURL    string    `json:"thumbnailUrl"`
	SourceOwner     string    `json:"sourceOwner"`
	SourcePageURL   string    `json:"sourcePageUrl"`
	TermsURL        string    `json:"termsUrl"`
	UsageNotes      string    `json:"usageNotes"`
	Latitude        *float64  `json:"latitude,omitempty"`
	Longitude       *float64  `json:"longitude,omitempty"`
	IsActive        bool      `json:"isActive"`
	CreatedAt       time.Time `json:"createdAt"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

type Market struct {
	CountingRules   *CountingSnapshot `json:"countingRules,omitempty"`
	ID              int64             `json:"id"`
	StreamID        int64             `json:"streamId"`
	StreamTitle     string            `json:"streamTitle,omitempty"`
	Title           string            `json:"title"`
	Threshold       int               `json:"threshold"`
	WindowStart     time.Time         `json:"windowStart"`
	WindowEnd       time.Time         `json:"windowEnd"`
	BettingClosesAt time.Time         `json:"bettingClosesAt"`
	OddsOver        float64           `json:"oddsOver"`
	OddsUnder       float64           `json:"oddsUnder"`
	Status          string            `json:"status"`
	ActualCount     *int              `json:"actualCount,omitempty"`
	VoidReason      string            `json:"voidReason,omitempty"`
	CreatedAt       time.Time         `json:"createdAt"`
	UpdatedAt       time.Time         `json:"updatedAt"`
}

// SettlementVerification records the operator's review of the complete capture
// interval. These assertions are required for manual settlement, not inferred
// from player health or treated as automatic evidence analysis.
type SettlementVerification struct {
	CaptureTimeVerified bool   `json:"captureTimeVerified"`
	CoverageVerified    bool   `json:"coverageVerified"`
	FramingVerified     bool   `json:"framingVerified"`
	EvidenceNote        string `json:"evidenceNote"`
}

type Bet struct {
	RangeMin               *int       `json:"rangeMin,omitempty"`
	RangeMax               *int       `json:"rangeMax,omitempty"`
	RangeOdds              *float64   `json:"rangeOdds,omitempty"`
	PricingModel           *string    `json:"pricingModel,omitempty"`
	ID                     int64      `json:"id"`
	UserID                 int64      `json:"userId"`
	MarketID               int64      `json:"marketId"`
	MarketTitle            string     `json:"marketTitle,omitempty"`
	StreamTitle            string     `json:"streamTitle,omitempty"`
	Side                   string     `json:"side"`
	StakeCredits           int64      `json:"stakeCredits"`
	PotentialPayoutCredits int64      `json:"potentialPayoutCredits"`
	Status                 string     `json:"status"`
	CreatedAt              time.Time  `json:"createdAt"`
	SettledAt              *time.Time `json:"settledAt,omitempty"`
	ActualCount            *int       `json:"actualCount,omitempty"`
	VoidReason             string     `json:"voidReason,omitempty"`
}

type StreamMetric struct {
	ID            int64     `json:"id"`
	StreamID      int64     `json:"streamId"`
	Source        string    `json:"source"`
	VehicleCount  int       `json:"vehicleCount"`
	IntervalStart time.Time `json:"intervalStart"`
	IntervalEnd   time.Time `json:"intervalEnd"`
	CreatedAt     time.Time `json:"createdAt"`
}
