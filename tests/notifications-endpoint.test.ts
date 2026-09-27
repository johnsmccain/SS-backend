import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { DataSource, getMetadataArgsStorage } from "typeorm";
import { User } from "../src/models/User.model";
import { Invoice } from "../src/models/Invoice.model";
import { Investment } from "../src/models/Investment.model";
import { Transaction } from "../src/models/Transaction.model";
import { KYCVerification } from "../src/models/KYCVerification.model";
import { AuthChallenge } from "../src/models/AuthChallenge.model";
import { Notification } from "../src/models/Notification.model";
import { KycHistory } from "../src/models/KycHistory.model";
import { SecondaryListing } from "../src/models/SecondaryListing.model";
import { Watchlist } from "../src/models/Watchlist.model";
import { KycEvent } from "../src/models/KycEvent.model";
import { InvestmentEvent } from "../src/models/InvestmentEvent.model";
import { SettlementEvent } from "../src/models/SettlementEvent.model";
import { NotificationType, UserType, KYCStatus } from "../src/types/enums";
import { createNotificationService } from "../src/services/notification.service";
import { createNotificationRouter } from "../src/routes/notification.routes";
import { createErrorMiddleware } from "../src/middleware/error.middleware";
import { logger } from "../src/observability/logger";

function patchEntityMetadataForSQLite(): void {
  const columns = getMetadataArgsStorage().columns;
  for (const col of columns) {
    if (col.options.type === "timestamptz") {
      col.options.type = "datetime" as any;
    }
    if (col.options.type === "jsonb") {
      col.options.type = "text" as any;
    }
    if (col.options.type === "enum") {
      col.options.type = "varchar" as any;
    }
  }
}

