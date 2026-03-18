import { v4 as uuidv4 } from 'uuid';
import { TrafficEvent, GeoInfo } from '../types';
import { DataStore } from '../store/DataStore';

/**
 * Simulator generates realistic traffic data for demonstration and testing.
 *
 * It creates vendors with distinct traffic profiles that mirror real-world
 * patterns we'd expect in the automotive digital media space:
 *
 * - Premium vendors: high geo match, diverse devices, natural timing, low bots
 * - Average vendors: moderate quality across all dimensions
 * - Low-quality vendors: poor geo match, concentrated IPs, some bots
 * - Fraudulent vendors: high bot rate, datacenter IPs, uniform timing
 *
 * This allows us to demonstrate that the scoring and experiment systems
 * correctly identify and rank vendors by quality.
 */
export class Simulator {
  private store: DataStore;

  constructor(store: DataStore) {
    this.store = store;
  }

  /**
   * Set up a complete demo scenario with vendors, campaigns, and traffic.
   */
  setupDemoScenario(): DemoScenario {
    // Create campaign
    const campaign = this.store.addCampaign({
      name: 'AutoNation Q1 VDP Campaign',
      agencyId: 'agency-premier-auto',
      vertical: 'automotive',
      targetGeos: ['California', 'Texas', 'Florida', 'New York'],
      dailyBudget: 5000,
      active: true,
      startDate: new Date('2026-01-01'),
      endDate: new Date('2026-03-31'),
    });

    // Create vendors with different quality profiles
    const vendors = [
      this.store.addVendor('PremiumTraffic Co', { tier: 'premium', region: 'US' }),
      this.store.addVendor('QualityClicks Inc', { tier: 'premium', region: 'US' }),
      this.store.addVendor('AutoAudience Net', { tier: 'good', region: 'US' }),
      this.store.addVendor('DigitalReach LLC', { tier: 'average', region: 'US' }),
      this.store.addVendor('MediaBlast Pro', { tier: 'average', region: 'mixed' }),
      this.store.addVendor('TrafficWave', { tier: 'low', region: 'mixed' }),
      this.store.addVendor('ClickStream Global', { tier: 'low', region: 'intl' }),
      this.store.addVendor('BargainClicks', { tier: 'suspect', region: 'intl' }),
      this.store.addVendor('QuickHits Network', { tier: 'suspect', region: 'intl' }),
      this.store.addVendor('ShadowTraffic Ltd', { tier: 'fraud', region: 'intl' }),
    ];

    // Vendor quality profiles (determines traffic characteristics)
    const profiles: VendorProfile[] = [
      { vendorIdx: 0, quality: 'premium',  clickCount: 500, botRate: 0.01, geoMatchRate: 0.92, ipDiversity: 0.95, avgLatency: 350 },
      { vendorIdx: 1, quality: 'premium',  clickCount: 450, botRate: 0.02, geoMatchRate: 0.88, ipDiversity: 0.92, avgLatency: 300 },
      { vendorIdx: 2, quality: 'good',     clickCount: 400, botRate: 0.03, geoMatchRate: 0.80, ipDiversity: 0.85, avgLatency: 280 },
      { vendorIdx: 3, quality: 'average',  clickCount: 350, botRate: 0.05, geoMatchRate: 0.60, ipDiversity: 0.70, avgLatency: 250 },
      { vendorIdx: 4, quality: 'average',  clickCount: 300, botRate: 0.08, geoMatchRate: 0.55, ipDiversity: 0.65, avgLatency: 220 },
      { vendorIdx: 5, quality: 'low',      clickCount: 400, botRate: 0.12, geoMatchRate: 0.35, ipDiversity: 0.45, avgLatency: 180 },
      { vendorIdx: 6, quality: 'low',      clickCount: 350, botRate: 0.15, geoMatchRate: 0.25, ipDiversity: 0.40, avgLatency: 150 },
      { vendorIdx: 7, quality: 'suspect',  clickCount: 500, botRate: 0.25, geoMatchRate: 0.15, ipDiversity: 0.25, avgLatency: 100 },
      { vendorIdx: 8, quality: 'suspect',  clickCount: 600, botRate: 0.30, geoMatchRate: 0.10, ipDiversity: 0.20, avgLatency: 80 },
      { vendorIdx: 9, quality: 'fraud',    clickCount: 800, botRate: 0.55, geoMatchRate: 0.05, ipDiversity: 0.10, avgLatency: 30 },
    ];

    // Generate traffic events for each vendor
    const allEvents: TrafficEvent[] = [];
    for (const profile of profiles) {
      const events = this.generateVendorTraffic(
        vendors[profile.vendorIdx].id,
        campaign.id,
        profile,
      );
      allEvents.push(...events);
    }

    this.store.addTrafficEvents(allEvents);

    return {
      campaign,
      vendors,
      totalEvents: allEvents.length,
      profiles,
    };
  }

