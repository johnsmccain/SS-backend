import { DataSource, EntityManager } from "typeorm";
import { Decimal } from "decimal.js";
import { Invoice } from "../models/Invoice.model";
import { Investment } from "../models/Investment.model";
import { User } from "../models/User.model";
import { InvestorReturn } from "../models/InvestorReturn.model";
import { SettlementRemainder } from "../models/SettlementRemainder.model";
import { InvoiceStatus, InvestmentStatus, NotificationType } from "../types/enums";
import { TransactionStatus, TransactionType } from "../types/enums";
import { Transaction } from "../models/Transaction.model";
import { ServiceError } from "../utils/service-error";
import { computeInvestorReturn } from "../lib/investor-return";
import { decimalStringToScaledBigInt, scaledBigIntToDecimalString } from "../lib/decimal-bigint";
import {
  createInvoiceStateMachine,
  entityManagerTransitionStore,
  type InvoiceStateMachine,
} from "../lib/invoice-state-machine";
import { logger } from "../observability/logger";
import {
  logSettlementStart,
  logSettlementFailure,
  logSettlementSuccess,
} from "../lib/settlement-observability";
import {
  settlementEventEmitter,
  SettlementEventEmitter,
  type SettlementEventPayload,
  type SettlementEventListener,
} from "../lib/settlement-events";
import type { PaymentDistributorContractService } from "./stellar/payment-distributor-contract.service";
import type { NotificationService } from "./notification.service";

// settlement.service.ts stores/computes amounts as decimal strings scaled by
// 10^4 (see decimal-bigint.ts), while stroopsToXlm expects a stroops count
// (10^7 scale). Multiplying by 10^3 converts between the two without any
// loss of precision, since 7 - 4 = 3.
const DECIMAL_SCALE_TO_STROOP_FACTOR = 10n ** 3n;

export interface SettleInvoiceInput {
  invoiceId: string;
  proceeds: string;
  actorWallet: string;
  sellerId?: string;
}

export interface PaymentDistributorSettlementConfig {
  feeRecipient: string;
  feeBps: number;
}

export interface InvestorSettlement {
  investmentId: string;
  investorId: string;
  investmentAmount: string;
  actualReturn: string;
}

export interface SettleInvoiceResult {
  invoiceId: string;
  sellerId?: string;
  status: InvoiceStatus.SETTLED;
  proceeds: string;
  totalDistributed: string;
  remainder: string;
  remainderDust: string;
  settlements: InvestorSettlement[];
  distributionTransactionHash?: string;
}

