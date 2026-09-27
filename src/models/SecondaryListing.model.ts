import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  VersionColumn,
} from "typeorm";
import { ListingStatus } from "../types/enums";
import type { User } from "./User.model";
import type { Invoice } from "./Invoice.model";

@Entity("secondary_listings")
@Index("idx_secondary_listings_seller", ["sellerWallet"])
@Index("idx_secondary_listings_invoice", ["invoiceId"])
@Index("idx_secondary_listings_status_expiry", ["status", "expiresAt"])
@Index("idx_secondary_listings_active", ["status", "expiresAt", "createdAt"])
export class SecondaryListing {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "invoice_id", type: "uuid" })
  invoiceId!: string;

  @Column({ name: "seller_wallet", type: "varchar", length: 56 })
  sellerWallet!: string;

  @Column({ name: "seller_id", type: "uuid", nullable: true })
  @Index("idx_secondary_listings_seller_id")
  sellerId!: string | null;

  @Column({ name: "quantity", type: "decimal", precision: 18, scale: 4 })
  quantity!: string;

  @Column({ name: "price_per_fraction", type: "decimal", precision: 18, scale: 4 })
  pricePerFraction!: string;

  @Column({ name: "total_price", type: "decimal", precision: 18, scale: 4 })
  totalPrice!: string;

  @Column({
    type: "enum",
    enum: ListingStatus,
    default: ListingStatus.ACTIVE,
  })
  @Index("idx_secondary_listings_status")
  status!: ListingStatus;

  @Column({ name: "expires_at", type: "timestamptz" })
  @Index("idx_secondary_listings_expires_at")
  expiresAt!: Date;

  @Column({ name: "cancellation_reason", type: "text", nullable: true })
  cancellationReason!: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;

  @DeleteDateColumn({ name: "deleted_at" })
  deletedAt!: Date | null;

  @VersionColumn()
  version!: number;

  @ManyToOne("Invoice", "secondaryListings", { onDelete: "CASCADE" })
  @JoinColumn({ name: "invoice_id" })
  invoice!: Invoice;

  @ManyToOne("User", "secondaryListings", { onDelete: "SET NULL" })
  @JoinColumn({ name: "seller_id" })
  seller!: User | null;

  /**
   * Checks if the listing has expired.
   */
  isExpired(referenceDate: Date = new Date()): boolean {
    return new Date(this.expiresAt).getTime() < referenceDate.getTime();
  }

  /**
   * Checks if the listing is active and not expired.
   */
  isActive(referenceDate: Date = new Date()): boolean {
    return this.status === ListingStatus.ACTIVE && !this.isExpired(referenceDate);
  }
}
