import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
  VersionColumn,
  BeforeInsert,
  BeforeUpdate,
} from "typeorm";
import Decimal from "decimal.js";
import { InvoiceStatus } from "../types/enums";
import { logger } from "../observability/logger";
import { AppError } from "../utils/http-error";

/**
 * Frozen state transition map optimized for performance.
 * Prevents accidental mutations and enables faster lookups.
 */
export const VALID_INVOICE_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> =
  Object.freeze({
    [InvoiceStatus.DRAFT]: Object.freeze([
      InvoiceStatus.PUBLISHED,
      InvoiceStatus.CANCELLED,
      InvoiceStatus.REJECTED,
    ]),
    [InvoiceStatus.PENDING]: Object.freeze([
      InvoiceStatus.PUBLISHED,
      InvoiceStatus.CANCELLED,
      InvoiceStatus.REJECTED,
    ]),
    [InvoiceStatus.PUBLISHED]: Object.freeze([InvoiceStatus.FUNDED, InvoiceStatus.CANCELLED]),
    [InvoiceStatus.FUNDED]: Object.freeze([InvoiceStatus.SETTLED, InvoiceStatus.CANCELLED]),
    [InvoiceStatus.SETTLED]: Object.freeze([InvoiceStatus.CANCELLED]),
    [InvoiceStatus.CANCELLED]: Object.freeze([]),
    [InvoiceStatus.REJECTED]: Object.freeze([]),
  });

/**
 * Validation constraints for invoice fields.
 */
const VALIDATION_CONSTRAINTS = Object.freeze({
  INVOICE_NUMBER_MAX_LENGTH: 64,
  CUSTOMER_NAME_MAX_LENGTH: 255,
  IPFS_HASH_MAX_LENGTH: 128,
  SMART_CONTRACT_ID_MAX_LENGTH: 64,
  DISCOUNT_RATE_MAX: 100,
  MIN_RUNWAY_HOURS_DEFAULT: 24,
  DECIMAL_PRECISION: 4,
});

