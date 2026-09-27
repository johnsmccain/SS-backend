import { DataSource } from "typeorm";
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
import {
  createMarketplaceService,
  MarketplaceService,
} from "../../src/services/marketplace.service";
import { InvoiceStatus, UserType, KYCStatus } from "../../src/types/enums";

/**
 * Integration coverage for issue #205: "invoice search endpoint returning
 * results ranked by relevance when query matches both title and
 * description."
 *
 * IMPORTANT SCOPE NOTE (see PR description for full disclosure): the
 * `Invoice` entity (src/models/Invoice.model.ts) has no `title` or
 * `description` field, and the marketplace search
 * (src/services/marketplace.service.ts -> TypeORMMarketplaceRepository)
 * performs a single case-insensitive `LIKE` filter against `customer_name`
 * only. There is no relevance scoring anywhere in the codebase (confirmed by
 * grepping for rank/score/relevance logic) — results are ordered strictly by
 * the caller-selected `sort` field (due_date/discount_rate/amount/created_at),
 * never by how well a row matches the search term. A title-vs-description
 * ranking test as literally described in the issue cannot be written against
 * existing functionality without inventing a schema and ranking algorithm
 * that don't exist, which is out of scope for a test-only PR.
 *
 * What this suite does instead: it exercises the search endpoint's one real
 * text-matching field end-to-end against a real Postgres database (case
 * sensitivity, substring matching, and empty-result behavior — the parts of
 * the issue's acceptance criteria that map onto real, existing behavior),
 * and it explicitly documents (and skips, rather than fakes) the
 * relevance-ranking assertions that have no implementation to verify.
 */
describe("Invoice search endpoint (issue #205) - real search behavior", () => {
  let dataSource: DataSource;
  let marketplaceService: MarketplaceService;
  let seller: User;

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
        stellarAddress: "GSELLERSEARCH123",
        email: "seller-search@test.com",
        userType: UserType.SELLER,
        kycStatus: KYCStatus.APPROVED,
      })
    );

    marketplaceService = createMarketplaceService(dataSource);
  }, 30000);

  afterAll(async () => {
    if (dataSource && dataSource.isInitialized) {
      await dataSource.destroy();
    }
  });

  async function seedInvoice(overrides: Partial<Invoice> = {}): Promise<Invoice> {
    const invoiceRepository = dataSource.getRepository(Invoice);
    return invoiceRepository.save(
      invoiceRepository.create({
        sellerId: seller.id,
        invoiceNumber: `INV-SEARCH-${Math.random().toString(36).slice(2, 10)}`,
        customerName: "Default Customer",
        amount: "1000.0000",
        discountRate: "5.00",
        netAmount: "950.0000",
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        status: InvoiceStatus.PUBLISHED,
        ...overrides,
      })
    );
  }

  it("matches invoices whose customer name contains the query term, case-insensitively", async () => {
    if (!dataSource || !dataSource.isInitialized) {
      console.warn("Skipping test - DATABASE_URL not configured");
      return;
    }

    const acme = await seedInvoice({ customerName: "Acme Logistics" });
    const other = await seedInvoice({ customerName: "Beta Traders" });

    const lowerResult = await marketplaceService.getPublishedInvoices({ search: "acme" });
    const ids = lowerResult.data.map((inv) => inv.id);
    expect(ids).toContain(acme.id);
    expect(ids).not.toContain(other.id);

    const upperResult = await marketplaceService.getPublishedInvoices({ search: "ACME" });
    expect(upperResult.data.map((inv) => inv.id)).toContain(acme.id);

    const mixedResult = await marketplaceService.getPublishedInvoices({ search: "AcMe" });
    expect(mixedResult.data.map((inv) => inv.id)).toContain(acme.id);
  });

  it("matches on a partial substring anywhere in the customer name", async () => {
    if (!dataSource || !dataSource.isInitialized) {
      console.warn("Skipping test - DATABASE_URL not configured");
      return;
    }

    const invoice = await seedInvoice({ customerName: "Northwind Traders Group" });

    const result = await marketplaceService.getPublishedInvoices({ search: "traders" });
    expect(result.data.map((inv) => inv.id)).toContain(invoice.id);
  });

  it("returns an empty array when the query matches no invoices", async () => {
    if (!dataSource || !dataSource.isInitialized) {
      console.warn("Skipping test - DATABASE_URL not configured");
      return;
    }

    await seedInvoice({ customerName: "Some Real Customer" });

    const result = await marketplaceService.getPublishedInvoices({
      search: "zzz-definitely-not-a-match-zzz",
    });

    expect(result.data).toEqual([]);
    expect(result.meta.total).toBe(0);
  });

  it("does not match invoices in the search term against unrelated fields (invoice number)", async () => {
    if (!dataSource || !dataSource.isInitialized) {
      console.warn("Skipping test - DATABASE_URL not configured");
      return;
    }

    const invoice = await seedInvoice({
      invoiceNumber: "INV-UNIQUE-TOKEN-999",
      customerName: "Unrelated Name Co",
    });

    // Searching for a term that only appears in invoiceNumber should not
    // match, since the search only filters on customer_name.
    const result = await marketplaceService.getPublishedInvoices({ search: "unique-token" });
    expect(result.data.map((inv) => inv.id)).not.toContain(invoice.id);
  });

  it.skip("GAP: ranks a title match above a description-only match (no title/description schema or relevance scoring exists to test)", () => {
    // Intentionally left unimplemented. Implementing this would require:
    //   1. Adding `title` and `description` columns to the Invoice entity
    //      (and a migration), since neither exists today.
    //   2. Implementing a relevance-ranking algorithm in
    //      TypeORMMarketplaceRepository (e.g. weighted full-text search via
    //      Postgres `ts_rank`/`ts_rank_cd`, or an application-level scoring
    //      pass) — today results are ordered only by the caller-provided
    //      `sort` field, never by match quality.
    // Both are feature work, not test work, and are out of scope for this
    // test-only issue. Flagged honestly here rather than asserting against
    // fabricated behavior.
  });

  it.skip("GAP: ranks a title+description match at or above a title-only match (same missing schema/ranking as above)", () => {
    // See skipped test above for the detailed explanation of the gap.
  });
});
