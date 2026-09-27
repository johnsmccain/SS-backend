import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  OneToMany,
  Index,
} from "typeorm";
import { UserType, KYCStatus } from "../types/enums";
import { logger } from "../observability/logger";
import { AppError } from "../utils/http-error";

/**
 * User model validation constraints.
 */
const USER_VALIDATION_CONSTRAINTS = Object.freeze({
  STELLAR_ADDRESS_LENGTH: 56,
  EMAIL_MAX_LENGTH: 255,
  EMAIL_PATTERN: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
});

/** Columns used by profile lookups; relations are loaded explicitly by callers that need them. */
export const USER_PROFILE_SELECT = [
  "id", "stellarAddress", "email", "userType", "kycStatus",
  "isKycVerified", "createdAt", "updatedAt", "deletedAt",
] as const;

@Entity("users")
@Index("idx_users_user_type_kyc_status", ["userType", "kycStatus"])
export class User {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "stellarAddress", type: "varchar", length: 56, unique: true })
  @Index("idx_users_stellar_address", { unique: true })
  stellarAddress!: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  @Index("idx_users_email")
  email!: string | null;

  @Column({
    name: "userType",
    type: "enum",
    enum: UserType,
    default: UserType.INVESTOR,
  })
  @Index("idx_users_user_type")
  userType!: UserType;

  @Column({
    name: "kycStatus",
    type: "enum",
    enum: KYCStatus,
    default: KYCStatus.PENDING,
  })
  @Index("idx_users_kyc_status")
  kycStatus!: KYCStatus;

  @Column({ name: "is_kyc_verified", type: "boolean", default: false })
  isKycVerified!: boolean;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;

  @DeleteDateColumn({ name: "deleted_at" })
  deletedAt!: Date | null;

  @OneToMany("Invoice", "seller", { cascade: false })
  invoices!: import("./Invoice.model").Invoice[];

  @OneToMany("Investment", "investor")
  investments!: import("./Investment.model").Investment[];

  @OneToMany("Transaction", "user")
  transactions!: import("./Transaction.model").Transaction[];

  @OneToMany("KYCVerification", "user")
  kycVerifications!: import("./KYCVerification.model").KYCVerification[];

  @OneToMany("KycHistory", "user")
  kycHistory!: import("./KycHistory.model").KycHistory[];

  @OneToMany("Notification", "user")
  notifications!: import("./Notification.model").Notification[];

  @OneToMany("SecondaryListing", "seller")
  secondaryListings!: import("./SecondaryListing.model").SecondaryListing[];

  @OneToMany("Watchlist", "user")
  watchlistEntries!: import("./Watchlist.model").Watchlist[];

  /**
   * Validates a Stellar address format and length.
   * Stellar addresses are 56 characters (base32 encoded public key).
   * 
   * @throws AppError if address is invalid
   */
  static validateStellarAddress(address: string): boolean {
    try {
      if (!address || typeof address !== "string") {
        return false;
      }

      const trimmed = address.trim();
      
      // Stellar public keys start with 'G' and are base32 encoded
      if (!trimmed.startsWith("G")) {
        return false;
      }

      if (trimmed.length !== USER_VALIDATION_CONSTRAINTS.STELLAR_ADDRESS_LENGTH) {
        return false;
      }

      // Validate base32 characters (A-Z, 2-7)
      const base32Pattern = /^G[A-Z2-7]{54}$/;
      return base32Pattern.test(trimmed);
    } catch (error) {
      logger.error("Error validating Stellar address", {
        error: error instanceof Error ? error.message : String(error),
        context: "User.validateStellarAddress",
      });
      return false;
    }
  }

  /**
   * Validates and normalizes an email address.
   * 
   * @returns Normalized email or null if invalid
   */
  static validateAndNormalizeEmail(email: string | null | undefined): string | null {
    try {
      if (!email || typeof email !== "string") {
        return null;
      }

      const trimmed = email.trim().toLowerCase();
      
      if (!trimmed) {
        return null;
      }

      if (trimmed.length > USER_VALIDATION_CONSTRAINTS.EMAIL_MAX_LENGTH) {
        logger.warn("Email exceeds maximum length", { email: trimmed.slice(0, 20) });
        return null;
      }

      if (!USER_VALIDATION_CONSTRAINTS.EMAIL_PATTERN.test(trimmed)) {
        return null;
      }

      return trimmed;
    } catch (error) {
      logger.error("Error validating email", {
        error: error instanceof Error ? error.message : String(error),
        context: "User.validateAndNormalizeEmail",
      });
      return null;
    }
  }

  /**
   * Sanitizes user input data before creating or updating a user.
   * Ensures all fields meet requirements and prevents injection attacks.
   * 
   * @throws AppError if validation fails
   */
  static sanitize(user: Partial<User>): void {
    try {
      // Validate and normalize Stellar address
      if (user.stellarAddress !== undefined) {
        if (!User.validateStellarAddress(user.stellarAddress)) {
          throw new AppError(
            400,
            "Invalid Stellar address format",
            "INVALID_STELLAR_ADDRESS",
          );
        }
        user.stellarAddress = user.stellarAddress.trim();
      }

      // Validate and normalize email
      if (user.email !== undefined && user.email !== null) {
        const normalizedEmail = User.validateAndNormalizeEmail(user.email);
        if (user.email && !normalizedEmail) {
          throw new AppError(
            400,
            "Invalid email format",
            "INVALID_EMAIL",
          );
        }
        user.email = normalizedEmail;
      }

      // Validate user type
      if (user.userType !== undefined && !Object.values(UserType).includes(user.userType)) {
        throw new AppError(
          400,
          "Invalid user type",
          "INVALID_USER_TYPE",
        );
      }

      // Validate KYC status
      if (user.kycStatus !== undefined && !Object.values(KYCStatus).includes(user.kycStatus)) {
        throw new AppError(
          400,
          "Invalid KYC status",
          "INVALID_KYC_STATUS",
        );
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      logger.error("Failed to sanitize user entity", {
        error: error instanceof Error ? error.message : String(error),
        userId: user.id,
        context: "User.sanitize",
      });

      throw new AppError(
        500,
        `User sanitization failed: ${error instanceof Error ? error.message : String(error)}`,
        "USER_SANITIZATION_FAILED",
      );
    }
  }

  /**
   * Checks if user is eligible for investor operations.
   * A user can be an investor if their account type allows it and KYC is verified.
   */
  static isInvestorEligible(user: Partial<User>): boolean {
    try {
      if (!user) return false;
      
      const isInvestor = 
        user.userType === UserType.INVESTOR || 
        user.userType === UserType.BOTH;
      
      const isKycVerified = user.isKycVerified === true;
      
      return isInvestor && isKycVerified;
    } catch (error) {
      logger.error("Error checking investor eligibility", {
        error: error instanceof Error ? error.message : String(error),
        userId: user.id,
        context: "User.isInvestorEligible",
      });
      return false;
    }
  }

  /**
   * Checks if user is eligible for seller operations.
   * A user can be a seller if their account type allows it.
   */
  static isSellerEligible(user: Partial<User>): boolean {
    try {
      if (!user) return false;
      
      return user.userType === UserType.SELLER || user.userType === UserType.BOTH;
    } catch (error) {
      logger.error("Error checking seller eligibility", {
        error: error instanceof Error ? error.message : String(error),
        userId: user.id,
        context: "User.isSellerEligible",
      });
      return false;
    }
  }

  /**
   * Factory method to safely construct and initialize a User instance.
   * 
   * @throws AppError if validation fails
   */
  static create(data: Partial<User>): User {
    try {
      const user = new User();
      Object.assign(user, data);
      User.sanitize(user);
      return user;
    } catch (error) {
      if (error instanceof AppError) throw error;

      logger.error("Failed to construct user entity", {
        error: error instanceof Error ? error.message : String(error),
        context: "User.create",
      });

      throw new AppError(
        500,
        "Failed to construct user entity",
        "USER_CONSTRUCTION_FAILED",
      );
    }
  }

  /**
   * Converts user entity to public DTO, excluding sensitive fields.
   */
  static toPublicDTO(user: User): Omit<User, "deletedAt"> {
    try {
      const dto: Omit<User, "deletedAt"> = {
        id: user.id,
        stellarAddress: user.stellarAddress,
        email: user.email,
        userType: user.userType,
        kycStatus: user.kycStatus,
        isKycVerified: user.isKycVerified,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        invoices: user.invoices,
        investments: user.investments,
        transactions: user.transactions,
        kycVerifications: user.kycVerifications,
        notifications: user.notifications,
        secondaryListings: user.secondaryListings,
        watchlistEntries: user.watchlistEntries,
        kycHistory: user.kycHistory,
      };
      return dto;
    } catch (error) {
      logger.error("Failed to serialize user to public DTO", {
        error: error instanceof Error ? error.message : String(error),
        userId: user?.id,
        context: "User.toPublicDTO",
      });
      throw new AppError(
        500,
        "Failed to serialize user",
        "USER_SERIALIZATION_FAILED",
      );
    }
  }
}
