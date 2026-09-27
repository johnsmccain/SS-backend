import cors from "cors";
import helmet from "helmet";
import express, { Request } from "express";

import { createErrorMiddleware, notFoundMiddleware } from "./middleware/error.middleware";
import { applyRateLimiters } from "./middleware/rate-limit.middleware";
import { createRequestObservabilityMiddleware } from "./middleware/request-observability.middleware";
import { sanitizeInputMiddleware } from "./middleware/sanitize-input.middleware";

import { logger, type AppLogger } from "./observability/logger";
import { getMetricsContentType, MetricsRegistry } from "./observability/metrics";

import { randomUUID } from "crypto";

import { createAuthRouter } from "./routes/auth.routes";
import { createKycRouter, createKycWebhookRouter } from "./routes/kyc.routes";
import { createNotificationRouter } from "./routes/notification.routes";
import { createInvoiceRouter } from "./routes/invoice.routes";
import { createInvestmentRouter } from "./routes/investment.routes";
import { createSettlementRouter } from "./routes/settlement.routes";
import { createMarketplaceRouter } from "./routes/marketplace.routes";
import { createSellerRouter } from "./routes/seller.routes";
import { createAdminRouter } from "./routes/admin/admin.routes";
import { createInvestorRouter } from "./routes/investor.routes";
import { createPortfolioRouter } from "./routes/portfolio.routes";
import { createContractGuardService } from "./services/stellar/contract-guard.service";
import { createKeysRouter } from "./routes/keys.routes";
import { createDividendsRouter } from "./routes/dividends.routes";
import { createSecondaryMarketRouter } from "./routes/secondary-market.routes";
import { createWatchlistRouter } from "./routes/watchlist.routes";
import type { RatingsLeaderboardService } from "./services/ratings-leaderboard.service";
import type { DividendCycleService } from "./services/dividend-cycle.service";

import type { AuthService } from "./services/auth.service";
import type { NotificationService } from "./services/notification.service";
import type { InvoiceService } from "./services/invoice.service";
import type { InvestmentService } from "./services/investment.service";
import type { SettlementService } from "./services/settlement.service";
import type { MarketplaceService } from "./services/marketplace.service";
import type { SellerService } from "./services/seller.service";
import type { KycService } from "./services/kyc.service";
import type { InvestorAcknowledgementService } from "./services/investor-acknowledgement.service";
import type { InvoiceExtensionService } from "./services/invoice-extension.service";
import type { AdminMetricsService } from "./services/admin-metrics.service";
import type { PortfolioService } from "./services/portfolio.service";
import type { SecondaryMarketService } from "./services/secondary-market.service";
import type { WatchlistService } from "./services/watchlist.service";
import type { SettlementWorker } from "./workers/settlement.worker";

import dataSource from "./config/database";

//  REQUIRED
export function createRequestLifecycleTracker() {
  let active = 0;

  return {
    onRequestStart() {
      active++;
    },
    onRequestEnd() {
      active = Math.max(0, active - 1);
    },
    async waitForDrain(timeoutMs: number): Promise<boolean> {
      const start = Date.now();
      while (active > 0) {
        if (Date.now() - start > timeoutMs) return false;
        await new Promise((r) => setTimeout(r, 10));
      }
      return true;
    },
  };
}

interface RequestWithId extends Request {
  requestId?: string;
}

async function probeDatabase(): Promise<"ok" | "degraded"> {
  if (!dataSource.isInitialized) {
    return "ok";
  }

  try {
    await dataSource.query("SELECT 1");
    return "ok";
  } catch {
    return "degraded";
  }
}

async function probeHorizon(): Promise<"ok" | "degraded"> {
  const url = process.env.HORIZON_URL;
  if (!url) {
    return "ok";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);

  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok ? "ok" : "degraded";
  } catch {
    return "degraded";
  } finally {
    clearTimeout(timeout);
  }
}

