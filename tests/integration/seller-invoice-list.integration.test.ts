import { DataSource } from "typeorm";
import { Investment } from "../../src/models/Investment.model";
import { Transaction } from "../../src/models/Transaction.model";
import { Invoice } from "../../src/models/Invoice.model";
import { User } from "../../src/models/User.model";
import { KYCVerification } from "../../src/models/KYCVerification.model";
import { Notification } from "../../src/models/Notification.model";
import { KycHistory } from "../../src/models/KycHistory.model";
import { SecondaryListing } from "../../src/models/SecondaryListing.model";
import { Watchlist } from "../../src/models/Watchlist.model";
import { AuthChallenge } from "../../src/models/AuthChallenge.model";
import { InvoiceStatus, UserType, KYCStatus } from "../../src/types/enums";
import { createInvoiceService, InvoiceService } from "../../src/services/invoice.service";
import type { IPFSService } from "../../src/services/ipfs.service";

describe("Seller invoice list integration: no cross-seller leakage", () => {
  let dataSource: DataSource;
  let invoiceService: InvoiceService;
  let sellerA: User;
  let sellerB: User;

  const noopIpfsService = {} as IPFSService;

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
    sellerA = await userRepository.save(
      userRepository.create({
        stellarAddress: "GSELLERA123",
        email: "sellerA@test.com",
        userType: UserType.SELLER,
        kycStatus: KYCStatus.APPROVED,
      })
    );

    sellerB = await userRepository.save(
      userRepository.create({
        stellarAddress: "GSELLERB123",
        email: "sellerB@test.com",
        userType: UserType.SELLER,
        kycStatus: KYCStatus.APPROVED,
      })
    );

    const invoiceRepository = dataSource.getRepository(Invoice);

    const sellerAInvoices = [
      { invoiceNumber: "INV-A-001", status: InvoiceStatus.DRAFT },
      { invoiceNumber: "INV-A-002", status: InvoiceStatus.PUBLISHED },
      { invoiceNumber: "INV-A-003", status: InvoiceStatus.FUNDED },
    ];
    for (const overrides of sellerAInvoices) {
      await invoiceRepository.save(
        invoiceRepository.create({
          sellerId: sellerA.id,
          customerName: "Customer A",
          amount: "1000.0000",
          discountRate: "5.00",
          netAmount: "950.0000",
          dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          ...overrides,
        })
      );
    }

    const sellerBInvoices = [
      { invoiceNumber: "INV-B-001", status: InvoiceStatus.PUBLISHED },
      { invoiceNumber: "INV-B-002", status: InvoiceStatus.SETTLED },
    ];
    for (const overrides of sellerBInvoices) {
      await invoiceRepository.save(
        invoiceRepository.create({
          sellerId: sellerB.id,
          customerName: "Customer B",
          amount: "2000.0000",
          discountRate: "5.00",
          netAmount: "1900.0000",
          dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          ...overrides,
        })
      );
    }

    invoiceService = createInvoiceService(dataSource, noopIpfsService);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it("returns exactly seller A's 3 invoices with no seller B leakage", async () => {
    if (!process.env.DATABASE_URL) {
      return;
    }

    const result = await invoiceService.getInvoicesBySellerId({
      sellerId: sellerA.id,
      take: 20,
    });

    expect(result.total).toBe(3);
    expect(result.invoices).toHaveLength(3);
    expect(result.invoices.every((invoice) => invoice.sellerId === sellerA.id)).toBe(true);

    const sellerBInvoiceNumbers = ["INV-B-001", "INV-B-002"];
    expect(
      result.invoices.some((invoice) => sellerBInvoiceNumbers.includes(invoice.invoiceNumber))
    ).toBe(false);
  });

  it("includes invoices in all states (draft, published, funded)", async () => {
    if (!process.env.DATABASE_URL) {
      return;
    }

    const result = await invoiceService.getInvoicesBySellerId({
      sellerId: sellerA.id,
      take: 20,
    });

    const statuses = result.invoices.map((invoice) => invoice.status);
    expect(statuses).toEqual(
      expect.arrayContaining([InvoiceStatus.DRAFT, InvoiceStatus.PUBLISHED, InvoiceStatus.FUNDED])
    );
  });

  it("returns exactly seller B's 2 invoices with no seller A leakage", async () => {
    if (!process.env.DATABASE_URL) {
      return;
    }

    const result = await invoiceService.getInvoicesBySellerId({
      sellerId: sellerB.id,
      take: 20,
    });

    expect(result.total).toBe(2);
    expect(result.invoices).toHaveLength(2);
    expect(result.invoices.every((invoice) => invoice.sellerId === sellerB.id)).toBe(true);

    const statuses = result.invoices.map((invoice) => invoice.status);
    expect(statuses).toEqual(
      expect.arrayContaining([InvoiceStatus.PUBLISHED, InvoiceStatus.SETTLED])
    );
  });
});