export class SettlementService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly paymentDistributor?: PaymentDistributorContractService,
    private readonly distributorConfig?: PaymentDistributorSettlementConfig,
    private readonly stateMachine: InvoiceStateMachine = createInvoiceStateMachine(),
    private readonly eventEmitter: SettlementEventEmitter = settlementEventEmitter,
    private readonly notificationService?: NotificationService
  ) {}

  /**
   * Registers a callback listener for settlement events.
   */
  public onSettlement(listener: SettlementEventListener): this {
    this.eventEmitter.on("settlement", listener);
    return this;
  }

  /**
   * Returns the event emitter instance used by this service.
   */
  public getEventEmitter(): SettlementEventEmitter {
    return this.eventEmitter;
  }

  /**
   * Calculates each fractional investor's return using floor division,
   * along with the total distributed amount and remainder dust.
   *
   * Verifies that the sum of all returns never exceeds the distributable settlement amount.
   */
  public calculateInvestorReturns(
    investments: Array<{ id: string; investorId: string; investmentAmount: string }>,
    proceedsAmount: string | Decimal,
    feeBps = 0
  ): {
    totalFunded: string;
    distributable: string;
    fee: string;
    totalDistributed: string;
    remainder: string;
    returns: Array<{
      investmentId: string;
      investorId: string;
      investmentAmount: string;
      returnAmount: string;
    }>;
  } {
    const proceeds = new Decimal(proceedsAmount);
    if (proceeds.isNegative() || proceeds.isZero()) {
      throw new ServiceError("INVALID_PROCEEDS", "Settlement proceeds must be greater than zero");
    }

    const totalFunded = investments.reduce(
      (sum, inv) => sum.plus(new Decimal(inv.investmentAmount)),
      new Decimal(0)
    );
    if (totalFunded.isZero() || totalFunded.isNegative()) {
      throw new ServiceError(
        "INVALID_FUNDED_AMOUNT",
        "Total funded amount must be greater than zero"
      );
    }

    const totalFundedScaled = decimalStringToScaledBigInt(totalFunded.toFixed(4));
    const proceedsScaled = decimalStringToScaledBigInt(proceeds.toFixed(4));
    const feeScaled = feeBps > 0 ? (proceedsScaled * BigInt(feeBps)) / 10_000n : 0n;
    const distributableScaled = proceedsScaled - feeScaled;

    let sumOfReturnsScaled = 0n;
    const returns: Array<{
      investmentId: string;
      investorId: string;
      investmentAmount: string;
      returnAmount: string;
    }> = [];

    for (const inv of investments) {
      const investmentAmountScaled = decimalStringToScaledBigInt(inv.investmentAmount);
      const returnScaled = computeInvestorReturn(
        investmentAmountScaled,
        totalFundedScaled,
        distributableScaled
      );
      sumOfReturnsScaled += returnScaled;
      returns.push({
        investmentId: inv.id,
        investorId: inv.investorId,
        investmentAmount: inv.investmentAmount,
        returnAmount: scaledBigIntToDecimalString(returnScaled),
      });
    }

    const remainderScaled = distributableScaled - sumOfReturnsScaled;

    return {
      totalFunded: totalFunded.toFixed(4),
      distributable: scaledBigIntToDecimalString(distributableScaled),
      fee: scaledBigIntToDecimalString(feeScaled),
      totalDistributed: scaledBigIntToDecimalString(sumOfReturnsScaled),
      remainder: scaledBigIntToDecimalString(remainderScaled),
      returns,
    };
  }

  /**
   * Settles a funded invoice by distributing proceeds to each investor
   * pro-rata to their share using floor division.
   *
   * Records individual return amounts in the investor_returns table,
   * handles remainder dust after floor division separately, and emits
   * a settlement event for downstream processing.
   */
  async settleInvoice(input: SettleInvoiceInput): Promise<SettleInvoiceResult> {
    const { invoiceId, proceeds: proceedsInput, actorWallet, sellerId } = input;

    const proceeds = new Decimal(proceedsInput);
    if (proceeds.isNegative() || proceeds.isZero()) {
      throw new ServiceError("INVALID_PROCEEDS", "Settlement proceeds must be greater than zero");
    }

    const startedAt = Date.now();
    logSettlementStart(logger, {
      invoiceId,
      actorWallet,
      startedAt: new Date(startedAt).toISOString(),
    });

    try {
      const { result, transition, proceedsScaled, settlementEvent } =
        await this.dataSource.transaction(async (transactionalEntityManager: EntityManager) => {
          // 1. Lock the invoice row for update (if supported by the driver).
          //    SQLite does not support row-level locking, so we fall back to a plain read.
          let invoice: Invoice | null;
          try {
            invoice = await transactionalEntityManager
              .createQueryBuilder(Invoice, "invoice")
              .setLock("pessimistic_write")
              .where("invoice.id = :id", { id: invoiceId })
              .getOne();
          } catch {
            invoice = await transactionalEntityManager
              .createQueryBuilder(Invoice, "invoice")
              .where("invoice.id = :id", { id: invoiceId })
              .getOne();
          }

          if (!invoice) {
            throw new ServiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
          }

          if (sellerId && invoice.sellerId && invoice.sellerId !== sellerId) {
            throw new ServiceError("FORBIDDEN", "Only the seller can settle this invoice", 403);
          }

          if (actorWallet && invoice.sellerId && typeof transactionalEntityManager.findOne === "function") {
            const seller = await transactionalEntityManager.findOne(User, {
              where: { id: invoice.sellerId },
            });
            if (seller && seller.stellarAddress && seller.stellarAddress !== actorWallet) {
              throw new ServiceError("FORBIDDEN", "Only the invoice seller can settle this invoice", 403);
            }
          }

          // 2. Validate invoice status
          if (invoice.status === InvoiceStatus.SETTLED) {
            throw new ServiceError(
              "invoice_already_settled",
              "Cannot settle an invoice with status settled",
              409
            );
          }
          if (invoice.status !== InvoiceStatus.FUNDED) {
            throw new ServiceError(
              "INVALID_INVOICE_STATUS",
              `INVALID_INVOICE_STATUS: Cannot settle an invoice with status ${invoice.status}`
            );
          }

          // 3. Find confirmed investments backing this invoice
          const investments = await transactionalEntityManager.find(Investment, {
            where: { invoiceId: invoice.id, status: InvestmentStatus.CONFIRMED },
            relations: { investor: true },
          });

          if (investments.length === 0) {
            throw new ServiceError(
              "NO_CONFIRMED_INVESTMENTS",
              "Invoice has no confirmed investments to settle"
            );
          }

          // 4. Distribute proceeds pro-rata to each investor's share using floor division
          const totalFunded = investments.reduce(
            (sum, investment) => sum.plus(new Decimal(investment.investmentAmount)),
            new Decimal(0)
          );
          const totalFundedScaled = decimalStringToScaledBigInt(totalFunded.toFixed(4));
          const proceedsScaled = decimalStringToScaledBigInt(proceeds.toFixed(4));
          const feeScaled = this.distributorConfig
            ? (proceedsScaled * BigInt(this.distributorConfig.feeBps)) / 10_000n
            : 0n;
          const distributableScaled = proceedsScaled - feeScaled;
          const settlements: InvestorSettlement[] = [];
          let distributionTransactionHash: string | undefined;

          if (this.paymentDistributor) {
            if (!this.distributorConfig) {
              throw new ServiceError(
                "DISTRIBUTOR_CONFIGURATION_MISSING",
                "Payment distributor fee configuration is required"
              );
            }
            const distribution = await this.paymentDistributor.distributePayouts({
              invoiceId: invoice.id,
              totalAmountStroops: proceedsScaled * DECIMAL_SCALE_TO_STROOP_FACTOR,
              feeRecipient: this.distributorConfig.feeRecipient,
              feeBps: this.distributorConfig.feeBps,
              recipients: investments.map((investment) => ({
                address: investment.investor?.stellarAddress ?? investment.investorId,
                amountStroops:
                  computeInvestorReturn(
                    decimalStringToScaledBigInt(investment.investmentAmount),
                    totalFundedScaled,
                    distributableScaled
                  ) * DECIMAL_SCALE_TO_STROOP_FACTOR,
              })),
            });
            distributionTransactionHash = distribution.transactionHash;
            await transactionalEntityManager.save(
              Transaction,
              transactionalEntityManager.create(Transaction, {
                userId: invoice.sellerId,
                invoiceId: invoice.id,
                investmentId: null,
                type: TransactionType.PAYMENT,
                amount: proceeds.toFixed(4),
                stellarTxHash: distribution.transactionHash,
                stellarOperationIndex: 0,
                status: TransactionStatus.COMPLETED,
              })
            );
          }

          let sumOfReturnsScaled = 0n;

          for (const investment of investments) {
            const investmentAmountScaled = decimalStringToScaledBigInt(investment.investmentAmount);
            // Calculate each investor's share using floor division on total return amount
            const actualReturnScaled = computeInvestorReturn(
              investmentAmountScaled,
              totalFundedScaled,
              distributableScaled
            );
            sumOfReturnsScaled += actualReturnScaled;

            const actualReturnStr = scaledBigIntToDecimalString(actualReturnScaled);
            investment.actualReturn = actualReturnStr;
            investment.status = InvestmentStatus.SETTLED;
            await transactionalEntityManager.save(Investment, investment);

            // Record individual return amounts in investor_returns table
            const investorReturnRecord = transactionalEntityManager.create(InvestorReturn, {
              invoiceId: invoice.id,
              investmentId: investment.id,
              investorId: investment.investorId,
              returnAmount: actualReturnStr,
              amount: actualReturnStr,
            });
            await transactionalEntityManager.save(InvestorReturn, investorReturnRecord);

            settlements.push({
              investmentId: investment.id,
              investorId: investment.investorId,
              investmentAmount: investment.investmentAmount,
              actualReturn: investment.actualReturn,
            });
          }

          // Handle remainder dust after floor division
          // The remainder is handled and recorded separately from investor returns.
          const remainderScaled = distributableScaled - sumOfReturnsScaled;
          const remainderStr = scaledBigIntToDecimalString(remainderScaled);
          const totalDistributedStr = scaledBigIntToDecimalString(sumOfReturnsScaled);

          // Record remainder on the invoice
          invoice.settlementRemainder = remainderStr;

          // Record remainder in settlement_remainders table
          const settlementRemainderRecord = transactionalEntityManager.create(SettlementRemainder, {
            invoiceId: invoice.id,
            remainderAmount: remainderStr,
            totalSettlementAmount: proceeds.toFixed(4),
            totalDistributedAmount: totalDistributedStr,
          });
          await transactionalEntityManager.save(SettlementRemainder, settlementRemainderRecord);

          // 5. Transition invoice to SETTLED (history row written in this transaction)
          const transition = await this.stateMachine.transition(
            entityManagerTransitionStore(transactionalEntityManager),
            invoice,
            InvoiceStatus.SETTLED,
            { actor: { role: "system", wallet: actorWallet }, trigger: "admin_settled" }
          );

          const eventPayload: SettlementEventPayload = {
            invoiceId: invoice.id,
            sellerId: invoice.sellerId,
            totalSettlementAmount: proceeds.toFixed(4),
            totalDistributedAmount: totalDistributedStr,
            remainderAmount: remainderStr,
            settledAt: new Date(),
            distributionTransactionHash: distributionTransactionHash ?? null,
            returns: settlements.map((s) => ({
              investmentId: s.investmentId,
              investorId: s.investorId,
              returnAmount: s.actualReturn,
            })),
          };

          return {
            transition,
            proceedsScaled,
            settlementEvent: eventPayload,
            result: {
              invoiceId: invoice.id,
              sellerId: invoice.sellerId,
              status: InvoiceStatus.SETTLED as const,
              proceeds: proceeds.toFixed(4),
              totalDistributed: totalDistributedStr,
              remainder: remainderStr,
              remainderDust: remainderStr,
              settlements,
              distributionTransactionHash,
            },
          };
        });

      await this.stateMachine.dispatch(transition);

      // Emit settlement event for downstream processing
      this.eventEmitter.emitSettlement(settlementEvent);

      // Dispatch settlement notifications to all holders
      if (this.notificationService) {
        try {
          for (const settlement of result.settlements) {
            await this.notificationService.createNotification(
              settlement.investorId,
              NotificationType.SETTLEMENT_RECEIVED,
              "Settlement Received",
              `You have received ${settlement.actualReturn} for your investment in invoice #${result.invoiceId}`,
              {
                invoiceId: result.invoiceId,
                investmentId: settlement.investmentId,
                amount: settlement.actualReturn,
              }
            );
          }
          logger.info("settlement.notifications.sent", {
            invoiceId: result.invoiceId,
            recipientCount: result.settlements.length,
          });
        } catch (notificationError) {
          logger.error("settlement.notifications.failed", {
            invoiceId: result.invoiceId,
            error: notificationError instanceof Error ? notificationError.message : String(notificationError),
          });
          // Don't fail the settlement if notifications fail
        }
      }

      logSettlementSuccess(logger, {
        invoiceId: result.invoiceId,
        totalProceedsStroops: proceedsScaled * DECIMAL_SCALE_TO_STROOP_FACTOR,
        investorCount: result.settlements.length,
        durationMs: Date.now() - startedAt,
        distributionTxHash: result.distributionTransactionHash ?? null,
      });

      return result;
    } catch (err) {
      logSettlementFailure(logger, {
        invoiceId,
        error: err,
        durationMs: Date.now() - startedAt,
        category: err instanceof ServiceError ? err.code : undefined,
      });

      throw err;
    }
  }
}

export function createSettlementService(
  dataSource: DataSource,
  paymentDistributor?: PaymentDistributorContractService,
  distributorConfig?: PaymentDistributorSettlementConfig,
  stateMachine?: InvoiceStateMachine,
  eventEmitter?: SettlementEventEmitter,
  notificationService?: NotificationService
): SettlementService {
  return new SettlementService(
    dataSource,
    paymentDistributor,
    distributorConfig,
    stateMachine,
    eventEmitter,
    notificationService
  );
}
