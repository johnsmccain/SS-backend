import { DataSource, Repository } from "typeorm";
import {
  DividendCycleConfig,
  DividendCycleFrequency,
} from "../models/DividendCycleConfig.model";
import {
  DividendDistribution,
  DistributionTrigger,
} from "../models/DividendDistribution.model";
import { logger } from "../observability/logger";
import { AppError } from "../utils/http-error";

export interface CycleConfigResult {
  issuerWallet: string;
  frequency: DividendCycleFrequency;
  nextDistributionAt: string | null;
  lastDistributionAt: string | null;
  updatedAt: string;
}

export interface DistributionHistoryPage {
  data: DividendDistributionDTO[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface DividendDistributionDTO {
  id: string;
  issuerWallet: string;
  totalAmount: string;
  recipientCount: number;
  trigger: string;
  txHash: string | null;
  cycleFrequency: string | null;
  status: string;
  distributedAt: string;
  createdAt: string;
}

/**
 * Calculates the next distribution date from a reference date given a frequency.
 */
function calculateNextDate(from: Date, frequency: DividendCycleFrequency): Date {
  const next = new Date(from);
  switch (frequency) {
    case DividendCycleFrequency.WEEKLY:
      next.setUTCDate(next.getUTCDate() + 7);
      break;
    case DividendCycleFrequency.QUARTERLY:
      next.setUTCMonth(next.getUTCMonth() + 3);
      break;
    case DividendCycleFrequency.MONTHLY:
    default:
      next.setUTCMonth(next.getUTCMonth() + 1);
      break;
  }
  return next;
}

export class DividendCycleService {
  private readonly configRepo: Repository<DividendCycleConfig>;
  private readonly distributionRepo: Repository<DividendDistribution>;

  constructor(dataSource: DataSource) {
    this.configRepo = dataSource.getRepository(DividendCycleConfig);
    this.distributionRepo = dataSource.getRepository(DividendDistribution);
  }

  /**
   * Returns current cycle config for an issuer wallet.
   * Creates a default monthly config if none exists.
   */
  async getCycleConfig(issuerWallet: string): Promise<CycleConfigResult> {
    let config = await this.configRepo.findOne({ where: { issuerWallet } });

    if (!config) {
      // Create default config
      config = this.configRepo.create({
        issuerWallet,
        frequency: DividendCycleFrequency.MONTHLY,
        nextDistributionAt: calculateNextDate(new Date(), DividendCycleFrequency.MONTHLY),
        lastDistributionAt: null,
      });
      await this.configRepo.save(config);
    }

    return this.toConfigDTO(config);
  }

  /**
   * Updates the cycle frequency and recalculates the next distribution date.
   */
  async updateCycleFrequency(
    issuerWallet: string,
    frequency: DividendCycleFrequency
  ): Promise<CycleConfigResult> {
    if (!Object.values(DividendCycleFrequency).includes(frequency)) {
      throw new AppError(
        400,
        `Invalid frequency. Must be one of: ${Object.values(DividendCycleFrequency).join(", ")}`,
        "INVALID_FREQUENCY"
      );
    }

    let config = await this.configRepo.findOne({ where: { issuerWallet } });

    if (!config) {
      config = this.configRepo.create({ issuerWallet });
    }

    config.frequency = frequency;
    config.nextDistributionAt = calculateNextDate(new Date(), frequency);
    await this.configRepo.save(config);

    logger.info("DividendCycle: Frequency updated", { issuerWallet, frequency });

    return this.toConfigDTO(config);
  }

  /**
   * Triggers an immediate manual distribution for the issuer.
   * Records the distribution event and updates last/next distribution dates.
   *
   * @throws AppError(403) if triggerWallet !== issuerWallet
   */
  async triggerManualDistribution(
    issuerWallet: string,
    triggerWallet: string
  ): Promise<DividendDistributionDTO> {
    if (triggerWallet !== issuerWallet) {
      throw new AppError(
        403,
        "Only the issuer wallet may trigger a manual distribution.",
        "FORBIDDEN_DISTRIBUTION_TRIGGER"
      );
    }

    const config = await this.configRepo.findOne({ where: { issuerWallet } });

    const now = new Date();

    // Record the distribution
    const distribution = this.distributionRepo.create({
      issuerWallet,
      totalAmount: "0", // Actual amount calculated by on-chain logic
      recipientCount: 0,
      trigger: DistributionTrigger.MANUAL,
      status: "success",
      distributedAt: now,
      cycleFrequency: config?.frequency ?? DividendCycleFrequency.MONTHLY,
      txHash: null,
    });
    await this.distributionRepo.save(distribution);

    // Update config dates
    if (config) {
      config.lastDistributionAt = now;
      config.nextDistributionAt = calculateNextDate(now, config.frequency);
      await this.configRepo.save(config);
    }

    logger.info("DividendCycle: Manual distribution triggered", { issuerWallet, distributionId: distribution.id });

    return this.toDistributionDTO(distribution);
  }

  /**
   * Returns paginated distribution history for an issuer, using cursor-based pagination.
   * Cursor is the `distributedAt` ISO timestamp of the last item received.
   */
  async getDistributionHistory(
    issuerWallet: string,
    limit = 20,
    cursor?: string | null
  ): Promise<DistributionHistoryPage> {
    const safLimit = Math.min(100, Math.max(1, limit));

    const qb = this.distributionRepo
      .createQueryBuilder("d")
      .where("d.issuer_wallet = :issuerWallet", { issuerWallet })
      .orderBy("d.distributed_at", "DESC")
      .addOrderBy("d.id", "DESC")
      .limit(safLimit + 1); // Fetch one extra to determine hasMore

    if (cursor) {
      try {
        const cursorDate = new Date(cursor);
        qb.andWhere("d.distributed_at < :cursor", { cursor: cursorDate });
      } catch {
        // Ignore invalid cursor
      }
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > safLimit;
    const items = hasMore ? rows.slice(0, safLimit) : rows;

    const nextCursor =
      hasMore && items.length > 0
        ? items[items.length - 1].distributedAt.toISOString()
        : null;

    return {
      data: items.map((d) => this.toDistributionDTO(d)),
      nextCursor,
      hasMore,
    };
  }

  private toConfigDTO(config: DividendCycleConfig): CycleConfigResult {
    return {
      issuerWallet: config.issuerWallet,
      frequency: config.frequency,
      nextDistributionAt: config.nextDistributionAt?.toISOString() ?? null,
      lastDistributionAt: config.lastDistributionAt?.toISOString() ?? null,
      updatedAt: config.updatedAt.toISOString(),
    };
  }

  private toDistributionDTO(d: DividendDistribution): DividendDistributionDTO {
    return {
      id: d.id,
      issuerWallet: d.issuerWallet,
      totalAmount: d.totalAmount,
      recipientCount: d.recipientCount,
      trigger: d.trigger,
      txHash: d.txHash,
      cycleFrequency: d.cycleFrequency,
      status: d.status,
      distributedAt: d.distributedAt.toISOString(),
      createdAt: d.createdAt.toISOString(),
    };
  }
}

export function createDividendCycleService(dataSource: DataSource): DividendCycleService {
  return new DividendCycleService(dataSource);
}
