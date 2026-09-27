import { Router } from "express";
import { DataSource } from "typeorm";

import { ipWhitelistMiddleware } from "@/middleware/ip-whitelist.middleware";
import type { InvoiceService } from "@/services/invoice.service";
import type { InvoiceExtensionService } from "@/services/invoice-extension.service";
import type { AdminMetricsService } from "@/services/admin-metrics.service";
import { approveKYC } from "./approve-kyc";
import { rejectKYC } from "./reject-kyc";
import { revokeKYC } from "./revoke-kyc";
import { approveInvoice } from "./approve-invoice";
import { rejectInvoice } from "./reject-invoice";
import { createRoyaltyAnalyticsService } from "@/services/royalty-analytics.service";
import { createAdminRoyaltiesRouter } from "./royalties.routes";
import { createAnalyticsSnapshotService } from "@/services/analytics-snapshot.service";
import { createAdminAnalyticsTrendsRouter } from "./analytics-trends.routes";

export interface AdminRouterDependencies {
  dataSource: DataSource;
  allowedCidrs: string[];
  /** Optional: enables POST /invoices/:id/approve and /invoices/:id/reject.
   *  Omitted deployments (e.g. minimal test apps) simply won't mount them. */
  invoiceService?: InvoiceService;
  /** Issue #477 — admin approval gate for funding deadline extensions. */
  extensionService?: InvoiceExtensionService;
  /** Issue #478 — platform metrics aggregation for the admin dashboard. */
  metricsService?: AdminMetricsService;
}

export function createAdminRouter({
  dataSource,
  allowedCidrs,
  invoiceService,
  extensionService: _extensionService,
  metricsService: _metricsService,
}: AdminRouterDependencies): Router {
  const router = Router();
  const ipWhitelist = ipWhitelistMiddleware(allowedCidrs);

  // Admin-only: IP whitelist is the role gate for this router (issue #478).
  router.use(ipWhitelist);

  router.post("/approve-kyc", (req, res) => {
    approveKYC(req, res, dataSource);
  });

  router.post("/reject-kyc", (req, res) => {
    rejectKYC(req, res, dataSource);
  });

  router.post("/revoke-kyc", (req, res) => {
    revokeKYC(req, res, dataSource);
  });

  if (invoiceService) {
    router.post("/invoices/:id/approve", (req, res) => {
      approveInvoice(req, res, invoiceService);
    });

    router.post("/invoices/:id/reject", (req, res) => {
      rejectInvoice(req, res, invoiceService);
    });
  }

  // ---- Royalty analytics (GET /admin/royalties/analytics) ----
  const royaltyAnalyticsService = createRoyaltyAnalyticsService(dataSource);
  router.use("/royalties", createAdminRoyaltiesRouter({ royaltyAnalyticsService }));

  // ---- Analytics trends / daily snapshots (GET /admin/analytics/trends) ----
  const analyticsSnapshotService = createAnalyticsSnapshotService(dataSource);
  router.use("/analytics", createAdminAnalyticsTrendsRouter({ analyticsSnapshotService }));

  return router;
}