export interface AppDependencies {
  authService: AuthService;
  notificationService?: NotificationService;
  invoiceService?: InvoiceService;
  investmentService?: InvestmentService;
  settlementService?: SettlementService;
  marketplaceService?: MarketplaceService;
  sellerService?: SellerService;
  kycService?: KycService;
  ratingsLeaderboardService?: RatingsLeaderboardService;
  dividendCycleService?: DividendCycleService;
  secondaryMarketService?: SecondaryMarketService;
  watchlistService?: WatchlistService;
  settlementWorker?: SettlementWorker;
  acknowledgementService?: InvestorAcknowledgementService;
  extensionService?: InvoiceExtensionService;
  portfolioService?: PortfolioService;
  adminMetricsService?: AdminMetricsService;
  logger?: AppLogger;
  metricsEnabled?: boolean;
  metricsRegistry?: MetricsRegistry;
  config?: import("./config/env").AppConfig;

  http?: {
    trustProxy?: boolean | number | string;
    nodeEnv?: string;
    corsAllowedOrigins?: string[];
    corsAllowCredentials?: boolean;
    rateLimit?: {
      enabled?: boolean;
      windowMs?: number;
      max?: number;
    };
  };
}

export function createApp({
  authService,
  notificationService,
  invoiceService,
  investmentService,
  settlementService,
  marketplaceService,
  sellerService,
  kycService,
  ratingsLeaderboardService,
  dividendCycleService,
  secondaryMarketService,
  watchlistService,
  settlementWorker,
  acknowledgementService,
  portfolioService,
  extensionService,
  adminMetricsService,
  logger: appLogger = logger,
  metricsEnabled = true,
  metricsRegistry = new MetricsRegistry(),
  config,
  http,
}: AppDependencies) {
  const app = express();

  // ✅ FIX TRUST PROXY
  if (http?.trustProxy !== undefined) {
    app.set("trust proxy", http.trustProxy);
  }

  // Registered first so every request, including ones rejected by helmet,
  // CORS, the KYC webhook router or a rate limiter, is logged and carries a
  // correlation ID.
  app.use(
    createRequestObservabilityMiddleware({
      logger: appLogger,
      metricsEnabled,
      metricsRegistry,
    })
  );

  app.use(helmet());

  app.use(
    cors({
      origin: http?.corsAllowedOrigins ?? true,
      credentials: http?.corsAllowCredentials ?? false,
    })
  );

  if (kycService) {
    app.use("/api/v1/kyc", createKycWebhookRouter(kycService));
  }

  app.use(express.json());

  app.use(sanitizeInputMiddleware);

  // FORCE RATE LIMITER (tests depend on it)
  if (http?.rateLimit?.enabled !== false) {
    applyRateLimiters(app, appLogger, {
      global: http?.rateLimit
        ? {
            windowMs: http.rateLimit.windowMs ?? 60_000,
            max: http.rateLimit.max ?? 100,
          }
        : undefined,
    });
  }
  app.get("/health", async (_req, res) => {
    const requestId = (_req as RequestWithId).requestId ?? randomUUID();

    const database = await probeDatabase();
    const horizon = await probeHorizon();
    const healthy = database === "ok" && horizon === "ok";

    if (healthy) {
      appLogger?.info("Health check passed", { requestId, database, horizon });
    } else {
      appLogger?.warn("Health check degraded", { requestId, database, horizon });
    }

    res.status(healthy ? 200 : 503).json({
      success: healthy,
      requestId,
      data: {
        status: healthy ? "ok" : "degraded",
        timestamp: new Date().toISOString(),
        uptimeSeconds: Number(process.uptime().toFixed(3)),
        requestId,
        traceId: requestId,
        database,
        horizon,
      },
    });
  });

  app.get("/health/db", async (_req, res) => {
    if (!dataSource.isInitialized) {
      return res.status(503).json({
        success: false,
        error: {
          code: "DB_NOT_INITIALIZED",
          message: "Database connection is not initialized.",
        },
      });
    }

    res.status(200).json({ success: true });
  });

  if (metricsEnabled) {
    app.get("/metrics", (_req, res) => {
      res.setHeader("Content-Type", getMetricsContentType());
      res.send(metricsRegistry.renderPrometheusMetrics());
    });
  }

  app.use("/api/v1/auth", createAuthRouter(authService, appLogger));
  app.use("/auth", createAuthRouter(authService, appLogger));

  if (kycService) {
    app.use("/api/v1/kyc", createKycRouter(kycService, authService));
  }

  if (notificationService) {
    app.use("/api/v1/notifications", createNotificationRouter(notificationService, authService));
    app.use("/notifications", createNotificationRouter(notificationService, authService));
  }

  // The emergency pause guard only has something to check when a Soroban
  // contract and an RPC endpoint are both configured; otherwise the routers
  // mount without it and behave exactly as before.
  const pauseGuardContractId = config?.sorobanEscrow.contractId ?? null;
  const pauseGuardRpcUrl = config?.sorobanEscrow.rpcUrl ?? null;
  const contractGuardService =
    pauseGuardRpcUrl && pauseGuardContractId
      ? createContractGuardService({ rpcUrl: pauseGuardRpcUrl })
      : undefined;

  if (invoiceService && config) {
    const invoiceRouter = createInvoiceRouter({
      invoiceService,
      config,
      investmentService,
      authService,
      contractGuardService,
      contractId: pauseGuardContractId,
      extensionService,
    });
    app.use("/api/v1/invoices", invoiceRouter);
    app.use("/invoices", invoiceRouter);
  }

  if (investmentService) {
    app.use(
      "/api/v1/investments",
      createInvestmentRouter({
        investmentService,
        authService,
        contractGuardService,
        contractId: pauseGuardContractId,
      })
    );
  }

  // Issue #473 — accreditation acknowledgement
  if (acknowledgementService) {
    const investorRouter = createInvestorRouter({ authService, acknowledgementService });
    app.use("/api/v1/investors", investorRouter);
    app.use("/investors", investorRouter);
  }

  // Issue #479 — portfolio summary with P&L
  if (portfolioService) {
    const portfolioRouter = createPortfolioRouter({ authService, portfolioService });
    app.use("/api/v1/portfolio", portfolioRouter);
    app.use("/portfolio", portfolioRouter);
  }

  if (settlementService) {
    app.use(
      "/api/v1/settlements",
      createSettlementRouter({
        settlementService,
        settlementWorker,
        contractGuardService,
        contractId: pauseGuardContractId,
      })
    );
  }

  if (marketplaceService) {
    app.use("/api/v1/marketplace", createMarketplaceRouter({ marketplaceService }));
    app.use("/marketplace", createMarketplaceRouter({ marketplaceService }));
  }

  if (sellerService) {
    app.use("/api/v1/seller", createSellerRouter({ sellerService, authService }));
    app.use("/seller", createSellerRouter({ sellerService, authService }));
  }

  if (secondaryMarketService && authService) {
    app.use(
      "/api/v1/secondary",
      createSecondaryMarketRouter({ secondaryMarketService, authService })
    );
  }

  if (watchlistService && authService) {
    app.use("/api/v1/watchlist", createWatchlistRouter({ watchlistService, authService }));
  }

  // ---- Keys: Ratings Leaderboard ----
  if (ratingsLeaderboardService) {
    app.use("/api/v1/keys", createKeysRouter({ ratingsLeaderboardService }));
  }

  // ---- Dividends: Cycle Config & Distribution ----
  if (dividendCycleService) {
    app.use("/api/v1/dividends", createDividendsRouter({ dividendCycleService, authService }));
  }

  if (config?.admin?.ipWhitelist?.length) {
    app.use(
      "/api/v1/admin",
      createAdminRouter({
        dataSource,
        allowedCidrs: config.admin.ipWhitelist,
        invoiceService,
        extensionService,
        metricsService: adminMetricsService,
      })
    );
  }

  app.use(notFoundMiddleware);
  app.use(createErrorMiddleware(appLogger));

  return app;
}
