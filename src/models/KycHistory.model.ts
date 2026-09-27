import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import { KYCStatus, KYCVerificationType } from "../types/enums";
import type { User } from "./User.model";

@Entity("kyc_history")
@Index("idx_kyc_history_user_id", ["userId"])
@Index("idx_kyc_history_wallet", ["wallet"])
@Index("idx_kyc_history_status", ["status"])
@Index("idx_kyc_history_created_at", ["createdAt"])
export class KycHistory {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @Column({ name: "wallet", type: "varchar", length: 56, nullable: true })
  wallet!: string | null;

  @Column({
    name: "verification_type",
    type: "enum",
    enum: KYCVerificationType,
  })
  verificationType!: KYCVerificationType;

  @Column({
    type: "enum",
    enum: KYCStatus,
  })
  status!: KYCStatus;

  @Column({ type: "jsonb", nullable: true })
  documents!: Record<string, unknown> | null;

  @Column({ name: "rejection_reason", type: "text", nullable: true })
  rejectionReason!: string | null;

  @Column({ name: "provider_reference", type: "varchar", length: 255, nullable: true })
  providerReference!: string | null;

  @Column({ name: "is_archived", type: "boolean", default: false })
  isArchived!: boolean;

  @Column({ name: "archived_at", type: "timestamptz", nullable: true })
  archivedAt!: Date | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @ManyToOne("User", "kycHistory", { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;
}
