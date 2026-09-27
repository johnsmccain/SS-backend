import type { Server } from "http";

import { createApp } from "./app";

import dataSource from "./config/database";
import { getConfig } from "./config/env";
import { logger } from "./observability/logger";
import { MetricsRegistry } from "./observability/metrics";

import { createAuthService } from "./services/auth.service";
import { createNotificationService } from "./services/notification.service";
import { InvoiceService } from "./services/invoice.service";
import { createInvoiceStateMachine } from "./lib/invoice-state-machine";
import {
  createInvestmentNotifier,
  createInvestorDirectory,
  createInvestorNotificationEffect,
} from "./lib/invoice-notifications";
import { Invoice } from "./models/Invoice.model";
import { createIPFSService } from "./services/ipfs.service";
import { createInvestmentService } from "./services/investment.service";
import { createSettlementService } from "./services/settlement.service";
import { createMarketplaceService } from "./services/marketplace.service";
import { KycService } from "./services/kyc.service";
import { PaymentDistributorContractService } from "./services/stellar/payment-distributor-contract.service";
import { getSorobanConfig } from "./config/stellar";
import { createRatingsLeaderboardService } from "./services/ratings-leaderboard.service";
import { createDividendCycleService } from "./services/dividend-cycle.service";
import { createSecondaryMarketService } from "./services/secondary-market.service";
import { createWatchlistService } from "./services/watchlist.service";
import { createSettlementWorker } from "./workers/settlement.worker";
import { scheduleAnalyticsSnapshotJob } from "./workers/analytics-snapshot.worker";

export async function bootstrap(): Promise<{ server: Server }> {
  const config = getConfig();

  if (!dataSource.isInitialized) {
    await dataSource.initialize();
  }

  const metricsRegistry = new MetricsRegistry();

  const authService = createAuthService(dataSource, config, logger, metricsRegistry);
  const notificationService = createNotificationService(dataSource);
  const ipfsService = createIPFSService(config.ipfs, logger);
  // One state machine shared by every service that changes invoice status,
  // so transitions are validated, recorded and notified the same way.
  const invoiceStateMachine = createInvoiceStateMachine({
    notificationSink: notificationService,
    effects: [
      createInvestorNotificationEffect(notificationService, createInvestorDirectory(dataSource)),
    ],
  });
  const invoiceService = new InvoiceService({
    invoiceRepository: dataSource.getRepository(Invoice),
    ipfsService,
    dataSource,
    stateMachine: invoiceStateMachine,
  });
  const investmentService = createInvestmentService(
    dataSource,
    invoiceStateMachine,
    createInvestmentNotifier(notificationService, logger)
  );
  const sorobanConfig = getSorobanConfig();
  const distributor =
    sorobanConfig.paymentDistributorContractId && sorobanConfig.platformSecretKey
      ? new PaymentDistributorContractService(
          { ...sorobanConfig, contractId: sorobanConfig.paymentDistributorContractId },
          logger
        )
      : undefined;
  const distributorConfig =
    distributor && sorobanConfig.platformFeeRecipient
      ? { feeRecipient: sorobanConfig.platformFeeRecipient, feeBps: sorobanConfig.platformFeeBps }
      : undefined;
  const settlementService = createSettlementService(
    dataSource,
    distributor,
    distributorConfig,
    invoiceStateMachine,
    undefined,
    notificationService
  );
  const marketplaceService = createMarketplaceService(dataSource);
  const kycService = new KycService(dataSource, config.kyc.webhookSecret ?? "", logger);

  // Keep process.env.TERMS_VERSION aligned with resolved config for services
  // that read the env directly (acknowledgement gate in InvestmentService).
  if (!process.env.TERMS_VERSION) {
    process.env.TERMS_VERSION = config.termsVersion;
  }

  // ---- Feature: Ratings Leaderboard ----
  const ratingsLeaderboardService = createRatingsLeaderboardService(dataSource, {
    redisUrl: config.cache.redisUrl,
  });

  // ---- Feature: Dividend Cycle Config ----
  const dividendCycleService = createDividendCycleService(dataSource);

  // ---- Feature: Secondary Market ----
  const secondaryMarketService = createSecondaryMarketService(dataSource);

  // ---- Feature: Watchlist ----
  const watchlistService = createWatchlistService(dataSource);

  // ---- Feature: Settlement Worker ----
  const settlementWorker = createSettlementWorker(dataSource, settlementService);

  const app = createApp({
    authService,
    notificationService,
    invoiceService,
    investmentService,
    settlementService,
    marketplaceService,
    kycService,
    ratingsLeaderboardService,
    dividendCycleService,
    secondaryMarketService,
    watchlistService,
    settlementWorker,
    config,
    logger,
    metricsEnabled: config.observability.metricsEnabled,
  });

  const server = app.listen(config.port, () => {
    logger.info("Server running", { port: config.port });
  });

  // ---- Start daily analytics snapshot cron (midnight UTC) ----
  const snapshotScheduler = scheduleAnalyticsSnapshotJob(dataSource);

  // ---- Start settlement worker cron (hourly) ----
  settlementWorker.start("0 * * * *");

  // Stop schedulers on server close
  server.on("close", () => {
    snapshotScheduler.stop();
    settlementWorker.stop();
  });

  return { server };
}

if (require.main === module) {
  bootstrap().catch((err) => {
    logger.error("Startup failed", { error: err });
    process.exit(1);
  });
}
