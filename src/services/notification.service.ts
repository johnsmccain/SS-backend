import { DataSource, Repository, FindOptionsWhere } from "typeorm";
import { Notification } from "../models/Notification.model";
import { KycEvent } from "../models/KycEvent.model";
import { InvestmentEvent } from "../models/InvestmentEvent.model";
import { SettlementEvent } from "../models/SettlementEvent.model";
import { NotificationType } from "../types/enums";
import { HttpError } from "../utils/http-error";
import type { NotificationInput } from "../lib/invoice-notifications";

export interface NotificationPage {
  data: Notification[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
  nextCursor?: string | null;
  hasMore?: boolean;
}

export interface ListNotificationsOptions {
  userId: string;
  walletAddress?: string;
  page?: number;
  limit?: number;
  read?: boolean;
  type?: NotificationType;
  sortOrder?: "asc" | "desc";
  cursor?: string | null;
}

export type { NotificationInput };

export interface NotificationRepositoryContract {
  create(
    userId: string,
    type: NotificationType,
    title: string,
    message: string,
    data?: Record<string, unknown>
  ): Promise<Notification>;
  /** Inserts all entries in a single statement. */
  createMany(entries: NotificationInput[]): Promise<void>;
  findByIdAndUserId(id: string, userId: string): Promise<Notification | null>;
  markRead(id: string, userId: string): Promise<Notification>;
  /** Marks every unread notification of the user as read in one statement; returns how many changed. */
  markAllRead(userId: string, walletAddress?: string): Promise<number>;
  countUnread(userId: string): Promise<number>;
  list(options: ListNotificationsOptions): Promise<NotificationPage>;
}

export class NotificationService {
  constructor(private readonly notificationRepository: NotificationRepositoryContract) {}

  /**
   * Creates a notification for a user.
   * Intended call sites:
   *   - Invoice publish  → createNotification(sellerId, NotificationType.INVOICE, ...)
   *   - Investment confirmed → createNotification(investorId, NotificationType.INVESTMENT, ...)
   *   - Settlement complete  → createNotification(userId, NotificationType.PAYMENT, ...)
   */
  async createNotification(
    userId: string,
    type: NotificationType,
    title: string,
    message: string,
    data?: Record<string, unknown>
  ): Promise<Notification> {
    return this.notificationRepository.create(userId, type, title, message, data);
  }

  /**
   * Creates several notifications at once, e.g. one per investor when an
   * invoice they funded settles.
   */
  async createNotifications(entries: NotificationInput[]): Promise<void> {
    if (entries.length === 0) return;
    await this.notificationRepository.createMany(entries);
  }

  async listNotifications(options: ListNotificationsOptions): Promise<NotificationPage> {
    return this.notificationRepository.list(options);
  }

  async markNotificationRead(notificationId: string, userId: string): Promise<Notification> {
    const notification = await this.notificationRepository.findByIdAndUserId(
      notificationId,
      userId
    );

    if (!notification) {
      throw new HttpError(404, "Notification not found.");
    }

    if (notification.read) {
      return notification;
    }

    return this.notificationRepository.markRead(notificationId, userId);
  }

  async markAllNotificationsRead(
    userId: string,
    walletAddress?: string
  ): Promise<{ updated: number }> {
    const updated = await this.notificationRepository.markAllRead(userId, walletAddress);
    return { updated: typeof updated === "number" ? updated : 0 };
  }

  async getUnreadCount(userId: string): Promise<{ unread: number }> {
    return { unread: await this.notificationRepository.countUnread(userId) };
  }
}

class TypeOrmNotificationRepository implements NotificationRepositoryContract {
  constructor(
    private readonly repository: Repository<Notification>,
    private readonly dataSource?: DataSource
  ) {}

  async create(
    userId: string,
    type: NotificationType,
    title: string,
    message: string,
    data?: Record<string, unknown>
  ): Promise<Notification> {
    const entity = this.repository.create({ userId, type, title, message, data });
    return this.repository.save(entity);
  }

  async createMany(entries: NotificationInput[]): Promise<void> {
    const entities = entries.map(entry => this.repository.create({
      userId: entry.userId,
      type: entry.type,
      title: entry.title,
      message: entry.message,
      data: entry.data || null,
    }));
    await this.repository.save(entities);
  }

