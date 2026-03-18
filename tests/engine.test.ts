import { v4 as uuidv4 } from 'uuid';
import { DataStore } from '../src/store/DataStore';
import { ExperimentEngine } from '../src/engine/ExperimentEngine';
import { TrafficDistributor } from '../src/engine/TrafficDistributor';
import { SignalCollector } from '../src/tracking/SignalCollector';
import { VendorScorer } from '../src/scoring/VendorScorer';
import { Simulator } from '../src/simulation/Simulator';
import { TrafficEvent } from '../src/types';

function createTestEvent(
  vendorId: string,
  campaignId: string,
  overrides: Partial<TrafficEvent> = {},
): TrafficEvent {
  return {
    id: uuidv4(),
    vendorId,
    campaignId,
    timestamp: new Date(),
    ip: `192.168.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
    userAgent: 'Mozilla/5.0 Test Browser',
    deviceType: 'mobile',
    geo: { country: 'US', region: 'California', city: 'Los Angeles', zipCode: '90001' },
    referrer: 'https://www.google.com',
    redirectLatencyMs: 250 + Math.random() * 300,
    knownBotSignature: false,
    repeatIp: false,
    timeSinceLastClickFromIp: null,
    ...overrides,
  };
}

describe('ExperimentEngine', () => {
  let store: DataStore;
  let engine: ExperimentEngine;

  beforeEach(() => {
    store = new DataStore();
    engine = new ExperimentEngine(store);
  });

  describe('createExperiment', () => {
    it('should create an experiment with valid config', () => {
      const campaign = store.addCampaign({
        name: 'Test Campaign',
        agencyId: 'agency-1',
        vertical: 'automotive',
        targetGeos: ['California'],
        dailyBudget: 1000,
        active: true,
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });
      const v1 = store.addVendor('Vendor A');
      const v2 = store.addVendor('Vendor B');

      const exp = engine.createExperiment({
        campaignId: campaign.id,
        vendorIds: [v1.id, v2.id],
        name: 'test-experiment',
      });

      expect(exp.status).toBe('scheduled');
      expect(exp.vendorIds).toHaveLength(2);
      expect(exp.results.size).toBe(2);
    });

    it('should reject experiments with fewer than 2 vendors', () => {
      expect(() =>
        engine.createExperiment({
          campaignId: 'campaign-1',
          vendorIds: ['vendor-1'],
        }),
      ).toThrow('at least 2 vendors');
    });
  });

  describe('experiment lifecycle', () => {
    it('should transition through scheduled → running → completed', () => {
      const campaign = store.addCampaign({
        name: 'Test',
        agencyId: 'a1',
        vertical: 'automotive',
        targetGeos: ['California'],
        dailyBudget: 1000,
        active: true,
        startDate: new Date(),
        endDate: new Date(Date.now() + 86400000),
      });
      const v1 = store.addVendor('V1');
      const v2 = store.addVendor('V2');

      const exp = engine.createExperiment({
        campaignId: campaign.id,
        vendorIds: [v1.id, v2.id],
        minSampleSize: 20,
      });

      expect(exp.status).toBe('scheduled');

      engine.startExperiment(exp.id);
      const started = store.getExperiment(exp.id)!;
      expect(started.status).toBe('running');
      expect(started.startedAt).toBeDefined();

      // Add traffic events for both vendors
      for (let i = 0; i < 30; i++) {
        store.addTrafficEvent(
          createTestEvent(v1.id, campaign.id, { experimentId: exp.id }),
        );
        store.addTrafficEvent(
          createTestEvent(v2.id, campaign.id, {
            experimentId: exp.id,
            knownBotSignature: Math.random() < 0.3,
            redirectLatencyMs: 30 + Math.random() * 50,
            geo: { country: 'IN', region: 'International', city: 'Mumbai', zipCode: '00000' },
          }),
        );
      }

      const analysis = engine.processEvents(exp.id);
      expect(analysis.results[v1.id]).toBeDefined();
      expect(analysis.results[v2.id]).toBeDefined();
      expect(analysis.results[v1.id].clicks).toBe(30);
    });

    it('should stop an experiment', () => {
      const v1 = store.addVendor('V1');
      const v2 = store.addVendor('V2');
      const exp = engine.createExperiment({
        campaignId: 'c1',
        vendorIds: [v1.id, v2.id],
      });
      engine.startExperiment(exp.id);
      engine.stopExperiment(exp.id);

      const stopped = store.getExperiment(exp.id)!;
      expect(stopped.status).toBe('stopped');
      expect(stopped.completedAt).toBeDefined();
    });
  });

  describe('autoSchedule', () => {
    it('should create experiments for unscored vendors first', () => {
      const campaign = store.addCampaign({
        name: 'Test',
        agencyId: 'a1',
        vertical: 'automotive',
        targetGeos: [],
        dailyBudget: 1000,
        active: true,
        startDate: new Date(),
        endDate: new Date(Date.now() + 86400000),
      });

      const vendors = Array.from({ length: 6 }, (_, i) => store.addVendor(`V${i}`));
      const vendorIds = vendors.map((v) => v.id);

      const experiments = engine.autoSchedule(campaign.id, vendorIds, {
        maxConcurrent: 2,
        groupSize: 3,
      });

      expect(experiments.length).toBe(2);
      expect(experiments[0].status).toBe('running');
    });

    it('should respect maxConcurrent limit', () => {
      const campaign = store.addCampaign({
        name: 'Test',
        agencyId: 'a1',
        vertical: 'automotive',
        targetGeos: [],
        dailyBudget: 1000,
        active: true,
        startDate: new Date(),
        endDate: new Date(Date.now() + 86400000),
      });

      const vendors = Array.from({ length: 10 }, (_, i) => store.addVendor(`V${i}`));
      const vendorIds = vendors.map((v) => v.id);

      engine.autoSchedule(campaign.id, vendorIds, { maxConcurrent: 1, groupSize: 3 });
      const secondRound = engine.autoSchedule(campaign.id, vendorIds, {
        maxConcurrent: 1,
        groupSize: 3,
      });

      expect(secondRound.length).toBe(0);
    });
  });
});

describe('TrafficDistributor', () => {
  let store: DataStore;
  let distributor: TrafficDistributor;

  beforeEach(() => {
    store = new DataStore();
    distributor = new TrafficDistributor(store);
  });

  it('should return equal weights for unknown vendors', () => {
    const v1 = store.addVendor('V1');
    const v2 = store.addVendor('V2');

    const allocations = distributor.computeAllocations([v1.id, v2.id]);
    expect(allocations).toHaveLength(2);

    const totalWeight = allocations.reduce((sum, a) => sum + a.weight, 0);
    expect(totalWeight).toBeCloseTo(1, 2);
  });

  it('should allocate more traffic to higher-scoring vendors', () => {
    const v1 = store.addVendor('Good Vendor');
    const v2 = store.addVendor('Bad Vendor');

    const signalCollector = new SignalCollector();
    const vendorScorer = new VendorScorer();
    const simulator = new Simulator(store);

    // Generate traffic for good vendor
    const goodEvents = simulator.generateVendorTraffic(v1.id, 'c1', {
      vendorIdx: 0, quality: 'premium', clickCount: 200, botRate: 0.01,
      geoMatchRate: 0.90, ipDiversity: 0.95, avgLatency: 350,
    });
    store.addTrafficEvents(goodEvents);

    // Generate traffic for bad vendor
    const badEvents = simulator.generateVendorTraffic(v2.id, 'c1', {
      vendorIdx: 1, quality: 'fraud', clickCount: 200, botRate: 0.50,
      geoMatchRate: 0.05, ipDiversity: 0.10, avgLatency: 30,
    });
    store.addTrafficEvents(badEvents);

    // Score both
    const now = new Date();
    const ago = new Date(Date.now() - 86400000);

    for (const vid of [v1.id, v2.id]) {
      const events = store.getTrafficEvents({ vendorId: vid });
      const signals = signalCollector.computeSignals(vid, 'c1', events, ago, now, ['California']);
      const score = vendorScorer.scoreVendor(signals);
      store.addVendorScore(score);
    }

    // Run deterministic allocation multiple times and check average
    const alloc = distributor.computeDeterministicAllocations([v1.id, v2.id]);
    const goodAlloc = alloc.find((a) => a.vendorId === v1.id)!;
    const badAlloc = alloc.find((a) => a.vendorId === v2.id)!;

    expect(goodAlloc.weight).toBeGreaterThan(badAlloc.weight);
  });

  it('should select a vendor from the pool', () => {
    const v1 = store.addVendor('V1');
    const v2 = store.addVendor('V2');

    const selected = distributor.selectVendor([v1.id, v2.id]);
    expect([v1.id, v2.id]).toContain(selected);
  });

  it('should handle single vendor', () => {
    const v1 = store.addVendor('V1');
    const allocations = distributor.computeAllocations([v1.id]);
    expect(allocations).toHaveLength(1);
    expect(allocations[0].weight).toBe(1.0);
  });
});

describe('SignalCollector', () => {
  let collector: SignalCollector;

  beforeEach(() => {
    collector = new SignalCollector();
  });

  it('should compute signals from traffic events', () => {
    const events: TrafficEvent[] = Array.from({ length: 100 }, (_, i) =>
      createTestEvent('v1', 'c1', {
        timestamp: new Date(Date.now() - Math.random() * 86400000),
      }),
    );

    const signals = collector.computeSignals(
      'v1', 'c1', events,
      new Date(Date.now() - 86400000), new Date(),
      ['California'],
    );

    expect(signals.totalClicks).toBe(100);
    expect(signals.geoMatchRate).toBeGreaterThan(0.5);
    expect(signals.ipDiversityRatio).toBeGreaterThan(0);
    expect(signals.botRate).toBe(0);
  });

  it('should return empty signals for no events', () => {
    const signals = collector.computeSignals(
      'v1', 'c1', [],
      new Date(), new Date(),
    );

    expect(signals.totalClicks).toBe(0);
    expect(signals.botRate).toBe(0);
  });
});
