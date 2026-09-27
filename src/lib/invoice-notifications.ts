import { Decimal } from "decimal.js";
import { In, type DataSource } from "typeorm";
import { Investment } from "../models/Investment.model";
import type { Invoice } from "../models/Invoice.model";
import { logger as defaultLogger, type AppLogger } from "../observability/logger";
import { InvestmentStatus, InvoiceStatus, NotificationType } from "../types/enums";
import type { TransitionEffect } from "./invoice-state-machine";

/**
 * In-app notifications for invoice lifecycle events (issue #467).
 *
 * Sellers hear about every status change through the state machine's seller
 * effect. This module covers the rest: both parties on a new investment, and
 * every investor on an invoice when it is funded or settled.
 */

export interface NotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  data?: Record<string, unknown>;
}

/** Satisfied by `NotificationService.createNotifications`. */
export interface BulkNotificationSink {
  createNotifications(entries: NotificationInput[]): Promise<void>;
}

/** Finds who has money in an invoice. */
export interface InvestorDirectory {
  findInvestorIds(invoiceId: string): Promise<string[]>;
}

// Cancelled commitments no longer have a stake in the invoice's outcome.
const STAKED_INVESTMENT_STATUSES = [
  InvestmentStatus.PENDING,
  InvestmentStatus.CONFIRMED,
  InvestmentStatus.SETTLED,
];

export function createInvestorDirectory(dataSource: DataSource): InvestorDirectory {
  return {
    async findInvestorIds(invoiceId) {
      const rows = await dataSource.getRepository(Investment).find({
        select: { investorId: true },
        where: { invoiceId, status: In(STAKED_INVESTMENT_STATUSES) },
      });
      return [...new Set(rows.map((row) => row.investorId))];
    },
  };
}

const INVESTOR_MESSAGES: Partial<
  Record<InvoiceStatus, { type: NotificationType; title: string; message: (i: Invoice) => string }>
> = {
  [InvoiceStatus.FUNDED]: {
    type: NotificationType.INVOICE_FUNDED,
    title: "Invoice Funded",
    message: (invoice) =>
      `Invoice ${invoice.invoiceNumber} is now fully funded. Your investment is locked in until settlement.`,
  },
  [InvoiceStatus.SETTLED]: {
    type: NotificationType.INVOICE_SETTLED,
    title: "Invoice Settled",
    message: (invoice) =>
      `Invoice ${invoice.invoiceNumber} has settled and your return has been distributed.`,
  },
};

/**
 * State machine effect notifying every investor in an invoice when it is
 * funded or settled. Each investor gets one notification even if they hold
 * several positions in the invoice.
 */
export function createInvestorNotificationEffect(
  sink: BulkNotificationSink,
  directory: InvestorDirectory
): TransitionEffect {
  return async function notifyInvestors(transition) {
    const template = INVESTOR_MESSAGES[transition.to];
    if (!template) return;

    const investorIds = await directory.findInvestorIds(transition.invoice.id);
    await sink.createNotifications(
      investorIds.map((userId) => ({
        userId,
        type: template.type,
        title: template.title,
        message: template.message(transition.invoice),
      }))
    );
  };
}

export interface InvestmentCreatedEvent {
  invoice: Pick<Invoice, "id" | "sellerId" | "invoiceNumber">;
  investment: Pick<Investment, "id" | "investorId" | "investmentAmount">;
}

/** Notifications for a newly committed investment: one to the investor, one to the seller. */
export function buildInvestmentCreatedNotifications({
  invoice,
  investment,
}: InvestmentCreatedEvent): NotificationInput[] {
  const amount = new Decimal(investment.investmentAmount).toFixed(4);
  return [
    {
      userId: investment.investorId,
      type: NotificationType.INVESTMENT_CREATED,
      title: "Investment Recorded",
      message: `Your investment of ${amount} in invoice ${invoice.invoiceNumber} has been recorded.`,
    },
    {
      userId: invoice.sellerId,
      type: NotificationType.INVESTMENT_CREATED,
      title: "New Investment",
      message: `An investor committed ${amount} to your invoice ${invoice.invoiceNumber}.`,
    },
  ];
}

export interface InvestmentNotifier {
  investmentCreated(event: InvestmentCreatedEvent): Promise<void>;
}

/**
 * Sends new-investment notifications. Failures are logged rather than
 * thrown: the investment is already committed and must not be reported to
 * the investor as failed because a notification could not be stored.
 */
export function createInvestmentNotifier(
  sink: BulkNotificationSink,
  log: AppLogger = defaultLogger
): InvestmentNotifier {
  return {
    async investmentCreated(event) {
      try {
        await sink.createNotifications(buildInvestmentCreatedNotifications(event));
      } catch (error) {
        log.warn("Failed to send new-investment notifications.", {
          invoice_id: event.invoice.id,
          investment_id: event.investment.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
