import path from 'path';
import express, { Request, Response, NextFunction } from 'express';
import { DataStore } from '../store/DataStore';
import { ExperimentEngine } from '../engine/ExperimentEngine';
import { TrafficDistributor } from '../engine/TrafficDistributor';
import { BudgetAllocator } from '../recommendation/BudgetAllocator';
import { SignalCollector } from '../tracking/SignalCollector';
import { VendorScorer } from '../scoring/VendorScorer';
import { FraudDetector } from '../scoring/FraudDetector';
import { ApiResponse, ExperimentConfig } from '../types';

function param(req: Request, name: string): string {
  const val = req.params[name];
  return Array.isArray(val) ? val[0] : val;
}

function queryStr(req: Request, name: string): string | undefined {
  const val = req.query[name];
  if (val === undefined) return undefined;
  return Array.isArray(val) ? String(val[0]) : String(val);
}

/**
 * REST API for the Traffic Intelligence Framework.
 *
 * Endpoints are organized by domain:
 * - /vendors       — vendor management and scoring
 * - /campaigns     — campaign management
 * - /experiments   — experiment lifecycle
 * - /allocations   — traffic allocation weights
 * - /recommendations — budget recommendations for the buying team
 * - /health        — system health and stats
 */
export function createServer(store: DataStore): express.Application {
  const app = express();
  app.use(express.json());

  // Serve the dashboard from /public
  const publicDir = path.join(__dirname, '..', '..', 'public');
  app.use('/dashboard', express.static(publicDir));

  // Redirect root to dashboard
  app.get('/', (_req: Request, res: Response) => {
    res.redirect('/dashboard');
  });

  const experimentEngine = new ExperimentEngine(store);
  const trafficDistributor = new TrafficDistributor(store);
  const budgetAllocator = new BudgetAllocator(store);
  const signalCollector = new SignalCollector();
  const vendorScorer = new VendorScorer();
  const fraudDetector = new FraudDetector();

  // -----------------------------------------------------------------------
  // Health & Stats
  // -----------------------------------------------------------------------

  app.get('/health', (_req: Request, res: Response) => {
    respond(res, { status: 'healthy', stats: store.getStats() });
  });

  // -----------------------------------------------------------------------
  // Vendors
  // -----------------------------------------------------------------------

  app.get('/vendors', (_req: Request, res: Response) => {
    respond(res, store.getAllVendors());
  });

  app.get('/vendors/:id', (req: Request, res: Response) => {
    const vendor = store.getVendor(param(req, 'id'));
    if (!vendor) return respondError(res, 'Vendor not found', 404);
    respond(res, vendor);
  });

  app.post('/vendors', (req: Request, res: Response) => {
    const { name, metadata } = req.body;
    if (!name) return respondError(res, 'name is required');
    const vendor = store.addVendor(name, metadata);
    respond(res, vendor, 201);
  });

  app.get('/vendors/:id/score', (req: Request, res: Response) => {
    const score = store.getLatestVendorScore(param(req, 'id'));
    if (!score) return respondError(res, 'No score available for this vendor', 404);
    respond(res, {
      ...score,
      qualityEstimate: vendorScorer.getQualityEstimate(score),
    });
  });

  app.get('/vendors/:id/score/history', (req: Request, res: Response) => {
    const limit = parseInt(queryStr(req, 'limit') || '20', 10);
    const history = store.getVendorScoreHistory(param(req, 'id'), limit);
    respond(res, history);
  });

  app.get('/vendors/ranking/all', (_req: Request, res: Response) => {
    const scores = store.getAllLatestScores();
    const ranked = vendorScorer.rankVendors(scores);
    respond(res, ranked.map((s, i) => ({
      rank: i + 1,
      vendorId: s.vendorId,
      vendorName: store.getVendor(s.vendorId)?.name || 'Unknown',
      compositeScore: s.compositeScore,
      engagementScore: s.engagementScore,
      fraudRiskScore: s.fraudRiskScore,
      confidence: s.confidence,
      sampleSize: s.sampleSize,
    })));
  });

  app.get('/vendors/top-tier/all', (_req: Request, res: Response) => {
    const scores = store.getAllLatestScores();
    const topTier = vendorScorer.getTopTier(scores, 0.20);
    respond(res, topTier.map((s) => ({
      vendorId: s.vendorId,
      vendorName: store.getVendor(s.vendorId)?.name || 'Unknown',
      compositeScore: s.compositeScore,
      confidence: s.confidence,
    })));
  });

  // -----------------------------------------------------------------------
  // Campaigns
  // -----------------------------------------------------------------------

  app.get('/campaigns', (_req: Request, res: Response) => {
    respond(res, store.getAllCampaigns());
  });

  app.get('/campaigns/:id', (req: Request, res: Response) => {
    const campaign = store.getCampaign(param(req, 'id'));
    if (!campaign) return respondError(res, 'Campaign not found', 404);
    respond(res, campaign);
  });

  // -----------------------------------------------------------------------
  // Experiments
  // -----------------------------------------------------------------------

  app.post('/experiments', (req: Request, res: Response) => {
    try {
      const config: ExperimentConfig = req.body;
      const experiment = experimentEngine.createExperiment(config);
      respond(res, experiment, 201);
    } catch (err) {
      respondError(res, (err as Error).message);
    }
  });

  app.post('/experiments/:id/start', (req: Request, res: Response) => {
    try {
      const experiment = experimentEngine.startExperiment(param(req, 'id'));
      respond(res, experiment);
    } catch (err) {
      respondError(res, (err as Error).message);
    }
  });

  app.post('/experiments/:id/stop', (req: Request, res: Response) => {
    try {
      const experiment = experimentEngine.stopExperiment(param(req, 'id'));
      respond(res, experiment);
    } catch (err) {
      respondError(res, (err as Error).message);
    }
  });

  app.get('/experiments/:id/results', (req: Request, res: Response) => {
    try {
      const analysis = experimentEngine.processEvents(param(req, 'id'));
      respond(res, analysis);
    } catch (err) {
      respondError(res, (err as Error).message);
    }
  });

  app.get('/experiments', (_req: Request, res: Response) => {
    respond(res, store.getAllExperiments());
  });

  app.get('/experiments/summary/:campaignId', (req: Request, res: Response) => {
    const summary = experimentEngine.getExperimentSummary(param(req, 'campaignId'));
    respond(res, summary);
  });

  app.post('/experiments/auto-schedule', (req: Request, res: Response) => {
    const { campaignId, vendorIds, maxConcurrent, groupSize } = req.body;
    if (!campaignId || !vendorIds) {
      return respondError(res, 'campaignId and vendorIds are required');
    }
    const experiments = experimentEngine.autoSchedule(campaignId, vendorIds, {
      maxConcurrent,
      groupSize,
    });
    respond(res, experiments, 201);
  });

  // -----------------------------------------------------------------------
  // Traffic Allocation
  // -----------------------------------------------------------------------

  app.post('/allocations/compute', (req: Request, res: Response) => {
    const { vendorIds } = req.body;
    if (!vendorIds || !Array.isArray(vendorIds)) {
      return respondError(res, 'vendorIds array is required');
    }
    const allocations = trafficDistributor.computeAllocations(vendorIds);
    respond(res, allocations);
  });

  app.post('/allocations/select-vendor', (req: Request, res: Response) => {
    const { vendorIds } = req.body;
    if (!vendorIds || !Array.isArray(vendorIds)) {
      return respondError(res, 'vendorIds array is required');
    }
    const selected = trafficDistributor.selectVendor(vendorIds);
    respond(res, { selectedVendorId: selected });
  });

  // -----------------------------------------------------------------------
  // Budget Recommendations
  // -----------------------------------------------------------------------

  app.post('/recommendations/plan', (req: Request, res: Response) => {
    const { campaignId, vendorIds, totalBudget } = req.body;
    if (!campaignId || !vendorIds || !totalBudget) {
      return respondError(res, 'campaignId, vendorIds, and totalBudget are required');
    }
    const plan = budgetAllocator.generateAllocationPlan(campaignId, vendorIds, totalBudget);
    respond(res, plan);
  });

  app.post('/recommendations/action-items', (req: Request, res: Response) => {
    const { campaignId, vendorIds } = req.body;
    if (!campaignId || !vendorIds) {
      return respondError(res, 'campaignId and vendorIds are required');
    }
    const items = budgetAllocator.getActionItems(campaignId, vendorIds);
    respond(res, items);
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled error:', err);
    respondError(res, 'Internal server error', 500);
  });

  return app;
}

function respond<T>(res: Response, data: T, status: number = 200): void {
  const response: ApiResponse<T> = {
    success: true,
    data,
    timestamp: new Date(),
  };
  res.status(status).json(response);
}

function respondError(res: Response, error: string, status: number = 400): void {
  const response: ApiResponse<null> = {
    success: false,
    error,
    timestamp: new Date(),
  };
  res.status(status).json(response);
}
