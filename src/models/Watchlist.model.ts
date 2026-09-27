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
import type { User } from "./User.model";
import type { Invoice } from "./Invoice.model";

@Entity("watchlist")
@Index("uq_watchlist_wallet_invoice", ["walletAddress", "invoiceId"], { unique: true })
@Index("idx_watchlist_wallet", ["walletAddress"])
@Index("idx_watchlist_invoice", ["invoiceId"])
export class Watchlist {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "wallet_address", type: "varchar", length: 56 })
  walletAddress!: string;

  @Column({ name: "user_id", type: "uuid", nullable: true })
  @Index("idx_watchlist_user_id")
  userId!: string | null;

  @Column({ name: "invoice_id", type: "uuid" })
  invoiceId!: string;

  @Column({ type: "jsonb", nullable: true })
  notes!: Record<string, unknown> | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;

  @DeleteDateColumn({ name: "deleted_at" })
  deletedAt!: Date | null;

  @VersionColumn()
  version!: number;

  @ManyToOne("User", "watchlistEntries", { onDelete: "SET NULL" })
  @JoinColumn({ name: "user_id" })
  user!: User | null;

  @ManyToOne("Invoice", "watchlistEntries", { onDelete: "CASCADE" })
  @JoinColumn({ name: "invoice_id" })
  invoice!: Invoice;
}
