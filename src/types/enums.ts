/**
 * Shared enums for entity status and type fields.
 */

export enum UserType {
  SELLER = "seller",
  INVESTOR = "investor",
  BOTH = "both",
}

export enum KYCStatus {
  PENDING = "pending",
  IN_REVIEW = "in_review",
  APPROVED = "approved",
  REJECTED = "rejected",
  EXPIRED = "expired",
}

export enum InvoiceStatus {
  DRAFT = "draft",
  PENDING = "pending",
  PUBLISHED = "published",
  FUNDED = "funded",
  SETTLED = "settled",
  CANCELLED = "cancelled",
  REJECTED = "rejected",
}

export enum InvestmentStatus {
  PENDING = "pending",
  CONFIRMED = "confirmed",
  SETTLED = "settled",
  CANCELLED = "cancelled",
}

export enum TransactionType {
  INVESTMENT = "investment",
  PAYMENT = "payment",
  WITHDRAWAL = "withdrawal",
  REFUND = "refund",
}

export enum TransactionStatus {
  PENDING = "pending",
  COMPLETED = "completed",
  FAILED = "failed",
}

export enum KYCVerificationType {
  IDENTITY = "identity",
  ADDRESS = "address",
  BUSINESS = "business",
}

export enum NotificationType {
  INVOICE = "invoice",
  INVESTMENT = "investment",
  PAYMENT = "payment",
  KYC = "kyc",
  SYSTEM = "system",
  INVOICE_REJECTED = "invoice_rejected",
  KYC_APPROVED = "kyc_approved",
  KYC_REJECTED = "kyc_rejected",
  INVESTMENT_CONFIRMED = "investment_confirmed",
  INVOICE_FUNDED = "invoice_funded",
  INVOICE_SETTLED = "invoice_settled",
  INVESTMENT_CREATED = "investment_created",
  SETTLEMENT_RECEIVED = "settlement_received",
  REFUND_PROCESSED = "refund_processed",
  /** Funding deadline extended after admin approval (issue #477). */
  INVOICE_DEADLINE_EXTENDED = "invoice_deadline_extended",
}

/** Seller funding-deadline extension request lifecycle (issue #477). */
export enum ExtensionRequestStatus {
  PENDING = "pending",
  APPROVED = "approved",
  REJECTED = "rejected",
}

/** Secondary market listing status for invoice fraction trading. */
export enum ListingStatus {
  ACTIVE = "active",
  SOLD = "sold",
  CANCELLED = "cancelled",
  EXPIRED = "expired",
}
