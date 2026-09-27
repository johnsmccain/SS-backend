import { DataSource } from "typeorm";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { Invoice } from "../../src/models/Invoice.model";
import { User } from "../../src/models/User.model";
import { Investment } from "../../src/models/Investment.model";
import { Transaction } from "../../src/models/Transaction.model";
import { KYCVerification } from "../../src/models/KYCVerification.model";
import { Notification } from "../../src/models/Notification.model";
import { KycHistory } from "../../src/models/KycHistory.model";
import { SecondaryListing } from "../../src/models/SecondaryListing.model";
import { Watchlist } from "../../src/models/Watchlist.model";
import { AuthChallenge } from "../../src/models/AuthChallenge.model";
import { InvoiceStatus, UserType, KYCStatus } from "../../src/types/enums";
import { createInvoiceService } from "../../src/services/invoice.service";
import { createInvoiceRouter } from "../../src/routes/invoice.routes";
import { createErrorMiddleware } from "../../src/middleware/error.middleware";
import { logger } from "../../src/observability/logger";
import type { IPFSService } from "../../src/services/ipfs.service";

describe("Invoice list endpoint filtering by status", () => {
  let dataSource: DataSource;
  let app: express.Application;
  let seller: User;
  let validToken: string;

  const noopIpfsService = {} as IPFSService;
  const mockConfig = {
    ipfs: {
      apiUrl: "https://api.pinata.cloud",
      jwt: "test-jwt",
      maxFileSizeMB: 10,
      allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png"],
      uploadRateLimit: { windowMs: 900000, maxUploads: 10 },
    },
    kyc: { skipVerification: true },
  };

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      console.warn("DATABASE_URL not set, skipping integration tests");
      return;
    }

    dataSource = new DataSource({
      type: "postgres",
      url: databaseUrl,
      entities: [
        User,
        Invoice,
        Investment,
        Transaction,
        KYCVerification,
        Notification,
        KycHistory,
        SecondaryListing,
        Watchlist,
        AuthChallenge,
      ],
      synchronize: true,
      logging: false,
      dropSchema: true,
    });

    await dataSource.initialize();

    const userRepository = dataSource.getRepository(User);
    seller = await userRepository.save(
      userRepository.create({
        stellarAddress: "GSELLERFILTER123",
        email: "sellerfilter@test.com",
        userType: UserType.SELLER,
        kycStatus: KYCStatus.APPROVED,
      }),
    );

    const invoiceRepository = dataSource.getRepository(Invoice);
    const invoices = [
      { invoiceNumber: "INV-F-001", status: InvoiceStatus.DRAFT },
      { invoiceNumber: "INV-F-002", status: InvoiceStatus.PUBLISHED },
      { invoiceNumber: "INV-F-003", status: InvoiceStatus.FUNDED },
      { invoiceNumber: "INV-F-004", status: InvoiceStatus.SETTLED },
    ];

    for (const overrides of invoices) {
      await invoiceRepository.save(
        invoiceRepository.create({
          sellerId: seller.id,
          customerName: "Filter Customer",
          amount: "1000.0000",
          discountRate: "5.00",
          netAmount: "950.0000",
          dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          ...overrides,
        }),
      );
    }

    const invoiceService = createInvoiceService(dataSource, noopIpfsService);

    process.env.JWT_SECRET = "test-secret";
    validToken = jwt.sign(
      { sub: seller.id, stellarAddress: seller.stellarAddress },
      process.env.JWT_SECRET,
    );

    app = express();
    app.use(express.json());
    app.use(
      "/api/v1/invoices",
      createInvoiceRouter({
        invoiceService,
        config: mockConfig as any,
      }),
    );
    app.use(createErrorMiddleware(logger));
  });

  afterAll(async () => {
    delete process.env.JWT_SECRET;
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it("?status=published returns only published invoices", async () => {
    if (!process.env.DATABASE_URL) return;

    const response = await request(app)
      .get("/api/v1/invoices?status=PUBLISHED")
      .set("Authorization", `Bearer ${validToken}`)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].status).toBe(InvoiceStatus.PUBLISHED);
    expect(response.body.data[0].invoiceNumber).toBe("INV-F-002");
  });

  it("?status=funded returns only funded invoices", async () => {
    if (!process.env.DATABASE_URL) return;

    const response = await request(app)
      .get("/api/v1/invoices?status=FUNDED")
      .set("Authorization", `Bearer ${validToken}`)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].status).toBe(InvoiceStatus.FUNDED);
    expect(response.body.data[0].invoiceNumber).toBe("INV-F-003");
  });

  it("No status param returns all invoices", async () => {
    if (!process.env.DATABASE_URL) return;

    const response = await request(app)
      .get("/api/v1/invoices")
      .set("Authorization", `Bearer ${validToken}`)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data).toHaveLength(4);
    
    const statuses = response.body.data.map((inv: any) => inv.status);
    expect(statuses).toContain(InvoiceStatus.DRAFT);
    expect(statuses).toContain(InvoiceStatus.PUBLISHED);
    expect(statuses).toContain(InvoiceStatus.FUNDED);
    expect(statuses).toContain(InvoiceStatus.SETTLED);
  });

  it("Invalid status value returns 422", async () => {
    if (!process.env.DATABASE_URL) return;

    const response = await request(app)
      .get("/api/v1/invoices?status=invalid")
      .set("Authorization", `Bearer ${validToken}`)
      .expect(422);

    expect(response.body.success).toBe(false);
    expect(response.body.error.message).toContain("status");
  });
});
