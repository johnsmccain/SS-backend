import "reflect-metadata";
import request from "supertest";
import { DataSource, getMetadataArgsStorage } from "typeorm";
import jwt from "jsonwebtoken";
import { createApp } from "../../src/app";
import { User } from "../../src/models/User.model";
import { Invoice } from "../../src/models/Invoice.model";
import { Investment } from "../../src/models/Investment.model";
import { AuthChallenge } from "../../src/models/AuthChallenge.model";
import { Transaction } from "../../src/models/Transaction.model";
import { KYCVerification } from "../../src/models/KYCVerification.model";
import { Notification } from "../../src/models/Notification.model";
import { KycHistory } from "../../src/models/KycHistory.model";
import { SecondaryListing } from "../../src/models/SecondaryListing.model";
import { Watchlist } from "../../src/models/Watchlist.model";
import { UserType, InvoiceStatus, KYCStatus } from "../../src/types/enums";
import { createAuthService } from "../../src/services/auth.service";
import { createInvoiceService } from "../../src/services/invoice.service";
import { createSellerService } from "../../src/services/seller.service";
import type { AppConfig } from "../../src/config/env";

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

describe("Integration: Seller Invoice Isolation", () => {
  let dataSource: DataSource;
  let app: ReturnType<typeof createApp>;
  let config: AppConfig;
  let authService: ReturnType<typeof createAuthService>;

  beforeAll(async () => {
    process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
    patchEntityMetadataForSQLite();
    dataSource = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [User, Invoice, Investment, AuthChallenge, Transaction, KYCVerification, Notification, KycHistory, SecondaryListing, Watchlist],
      synchronize: true,
      dropSchema: true,
    });
    await dataSource.initialize();

    config = {
      port: 3000,
      nodeEnv: "test",
      jwt: { secret: "test-secret-at-least-32-characters-long", expiresIn: "1h" },
      auth: { challengeTtlMs: 5 * 60 * 1000 },
      observability: { metricsEnabled: false },
      http: {
        trustProxy: false,
        corsAllowedOrigins: [],
        corsAllowCredentials: false,
        bodySizeLimit: "1mb",
        shutdownTimeoutMs: 15000,
        rateLimit: { enabled: false, windowMs: 60000, max: 1000 },
      },
      reconciliation: { enabled: false, intervalMs: 30000, batchSize: 25, gracePeriodMs: 60000, maxRuntimeMs: 10000 },
      stellar: { network: "testnet", networkPassphrase: "Test SDF Network ; September 2015" },
      sorobanEscrow: { enabled: false, contractId: null, fundingMode: "wallet_xdr", settlementMode: "wallet_xdr" },
      admin: { apiKey: "test-admin-key" },
      ipfs: {
        pinataJwt: "test",
        pinataGateway: "test",
        timeoutMs: 5000,
        maxRetries: 3,
        baseRetryDelayMs: 100,
        maxFileSizeMB: 10,
        allowedMimeTypes: ["application/pdf", "image/png", "image/jpeg"],
        uploadRateLimit: { windowMs: 15 * 60 * 1000, maxUploads: 10 },
      },
      kyc: {
        skipVerification: true,
        webhookSecret: "",
      },
    } as unknown as AppConfig;

    authService = createAuthService(dataSource, config);
    const invoiceService = createInvoiceService(dataSource, {} as any);
    app = createApp({ authService, invoiceService, config });
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it("should restrict seller dashboard aggregates (invoice list) to owned invoices", async () => {
    // 1. Setup - Create 2 users
    const userRepo = dataSource.getRepository(User);
    const sellerA = await userRepo.save(userRepo.create({ stellarAddress: "GA-SELLER-A", isKycVerified: true }));
    const sellerB = await userRepo.save(userRepo.create({ stellarAddress: "GA-SELLER-B", isKycVerified: true }));

    // 2. Create invoices for each
    const invoiceRepo = dataSource.getRepository(Invoice);
    await invoiceRepo.save([
      invoiceRepo.create({ sellerId: sellerA.id, invoiceNumber: "INV-A1", amount: "100", customerName: "C1", status: InvoiceStatus.DRAFT, dueDate: new Date() }),
      invoiceRepo.create({ sellerId: sellerA.id, invoiceNumber: "INV-A2", amount: "200", customerName: "C2", status: InvoiceStatus.FUNDED, dueDate: new Date() }),
      invoiceRepo.create({ sellerId: sellerB.id, invoiceNumber: "INV-B1", amount: "300", customerName: "C3", status: InvoiceStatus.SETTLED, dueDate: new Date() }),
    ]);

    // 3. Mock authentication
    const tokenA = authService.generateToken({ id: sellerA.id, stellarAddress: sellerA.stellarAddress });
    const tokenB = authService.generateToken({ id: sellerB.id, stellarAddress: sellerB.stellarAddress });

    // 4. Request invoices for Seller A
    const resA = await request(app)
      .get("/api/v1/invoices")
      .set("Authorization", `Bearer ${tokenA}`);

    expect(resA.status).toBe(200);
    expect(resA.body.data).toHaveLength(2);
    expect(resA.body.data.every((inv: any) => inv.sellerId === sellerA.id)).toBe(true);

    // 5. Request invoices for Seller B
    const resB = await request(app)
      .get("/api/v1/invoices")
      .set("Authorization", `Bearer ${tokenB}`);

    expect(resB.status).toBe(200);
    expect(resB.body.data).toHaveLength(1);
    expect(resB.body.data[0].sellerId).toBe(sellerB.id);
  });
});

