import { Router, Response, NextFunction } from "express";
import { DividendCycleService } from "../services/dividend-cycle.service";
import { DividendCycleFrequency } from "../models/DividendCycleConfig.model";
import { AppError } from "../utils/http-error";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import type { AuthService } from "../services/auth.service";
import type { AuthenticatedRequest } from "../types/auth";
import { logger } from "../observability/logger";

export interface DividendsRouterDependencies {
  dividendCycleService: DividendCycleService;
  authService: AuthService;
}

/**
 * Dividend distribution cycle routes:
 *
 *   GET  /dividends/cycle-config          - Returns current cycle frequency and next distribution date
 *   PATCH /dividends/cycle-config         - Updates cycle frequency (weekly | monthly | quarterly)
 *   POST  /dividends/distribute           - Triggers an immediate manual distribution (issuer only)
 *   GET   /dividends/history              - Paginated distribution history (cursor-based)
 */
export function createDividendsRouter({
  dividendCycleService,
  authService,
}: DividendsRouterDependencies): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(authService);

  /**
   * GET /dividends/cycle-config
   * Returns the current cycle config for the authenticated issuer wallet.
   */
  router.get(
    "/cycle-config",
    requireAuth,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
      try {
        const issuerWallet = req.user?.stellarAddress;
        if (!issuerWallet) {
          next(new AppError(401, "Authentication required.", "UNAUTHENTICATED"));
          return;
        }

        const config = await dividendCycleService.getCycleConfig(issuerWallet);

        res.status(200).json({
          success: true,
          data: config,
        });
      } catch (error) {
        logger.error("GET /dividends/cycle-config failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        next(
          error instanceof AppError
            ? error
            : new AppError(500, "Failed to retrieve cycle config", "CYCLE_CONFIG_ERROR")
        );
      }
    }
  );

  /**
   * PATCH /dividends/cycle-config
   * Updates cycle frequency and recalculates next distribution date.
   * Body: { frequency: "weekly" | "monthly" | "quarterly" }
   */
  router.patch(
    "/cycle-config",
    requireAuth,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
      try {
        const issuerWallet = req.user?.stellarAddress;
        if (!issuerWallet) {
          next(new AppError(401, "Authentication required.", "UNAUTHENTICATED"));
          return;
        }

        const { frequency } = req.body as { frequency?: string };
        if (!frequency) {
          next(new AppError(400, "'frequency' field is required.", "MISSING_FREQUENCY"));
          return;
        }

        const validFrequencies = Object.values(DividendCycleFrequency);
        if (!validFrequencies.includes(frequency as DividendCycleFrequency)) {
          next(
            new AppError(
              400,
              `Invalid frequency. Must be one of: ${validFrequencies.join(", ")}`,
              "INVALID_FREQUENCY"
            )
          );
          return;
        }

        const updated = await dividendCycleService.updateCycleFrequency(
          issuerWallet,
          frequency as DividendCycleFrequency
        );

        res.status(200).json({
          success: true,
          data: updated,
        });
      } catch (error) {
        logger.error("PATCH /dividends/cycle-config failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        next(
          error instanceof AppError
            ? error
            : new AppError(500, "Failed to update cycle config", "CYCLE_CONFIG_UPDATE_ERROR")
        );
      }
    }
  );

  /**
   * POST /dividends/distribute
   * Triggers an immediate manual distribution for the issuer.
   * Body: { issuerWallet: string }  — wallet used to identify the issuer (must match authenticated wallet)
   */
  router.post(
    "/distribute",
    requireAuth,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
      try {
        const triggerWallet = req.user?.stellarAddress;
        if (!triggerWallet) {
          next(new AppError(401, "Authentication required.", "UNAUTHENTICATED"));
          return;
        }

        // issuerWallet can be provided in body; if omitted defaults to authenticated wallet
        const issuerWallet: string =
          (req.body as { issuerWallet?: string })?.issuerWallet ?? triggerWallet;

        const distribution = await dividendCycleService.triggerManualDistribution(
          issuerWallet,
          triggerWallet
        );

        res.status(200).json({
          success: true,
          data: distribution,
        });
      } catch (error) {
        logger.error("POST /dividends/distribute failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        next(
          error instanceof AppError
            ? error
            : new AppError(500, "Failed to trigger distribution", "DISTRIBUTION_TRIGGER_ERROR")
        );
      }
    }
  );

  /**
   * GET /dividends/history
   * Returns paginated distribution history for the authenticated issuer.
   * Query params:
   *   - limit   (optional, default 20, max 100)
   *   - cursor  (optional, ISO timestamp of last item's distributedAt)
   */
  router.get(
    "/history",
    requireAuth,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
      try {
        const issuerWallet = req.user?.stellarAddress;
        if (!issuerWallet) {
          next(new AppError(401, "Authentication required.", "UNAUTHENTICATED"));
          return;
        }

        const rawLimit = parseInt(String(req.query.limit ?? "20"), 10);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
        const cursor = req.query.cursor ? String(req.query.cursor) : null;

        const result = await dividendCycleService.getDistributionHistory(
          issuerWallet,
          limit,
          cursor
        );

        res.status(200).json({
          success: true,
          data: result.data,
          meta: {
            hasMore: result.hasMore,
            nextCursor: result.nextCursor,
          },
        });
      } catch (error) {
        logger.error("GET /dividends/history failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        next(
          error instanceof AppError
            ? error
            : new AppError(500, "Failed to retrieve distribution history", "HISTORY_ERROR")
        );
      }
    }
  );

  return router;
}