  /**
   * Generate traffic events matching a vendor's quality profile.
   */
  generateVendorTraffic(
    vendorId: string,
    campaignId: string,
    profile: VendorProfile,
  ): TrafficEvent[] {
    const events: TrafficEvent[] = [];
    const ipPool = this.generateIpPool(profile.ipDiversity, profile.clickCount);
    const baseTime = Date.now() - 24 * 60 * 60 * 1000; // last 24 hours

    for (let i = 0; i < profile.clickCount; i++) {
      const ip = ipPool[Math.floor(Math.random() * ipPool.length)];
      const isBot = Math.random() < profile.botRate;
      const timestamp = this.generateTimestamp(baseTime, profile.quality, i, profile.clickCount);

      events.push({
        id: uuidv4(),
        vendorId,
        campaignId,
        timestamp: new Date(timestamp),
        ip,
        userAgent: isBot ? this.randomBotUA() : this.randomHumanUA(),
        deviceType: this.randomDevice(profile.quality),
        geo: this.randomGeo(profile.geoMatchRate),
        referrer: this.randomReferrer(profile.quality),
        redirectLatencyMs: this.randomLatency(profile.avgLatency, isBot),
        knownBotSignature: isBot,
        repeatIp: ipPool.filter((p) => p === ip).length > 1 && Math.random() < 0.3,
        timeSinceLastClickFromIp: Math.random() < 0.3 ? Math.random() * 3600 : null,
      });
    }

    return events;
  }

  private generateIpPool(diversityRatio: number, clickCount: number): string[] {
    const uniqueCount = Math.max(5, Math.floor(clickCount * diversityRatio));
    const ips: string[] = [];

    for (let i = 0; i < uniqueCount; i++) {
      ips.push(this.randomIp());
    }

    // For low diversity, repeat IPs to create concentration
    const pool: string[] = [];
    for (let i = 0; i < clickCount; i++) {
      if (Math.random() < diversityRatio) {
        pool.push(ips[Math.floor(Math.random() * ips.length)]);
      } else {
        pool.push(ips[Math.floor(Math.random() * Math.min(5, ips.length))]);
      }
    }
    return pool;
  }

  private generateTimestamp(
    baseTime: number,
    quality: string,
    index: number,
    total: number,
  ): number {
    const dayMs = 24 * 60 * 60 * 1000;

    if (quality === 'fraud') {
      // Bots: uniform distribution (suspicious)
      return baseTime + (index / total) * dayMs;
    }

    // Human-like: peaks during 9am-9pm with natural variance
    const hour = this.weightedRandomHour(quality);
    const minuteOffset = Math.random() * 60 * 60 * 1000;
    return baseTime + hour * 60 * 60 * 1000 + minuteOffset + (Math.random() - 0.5) * 600000;
  }

