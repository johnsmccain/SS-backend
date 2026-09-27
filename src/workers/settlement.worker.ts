import cron from "node-cron";
import { DataSource } from "typeorm";
import { Invoice } from "../models/Invoice.model";
import { InvoiceStatus } from "../types/enums";
import { SettlementService } from "../services/settlement.service";
import { logger } from "../observability/logger";

export interface SettlementWorkerDependencies {
  dataSource: DataSource;
  settlementService: SettlementService;
}

export class SettlementWorker {
  private cronJob: cron.ScheduledTask | null = null;
  private isRunning = false;

  constructor(private readonly dependencies: SettlementWorkerDependencies) {}

  /**
   * Start the settlement worker cron job.
   * Runs every hour to check for invoices that have reached maturity.
   */
  start(cronExpression: string = "0 * * * *"): void {
    if (this.cronJob) {
      logger.warn("Settlement worker is already running");
      return;
    }

    this.cronJob = cron.schedule(cronExpression, async () => {
      if (this.isRunning) {
        logger.info("Settlement worker already running, skipping this cycle");
        return;
      }

      await this.processMaturedInvoices();
    });

    logger.info("Settlement worker started", { cronExpression });
  }

  /**
   * Stop the settlement worker cron job.
   */
  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      logger.info("Settlement worker stopped");
    }
  }

  /**
   * Process all invoices that have reached maturity date.
   * This is the main settlement logic triggered by the cron job.
   */
  private async processMaturedInvoices(): Promise<void> {
    this.isRunning = true;
    const startTime = Date.now();

    try {
      logger.info("Settlement worker cycle started");

      const { dataSource, settlementService } = this.dependencies;

      // Find all funded invoices that have passed their due date
      const invoiceRepository = dataSource.getRepository(Invoice);
      const maturedInvoices = await invoiceRepository.find({
        where: {
          status: InvoiceStatus.FUNDED,
        },
        order: { dueDate: "ASC" },
      });

      const now = new Date();
      const eligibleInvoices = maturedInvoices.filter(
        (invoice) => invoice.dueDate && new Date(invoice.dueDate) <= now
      );

      logger.info("Found matured invoices", {
        total: maturedInvoices.length,
        eligible: eligibleInvoices.length,
      });

      let processedCount = 0;
      let failedCount = 0;

      for (const invoice of eligibleInvoices) {
        try {
          logger.info("Processing matured invoice", {
            invoice_id: invoice.id,
            invoice_number: invoice.invoiceNumber,
            due_date: invoice.dueDate,
          });

          // For automatic settlement, we need the proceeds amount
          // In a real implementation, this would come from:
          // 1. Oracle data feed
          // 2. Admin-configured proceeds
          // 3. Smart contract data
          // For now, we'll use the invoice amount as proceeds (simplified)
          const proceeds = invoice.amount;

          await settlementService.settleInvoice({
            invoiceId: invoice.id,
            proceeds,
            actorWallet: invoice.sellerWallet || "system",
            sellerId: invoice.sellerId,
          });

          processedCount++;
          logger.info("Successfully settled matured invoice", {
            invoice_id: invoice.id,
            invoice_number: invoice.invoiceNumber,
          });
        } catch (error) {
          failedCount++;
          logger.error("Failed to settle matured invoice", {
            invoice_id: invoice.id,
            invoice_number: invoice.invoiceNumber,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const duration = Date.now() - startTime;
      logger.info("Settlement worker cycle completed", {
        processed: processedCount,
        failed: failedCount,
        duration_ms: duration,
      });
    } catch (error) {
      logger.error("Settlement worker cycle failed", {
        error: error instanceof Error ? error.message : String(error),
        duration_ms: Date.now() - startTime,
      });
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Manually trigger settlement processing (for admin endpoint).
   */
  async triggerManualSettlement(invoiceId: string, proceeds: string, actorWallet: string): Promise<void> {
    logger.info("Manual settlement triggered", {
      invoice_id: invoiceId,
      proceeds,
      actor_wallet: actorWallet,
    });

    try {
      await this.dependencies.settlementService.settleInvoice({
        invoiceId,
        proceeds,
        actorWallet,
      });

      logger.info("Manual settlement completed", { invoice_id: invoiceId });
    } catch (error) {
      logger.error("Manual settlement failed", {
        invoice_id: invoiceId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

export function createSettlementWorker(
  dataSource: DataSource,
  settlementService: SettlementService
): SettlementWorker {
  return new SettlementWorker({ dataSource, settlementService });
}
