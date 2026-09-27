import { Router, type RequestHandler } from "express";
import { SettlementController } from "../controllers/settlement.controller";
import type { SettlementService } from "../services/settlement.service";
import { authenticateJWT } from "../middleware/auth.middleware";
import { checkContractNotPaused } from "../middleware/contract-pause-guard.middleware";
import type { ContractGuardService } from "../services/stellar/contract-guard.service";
import type { SettlementWorker } from "../workers/settlement.worker";

export interface SettlementRouterDependencies {
  settlementService: SettlementService;
  settlementWorker?: SettlementWorker;
  contractGuardService?: ContractGuardService;
  contractId?: string | null;
}

export function createSettlementRouter({
  settlementService,
  settlementWorker,
  contractGuardService,
  contractId = null,
}: SettlementRouterDependencies): Router {
  const router = Router();
  const controller = new SettlementController(settlementService);

  const pauseGuard: RequestHandler[] = contractGuardService
    ? [checkContractNotPaused({ contractGuardService, contractId })]
    : [];

  // POST /api/v1/settlements/:invoiceId - Settle a funded invoice and
  // distribute pro-rata returns to its confirmed investors
  router.post("/:invoiceId", authenticateJWT, ...pauseGuard, controller.settleInvoice);

  // POST /api/v1/settlements/admin/trigger/:invoiceId - Admin endpoint to manually trigger settlement
  if (settlementWorker) {
    router.post("/admin/trigger/:invoiceId", authenticateJWT, async (req, res) => {
      try {
        if (!req.user) {
          return res.status(401).json({ error: "Unauthorized" });
        }

        const { invoiceId } = req.params;
        const { proceeds } = req.body;

        if (!proceeds) {
          return res.status(400).json({
            error: {
              code: "MISSING_FIELDS",
              message: "proceeds is required",
            },
          });
        }

        await settlementWorker.triggerManualSettlement(
          Array.isArray(invoiceId) ? invoiceId[0] : invoiceId,
          Array.isArray(proceeds) ? proceeds[0] : proceeds,
          req.user.stellarAddress
        );

        return res.status(200).json({
          success: true,
          message: "Settlement triggered successfully",
        });
      } catch (err: unknown) {
        const statusCode =
          (err as { statusCode?: number }).statusCode || (err as { status?: number }).status || 400;
        return res.status(statusCode).json({
          error: {
            code: (err as { code?: string }).code || "INTERNAL_ERROR",
            message: (err as { message?: string }).message || "Internal server error",
          },
        });
      }
    });
  }

  return router;
}
