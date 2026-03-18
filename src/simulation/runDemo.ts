import { DataStore } from '../store/DataStore';
import { Simulator } from './Simulator';
import { SignalCollector } from '../tracking/SignalCollector';
import { VendorScorer } from '../scoring/VendorScorer';
import { FraudDetector } from '../scoring/FraudDetector';
import { ExperimentEngine } from '../engine/ExperimentEngine';
import { TrafficDistributor } from '../engine/TrafficDistributor';
import { BudgetAllocator } from '../recommendation/BudgetAllocator';

/**
 * Full end-to-end demonstration of the Traffic Intelligence Framework.
 *
 * Walks through the complete pipeline:
 * 1. Generate simulated traffic from 10 vendors with varying quality
 * 2. Collect and analyze quality signals
 * 3. Score each vendor using the Bayesian model
 * 4. Run experiments to compare vendors head-to-head
 * 5. Generate budget allocation recommendations
 */
async function runDemo(): Promise<void> {
  console.log('='.repeat(70));
  console.log('  TRAFFIC INTELLIGENCE FRAMEWORK — End-to-End Demo');
  console.log('='.repeat(70));
  console.log();

  const store = new DataStore();
  const simulator = new Simulator(store);
  const signalCollector = new SignalCollector();
  const vendorScorer = new VendorScorer();
  const fraudDetector = new FraudDetector();
  const experimentEngine = new ExperimentEngine(store);
  const trafficDistributor = new TrafficDistributor(store);
  const budgetAllocator = new BudgetAllocator(store);

  // -----------------------------------------------------------------------
  // Step 1: Setup scenario
  // -----------------------------------------------------------------------
  console.log('STEP 1: Setting up demo scenario...');
  const scenario = simulator.setupDemoScenario();
  console.log(`  Campaign: ${scenario.campaign.name}`);
  console.log(`  Vendors: ${scenario.vendors.length}`);
  console.log(`  Total traffic events: ${scenario.totalEvents}`);
  console.log();

  // -----------------------------------------------------------------------
  // Step 2: Compute quality signals for each vendor
  // -----------------------------------------------------------------------
  console.log('STEP 2: Computing quality signals per vendor...');
  console.log('-'.repeat(70));

  const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const windowEnd = new Date();

  for (const vendor of scenario.vendors) {
    const events = store.getTrafficEvents({
      vendorId: vendor.id,
      campaignId: scenario.campaign.id,
    });

    const signals = signalCollector.computeSignals(
      vendor.id,
      scenario.campaign.id,
      events,
      windowStart,
      windowEnd,
      scenario.campaign.targetGeos,
    );

    store.addQualitySignals(signals);

    console.log(`  ${vendor.name.padEnd(22)} | clicks: ${String(signals.totalClicks).padStart(4)} | ` +
      `bots: ${(signals.botRate * 100).toFixed(1).padStart(5)}% | ` +
      `geo: ${(signals.geoMatchRate * 100).toFixed(1).padStart(5)}% | ` +
      `IP div: ${signals.ipDiversityRatio.toFixed(2)}`);
  }
  console.log();

  // -----------------------------------------------------------------------
  // Step 3: Score vendors using Bayesian model
  // -----------------------------------------------------------------------
  console.log('STEP 3: Scoring vendors (Bayesian composite scoring)...');
  console.log('-'.repeat(70));

  for (const vendor of scenario.vendors) {
    const signals = store.getLatestQualitySignals(vendor.id, scenario.campaign.id);
    if (!signals) continue;

    const score = vendorScorer.scoreVendor(signals);
    store.addVendorScore(score);

    const fraudAnalysis = fraudDetector.analyzeEvents(
      store.getTrafficEvents({ vendorId: vendor.id }),
    );

    console.log(
      `  ${vendor.name.padEnd(22)} | ` +
      `composite: ${String(score.compositeScore).padStart(3)} | ` +
      `engagement: ${String(score.engagementScore).padStart(3)} | ` +
      `fraud risk: ${String(score.fraudRiskScore).padStart(3)} | ` +
      `confidence: ${score.confidence.toFixed(2)} | ` +
      `risk: ${fraudAnalysis.overallRisk}`,
    );
  }
  console.log();

  // -----------------------------------------------------------------------
  // Step 4: Identify top 20% vendors
  // -----------------------------------------------------------------------
  console.log('STEP 4: Identifying top 20% traffic sources...');
  console.log('-'.repeat(70));

  const allScores = store.getAllLatestScores();
  const topTier = vendorScorer.getTopTier(allScores, 0.20);

  console.log(`  Top tier vendors (${topTier.length} of ${allScores.length}):`);
  for (const score of topTier) {
    const vendor = store.getVendor(score.vendorId);
    console.log(`    ★ ${vendor?.name.padEnd(22)} — composite: ${score.compositeScore}, ` +
      `engagement: ${score.engagementScore}, fraud risk: ${score.fraudRiskScore}`);
  }
  console.log();

  // -----------------------------------------------------------------------
  // Step 5: Run experiments
  // -----------------------------------------------------------------------
  console.log('STEP 5: Running randomized experiments...');
  console.log('-'.repeat(70));

  // Create experiment comparing top vendor vs bottom vendor vs average
  const ranked = vendorScorer.rankVendors(allScores);
  const experimentVendors = [
    ranked[0].vendorId,
    ranked[Math.floor(ranked.length / 2)].vendorId,
    ranked[ranked.length - 1].vendorId,
  ];

  // Tag some events as belonging to the experiment
  const experimentConfig = {
    campaignId: scenario.campaign.id,
    vendorIds: experimentVendors,
    name: 'top-vs-mid-vs-bottom',
    trafficAllocationPercent: 15,
    minSampleSize: 50,
  };

  const experiment = experimentEngine.createExperiment(experimentConfig);
  experimentEngine.startExperiment(experiment.id);

  // Simulate experiment traffic assignment
  for (const vendorId of experimentVendors) {
    const events = store.getTrafficEvents({
      vendorId,
      campaignId: scenario.campaign.id,
    });
    // Assign a subset of events to the experiment
    const sampleSize = Math.min(150, events.length);
    for (let i = 0; i < sampleSize; i++) {
      events[i].experimentId = experiment.id;
    }
  }

  const analysis = experimentEngine.processEvents(experiment.id);
  console.log(`  Experiment: ${experiment.name}`);
  console.log(`  Status: ${analysis.status}`);

  for (const [vendorId, result] of Object.entries(analysis.results)) {
    const vendor = store.getVendor(vendorId);
    console.log(
      `    ${vendor?.name?.padEnd(22) || vendorId.slice(0, 22).padEnd(22)} | ` +
      `clicks: ${String(result.clicks).padStart(4)} | ` +
      `engagement: ${String(result.engagementScore).padStart(3)} | ` +
      `fraud: ${String(result.fraudRiskScore).padStart(3)} | ` +
      `significant: ${result.isSignificant ? 'YES' : 'no '}` +
      (result.pValue !== null ? ` (p=${result.pValue.toFixed(4)})` : ''),
    );
  }
  console.log(`  Recommendation: ${analysis.recommendation}`);
  console.log();

  // -----------------------------------------------------------------------
  // Step 6: Thompson Sampling allocation
  // -----------------------------------------------------------------------
  console.log('STEP 6: Thompson Sampling traffic allocation...');
  console.log('-'.repeat(70));

  const vendorIds = scenario.vendors.map((v) => v.id);
  const allocations = trafficDistributor.computeAllocations(vendorIds);

  allocations.sort((a, b) => b.weight - a.weight);
  for (const alloc of allocations) {
    const vendor = store.getVendor(alloc.vendorId);
    const bar = '█'.repeat(Math.round(alloc.weight * 100));
    console.log(
      `  ${vendor?.name?.padEnd(22) || '???'.padEnd(22)} | ` +
      `${(alloc.weight * 100).toFixed(1).padStart(5)}% | ` +
      `explore: ${(alloc.explorationBonus * 100).toFixed(1).padStart(5)}% | ${bar}`,
    );
  }
  console.log();

  // -----------------------------------------------------------------------
  // Step 7: Budget recommendations
  // -----------------------------------------------------------------------
  console.log('STEP 7: Generating budget allocation recommendations...');
  console.log('-'.repeat(70));

  const plan = budgetAllocator.generateAllocationPlan(
    scenario.campaign.id,
    vendorIds,
    scenario.campaign.dailyBudget,
  );

  console.log(`  ${plan.summary}`);
  console.log();

  for (const rec of plan.allocations) {
    const vendor = store.getVendor(rec.vendorId);
    const actionIcon =
      rec.action === 'increase' ? '↑' :
      rec.action === 'decrease' ? '↓' :
      rec.action === 'pause' ? '⏸' :
      rec.action === 'review' ? '⚠' : '=';

    console.log(
      `  ${actionIcon} ${vendor?.name?.padEnd(22) || '???'.padEnd(22)} | ` +
      `${rec.action.padEnd(8)} | ` +
      `score: ${String(rec.compositeScore).padStart(3)} | ` +
      `alloc: ${rec.currentAllocationPercent}% → ${rec.recommendedAllocationPercent}% | ` +
      `conf: ${rec.confidence.toFixed(2)}`,
    );
  }
  console.log();

  // -----------------------------------------------------------------------
  // Step 8: Action items for buying team
  // -----------------------------------------------------------------------
  console.log('STEP 8: Action items for the media buying team...');
  console.log('-'.repeat(70));

  const actionItems = budgetAllocator.getActionItems(scenario.campaign.id, vendorIds);
  if (actionItems.length === 0) {
    console.log('  No immediate action items.');
  } else {
    for (const item of actionItems) {
      const icon =
        item.priority === 'critical' ? '🔴' :
        item.priority === 'high' ? '🟠' :
        item.priority === 'medium' ? '🟡' : '🟢';
      console.log(`  ${icon} [${item.priority.toUpperCase()}] ${item.vendorName}: ${item.action}`);
    }
  }

  console.log();
  console.log('='.repeat(70));
  console.log('  Demo complete. System stats:', store.getStats());
  console.log('='.repeat(70));
}

runDemo().catch(console.error);