  private weightedRandomHour(quality: string): number {
    // Natural distribution: more traffic during business hours
    const weights =
      quality === 'premium' || quality === 'good'
        ? [1, 1, 1, 1, 1, 2, 3, 5, 8, 10, 10, 9, 8, 9, 10, 10, 8, 7, 6, 5, 4, 3, 2, 1]
        : [2, 2, 2, 2, 3, 3, 4, 5, 7, 8, 8, 7, 7, 8, 8, 7, 6, 5, 5, 4, 4, 3, 3, 2];

    const total = weights.reduce((a, b) => a + b, 0);
    let roll = Math.random() * total;

    for (let h = 0; h < 24; h++) {
      roll -= weights[h];
      if (roll <= 0) return h;
    }
    return 12;
  }

  private randomIp(): string {
    return `${this.randInt(1, 254)}.${this.randInt(0, 255)}.${this.randInt(0, 255)}.${this.randInt(1, 254)}`;
  }

  private randomDevice(quality: string): 'desktop' | 'mobile' | 'tablet' | 'unknown' {
    const roll = Math.random();
    if (quality === 'fraud') return roll < 0.9 ? 'desktop' : 'mobile';
    if (quality === 'premium' || quality === 'good') {
      if (roll < 0.55) return 'mobile';
      if (roll < 0.85) return 'desktop';
      return 'tablet';
    }
    if (roll < 0.4) return 'mobile';
    if (roll < 0.8) return 'desktop';
    if (roll < 0.95) return 'tablet';
    return 'unknown';
  }

  private randomGeo(matchRate: number): GeoInfo {
    const targetStates = ['California', 'Texas', 'Florida', 'New York'];
    const targetCities = ['Los Angeles', 'Houston', 'Miami', 'New York City'];
    const otherStates = ['Oregon', 'Montana', 'Vermont', 'Maine', 'Alaska'];
    const otherCities = ['Portland', 'Helena', 'Burlington', 'Augusta', 'Juneau'];

    if (Math.random() < matchRate) {
      const idx = Math.floor(Math.random() * targetStates.length);
      return {
        country: 'US',
        region: targetStates[idx],
        city: targetCities[idx],
        zipCode: `${this.randInt(10000, 99999)}`,
      };
    }

    if (Math.random() < 0.5) {
      const idx = Math.floor(Math.random() * otherStates.length);
      return {
        country: 'US',
        region: otherStates[idx],
        city: otherCities[idx],
        zipCode: `${this.randInt(10000, 99999)}`,
      };
    }

    return {
      country: ['IN', 'PH', 'BD', 'PK'][Math.floor(Math.random() * 4)],
      region: 'International',
      city: 'Unknown',
      zipCode: '00000',
    };
  }

  private randomLatency(avgMs: number, isBot: boolean): number {
    if (isBot) return Math.max(5, avgMs * 0.2 * (0.5 + Math.random()));
    return Math.max(50, avgMs * (0.5 + Math.random() * 1.0));
  }

  private randomHumanUA(): string {
    const uas = [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    ];
    return uas[Math.floor(Math.random() * uas.length)];
  }

  private randomBotUA(): string {
    const uas = [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'python-requests/2.31.0',
      'curl/8.1.2',
      'Java/1.8.0_301',
      'Go-http-client/1.1',
    ];
    return uas[Math.floor(Math.random() * uas.length)];
  }

  private randomReferrer(quality: string): string {
    if (quality === 'fraud') return '';
    const refs = [
      'https://www.google.com/search?q=cars+for+sale',
      'https://www.facebook.com/ads/click',
      'https://www.bing.com/search?q=used+cars',
      'https://news.google.com/',
      'https://www.autotrader.com/',
    ];
    return Math.random() < 0.7 ? refs[Math.floor(Math.random() * refs.length)] : '';
  }

  private randInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
}

export interface VendorProfile {
  vendorIdx: number;
  quality: string;
  clickCount: number;
  botRate: number;
  geoMatchRate: number;
  ipDiversity: number;
  avgLatency: number;
}

export interface DemoScenario {
  campaign: ReturnType<DataStore['addCampaign']>;
  vendors: ReturnType<DataStore['addVendor']>[];
  totalEvents: number;
  profiles: VendorProfile[];
}
