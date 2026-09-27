import { DataSource, EntityManager } from "typeorm";
import { Watchlist } from "../models/Watchlist.model";
import { Invoice } from "../models/Invoice.model";
import { InvoiceStatus } from "../types/enums";
import { ServiceError } from "../utils/service-error";
import { logger } from "../observability/logger";

export interface PaginationOptions {
  page: number;
  limit: number;
}

export interface WatchlistEntry {
  id: string;
  invoiceId: string;
  walletAddress: string;
  notes: Record<string, unknown> | null;
  createdAt: Date;
  invoice: {
    id: string;
    invoiceNumber: string;
    customerName: string;
    amount: string;
    discountRate: string;
    netAmount: string;
    dueDate: Date;
    status: InvoiceStatus;
  };
}

export interface WatchlistResult {
  data: WatchlistEntry[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export class WatchlistService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Add an invoice to a wallet's watchlist.
   * Prevents duplicate entries per wallet.
   */
  async addToWatchlist(
    walletAddress: string,
    invoiceId: string,
    userId?: string,
    notes?: Record<string, unknown>
  ): Promise<Watchlist> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      // Check if invoice exists
      const invoice = await manager.findOne(Invoice, { where: { id: invoiceId } });
      if (!invoice) {
        throw new ServiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
      }

      // Check for existing entry
      const existing = await manager.findOne(Watchlist, {
        where: { walletAddress, invoiceId },
      });

      if (existing) {
        throw new ServiceError(
          "ALREADY_WATCHLISTED",
          "Invoice is already in your watchlist",
          409
        );
      }

      // Create watchlist entry
      const watchlist = manager.create(Watchlist, {
        walletAddress,
        userId: userId || null,
        invoiceId,
        notes: notes || null,
      });

      const saved = await manager.save(watchlist);

      logger.info("watchlist.entry.created", {
        watchlist_id: saved.id,
        wallet_address: walletAddress,
        invoice_id: invoiceId,
      });

      return saved;
    });
  }

  /**
   * Remove an invoice from a wallet's watchlist.
   * Returns 404 for non-existent entries.
   */
  async removeFromWatchlist(walletAddress: string, invoiceId: string): Promise<void> {
    const repository = this.dataSource.getRepository(Watchlist);
    const entry = await repository.findOne({
      where: { walletAddress, invoiceId },
    });

    if (!entry) {
      throw new ServiceError("WATCHLIST_ENTRY_NOT_FOUND", "Watchlist entry not found", 404);
    }

    await repository.remove(entry);

    logger.info("watchlist.entry.removed", {
      wallet_address: walletAddress,
      invoice_id: invoiceId,
    });
  }

  /**
   * Get paginated list of bookmarked invoices with current status.
   * Status data is joined from invoice table on list fetch.
   */
  async getWatchlist(
    walletAddress: string,
    pagination: PaginationOptions = { page: 1, limit: 20 }
  ): Promise<WatchlistResult> {
    const repository = this.dataSource.getRepository(Watchlist);
    const queryBuilder = repository
      .createQueryBuilder("watchlist")
      .leftJoinAndSelect("watchlist.invoice", "invoice")
      .where("watchlist.wallet_address = :walletAddress", { walletAddress })
      .andWhere("watchlist.deleted_at IS NULL")
      .orderBy("watchlist.created_at", "DESC");

    // Get total count
    const total = await queryBuilder.getCount();

    // Apply pagination
    const offset = (pagination.page - 1) * pagination.limit;
    queryBuilder.skip(offset).take(pagination.limit);

    const entries = await queryBuilder.getMany();

    const data: WatchlistEntry[] = entries.map((entry) => ({
      id: entry.id,
      invoiceId: entry.invoiceId,
      walletAddress: entry.walletAddress,
      notes: entry.notes,
      createdAt: entry.createdAt,
      invoice: {
        id: entry.invoice.id,
        invoiceNumber: entry.invoice.invoiceNumber,
        customerName: entry.invoice.customerName,
        amount: entry.invoice.amount,
        discountRate: entry.invoice.discountRate,
        netAmount: entry.invoice.netAmount,
        dueDate: entry.invoice.dueDate,
        status: entry.invoice.status,
      },
    }));

    return {
      data,
      meta: {
        total,
        page: pagination.page,
        limit: pagination.limit,
        totalPages: Math.ceil(total / pagination.limit),
      },
    };
  }

  /**
   * Check if an invoice is in a wallet's watchlist.
   */
  async isInWatchlist(walletAddress: string, invoiceId: string): Promise<boolean> {
    const repository = this.dataSource.getRepository(Watchlist);
    const entry = await repository.findOne({
      where: { walletAddress, invoiceId },
    });
    return !!entry;
  }
}

export function createWatchlistService(dataSource: DataSource): WatchlistService {
  return new WatchlistService(dataSource);
}
