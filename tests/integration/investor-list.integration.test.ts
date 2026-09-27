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
import { InvoiceStatus, UserType, KYCStatus, InvestmentStatus } from "../../src/types/enums";
import { createInvoiceService } from "../../src/services/invoice.service";
import { createInvoiceRouter } from "../../src/routes/invoice.routes";
import { createErrorMiddleware } from "../../src/middleware/error.middleware";
import { logger } from "../../src/observability/logger";
import type { IPFSService } from "../../src/services/ipfs.service";

describe("Investor list endpoint for funded invoice", () => {
  let dataSource: DataSource;
  let app: express.Application;
  let seller: User;
  let otherSeller: User;
  let validToken: string;
  let otherToken: string;
  let fundedInvoice: Invoice;

  const noopIpfsService = {} as IPFSService;
  const mockConfig = {
    ipfs: {
      apiUrl: "https://api.pinata.cloud",
      jwt: "test-jwt",
      maxFileSizeMB: 10,
      allowedMimeTypes: ["application/pdf"],
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
        stellarAddress: "GSELLER123",
        email: "seller1@test.com",
        userType: UserType.SELLER,
        kycStatus: KYCStatus.APPROVED,
      }),
    );

    otherSeller = await userRepository.save(
      userRepository.create({
        stellarAddress: "GOTHERSELLER456",
        email: "seller2@test.com",
        userType: UserType.SELLER,
        kycStatus: KYCStatus.APPROVED,
      }),
    );

    const invoiceRepository = dataSource.getRepository(Invoice);
    fundedInvoice = await invoiceRepository.save(
      invoiceRepository.create({
        sellerId: seller.id,
        invoiceNumber: "INV-TOK-001",
        customerName: "Token Customer",
        amount: "10000.0000",
        discountRate: "10.00",
        netAmount: "9000.0000",
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        status: InvoiceStatus.FUNDED,
      }),
    );

    const investor1 = await userRepository.save(
      userRepository.create({
        stellarAddress: "GINVESTORONE123456",
        email: "inv1@test.com",
        userType: UserType.INVESTOR,
        kycStatus: KYCStatus.APPROVED,
      }),
    );

    const investor2 = await userRepository.save(
      userRepository.create({
        stellarAddress: "GINVESTORTWO123456",
        email: "inv2@test.com",
        userType: UserType.INVESTOR,
        kycStatus: KYCStatus.APPROVED,
      }),
    );

    const investor3 = await userRepository.save(
      userRepository.create({
        stellarAddress: "GINVESTORTHR123456",
        email: "inv3@test.com",
        userType: UserType.INVESTOR,
        kycStatus: KYCStatus.APPROVED,
      }),
    );

    const investmentRepository = dataSource.getRepository(Investment);
    await investmentRepository.save([
      investmentRepository.create({
        invoiceId: fundedInvoice.id,
        investorId: investor1.id,
        investmentAmount: "2000.0000",
        expectedReturn: "2222.2222",
        status: InvestmentStatus.CONFIRMED,
      }),
      investmentRepository.create({
        invoiceId: fundedInvoice.id,
        investorId: investor2.id,
        investmentAmount: "3000.0000",
        expectedReturn: "3333.3333",
        status: InvestmentStatus.CONFIRMED,
      }),
      investmentRepository.create({
        invoiceId: fundedInvoice.id,
        investorId: investor3.id,
        investmentAmount: "5000.0000",
        expectedReturn: "5555.5555",
        status: InvestmentStatus.CONFIRMED,
      }),
    ]);

    const invoiceService = createInvoiceService(dataSource, noopIpfsService);

    process.env.JWT_SECRET = "test-secret";
    validToken = jwt.sign(
      { sub: seller.id, stellarAddress: seller.stellarAddress },
      process.env.JWT_SECRET,
    );
    
    otherToken = jwt.sign(
      { sub: otherSeller.id, stellarAddress: otherSeller.stellarAddress },
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

  it("should return 403 when a different seller accesses the endpoint", async () => {
    if (!process.env.DATABASE_URL) return;

    await request(app)
      .get(`/api/v1/invoices/${fundedInvoice.id}/tokens`)
      .set("Authorization", `Bearer ${otherToken}`)
      .expect(403);
  });

  it("should return all commitments with truncated wallets, correct amounts and shares", async () => {
    if (!process.env.DATABASE_URL) return;

    const response = await request(app)
      .get(`/api/v1/invoices/${fundedInvoice.id}/tokens`)
      .set("Authorization", `Bearer ${validToken}`)
      .expect(200);

    expect(response.body.success).toBe(true);
    const commitments = response.body.data;
    
    expect(commitments).toHaveLength(3);

    const inv1 = commitments.find((c: any) => c.wallet === "GINV...3456" && c.amount === "2000.0000");
    expect(inv1).toBeDefined();
    expect(inv1.share_percent).toBe("20.00");
    expect(inv1.committed_at).toBeDefined();

    const inv2 = commitments.find((c: any) => c.wallet === "GINV...3456" && c.amount === "3000.0000");
    expect(inv2).toBeDefined();
    expect(inv2.share_percent).toBe("30.00");
    expect(inv2.committed_at).toBeDefined();

    const inv3 = commitments.find((c: any) => c.wallet === "GINV...3456" && c.amount === "5000.0000");
    expect(inv3).toBeDefined();
    expect(inv3.share_percent).toBe("50.00");
    expect(inv3.committed_at).toBeDefined();

    const totalShare = commitments.reduce((acc: number, c: any) => acc + parseFloat(c.share_percent), 0);
    expect(totalShare).toBe(100);
  });
});
