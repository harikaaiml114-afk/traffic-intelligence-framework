/**
 * Core type definitions for the Traffic Intelligence Framework.
 *
 * Design rationale: We model the domain around three key entities:
 * 1. Vendors (traffic sources we purchase from)
 * 2. Campaigns (client work being fulfilled)
 * 3. Experiments (randomized tests to evaluate vendor quality)
 *
 * Since we cannot observe landing page conversions, we define
 * "engagement proxy" signals derived from what we CAN observe:
 * click-level metadata captured at our redirect/tracking layer.
 */

// ---------------------------------------------------------------------------
// Vendor & Campaign Models
// ---------------------------------------------------------------------------

export interface Vendor {
  id: string;
  name: string;
  active: boolean;
  createdAt: Date;
  metadata: Record<string, string>;
}

export interface Campaign {
  id: string;
  name: string;
  agencyId: string;
  vertical: 'automotive' | 'other';
  targetGeos: string[];
  dailyBudget: number;
  active: boolean;
  startDate: Date;
  endDate: Date;
}

// ---------------------------------------------------------------------------
// Traffic Event — the atomic unit of data we collect
// ---------------------------------------------------------------------------

export interface TrafficEvent {
  id: string;
  vendorId: string;
  campaignId: string;
  timestamp: Date;
  experimentId?: string;

  ip: string;
  userAgent: string;
  deviceType: 'desktop' | 'mobile' | 'tablet' | 'unknown';
  geo: GeoInfo;
  referrer: string;

  /** Milliseconds between click and our redirect completing */
  redirectLatencyMs: number;
  /** Whether this click came via a known bot user-agent */
  knownBotSignature: boolean;
  /** Has this IP been seen before in recent window */
  repeatIp: boolean;
  /** Seconds since last click from same IP */
  timeSinceLastClickFromIp: number | null;
}

export interface GeoInfo {
  country: string;
  region: string;
  city: string;
  zipCode: string;
}

// ---------------------------------------------------------------------------
// Quality Signals — derived from raw TrafficEvents
// ---------------------------------------------------------------------------

export interface QualitySignals {
  vendorId: string;
  campaignId: string;
  windowStart: Date;
  windowEnd: Date;
  totalClicks: number;

  /** Fraction of clicks flagged as likely non-human */
  botRate: number;
  /** Fraction of clicks from repeat IPs within short window */
  ipConcentrationRate: number;
  /** Unique IPs / total clicks — low diversity = suspicious */
  ipDiversityRatio: number;
  /** Fraction of clicks from target geography */
  geoMatchRate: number;
  /** Distribution entropy of click timing (uniform = suspicious) */
  temporalEntropy: number;
  /** Distribution entropy of device types */
  deviceDiversityScore: number;
  /** Average redirect latency — extremely fast = suspicious */
  avgRedirectLatencyMs: number;
  /** Fraction of clicks with redirect latency < 100ms (bot-like) */
  suspiciouslyFastRate: number;
  /** Coefficient of variation in inter-click intervals */
  clickTimingVariance: number;
}

// ---------------------------------------------------------------------------
// Vendor Scoring
// ---------------------------------------------------------------------------

export interface VendorScore {
  vendorId: string;
  timestamp: Date;

  engagementScore: number;   // 0-100
  fraudRiskScore: number;    // 0-100 (higher = riskier)
  consistencyScore: number;  // 0-100
  compositeScore: number;    // 0-100

  confidence: number;        // 0-1 (how much data backs this)
  sampleSize: number;

  /** Bayesian beta distribution parameters for quality */
  alpha: number;
  beta: number;

  breakdown: ScoreBreakdown;
}

export interface ScoreBreakdown {
  geoRelevance: number;
  deviceDistribution: number;
  temporalPattern: number;
  ipQuality: number;
  latencyProfile: number;
  botRisk: number;
}

// ---------------------------------------------------------------------------
// Experiment Engine
// ---------------------------------------------------------------------------

export type ExperimentStatus = 'scheduled' | 'running' | 'completed' | 'stopped';

export interface Experiment {
  id: string;
  name: string;
  campaignId: string;
  status: ExperimentStatus;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;

  vendorIds: string[];
  /** Fraction of total campaign traffic allocated to this experiment */
  trafficAllocationPercent: number;
  /** Minimum clicks per vendor before results are evaluated */
  minSampleSize: number;
  /** p-value threshold for statistical significance */
  significanceLevel: number;

  results: Map<string, ExperimentResult>;
}

export interface ExperimentResult {
  vendorId: string;
  clicks: number;
  qualitySignals: QualitySignals | null;
  engagementScore: number;
  fraudRiskScore: number;
  isSignificant: boolean;
  pValue: number | null;
  confidenceInterval: [number, number] | null;
}

export interface ExperimentConfig {
  campaignId: string;
  vendorIds: string[];
  name?: string;
  trafficAllocationPercent?: number;
  minSampleSize?: number;
  significanceLevel?: number;
}

// ---------------------------------------------------------------------------
// Traffic Distribution — multi-armed bandit allocation
// ---------------------------------------------------------------------------

export interface AllocationWeights {
  vendorId: string;
  weight: number;
  /** Exploration bonus from Thompson Sampling */
  explorationBonus: number;
}

// ---------------------------------------------------------------------------
// Budget Recommendations
// ---------------------------------------------------------------------------

export type RecommendationAction = 'increase' | 'maintain' | 'decrease' | 'pause' | 'review';

export interface BudgetRecommendation {
  vendorId: string;
  campaignId: string;
  timestamp: Date;
  action: RecommendationAction;
  currentAllocationPercent: number;
  recommendedAllocationPercent: number;
  reason: string;
  confidence: number;
  compositeScore: number;
}

export interface AllocationPlan {
  campaignId: string;
  timestamp: Date;
  allocations: BudgetRecommendation[];
  totalBudget: number;
  topTierVendorIds: string[];
  flaggedVendorIds: string[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Statistical helpers
// ---------------------------------------------------------------------------

export interface StatisticalTest {
  testName: string;
  statistic: number;
  pValue: number;
  significant: boolean;
  effectSize: number;
  confidenceInterval: [number, number];
}

// ---------------------------------------------------------------------------
// API DTOs
// ---------------------------------------------------------------------------

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: Date;
}
