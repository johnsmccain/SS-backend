import "reflect-metadata";
import crypto from "crypto";
import { DataSource, getMetadataArgsStorage } from "typeorm";
import {
  MarketplaceService,
  createMarketplaceService,
} from "../../src/services/marketplace.service";
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

/**
 * SQLite does not support PostgreSQL-specific types (timestamptz, jsonb, enum);
 * we remap them to SQLite-compatible equivalents before DataSource init.
 */
function patchEntityMetadataForSQLite(): void {
  const columns = getMetadataArgsStorage().columns;
  for (const col of columns) {
    if (col.options.type === "timestamptz") {
      col.options.type = "datetime" as any;
    }
    if (col.options.type === "jsonb") {
      col.options.type = "simple-json" as any;
    }
    if (col.options.type === "enum") {
      col.options.type = "varchar" as any;
    }
  }
}

/**
 * Integration coverage for issue #226: marketplace cursor pagination must be
 * deterministic when listings share the primary sort value (equal face values
 * or equal creation timestamps). Pages must follow the documented primary sort
 * key plus the secondary id tiebreaker, with no listing repeated or skipped
 * across pages, and an invalid cursor must fail with a client error.
 */
describe("Marketplace cursor pagination stable ordering (issue #226)", () => {
  let dataSource: DataSource;
  let service: MarketplaceService;
  let sellerId: string;
  let seededInvoiceIds: string[];

  beforeAll(async () => {
    patchEntityMetadataForSQLite();

    dataSource = new DataSource({
      type: "sqlite",
      database: ":memory:",
      synchronize: true,
      logging: false,
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
    });

    await dataSource.initialize();

    const userRepository = dataSource.getRepository(User);
    const seller = (await userRepository.save(
      userRepository.create({
        stellarAddress: "GMARKETPLACECURSOR1",
        email: "seller-cursor@test.com",
        userType: UserType.SELLER,
        kycStatus: KYCStatus.APPROVED,
      } as any)
    )) as unknown as User;
    sellerId = seller.id;

    service = createMarketplaceService(dataSource);
  }, 30000);

  beforeEach(async () => {
    await dataSource.getRepository(Invoice).clear();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  function invoiceRepo() {
    return dataSource.getRepository(Invoice);
  }

  async function seedInvoice(overrides: Partial<Invoice>): Promise<Invoice> {
    return (await invoiceRepo().save(
      invoiceRepo().create({
        sellerId,
        invoiceNumber: `INV-${crypto.randomUUID().slice(0, 8)}`,
        customerName: "Corp",
        amount: "5000.0000",
        discountRate: "5.00",
        netAmount: "4750.0000",
        dueDate: new Date("2026-01-31"),
        ipfsHash: "QmTest",
        riskScore: null,
        status: InvoiceStatus.PUBLISHED,
        smartContractId: null,
        ...overrides,
      } as any)
    )) as unknown as Invoice;
  }

  /** Seeds `count` listings that all share the same primary sort value. */
  async function seedTiedListings(count: number, shared: Partial<Invoice>): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const invoice = await seedInvoice(shared);
      ids.push(invoice.id);
    }
    return ids;
  }

  async function collectAllPages(
    sortField: "amount" | "created_at",
    limit: number
  ): Promise<string[]> {
    const ordered: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    for (;;) {
      const page = await service.getPublishedInvoicesByCursor(
        { status: [InvoiceStatus.PUBLISHED] },
        {
          sortField,
          order: "DESC",
          limit,
          cursor,
        }
      );
      page.data.forEach((invoice) => ordered.push(invoice.id));
      pages += 1;
      if (!page.hasMore) {
        break;
      }
      cursor = page.nextCursor;
      expect(pages).toBeLessThanOrEqual(100);
    }

    return ordered;
  }

  it("pages over equal face values with deterministic id tie-ins (no repeats, no skips)", async () => {
    const expected = await seedTiedListings(7, {
      amount: "5000.0000",
      status: InvoiceStatus.PUBLISHED,
    });
    const idAsc = [...expected].sort((a, b) => a.localeCompare(b));

    const ordered = await collectAllPages("amount", 2);

    expect(ordered).toHaveLength(expected.length);
    expect(new Set(ordered).size).toBe(expected.length); // no duplicates
    expect(ordered).toEqual(idAsc); // primary value equal -> secondary id ASC wins
  });

  it("applies the primary amount ordering before the id tiebreaker", async () => {
    const big = await seedInvoice({ amount: "9000.0000" });
    const medium = await seedInvoice({ amount: "7000.0000" });
    const small = await seedInvoice({ amount: "1000.0000" });
    const expectedByName: Record<string, string> = {
      "9000.0000": big.id,
      "7000.0000": medium.id,
      "1000.0000": small.id,
    };

    const page = await service.getPublishedInvoicesByCursor(
      { status: [InvoiceStatus.PUBLISHED] },
      { sortField: "amount", order: "DESC", limit: 10 }
    );

    const amounts = page.data.map((invoice) => Number(invoice.amount));
    expect(amounts).toEqual([9000, 7000, 1000]);

    // Each listing appears in the page exactly once.
    const ids = page.data.map((invoice) => invoice.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toContain(expectedByName["9000.0000"]);
    expect(ids).toContain(expectedByName["7000.0000"]);
    expect(ids).toContain(expectedByName["1000.0000"]);
  });

  it("assets equal creation timestamps are broken by the id tiebreaker without gaps", async () => {
    const fixedCreatedAt = new Date("2025-06-01T00:00:00.000Z");
    const ids = await seedTiedListings(6, {
      status: InvoiceStatus.PUBLISHED,
      createdAt: fixedCreatedAt,
    });

    // Force the created_at column to an identical value so the primary sort is
    // genuinely tied (CreateDateColumn otherwise timestamps each insert).
    await dataSource.query(`UPDATE invoices SET created_at = ?`, [fixedCreatedAt.toISOString()]);

    const idAsc = [...ids].sort((a, b) => a.localeCompare(b));
    const ordered = await collectAllPages("created_at", 3);

    expect(ordered).toHaveLength(ids.length);
    expect(new Set(ordered).size).toBe(ids.length); // no duplicate / skipped rows
    expect(ordered).toEqual(idAsc);
  });

  it("returns the expected client error for an invalid cursor", async () => {
    await expect(
      service.getPublishedInvoicesByCursor(
        { status: [InvoiceStatus.PUBLISHED] },
        { sortField: "amount", order: "DESC", limit: 10, cursor: "not-valid-cursor!!" }
      )
    ).rejects.toMatchObject({ code: "invalid_cursor", statusCode: 400 });
  });

  it("returns the expected client error when a cursor is encoded for a different field", async () => {
    const { encodeQueryCursor } = await import("../../src/utils/query-pagination.utils");
    const wrongFieldCursor = encodeQueryCursor(
      "invoice.dueDate",
      "2026-01-31T00:00:00.000Z",
      "some-id"
    );

    await expect(
      service.getPublishedInvoicesByCursor(
        { status: [InvoiceStatus.PUBLISHED] },
        { sortField: "amount", order: "DESC", limit: 10, cursor: wrongFieldCursor }
      )
    ).rejects.toMatchObject({ code: "invalid_cursor", statusCode: 400 });
  });
});