  findByIdAndUserId(id: string, userId: string): Promise<Notification | null> {
    return this.repository.findOne({ where: { id, userId } });
  }

  async markAllRead(userId: string, walletAddress?: string): Promise<number> {
    const wallet = walletAddress && walletAddress !== userId ? walletAddress : null;
    const result = wallet
      ? await this.repository.update(
          [{ userId, read: false }, { userId: wallet, read: false }] as unknown as FindOptionsWhere<Notification>,
          { read: true }
        )
      : await this.repository.update({ userId, read: false }, { read: true });

    let affected = result?.affected ?? 0;

    if (this.dataSource && this.dataSource.isInitialized) {
      try {
        const kycRepo = this.dataSource.getRepository(KycEvent);
        const res = await kycRepo.update(
          [{ walletAddress: walletAddress || userId, read: false }, { userId, read: false }] as unknown as FindOptionsWhere<KycEvent>,
          { read: true }
        );
        affected += res?.affected ?? 0;
      } catch {
        // ignore error
      }

      try {
        const investRepo = this.dataSource.getRepository(InvestmentEvent);
        const res = await investRepo.update(
          [{ walletAddress: walletAddress || userId, read: false }, { userId, read: false }] as unknown as FindOptionsWhere<InvestmentEvent>,
          { read: true }
        );
        affected += res?.affected ?? 0;
      } catch {
        // ignore error
      }

      try {
        const settleRepo = this.dataSource.getRepository(SettlementEvent);
        const res = await settleRepo.update(
          [{ walletAddress: walletAddress || userId, read: false }, { userId, read: false }] as unknown as FindOptionsWhere<SettlementEvent>,
          { read: true }
        );
        affected += res?.affected ?? 0;
      } catch {
        // ignore error
      }
    }

    return affected;
  }

  countUnread(userId: string): Promise<number> {
    return this.repository.count({ where: { userId, read: false } });
  }

  async markRead(id: string, userId: string): Promise<Notification> {
    await this.repository.update({ id, userId }, { read: true });
    const updated = await this.repository.findOne({ where: { id, userId } });
    if (!updated) {
      throw new HttpError(404, "Notification not found.");
    }
    return updated;
  }



