export type Role = 'admin' | 'user';
export type StreamType = 'hls' | 'mp4' | 'youtube' | 'iframe' | 'rtsp' | 'image' | 'mjpeg';
export type MarketStatus = 'draft' | 'open' | 'settled' | 'void';
export type BetSide = 'over' | 'under' | 'range';
export type BetStatus = 'pending' | 'won' | 'lost' | 'void';

export interface User {
  id: number;
  email: string;
  displayName: string;
  role: Role;
  balanceCredits: number;
  createdAt: string;
}

export interface UserPage {
  items: User[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface StakeAmounts {
  pendingRangeBetCount: number;
  pendingRangeCredits: number;
  totalBetCount: number;
  totalStakeCredits: number;
  pendingBetCount: number;
  pendingStakeCredits: number;
  pendingOverBetCount: number;
  pendingOverCredits: number;
  pendingUnderBetCount: number;
  pendingUnderCredits: number;
  settledStakeCredits: number;
  refundedStakeCredits: number;
}

export interface RoundStakeVolume extends StakeAmounts {
  marketId: number;
  title: string;
  status: MarketStatus;
  threshold: number;
  bettingClosesAt: string;
  windowStart: string;
  windowEnd: string;
}

export interface CameraStakeVolume extends StakeAmounts {
  streamId: number;
  title: string;
  city: string;
  isActive: boolean;
  rounds: RoundStakeVolume[];
}

export interface StakeVolumeSnapshot {
  asOf: string;
  totals: StakeAmounts;
  historicalTotals: StakeAmounts;
  cameras: CameraStakeVolume[];
}

export interface AdminStakeBet extends Bet {
  streamId: number;
  displayName: string;
  email: string;
}

export interface StakeBetPage {
  asOf: string;
  streamId: number;
  marketId?: number;
  status: BetStatus | 'all';
  items: AdminStakeBet[];
  total: number;
  stakeCredits: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface TrafficStream {
  countingGuide?: PublicCountingGuide;
  /** Why automatic counting paused this camera's rounds, e.g. no readable clock. */
  automationPause?: string;
  id: number;
  title: string;
  city: string;
  country: string;
  locationLabel: string;
  description: string;
  streamType: StreamType;
  streamUrl: string;
  thumbnailUrl: string;
  sourceOwner: string;
  sourcePageUrl: string;
  termsUrl: string;
  usageNotes: string;
  latitude?: number;
  longitude?: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type StreamPayload = Omit<TrafficStream, 'id' | 'createdAt' | 'updatedAt' | 'countingGuide'>;

export interface Market {
  id: number;
  streamId: number;
  streamTitle?: string;
  title: string;
  threshold: number;
  bettingClosesAt: string;
  windowStart: string;
  windowEnd: string;
  oddsOver: number;
  oddsUnder: number;
  status: MarketStatus;
  actualCount?: number;
  voidReason?: string;
  createdAt: string;
  updatedAt: string;
  countingRules?: CountingSnapshot;
}

export interface MarketPayload {
  streamId: number;
  title: string;
  threshold: number;
  bettingClosesAt: string;
  windowStart: string;
  windowEnd: string;
  oddsOver: number;
  oddsUnder: number;
  status: Exclude<MarketStatus, 'settled'>;
}

/** Live AI progress for a round (display only; settlement waits for the final verified result). */
export interface LiveCrossing { at: number; direction: string; class: string; }
export interface LiveSegment { seq: number; startUtc: number; duration: number; }
export interface LiveRound {
  marketId: number;
  streamId: number;
  status: MarketStatus;
  threshold: number;
  windowStart: string;
  windowEnd: string;
  actualCount?: number;
  voidReason?: string;
  live: { vehicleCount: number; crossings: LiveCrossing[]; segments: LiveSegment[]; processedUntil: number; updatedAt: string } | null;
}

export interface RangeQuote {
  marketId: number;
  rangeMin: number;
  rangeMax: number;
  odds: number;
  pricingModel: string;
}

export interface SettlementVerification {
  captureTimeVerified: boolean;
  coverageVerified: boolean;
  framingVerified: boolean;
  evidenceNote: string;
}

export interface Bet {
  rangeMin?: number;
  rangeMax?: number;
  rangeOdds?: number;
  pricingModel?: string;
  id: number;
  userId: number;
  marketId: number;
  marketTitle?: string;
  streamTitle?: string;
  side: BetSide;
  stakeCredits: number;
  potentialPayoutCredits: number;
  status: BetStatus;
  createdAt: string;
  settledAt?: string;
  actualCount?: number;
  voidReason?: string;
}

export interface StreamMetric {
  id: number;
  streamId: number;
  source: 'manual' | 'ai';
  vehicleCount: number;
  intervalStart: string;
  intervalEnd: string;
  createdAt: string;
}

export interface LoginResponse {
  user: User;
}

export interface CreditLedgerEntry {
  id: number;
  betId?: number;
  marketId?: number;
  reason: 'opening' | 'stake' | 'payout' | 'refund';
  deltaCredits: number;
  balanceAfter: number;
  createdAt: string;
}
export interface RoundScheduleSettings {
  enabled: boolean;
  countingRule: string;
  threshold: number;
  oddsOver: number;
  oddsUnder: number;
  entrySeconds: number;
  leadSeconds: number;
  countingSeconds: number;
}
export interface RoundSchedule extends RoundScheduleSettings {
  streamId: number;
  streamTitle: string;
  isActive: boolean;
  supported: boolean;
  nextRunAt: string | null;
  lastCheckedAt: string | null;
  lastMarketId: number | null;
  awaitingVerification: number;
}
export interface RoundScheduleSnapshot { asOf: string; schedules: RoundSchedule[]; }

export interface CountingDefinition {
  label: string; lineStart: { x: number; y: number }; lineEnd: { x: number; y: number };
  directions: string[]; classes: string[]; anchor: string; timeBasis: string; notes: string;
}
export interface PublicCountingGuide { profileId: number; version: number; approved: boolean; sourceFingerprint: string; width: number; height: number; definition: CountingDefinition; }
export interface CountingReference { id: number; streamId: number; sourceFingerprint: string; imageSha256: string; width: number; height: number; createdAt: string; }
export interface CountingProfile { id: number; streamId: number; version: number; referenceId: number; sourceFingerprint: string; definition: CountingDefinition; createdAt: string; approved: boolean; sourceMatches: boolean; }
export interface CountingSnapshot { mode: string; profileId?: number; version?: number; referenceId?: number; sourceFingerprint?: string; definition?: CountingDefinition; publishedTitle: string; intervalConvention: string; }
export interface CountingPreparation { streamId: number; sourceFingerprint: string; profiles: CountingProfile[]; references: CountingReference[]; }
export interface SourceObservation { id: number; streamId: number; sourceFingerprint: string; observedAt: string; report: { kind: string; status: string; issues: string[]; firstSequence?: number; lastSequence?: number; lastAdvanceAt?: string; fetchedSegments: number; missingSequences: number; replayedSegments: number; discontinuity: boolean; programDateTime?: string; captureTimeTrusted: boolean; fullCoverageProven: boolean; framesDecoded: boolean; framingVerified: boolean; }; }
export interface SourceHealth { asOf: string; observerEnabled: boolean; cameras: { streamId: number; title: string; isActive: boolean; sourceFingerprint: string; profileId?: number; observation?: SourceObservation; }[]; }
export interface RoundReview { id: number; marketId: number; outcome: 'needs_review' | 'verified' | 'invalid'; proposedCount?: number; verification: SettlementVerification; evidenceNote: string; evidenceId?: number; createdBy: number; createdAt: string; }
export interface ReviewDetail { market: Market; snapshot: CountingSnapshot; reviews: RoundReview[]; observations: SourceObservation[]; }
export interface ReviewQueueItem { id: number; streamId: number; streamTitle: string; title: string; windowStart: string; windowEnd: string; countingRules: CountingSnapshot; reviewOutcome: string; }
export interface AuditItem { id: number; actorUserId?: number; action: string; resourceType: string; resourceId?: number; createdAt: string; }
export interface CursorPage<T> { items: T[]; hasMore: boolean; }