describe("Integration: Seller Dashboard Aggregates", () => {
  let dataSource: DataSource;
  let app: ReturnType<typeof createApp>;
  const JWT_SECRET = "test-jwt-secret-key-32-chars-minimum-length";

  beforeAll(async () => {
    patchEntityMetadataForSQLite();
    dataSource = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [User, Invoice, Investment, AuthChallenge, Transaction, KYCVerification, Notification, KycHistory, SecondaryListing, Watchlist],
      synchronize: true,
      dropSchema: true,
    });
    await dataSource.initialize();

    const config = {
      jwt: { secret: JWT_SECRET, expiresIn: "1h" },
      auth: { challengeTtlMs: 300000 },
      stellar: { network: "TESTNET", networkPassphrase: "Test SDF Network ; September 2015" },
    } as unknown as AppConfig;

    const authService = createAuthService(dataSource, config);
    const sellerService = createSellerService(dataSource);

    app = createApp({
      authService,
      sellerService,
      metricsEnabled: false,
    });
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  function makeToken(user: User): string {
    return jwt.sign(
      {
        sub: user.stellarAddress,
        stellarAddress: user.stellarAddress,
        wallet: user.stellarAddress,
        role: user.userType,
        userType: user.userType,
        userId: user.id,
      },
      JWT_SECRET,
      { expiresIn: "1h" }
    );
  }

  it("should restrict seller dashboard aggregates to owned invoices and return accurate summary", async () => {
    const userRepo = dataSource.getRepository(User);
    const sellerA = await userRepo.save(
      userRepo.create({
        stellarAddress: "GASELLERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        userType: UserType.SELLER,
        kycStatus: KYCStatus.APPROVED,
        isKycVerified: true,
      })
    );
    const sellerB = await userRepo.save(
      userRepo.create({
        stellarAddress: "GBSELLERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        userType: UserType.SELLER,
        kycStatus: KYCStatus.APPROVED,
        isKycVerified: true,
      })
    );
    const investor = await userRepo.save(
      userRepo.create({
        stellarAddress: "GCINVESTORCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
        userType: UserType.INVESTOR,
        kycStatus: KYCStatus.APPROVED,
        isKycVerified: true,
      })
    );

    const invoiceRepo = dataSource.getRepository(Invoice);
    await invoiceRepo.save([
      invoiceRepo.create({
        sellerId: sellerA.id,
        invoiceNumber: "INV-A1",
        amount: "100.0000",
        netAmount: "95.0000",
        fundedAmount: "0.0000",
        customerName: "Customer 1",
        status: InvoiceStatus.PUBLISHED,
        dueDate: new Date(Date.now() + 86400000),
      }),
      invoiceRepo.create({
        sellerId: sellerA.id,
        invoiceNumber: "INV-A2",
        amount: "200.0000",
        netAmount: "190.0000",
        fundedAmount: "190.0000",
        customerName: "Customer 2",
        status: InvoiceStatus.FUNDED,
        dueDate: new Date(Date.now() + 86400000),
      }),
      invoiceRepo.create({
        sellerId: sellerB.id,
        invoiceNumber: "INV-B1",
        amount: "500.0000",
        netAmount: "480.0000",
        fundedAmount: "480.0000",
        customerName: "Customer 3",
        status: InvoiceStatus.SETTLED,
        dueDate: new Date(Date.now() + 86400000),
      }),
    ]);

    const tokenA = makeToken(sellerA);
    const tokenB = makeToken(sellerB);
    const tokenInvestor = makeToken(investor);

    // Request Seller A dashboard
    const resA = await request(app)
      .get("/api/v1/seller/dashboard")
      .set("Authorization", `Bearer ${tokenA}`);

    expect(resA.status).toBe(200);
    expect(resA.body.success).toBe(true);
    expect(resA.body.data.totalInvoices).toBe(2);
    expect(resA.body.data.totalFunded).toBe(1);
    expect(resA.body.data.totalSettled).toBe(0);
    expect(resA.body.data.totalRaised).toBe("190.0000");
    expect(resA.body.data.invoices).toHaveLength(2);
    expect(resA.body.data.invoices[0].fundingPercentage).toBeDefined();

    // Request Seller B dashboard
    const resB = await request(app)
      .get("/seller/dashboard")
      .set("Authorization", `Bearer ${tokenB}`);

    expect(resB.status).toBe(200);
    expect(resB.body.data.totalInvoices).toBe(1);
    expect(resB.body.data.totalSettled).toBe(1);
    expect(resB.body.data.totalRepaid).toBe("480.0000");

    // Investor should receive 403 Forbidden
    const resInvestor = await request(app)
      .get("/api/v1/seller/dashboard")
      .set("Authorization", `Bearer ${tokenInvestor}`);

    expect(resInvestor.status).toBe(403);

    // Unauthenticated should receive 401
    const resAnon = await request(app).get("/api/v1/seller/dashboard");
    expect(resAnon.status).toBe(401);
  });
});
