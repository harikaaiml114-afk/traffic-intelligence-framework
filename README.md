# Traffic Intelligence Framework

An automated, continuously operating system for assessing traffic quality from third-party vendors, identifying high-performing sources, and providing data-driven budget allocation recommendations for digital media campaign fulfillment.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Architecture Overview](#architecture-overview)
- [Key Design Decisions](#key-design-decisions)
- [Module Breakdown](#module-breakdown)
- [How It Works End-to-End](#how-it-works-end-to-end)
- [Getting Started](#getting-started)
- [API Reference](#api-reference)
- [Assumptions](#assumptions)
- [Trade-offs & Future Work](#trade-offs--future-work)

---

## Problem Statement

A digital media company purchases traffic from third-party vendors and routes it to client landing pages (automotive VDPs). The company:

- **Cannot access** landing pages or observe post-click behavior
- **Cannot see** conversion data (form fills)
- **Must evaluate** vendor traffic quality despite these constraints
- **Must handle** vendors who change behavior dynamically
- **Must not disrupt** live campaigns during evaluation

The framework solves this by deriving quality signals from what *can* be observed at the traffic routing layer, and using statistical methods to continuously assess and rank vendors.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Traffic Intelligence Framework                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │   Tracking    │───▶│   Scoring     │───▶│  Recommendation  │  │
│  │    Layer      │    │    Layer      │    │     Layer        │  │
│  ├──────────────┤    ├──────────────┤    ├──────────────────┤  │
│  │ Signal       │    │ FraudDetector│    │ BudgetAllocator  │  │
│  │ Collector    │    │ Engagement   │    │ Action Items     │  │
│  │              │    │ Proxy        │    │ Allocation Plans │  │
│  │              │    │ VendorScorer │    │                  │  │
│  └──────────────┘    └──────────────┘    └──────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    Experiment Engine                       │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐ │  │
│  │  │  Scheduling  │  │  Traffic      │  │  Statistical    │ │  │
│  │  │  & Lifecycle │  │  Distribution │  │  Analysis       │ │  │
│  │  └─────────────┘  └──────────────┘  └─────────────────┘ │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Data Store (pluggable — in-memory for demo, DB-ready)   │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Key Design Decisions

### 1. Engagement Proxy Scoring (solving the "no conversion data" constraint)

Since we cannot observe landing page behavior or form submissions, we need proxy metrics that correlate with genuine engagement. The framework derives five dimensions from click-level data captured at our redirect layer:

| Dimension | What it measures | Why it matters |
|-----------|-----------------|----------------|
| **Geographic relevance** | % of clicks from target market area | Out-of-geo traffic for local dealerships has near-zero conversion potential |
| **Device profile** | Distribution of mobile/desktop/tablet | Automotive shoppers are ~60% mobile; pure-desktop traffic is suspicious |
| **Behavioral authenticity** | Temporal entropy + click timing variance | Humans click irregularly; bots follow clockwork patterns |
| **IP quality** | IP diversity ratio + concentration rate | Diverse, non-repeating residential IPs indicate genuine consumers |
| **Latency profile** | Average redirect latency + fast-click rate | Real users on real devices have measurable network latency |

### 2. Bayesian Vendor Scoring (handling uncertainty and change)

Each vendor's quality is modeled as a **Beta distribution**. This handles two critical challenges:

- **Small sample uncertainty**: New vendors start with a weak prior (Beta(2,2)). The posterior naturally widens with less data, preventing premature conclusions.
- **Behavioral change detection**: A **decay factor (0.95)** down-weights historical observations, so if a vendor's quality drops (as warned in the brief), the model adapts within a few scoring cycles.

The composite score weighs engagement (50%), inverse fraud risk (30%), and consistency (20%).

### 3. Thompson Sampling for Traffic Allocation (explore vs. exploit)

Traffic allocation uses **Thompson Sampling**, a multi-armed bandit algorithm that:

- **Explores** uncertain vendors (samples from wide posteriors can be high)
- **Exploits** known good vendors (narrow posteriors centered on high quality get selected often)
- **Adapts automatically** as vendor quality changes
- Is **provably near-optimal** for minimizing cumulative regret

This means we don't need manual threshold tuning — the algorithm naturally balances testing and performance.

### 4. Non-Disruptive Experiment Design

Experiments divert only a configurable fraction of traffic (default 10%), leaving the remaining 90% untouched. This directly addresses the constraint: *"must avoid disrupting live campaigns."*

Experiments also use **sequential testing** — results are evaluated after each batch, and experiments complete early when statistical significance is reached. This minimizes the budget spent on testing.

### 5. TypeScript with Strict Mode

TypeScript was chosen over JavaScript for:
- **Type safety** for complex domain models (vendors, experiments, scores, signals)
- **Self-documenting interfaces** that serve as the system specification
- **Refactoring confidence** — critical for a system that will evolve
- **Better tooling** — IDE autocomplete and error detection during development

---

## Module Breakdown

### `src/types.ts`
All TypeScript interfaces and types. The single source of truth for the domain model.

### `src/tracking/SignalCollector.ts`
Processes raw `TrafficEvent` records and computes aggregate `QualitySignals` per vendor per campaign per time window. This is the translation layer between raw click data and quality indicators.

### `src/scoring/FraudDetector.ts`
Evaluates traffic for non-human activity using six weighted heuristics: bot signatures, fast clicks, IP concentration, IP diversity, temporal uniformity, and click timing regularity. Produces a 0-100 fraud risk score.

### `src/scoring/EngagementProxy.ts`
Computes a proxy engagement score (0-100) from five dimensions that approximate the likelihood of genuine landing page engagement, despite having no access to the landing page itself.

### `src/scoring/VendorScorer.ts`
Maintains the Bayesian quality model. Combines engagement proxy, fraud risk, and consistency into a composite score. Supports ranking, top-tier identification, and score history tracking.

### `src/engine/ExperimentEngine.ts`
The core experiment module. Creates, schedules, runs, and evaluates randomized traffic tests. Supports manual and auto-scheduling. Uses z-tests to determine statistical significance.

### `src/engine/TrafficDistributor.ts`
Implements Thompson Sampling for traffic allocation. Computes allocation weights, selects vendors for individual clicks, and supports both stochastic (live routing) and deterministic (recommendation) modes.

### `src/recommendation/BudgetAllocator.ts`
Generates actionable output for the media buying team: allocation plans with clear actions (increase/maintain/decrease/pause/review), priority-sorted action items, and human-readable summaries.

### `src/store/DataStore.ts`
In-memory data store with a clean interface boundary. Designed to be swappable with a real database (TimescaleDB for events, PostgreSQL for metadata).

### `src/api/server.ts`
Express REST API with endpoints for vendor management, experiment lifecycle, allocation computation, and budget recommendations.

### `src/simulation/Simulator.ts`
Generates realistic traffic data with 10 vendors across five quality tiers (premium, good, average, suspect, fraud) for demonstration and testing.

### `src/utils/statistics.ts`
Self-contained statistical utilities: normal CDF, z-tests, Wilson intervals, Shannon entropy, Beta distribution sampling, and more. No heavy external dependencies.

---

## How It Works End-to-End

```
1. COLLECT     Raw TrafficEvents arrive at the redirect layer
                (IP, user agent, device, geo, latency, timing)
                        │
2. ANALYZE     SignalCollector aggregates events into QualitySignals
                per vendor per campaign per time window
                        │
3. DETECT      FraudDetector evaluates signals for non-human patterns
                EngagementProxy computes engagement likelihood
                        │
4. SCORE       VendorScorer updates Bayesian posteriors
                Produces composite score (0-100) with confidence
                        │
5. EXPERIMENT  ExperimentEngine runs randomized A/B tests
                Statistical significance determines winners
                        │
6. ALLOCATE    TrafficDistributor uses Thompson Sampling
                to route traffic optimally across vendors
                        │
7. RECOMMEND   BudgetAllocator generates allocation plans
                with clear actions and reasons for each vendor
                        │
8. OUTPUT      Media buying team receives:
                • Ranked vendor list with scores
                • Top 20% vendor identification
                • Budget allocation recommendations
                • Priority action items with reasons
```

---

## Getting Started

### Prerequisites
- Node.js 18+
- npm 9+

### Install

```bash
npm install
```

### Run the Demo

See the complete framework in action with simulated data:

```bash
npm run demo
```

This generates 10 vendors with varying quality profiles, runs the full scoring pipeline, executes an experiment, and produces budget recommendations.

### Start the Server + Dashboard

```bash
npm start
```

This starts the Express server on `http://localhost:3000` with demo data preloaded.

- **Dashboard**: [http://localhost:3000/dashboard](http://localhost:3000/dashboard)
- **API**: [http://localhost:3000/health](http://localhost:3000/health)

The dashboard provides a visual interface with 7 sections:

| Section | What it shows |
|---------|---------------|
| **Overview** | Key metrics, quality distribution chart, fraud radar, action items |
| **Vendor Rankings** | Bar chart + detailed table of all vendors ranked by composite score |
| **Fraud Detection** | Risk breakdown by vendor, detection heuristic explanations |
| **Experiments** | Active/completed experiments with statistical results |
| **Budget Allocation** | Recommended vs current allocation, action-tagged vendor table |
| **Data Pipeline** | Visual flow from data collection → scoring → recommendations |
| **Event Handling** | Edge cases, failure modes, scaling strategy, TrafficEvent schema |

### Run Tests

```bash
npm test
```

57 tests covering statistics, scoring, experiments, and recommendations.

### Build

```bash
npm run build
```

---

## API Reference

### Health
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | System health and stats |

### Vendors
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/vendors` | List all vendors |
| GET | `/vendors/:id` | Get vendor details |
| POST | `/vendors` | Create vendor `{ name, metadata }` |
| GET | `/vendors/:id/score` | Latest quality score |
| GET | `/vendors/:id/score/history` | Score history |
| GET | `/vendors/ranking/all` | All vendors ranked by quality |
| GET | `/vendors/top-tier/all` | Top 20% vendors |

### Experiments
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/experiments` | Create experiment `{ campaignId, vendorIds }` |
| POST | `/experiments/:id/start` | Start a scheduled experiment |
| POST | `/experiments/:id/stop` | Stop a running experiment |
| GET | `/experiments/:id/results` | Get results with statistical analysis |
| GET | `/experiments` | List all experiments |
| POST | `/experiments/auto-schedule` | Auto-schedule vendor comparisons |

### Allocations
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/allocations/compute` | Compute Thompson Sampling weights |
| POST | `/allocations/select-vendor` | Select vendor for next click |

### Recommendations
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/recommendations/plan` | Generate full allocation plan |
| POST | `/recommendations/action-items` | Get priority action items |

---

## Assumptions

1. **Redirect/tracking layer exists**: We assume the company operates a redirect layer (click tracker) that captures metadata about each click before forwarding to the landing page. This is standard in digital media.

2. **Click-level metadata is available**: IP, user agent, device type, geographic info, and redirect latency are captured per click. These are standard HTTP request attributes.

3. **No landing page instrumentation needed**: All quality signals are derived from pre-click data. We do not require placing pixels or scripts on client landing pages (which we don't control).

4. **Engagement proxy validity**: Our proxy metrics correlate with, but do not guarantee, actual conversion performance. The assumption is that traffic showing human behavioral patterns from relevant geographies with diverse IPs is *more likely* to produce genuine engagement than traffic lacking these characteristics.

5. **Statistical independence**: Traffic events within a vendor's pool are approximately independent. This underpins the validity of our z-tests and Bayesian updating.

6. **Vendor behavior is non-stationary**: The decay factor in Bayesian scoring accounts for vendors changing their traffic characteristics over time.

---

## Trade-offs & Future Work

### Current Trade-offs

| Decision | Trade-off |
|----------|-----------|
| In-memory store | Fast iteration, but not production-ready for persistence or scale |
| No external ML library | Self-contained and auditable, but limited to simpler models |
| Proxy engagement only | Works without landing page access, but can't capture actual conversion signal |
| Single-machine design | Simple deployment, but won't scale to millions of events/second |

### Future Enhancements

1. **Landing page pixel (if permitted)**: If the company can negotiate placing a lightweight tracking pixel on client VDPs, we could capture bounce rate, time-on-page, and scroll depth. This would dramatically improve engagement scoring accuracy.

2. **Conversion feedback loop**: If agencies share even aggregated conversion data, we could calibrate our proxy scores against actual outcomes, creating a supervised learning signal.

3. **Real-time streaming**: Replace batch processing with a streaming architecture (Kafka + Flink) for sub-second fraud detection and allocation updates.

4. **ML-based fraud detection**: Train an isolation forest or autoencoder on known-good traffic to detect novel fraud patterns beyond rule-based heuristics.

5. **Multi-campaign learning**: Transfer quality signals across campaigns — a vendor that's fraudulent on one campaign is likely fraudulent on others.

6. **Vendor feedback API**: Allow vendors to receive quality scorecards, creating incentives for improvement.

---

## Success Criteria Mapping

| Criterion | How the Framework Addresses It |
|-----------|-------------------------------|
| **Identify top 20% traffic sources** | `VendorScorer.getTopTier()` ranks vendors by Bayesian composite score and returns the top quintile |
| **These sources produce higher engagement** | Engagement proxy scoring validates that top-tier vendors have higher geo relevance, device diversity, behavioral authenticity, and IP quality |
| **Media buying decisions become data-driven** | `BudgetAllocator` produces explicit increase/maintain/decrease/pause recommendations with confidence scores and plain-language reasons |

---

## Project Structure

```
public/
└── index.html                      # Interactive dashboard (Chart.js)

src/
├── types.ts                        # Domain type definitions
├── index.ts                        # API server entry point
├── utils/
│   └── statistics.ts               # Statistical utilities
├── store/
│   └── DataStore.ts                # In-memory data store
├── tracking/
│   └── SignalCollector.ts          # Quality signal extraction
├── scoring/
│   ├── FraudDetector.ts            # Fraud/bot detection
│   ├── EngagementProxy.ts          # Engagement proxy scoring
│   └── VendorScorer.ts             # Bayesian vendor scoring
├── engine/
│   ├── ExperimentEngine.ts         # Experiment scheduling & execution
│   └── TrafficDistributor.ts       # Thompson Sampling allocation
├── recommendation/
│   └── BudgetAllocator.ts          # Budget recommendations
├── api/
│   └── server.ts                   # REST API + dashboard serving
└── simulation/
    ├── Simulator.ts                # Realistic data generation
    └── runDemo.ts                  # End-to-end demo script

tests/
├── statistics.test.ts              # 27 tests
├── scoring.test.ts                 # 11 tests
├── engine.test.ts                  # 12 tests
└── recommendation.test.ts          # 7 tests
```