  async list(options: ListNotificationsOptions): Promise<NotificationPage> {
    const {
      userId,
      walletAddress,
      page = 1,
      limit = 20,
      read,
      type,
      sortOrder = "desc",
      cursor,
    } = options;

    const wallet = walletAddress || userId;

    // If dataSource is available, aggregate from notifications, kyc_events, investment_events, settlement_events
    if (this.dataSource && this.dataSource.isInitialized) {
      try {
        const aggregated: Notification[] = [];

        // 1. Notifications table
        try {
          const notifs = await this.repository
            .createQueryBuilder("n")
            .where("n.userId = :userId OR n.userId = :wallet", { userId, wallet })
            .getMany();
          aggregated.push(...notifs);
        } catch {
          // ignore error
        }

        // 2. KYC events
        try {
          const kycRepo = this.dataSource.getRepository(KycEvent);
          const kycEvents = await kycRepo
            .createQueryBuilder("k")
            .where("k.walletAddress = :wallet OR k.userId = :userId", { wallet, userId })
            .getMany();
          for (const ev of kycEvents) {
            aggregated.push({
              id: ev.id,
              userId: ev.userId || userId,
              type: ev.type as NotificationType,
              title: ev.title,
              message: ev.message,
              read: Boolean(ev.read),
              createdAt: ev.createdAt,
              timestamp: ev.createdAt,
            } as Notification);
          }
        } catch {
          // ignore error
        }

        // 3. Investment events
        try {
          const investRepo = this.dataSource.getRepository(InvestmentEvent);
          const investEvents = await investRepo
            .createQueryBuilder("i")
            .where("i.walletAddress = :wallet OR i.userId = :userId", { wallet, userId })
            .getMany();
          for (const ev of investEvents) {
            aggregated.push({
              id: ev.id,
              userId: ev.userId || userId,
              type: ev.type as NotificationType,
              title: ev.title,
              message: ev.message,
              read: Boolean(ev.read),
              createdAt: ev.createdAt,
              timestamp: ev.createdAt,
            } as Notification);
          }
        } catch {
          // ignore error
        }

        // 4. Settlement events
        try {
          const settleRepo = this.dataSource.getRepository(SettlementEvent);
          const settleEvents = await settleRepo
            .createQueryBuilder("s")
            .where("s.walletAddress = :wallet OR s.userId = :userId", { wallet, userId })
            .getMany();
          for (const ev of settleEvents) {
            aggregated.push({
              id: ev.id,
              userId: ev.userId || userId,
              type: ev.type as NotificationType,
              title: ev.title,
              message: ev.message,
              read: Boolean(ev.read),
              createdAt: ev.createdAt,
              timestamp: ev.createdAt,
            } as Notification);
          }
        } catch {
          // ignore error
        }

        // Apply filters
        let filtered = aggregated.map((item) => {
          if (!item.createdAt && item.timestamp) {
            item.createdAt = item.timestamp;
          }
          if (!item.timestamp && item.createdAt) {
            item.timestamp = item.createdAt;
          }
          return item;
        });

        if (read !== undefined) {
          filtered = filtered.filter((n) => n.read === read);
        }

        if (type !== undefined) {
          filtered = filtered.filter((n) => n.type === type);
        }

        // Sort by createdAt descending (or asc if requested)
        filtered.sort((a, b) => {
          const dateA = new Date(a.createdAt || a.timestamp).getTime();
          const dateB = new Date(b.createdAt || b.timestamp).getTime();
          return sortOrder === "asc" ? dateA - dateB : dateB - dateA;
        });

        const total = filtered.length;
        const startIndex = (page - 1) * limit;
        const data = filtered.slice(startIndex, startIndex + limit);
        const hasMore = startIndex + limit < total;

        const last = data[data.length - 1];
        const nextCursor =
          hasMore && last
            ? Buffer.from(`${(last.createdAt || last.timestamp).toISOString()}::${last.id}`).toString("base64")
            : null;

        return {
          data,
          meta: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
          },
          nextCursor,
          hasMore,
        };
      } catch {
        // Fallback to basic repository query if aggregation fails
      }
    }

    const qb = this.repository
      .createQueryBuilder("n")
      .where("n.userId = :userId OR n.userId = :wallet", { userId, wallet })
      .orderBy("n.timestamp", sortOrder === "asc" ? "ASC" : "DESC")
      .addOrderBy("n.id", sortOrder === "asc" ? "ASC" : "DESC")
      .take(limit + 1);

    if (cursor) {
      const decoded = Buffer.from(cursor, "base64").toString("utf8").split("::");
      if (
        decoded.length !== 2 ||
        !decoded[0] ||
        !decoded[1] ||
        Number.isNaN(Date.parse(decoded[0]))
      ) {
        throw new HttpError(400, "Invalid notification cursor.");
      }
      const operator = sortOrder === "asc" ? ">" : "<";
      qb.andWhere(
        `(n.timestamp ${operator} :cursorTimestamp OR (n.timestamp = :cursorTimestamp AND n.id ${operator} :cursorId))`,
        {
          cursorTimestamp: new Date(decoded[0]),
          cursorId: decoded[1],
        }
      );
    } else {
      qb.skip((page - 1) * limit);
    }

    if (read !== undefined) {
      qb.andWhere("n.read = :read", { read });
    }

    if (type !== undefined) {
      qb.andWhere("n.type = :type", { type });
    }

    const [rows, total] = await qb.getManyAndCount();
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map((r) => {
      if (!r.createdAt && r.timestamp) {
        r.createdAt = r.timestamp;
      }
      return r;
    });
    const last = data[data.length - 1];
    const nextCursor =
      hasMore && last
        ? Buffer.from(`${last.timestamp.toISOString()}::${last.id}`).toString("base64")
        : null;

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
      nextCursor,
      hasMore,
    };
  }
}

export function createNotificationService(dataSource: DataSource): NotificationService {
  return new NotificationService(
    new TypeOrmNotificationRepository(dataSource.getRepository(Notification), dataSource)
  );
}