describe("Notifications Endpoint (Issue #458)", () => {
  let app: express.Application;
  let dataSource: DataSource;
  let notificationService: any;

  const testWallet = "GBXYZ9876543210STELLARWALLET";
  const testUserId = "user-uuid-458";
  const validToken = jwt.sign(
    { sub: testUserId, stellarAddress: testWallet, userType: UserType.INVESTOR },
    "test-secret"
  );

  beforeAll(async () => {
    process.env.JWT_SECRET = "test-secret";
    patchEntityMetadataForSQLite();

    dataSource = new DataSource({
      type: "sqlite",
      database: ":memory:",
      dropSchema: true,
      entities: [
        User,
        Invoice,
        Investment,
        Transaction,
        KYCVerification,
        AuthChallenge,
        Notification,
        KycHistory,
        SecondaryListing,
        Watchlist,
        KycEvent,
        InvestmentEvent,
        SettlementEvent,
      ],
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();

    notificationService = createNotificationService(dataSource);

    app = express();
    app.use(express.json());
    app.use("/notifications", createNotificationRouter(notificationService));
    app.use("/api/v1/notifications", createNotificationRouter(notificationService));
    app.use(createErrorMiddleware(logger));
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    delete process.env.JWT_SECRET;
  });

  beforeEach(async () => {
    // Clear all tables before each test
    await dataSource.getRepository(Notification).clear();
    await dataSource.getRepository(KycEvent).clear();
    await dataSource.getRepository(InvestmentEvent).clear();
    await dataSource.getRepository(SettlementEvent).clear();
    await dataSource.getRepository(User).clear();

    await dataSource.getRepository(User).save({
      id: testUserId,
      stellarAddress: testWallet,
      userType: UserType.INVESTOR,
      kycStatus: KYCStatus.PENDING,
      isKycVerified: false,
    });
  });

  it("should return 401 when request is unauthenticated", async () => {
    await request(app).get("/notifications").expect(401);
    await request(app).post("/notifications/read-all").expect(401);
  });

  it("should return all supported notification types correctly aggregated across event sources", async () => {
    const kycRepo = dataSource.getRepository(KycEvent);
    const investRepo = dataSource.getRepository(InvestmentEvent);
    const settleRepo = dataSource.getRepository(SettlementEvent);
    const notifRepo = dataSource.getRepository(Notification);

    const now = Date.now();

    // 1. kyc_approved
    await kycRepo.save({
      walletAddress: testWallet,
      userId: testUserId,
      type: NotificationType.KYC_APPROVED,
      title: "KYC Approved",
      message: "Your identity verification has been approved.",
      read: false,
      createdAt: new Date(now - 60000),
    });

    // 2. kyc_rejected
    await kycRepo.save({
      walletAddress: testWallet,
      userId: testUserId,
      type: NotificationType.KYC_REJECTED,
      title: "KYC Rejected",
      message: "Please resubmit your identity documents.",
      read: false,
      createdAt: new Date(now - 50000),
    });

    // 3. investment_confirmed
    await investRepo.save({
      walletAddress: testWallet,
      userId: testUserId,
      type: NotificationType.INVESTMENT_CONFIRMED,
      title: "Investment Confirmed",
      message: "Your investment of 500 XLM has been confirmed.",
      read: false,
      createdAt: new Date(now - 40000),
    });

    // 4. invoice_funded
    await investRepo.save({
      walletAddress: testWallet,
      userId: testUserId,
      type: NotificationType.INVOICE_FUNDED,
      title: "Invoice Funded",
      message: "Invoice INV-001 has reached 100% funding target.",
      read: false,
      createdAt: new Date(now - 30000),
    });

    // 5. settlement_received
    await settleRepo.save({
      walletAddress: testWallet,
      userId: testUserId,
      type: NotificationType.SETTLEMENT_RECEIVED,
      title: "Settlement Received",
      message: "Settlement payment received for INV-001.",
      read: false,
      createdAt: new Date(now - 20000),
    });

    // 6. refund_processed
    await settleRepo.save({
      walletAddress: testWallet,
      userId: testUserId,
      type: NotificationType.REFUND_PROCESSED,
      title: "Refund Processed",
      message: "A refund of 50 XLM has been returned to your wallet.",
      read: true,
      createdAt: new Date(now - 10000),
    });

    const res = await request(app)
      .get("/notifications")
      .set("Authorization", `Bearer ${validToken}`)
      .expect(200);

    const items = res.body.data;
    expect(items).toBeDefined();
    expect(items.length).toBe(6);

    const types = items.map((i: any) => i.type);
    expect(types).toContain(NotificationType.KYC_APPROVED);
    expect(types).toContain(NotificationType.KYC_REJECTED);
    expect(types).toContain(NotificationType.INVESTMENT_CONFIRMED);
    expect(types).toContain(NotificationType.INVOICE_FUNDED);
    expect(types).toContain(NotificationType.SETTLEMENT_RECEIVED);
    expect(types).toContain(NotificationType.REFUND_PROCESSED);
  });

  it("should return notifications sorted by createdAt descending", async () => {
    const kycRepo = dataSource.getRepository(KycEvent);
    const investRepo = dataSource.getRepository(InvestmentEvent);

    const base = Date.now();

    await kycRepo.save({
      walletAddress: testWallet,
      userId: testUserId,
      type: NotificationType.KYC_APPROVED,
      title: "Oldest Event",
      message: "Event 1",
      read: false,
      createdAt: new Date(base - 100000),
    });

    await investRepo.save({
      walletAddress: testWallet,
      userId: testUserId,
      type: NotificationType.INVESTMENT_CONFIRMED,
      title: "Newest Event",
      message: "Event 3",
      read: false,
      createdAt: new Date(base),
    });

    await kycRepo.save({
      walletAddress: testWallet,
      userId: testUserId,
      type: NotificationType.KYC_REJECTED,
      title: "Middle Event",
      message: "Event 2",
      read: false,
      createdAt: new Date(base - 50000),
    });

    const res = await request(app)
      .get("/notifications")
      .set("Authorization", `Bearer ${validToken}`)
      .expect(200);

    const items = res.body.data;
    expect(items).toHaveLength(3);
    expect(items[0].title).toBe("Newest Event");
    expect(items[1].title).toBe("Middle Event");
    expect(items[2].title).toBe("Oldest Event");

    // Verify descending timestamps
    const t0 = new Date(items[0].createdAt).getTime();
    const t1 = new Date(items[1].createdAt).getTime();
    const t2 = new Date(items[2].createdAt).getTime();
    expect(t0).toBeGreaterThanOrEqual(t1);
    expect(t1).toBeGreaterThanOrEqual(t2);
  });

  it("should accurately reflect the read boolean field", async () => {
    const settleRepo = dataSource.getRepository(SettlementEvent);

    await settleRepo.save({
      walletAddress: testWallet,
      userId: testUserId,
      type: NotificationType.SETTLEMENT_RECEIVED,
      title: "Unread Settlement",
      message: "Amount credited",
      read: false,
      createdAt: new Date(),
    });

    await settleRepo.save({
      walletAddress: testWallet,
      userId: testUserId,
      type: NotificationType.REFUND_PROCESSED,
      title: "Read Refund",
      message: "Amount refunded",
      read: true,
      createdAt: new Date(Date.now() - 5000),
    });

    const res = await request(app)
      .get("/notifications")
      .set("Authorization", `Bearer ${validToken}`)
      .expect(200);

    const unread = res.body.data.find((n: any) => n.title === "Unread Settlement");
    const read = res.body.data.find((n: any) => n.title === "Read Refund");

    expect(unread.read).toBe(false);
    expect(read.read).toBe(true);
  });

  it("POST /notifications/read-all should mark all notifications as read and return 204", async () => {
    const kycRepo = dataSource.getRepository(KycEvent);
    const investRepo = dataSource.getRepository(InvestmentEvent);
    const notifRepo = dataSource.getRepository(Notification);

    await kycRepo.save({
      walletAddress: testWallet,
      userId: testUserId,
      type: NotificationType.KYC_APPROVED,
      title: "KYC Notice",
      message: "Approved",
      read: false,
      createdAt: new Date(),
    });

    await investRepo.save({
      walletAddress: testWallet,
      userId: testUserId,
      type: NotificationType.INVESTMENT_CONFIRMED,
      title: "Invest Notice",
      message: "Confirmed",
      read: false,
      createdAt: new Date(),
    });

    await notifRepo.save({
      userId: testUserId,
      type: NotificationType.INVOICE,
      title: "Invoice Notice",
      message: "Draft published",
      read: false,
      timestamp: new Date(),
    });

    // Verify unread before read-all
    const beforeRes = await request(app)
      .get("/notifications")
      .set("Authorization", `Bearer ${validToken}`)
      .expect(200);

    expect(beforeRes.body.data.some((n: any) => !n.read)).toBe(true);

    // Call POST /notifications/read-all -> returns 204
    await request(app)
      .post("/notifications/read-all")
      .set("Authorization", `Bearer ${validToken}`)
      .expect(204);

    // Verify all are now read
    const afterRes = await request(app)
      .get("/notifications")
      .set("Authorization", `Bearer ${validToken}`)
      .expect(200);

    expect(afterRes.body.data.every((n: any) => n.read === true)).toBe(true);
  });

  it("should work on /api/v1/notifications as well", async () => {
    const kycRepo = dataSource.getRepository(KycEvent);
    await kycRepo.save({
      walletAddress: testWallet,
      userId: testUserId,
      type: NotificationType.KYC_APPROVED,
      title: "API v1 Notice",
      message: "Approved",
      read: false,
      createdAt: new Date(),
    });

    const res = await request(app)
      .get("/api/v1/notifications")
      .set("Authorization", `Bearer ${validToken}`)
      .expect(200);

    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].title).toBe("API v1 Notice");

    await request(app)
      .post("/api/v1/notifications/read-all")
      .set("Authorization", `Bearer ${validToken}`)
      .expect(204);
  });
});