export interface PublicInvoiceDTO {
  id: string;
  sellerId: string;
  invoiceNumber: string;
  customerName: string;
  amount: string;
  discountRate: string;
  netAmount: string;
  dueDate: Date;
  ipfsHash: string | null;
  riskScore: string | null;
  status: InvoiceStatus;
  smartContractId: string | null;
  rejectionReason: string | null;
  title?: string | null;
  description?: string | null;
  faceValue?: string | null;
  fundingTarget?: string | null;
  yieldBps?: number | null;
  fundingDeadline?: Date | null;
  ipfsDocumentUrl?: string | null;
  sellerWallet?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Entity("invoices")
@Index("idx_invoices_seller_status_created", ["sellerId", "status", "createdAt"])
@Index("idx_invoices_status_due_date", ["status", "dueDate"])
@Index("idx_invoices_status_created_at", ["status", "createdAt"])
@Index("idx_invoices_status_amount", ["status", "amount"])
export class Invoice {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "seller_id", type: "uuid" })
  @Index("idx_invoices_seller_id")
  sellerId!: string;

  @Column({ name: "invoice_number", type: "varchar", length: 64 })
  @Index("idx_invoices_invoice_number", { unique: true })
  invoiceNumber!: string;

  @Column({ name: "customer_name", type: "varchar", length: 255 })
  @Index("idx_invoices_customer_name")
  customerName!: string;

  @Column({ type: "decimal", precision: 18, scale: 4, default: 0 })
  amount!: string;

  @Column({ name: "discount_rate", type: "decimal", precision: 5, scale: 2, default: 0 })
  discountRate!: string;

  @Column({ name: "net_amount", type: "decimal", precision: 18, scale: 4, default: 0 })
  netAmount!: string;

  /**
   * Total committed by investors so far. Only changed through atomic,
   * version-checked updates, and capped at netAmount by a CHECK constraint.
   */
  @Column({ name: "funded_amount", type: "decimal", precision: 18, scale: 4, default: 0 })
  fundedAmount?: string;

  /**
   * Remainder dust left over after floor division on settlement.
   * Handled and recorded separately from investor returns.
   */
  @Column({ name: "settlement_remainder", type: "decimal", precision: 18, scale: 4, default: 0 })
  settlementRemainder?: string;

  @Column({ name: "due_date", type: "date" })
  @Index("idx_invoices_due_date")
  dueDate!: Date;

  @Column({ name: "ipfs_hash", type: "varchar", length: 128, nullable: true })
  @Index("idx_invoices_ipfs_hash")
  ipfsHash!: string | null;

  @Column({ name: "risk_score", type: "decimal", precision: 5, scale: 2, nullable: true })
  riskScore!: string | null;

  @Column({
    type: "enum",
    enum: InvoiceStatus,
    default: InvoiceStatus.DRAFT,
  })
  @Index("idx_invoices_status")
  status!: InvoiceStatus;

  @Column({ name: "smart_contract_id", type: "varchar", length: 64, nullable: true })
  @Index("idx_invoices_smart_contract_id")
  smartContractId!: string | null;

  @Column({ name: "rejection_reason", type: "text", nullable: true })
  rejectionReason!: string | null;

  @Column({ type: "varchar", length: 255, nullable: true })
  title!: string | null;

  @Column({ type: "text", nullable: true })
  description!: string | null;

  @Column({ name: "face_value", type: "decimal", precision: 18, scale: 4, nullable: true })
  faceValue!: string | null;

  @Column({ name: "funding_target", type: "decimal", precision: 18, scale: 4, nullable: true })
  fundingTarget!: string | null;

  @Column({ name: "yield_bps", type: "int", nullable: true })
  yieldBps!: number | null;

  @Column({ name: "funding_deadline", type: "timestamptz", nullable: true })
  fundingDeadline!: Date | null;

  @Column({ name: "ipfs_document_url", type: "varchar", length: 512, nullable: true })
  ipfsDocumentUrl!: string | null;

  @Column({ name: "seller_wallet", type: "varchar", length: 56, nullable: true })
  @Index("idx_invoices_seller_wallet")
  sellerWallet!: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;

  @DeleteDateColumn({ name: "deleted_at" })
  deletedAt!: Date | null;

  @VersionColumn()
  version!: number;

  @ManyToOne("User", "invoices", { onDelete: "CASCADE", eager: false })
  @JoinColumn({ name: "seller_id" })
  seller!: import("./User.model").User;

  @OneToMany("Investment", "invoice")
  investments?: import("./Investment.model").Investment[];

  @OneToMany("Transaction", "invoice")
  transactions?: import("./Transaction.model").Transaction[];

  investorReturns?: import("./InvestorReturn.model").InvestorReturn[];

  settlementRemainders?: import("./SettlementRemainder.model").SettlementRemainder[];

  secondaryListings?: import("./SecondaryListing.model").SecondaryListing[];

  watchlistEntries?: import("./Watchlist.model").Watchlist[];

  /**
   * Calculates the exact net amount using arbitrary-precision decimal arithmetic.
   * Net Amount = amount * (1 - discountRate / 100) rounded to 4 decimal places.
   * Optimized with early validation and efficient decimal operations.
   *
   * @throws AppError if inputs are invalid or calculation fails
   */
  static calculateNetAmount(
    amount: string | number | Decimal,
    discountRate: string | number | Decimal
  ): string {
    try {
      // Convert to Decimal with error handling
      let amt: Decimal;
      let disc: Decimal;

      try {
        amt = new Decimal(amount);
        disc = new Decimal(discountRate);
      } catch {
        throw new AppError(
          400,
          "Amount and discount rate must be valid numeric values",
          "INVALID_AMOUNT_OR_DISCOUNT"
        );
      }

      // Validate constraints efficiently
      if (
        !amt.isFinite() ||
        !disc.isFinite() ||
        amt.isNegative() ||
        disc.isNegative() ||
        disc.gt(VALIDATION_CONSTRAINTS.DISCOUNT_RATE_MAX)
      ) {
        throw new AppError(
          400,
          "Amount must be non-negative and discount rate must be between 0 and 100",
          "INVALID_AMOUNT_OR_DISCOUNT"
        );
      }

      // Perform calculation with optimized precision
      const net = amt.minus(amt.times(disc.dividedBy(VALIDATION_CONSTRAINTS.DISCOUNT_RATE_MAX)));
      return net.toFixed(VALIDATION_CONSTRAINTS.DECIMAL_PRECISION);
    } catch (error) {
      // Re-throw AppError without wrapping
      if (error instanceof AppError) {
        throw error;
      }

      logger.error("Failed to calculate invoice net amount", {
        error: error instanceof Error ? error.message : String(error),
        amount: String(amount),
        discountRate: String(discountRate),
        context: "Invoice.calculateNetAmount",
      });

      throw new AppError(
        500,
        "Failed to calculate invoice net amount",
        "NET_AMOUNT_CALCULATION_FAILED"
      );
    }
  }

  /**
   * Sanitizes and normalizes invoice fields to prevent data corruption.
   * Optimized to minimize object traversal and reduce redundant operations.
   * Handles null/undefined gracefully without deep equality checks.
   *
   * @throws AppError if normalization fails
   */
  static sanitizeAndNormalize(invoice: Partial<Invoice>): void {
    try {
      // Helper function to trim and truncate strings
      const sanitizeString = (
        value: string | undefined | null,
        maxLength: number
      ): string | null => {
        if (value === undefined || value === null) return value as null;
        const trimmed = String(value).trim();
        return trimmed.length > 0 ? trimmed.slice(0, maxLength) : null;
      };

      // Sanitize string fields efficiently
      if (invoice.invoiceNumber !== undefined && invoice.invoiceNumber !== null) {
        invoice.invoiceNumber =
          sanitizeString(invoice.invoiceNumber, VALIDATION_CONSTRAINTS.INVOICE_NUMBER_MAX_LENGTH) ||
          invoice.invoiceNumber;
      }

      if (invoice.customerName !== undefined && invoice.customerName !== null) {
        invoice.customerName =
          sanitizeString(invoice.customerName, VALIDATION_CONSTRAINTS.CUSTOMER_NAME_MAX_LENGTH) ||
          invoice.customerName;
      }

      if (invoice.ipfsHash !== undefined) {
        invoice.ipfsHash = sanitizeString(
          invoice.ipfsHash,
          VALIDATION_CONSTRAINTS.IPFS_HASH_MAX_LENGTH
        );
      }

      if (invoice.smartContractId !== undefined) {
        invoice.smartContractId = sanitizeString(
          invoice.smartContractId,
          VALIDATION_CONSTRAINTS.SMART_CONTRACT_ID_MAX_LENGTH
        );
      }

      if (invoice.rejectionReason !== undefined) {
        invoice.rejectionReason = sanitizeString(invoice.rejectionReason, Number.MAX_SAFE_INTEGER);
      }

      // Auto-calculate netAmount only if both amount and discountRate are present and netAmount is unset
      if (
        invoice.amount !== undefined &&
        invoice.discountRate !== undefined &&
        invoice.amount !== null &&
        invoice.discountRate !== null &&
        (!invoice.netAmount || invoice.netAmount === "0" || invoice.netAmount === "0.0000")
      ) {
        try {
          const amtStr = String(invoice.amount).trim();
          const discStr = String(invoice.discountRate).trim();

          // Quick validation before expensive calculation
          if (amtStr && discStr && !isNaN(Number(amtStr)) && !isNaN(Number(discStr))) {
            invoice.netAmount = Invoice.calculateNetAmount(amtStr, discStr);
          }
        } catch (calcError) {
          // Log but don't throw - allow invoice to be created without netAmount
          logger.warn("Failed to auto-calculate netAmount during normalization", {
            error: calcError instanceof Error ? calcError.message : String(calcError),
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
          });
        }
      }
    } catch (error) {
      logger.error("Failed to sanitize/normalize invoice entity", {
        error: error instanceof Error ? error.message : String(error),
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        context: "Invoice.sanitizeAndNormalize",
      });

      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(
        500,
        `Invoice normalization failed: ${error instanceof Error ? error.message : String(error)}`,
        "INVOICE_NORMALIZATION_FAILED"
      );
    }
  }

  /**
   * Checks if a transition from current status to target status is valid.
   * Optimized with early exit and fallback safety.
   */
  static isValidTransition(currentStatus: InvoiceStatus, targetStatus: InvoiceStatus): boolean {
    try {
      const current = currentStatus ?? InvoiceStatus.DRAFT;
      const allowed = VALID_INVOICE_TRANSITIONS[current];

      // Handle edge case where status key doesn't exist
      if (!allowed) {
        logger.warn("Unknown invoice status in transition check", { status: current });
        return false;
      }

      return allowed.includes(targetStatus);
    } catch (error) {
      logger.error("Error checking invoice transition validity", {
        error: error instanceof Error ? error.message : String(error),
        currentStatus,
        targetStatus,
        context: "Invoice.isValidTransition",
      });
      return false;
    }
  }

  /**
   * Safely transitions the invoice status with validation.
   * Optimized to minimize state mutations and improve error context.
   *
   * @throws AppError if transition is invalid or operation fails
   */
  static transitionTo(
    invoice: Invoice,
    targetStatus: InvoiceStatus,
    rejectionReason?: string | null
  ): void {
    try {
      // Validate transition before modifying state
      if (!Invoice.isValidTransition(invoice.status, targetStatus)) {
        throw new AppError(
          400,
          `Cannot transition invoice from ${invoice.status} to ${targetStatus}`,
          "INVALID_STATUS_TRANSITION"
        );
      }

      // Apply state transition
      invoice.status = targetStatus;

      // Handle rejection reason if applicable
      if (targetStatus === InvoiceStatus.REJECTED) {
        if (rejectionReason) {
          invoice.rejectionReason = String(rejectionReason).trim();
        }
      }

      logger.debug("Invoice status transitioned successfully", {
        invoiceId: invoice.id,
        fromStatus: invoice.status,
        toStatus: targetStatus,
      });
    } catch (error) {
      // Re-throw AppError without wrapping
      if (error instanceof AppError) {
        throw error;
      }

      logger.error("Failed to transition invoice status", {
        error: error instanceof Error ? error.message : String(error),
        invoiceId: invoice.id,
        fromStatus: invoice.status,
        toStatus: targetStatus,
        context: "Invoice.transitionTo",
      });

      throw new AppError(
        500,
        "Failed to execute invoice status transition",
        "STATUS_TRANSITION_FAILED"
      );
    }
  }

  /**
   * Evaluates if the invoice is eligible to be published to the marketplace.
   * Optimized with early validation and efficient array building.
   *
   * @returns Object with publishable flag and detailed error messages
   */
  static isPublishable(
    invoice: Partial<Invoice>,
    options: { referenceDate?: Date; minRunwayHours?: number } = {}
  ): {
    publishable: boolean;
    errors: string[];
  } {
    const errors: string[] = [];
    const minRunwayHours =
      options.minRunwayHours ?? VALIDATION_CONSTRAINTS.MIN_RUNWAY_HOURS_DEFAULT;
    const now = options.referenceDate ?? new Date();

    try {
      // Check status - early exit if invalid
      if (invoice.status !== InvoiceStatus.DRAFT && invoice.status !== InvoiceStatus.PENDING) {
        errors.push(`Status must be draft or pending, currently ${invoice.status}`);
      }

      // Validate amount
      try {
        const amt = new Decimal(invoice.amount || 0);
        if (amt.lte(0)) {
          errors.push("Invoice amount must be greater than zero");
        }
      } catch {
        errors.push("Invalid amount format");
      }

      // Validate customer name
      if (!invoice.customerName || !String(invoice.customerName).trim()) {
        errors.push("Customer name is required");
      }

      // Validate due date with efficient date handling
      if (!invoice.dueDate) {
        errors.push("Due date is required");
      } else {
        try {
          const dueTime = new Date(invoice.dueDate).getTime();
          if (isNaN(dueTime)) {
            errors.push("Invalid due date format");
          } else {
            const minDueTime = now.getTime() + minRunwayHours * 60 * 60 * 1000;
            if (dueTime < minDueTime) {
              errors.push(`Due date must be at least ${minRunwayHours} hours in the future`);
            }
          }
        } catch {
          errors.push("Invalid due date format");
        }
      }

      // Validate IPFS hash
      if (!invoice.ipfsHash || !String(invoice.ipfsHash).trim()) {
        errors.push("Invoice document IPFS hash is required");
      }
    } catch (error) {
      logger.error("Error during invoice publishability check", {
        error: error instanceof Error ? error.message : String(error),
        invoiceId: invoice.id,
        context: "Invoice.isPublishable",
      });
      // Return unpublishable on unexpected errors
      errors.push("Unexpected error during validation");
    }

    return {
      publishable: errors.length === 0,
      errors,
    };
  }

  /**
   * Checks if the invoice due date has passed.
   * Optimized with efficient date comparison.
   */
  static isOverdue(invoice: Partial<Invoice>, referenceDate: Date = new Date()): boolean {
    if (!invoice.dueDate) return false;

    try {
      const dueTime = new Date(invoice.dueDate).getTime();
      return !isNaN(dueTime) && dueTime < referenceDate.getTime();
    } catch {
      logger.warn("Invalid due date when checking overdue status", { invoiceId: invoice.id });
      return false;
    }
  }

  /**
   * Calculates the remaining funding runway in hours.
   * Optimized with efficient time delta calculation.
   */
  static getFundingRunwayHours(
    invoice: Partial<Invoice>,
    referenceDate: Date = new Date()
  ): number {
    if (!invoice.dueDate) return 0;

    try {
      const dueTime = new Date(invoice.dueDate).getTime();
      if (isNaN(dueTime)) return 0;

      const diffMs = dueTime - referenceDate.getTime();
      return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60)));
    } catch {
      logger.warn("Error calculating funding runway hours", { invoiceId: invoice.id });
      return 0;
    }
  }

  /**
   * Static factory method to safely construct and initialize an Invoice instance.
   * Optimized with early validation and efficient object construction.
   */
  static create(data: Partial<Invoice>): Invoice {
    try {
      const invoice = new Invoice();

      // Assign properties efficiently
      Object.assign(invoice, data);

      // Normalize and sanitize
      Invoice.sanitizeAndNormalize(invoice);

      return invoice;
    } catch (error) {
      if (error instanceof AppError) throw error;

      logger.error("Failed to construct invoice entity", {
        error: error instanceof Error ? error.message : String(error),
        context: "Invoice.create",
      });

      throw new AppError(500, "Failed to construct invoice entity", "INVOICE_CONSTRUCTION_FAILED");
    }
  }

  /**
   * Evaluates if the invoice due date has passed.
   */
  isExpired(referenceDate: Date = new Date()): boolean {
    return this.dueDate ? new Date(this.dueDate).getTime() < referenceDate.getTime() : false;
  }

  /**
   * Checks whether the invoice can be published.
   */
  isPublishable(): boolean {
    return (
      (this.status === InvoiceStatus.DRAFT || this.status === InvoiceStatus.PENDING) &&
      !this.isExpired() &&
      Boolean(this.ipfsHash && this.ipfsHash.trim().length > 0)
    );
  }

  /**
   * Checks whether the invoice can be cancelled.
   */
  canBeCancelled(): boolean {
    return (
      this.status === InvoiceStatus.DRAFT ||
      this.status === InvoiceStatus.PENDING ||
      this.status === InvoiceStatus.PUBLISHED ||
      this.status === InvoiceStatus.FUNDED ||
      this.status === InvoiceStatus.SETTLED
    );
  }

  /**
   * Checks whether the invoice can be rejected.
   */
  canBeRejected(): boolean {
    return this.status === InvoiceStatus.DRAFT || this.status === InvoiceStatus.PENDING;
  }

  /**
   * Checks whether the invoice is in a fundable state.
   */
  isFundable(): boolean {
    return this.status === InvoiceStatus.PUBLISHED && !this.isExpired();
  }

  /**
   * Checks whether the invoice is in a settlable state.
   */
  isSettlable(): boolean {
    return this.status === InvoiceStatus.FUNDED;
  }

  /**
   * Calculates and formats amounts using Decimal precision and sanitizes customer name.
   */
  @BeforeInsert()
  @BeforeUpdate()
  calculateAndFormatAmounts(): void {
    try {
      if (this.customerName) {
        this.customerName = String(this.customerName).trim();
      }

      if (this.amount !== undefined && this.amount !== null) {
        const amt = new Decimal(this.amount);
        if (!amt.isFinite() || amt.isNegative()) {
          throw new AppError(400, "Amount must be positive", "INVALID_AMOUNT");
        }
        this.amount = amt.toFixed(4);
      }

      if (this.discountRate !== undefined && this.discountRate !== null) {
        const disc = new Decimal(this.discountRate);
        if (!disc.isFinite() || disc.isNegative() || disc.gt(100)) {
          throw new AppError(400, "Discount rate must be between 0 and 100", "INVALID_DISCOUNT_RATE");
        }
        this.discountRate = disc.toFixed(2);
      }

      if (this.amount && this.discountRate) {
        this.netAmount = Invoice.calculateNetAmount(this.amount, this.discountRate);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      logger.error("Failed to calculate and format invoice amounts", {
        error: error instanceof Error ? error.message : String(error),
        invoiceId: this.id,
      });
      throw new AppError(500, "Failed to calculate amounts", "CALCULATION_FAILED");
    }
  }

  /**
   * Validates invoice readiness for publish.
   */
  validateForPublish(): void {
    if (!this.ipfsHash || !String(this.ipfsHash).trim()) {
      throw new AppError(400, "IPFS document is required to publish invoice", "MISSING_IPFS_HASH");
    }
    if (this.isExpired()) {
      throw new AppError(400, "Cannot publish an overdue invoice", "INVOICE_OVERDUE");
    }
  }

  /**
   * Batch updates status of multiple invoices safely.
   */
  static async batchUpdateStatus(
    invoices: Invoice[],
    targetStatus: InvoiceStatus,
    rejectionReason?: string | null,
  ): Promise<Invoice[]> {
    try {
      for (const invoice of invoices) {
        Invoice.transitionTo(invoice, targetStatus, rejectionReason);
      }
      return invoices;
    } catch (error) {
      if (error instanceof AppError) throw error;
      logger.error("Failed batch updating invoice status", {
        error: error instanceof Error ? error.message : String(error),
        targetStatus,
      });
      throw new AppError(500, "Failed to update batch status", "BATCH_STATUS_UPDATE_FAILED");
    }
  }

  /**
   * Processes a batch of invoices safely with amount normalization.
   */
  static async processBatch(invoices: Invoice[]): Promise<Invoice[]> {
    try {
      for (const invoice of invoices) {
        invoice.calculateAndFormatAmounts();
      }
      return invoices;
    } catch (error) {
      if (error instanceof AppError) throw error;
      logger.error("Failed processing batch invoices", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AppError(500, "Failed to process batch", "BATCH_PROCESS_FAILED");
    }
  }

  /**
   * Serializes entity to a clean DTO payload.
   * Optimized with direct field mapping to avoid unnecessary operations.
   */
  static toDTO(invoice: Invoice): PublicInvoiceDTO {
    try {
      return {
        id: invoice.id,
        sellerId: invoice.sellerId,
        invoiceNumber: invoice.invoiceNumber,
        customerName: invoice.customerName,
        amount: invoice.amount,
        discountRate: invoice.discountRate,
        netAmount: invoice.netAmount,
        dueDate: invoice.dueDate,
        ipfsHash: invoice.ipfsHash,
        riskScore: invoice.riskScore,
        status: invoice.status,
        smartContractId: invoice.smartContractId,
        rejectionReason: invoice.rejectionReason,
        createdAt: invoice.createdAt,
        updatedAt: invoice.updatedAt,
      };
    } catch (error) {
      logger.error("Failed to serialize invoice to DTO", {
        error: error instanceof Error ? error.message : String(error),
        invoiceId: invoice?.id,
        context: "Invoice.toDTO",
      });
      throw new AppError(500, "Failed to serialize invoice", "INVOICE_SERIALIZATION_FAILED");
    }
  }
}
