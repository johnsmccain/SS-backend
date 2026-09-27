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
import {
  InvestmentStatus,
  TransactionStatus,
  TransactionType,
  InvoiceStatus,
  UserType,
  KYCStatus,
} from "../../src/types/enums";
import { VerifyPaymentService } from "../../src/services/stellar/verify-payment.service";

/**
 * Integration coverage for issue #219: retrying the same investment funding
 * request must not create duplicate commitments or double-process the
 * investor's payment.
 *
 * IMPORTANT SCOPE NOTE (see PR description for full disclosure): this
 * codebase has no idempotency-key parameter on
 * `InvestmentService.createInvestment` (src/services/investment.service.ts).
 * Calling it twice with identical inputs creates two independent Investment
 * rows today — there is no request-identity or idempotency-key dedup at that
 * layer to test.
 *
 * The dedup key that *does* exist end-to-end is the Stellar transaction hash
 * used to confirm a commitment's on-chain payment
 * (VerifyPaymentService.verifyPayment, invoked both from the manual
 * verify-payment route and from the reconciliation worker). Resubmitting the
 * same transaction hash for the same investment is the realistic way a
 * "retry" manifests in this system (e.g. a client retrying a webhook or a
 * reconciliation tick re-processing a candidate), so this suite verifies
 * that path end-to-end against a real database: only one investment
 * commitment transitions to CONFIRMED and only one Transaction row is ever
 * created, no matter how many times the same payment is submitted.
 */
describe("Duplicate investment funding idempotency (issue #219)", () => {
  let dataSource: DataSource;
  let seller: User;
  let investor: User;
  let invoice: Invoice;

  const paymentVerificationConfig = {
    horizonUrl: "https://horizon-testnet.stellar.org",
    escrowPublicKey: "GESCROW123",
    usdcAssetCode: "USDC",
    usdcAssetIssuer: "GUSDC123",
    allowedAmountDelta: "0.01",
    retryAttempts: 3,
    retryBaseDelayMs: 10,
  };

  function createVerifier(mockFetch: jest.Mock): VerifyPaymentService {
    return new VerifyPaymentService({
      investmentReader: {
        findById: async (id: string) =>
          dataSource.getRepository(Investment).findOne({ where: { id } }),
      },
      transactionRunner: {
        runInTransaction: async (callback) =>
          dataSource.transaction(async (manager) => {
            const investmentRepo = manager.getRepository(Investment);
            const transactionRepo = manager.getRepository(Transaction);
            return callback({
              findInvestmentByIdForUpdate: (id: string) =>
                investmentRepo.findOne({ where: { id } }),
              findTransactionsByInvestmentIdForUpdate: (investmentId: string) =>
                transactionRepo.find({ where: { investmentId } }),
              saveInvestment: (inv: Investment) => investmentRepo.save(inv),
              saveTransaction: (tx: Transaction) => transactionRepo.save(tx),
              createTransaction: (input: Partial<Transaction>) => transactionRepo.create(input),
            });
          }),
      },
      config: paymentVerificationConfig,
      fetchImplementation: mockFetch,
      sleep: async () => undefined,
    });
  }

  function mockHorizonSuccess(amount: string): jest.Mock {
    return jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ successful: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          _embedded: {
            records: [
              {
                id: "op-1",
                type: "payment",
                asset_code: "USDC",
                asset_issuer: "GUSDC123",
                amount,
                to: "GESCROW123",
              },
            ],
          },
        }),
      });
  }

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
        stellarAddress: "GSELLERDUP123",
        email: "seller-dup@test.com",
        userType: UserType.SELLER,
        kycStatus: KYCStatus.APPROVED,
      })
    );

    investor = await userRepository.save(
      userRepository.create({
        stellarAddress: "GINVESTORDUP123",
        email: "investor-dup@test.com",
        userType: UserType.INVESTOR,
        kycStatus: KYCStatus.APPROVED,
      })
    );

    const invoiceRepository = dataSource.getRepository(Invoice);
    invoice = await invoiceRepository.save(
      invoiceRepository.create({
        sellerId: seller.id,
        invoiceNumber: "TEST-INV-DUP-001",
        customerName: "Duplicate Test Customer",
        amount: "1000.0000",
        discountRate: "10.00",
        netAmount: "900.0000",
        dueDate: new Date("2025-12-31"),
        status: InvoiceStatus.PUBLISHED,
      })
    );
  }, 30000);

  afterAll(async () => {
    if (dataSource && dataSource.isInitialized) {
      await dataSource.destroy();
    }
  });

  it("produces exactly one investment commitment and one transaction record when the same payment is verified twice", async () => {
    if (!dataSource || !dataSource.isInitialized) {
      console.warn("Skipping test - DATABASE_URL not configured");
      return;
    }

    const investmentRepository = dataSource.getRepository(Investment);
    const transactionRepository = dataSource.getRepository(Transaction);

    const investment = await investmentRepository.save(
      investmentRepository.create({
        invoiceId: invoice.id,
        investorId: investor.id,
        investmentAmount: "500.0000",
        expectedReturn: "526.3158",
        status: InvestmentStatus.PENDING,
      })
    );

    const stellarTxHash = "dup-tx-hash-001";

    // First submission: the request identity is the Stellar transaction hash,
    // standing in for a client-supplied idempotency key / request identity.
    const firstVerifier = createVerifier(mockHorizonSuccess("500.0000"));
    const firstResult = await firstVerifier.verifyPayment({
      investmentId: investment.id,
      stellarTxHash,
    });

    expect(firstResult.outcome).toBe("verified");
    expect(firstResult.status).toBe(InvestmentStatus.CONFIRMED);

    // Second submission: the investor (or a retried webhook/client) resubmits
    // the exact same payment confirmation for the exact same investment.
    const secondVerifier = createVerifier(mockHorizonSuccess("500.0000"));
    const secondResult = await secondVerifier.verifyPayment({
      investmentId: investment.id,
      stellarTxHash,
    });

    // The response should identify the original result consistently rather
    // than creating new state.
    expect(secondResult.outcome).toBe("already_verified");
    expect(secondResult.status).toBe(InvestmentStatus.CONFIRMED);
    expect(secondResult.investmentId).toBe(firstResult.investmentId);
    expect(secondResult.stellarTxHash).toBe(firstResult.stellarTxHash);

    // Exactly one investment commitment exists.
    const investmentCount = await investmentRepository.count({
      where: { invoiceId: invoice.id, investorId: investor.id },
    });
    expect(investmentCount).toBe(1);

    // Only one payment-verification (Transaction) workflow/record was created.
    const transactions = await transactionRepository.find({
      where: { investmentId: investment.id },
    });
    expect(transactions).toHaveLength(1);
    expect(transactions[0].status).toBe(TransactionStatus.COMPLETED);
    expect(transactions[0].type).toBe(TransactionType.INVESTMENT);

    const finalInvestment = await investmentRepository.findOne({ where: { id: investment.id } });
    expect(finalInvestment?.status).toBe(InvestmentStatus.CONFIRMED);
    expect(finalInvestment?.transactionHash).toBe(stellarTxHash);
  });

  it("rejects a conflicting confirmation attempt for an already-confirmed investment with a different payment", async () => {
    if (!dataSource || !dataSource.isInitialized) {
      console.warn("Skipping test - DATABASE_URL not configured");
      return;
    }

    const investmentRepository = dataSource.getRepository(Investment);

    const investment = await investmentRepository.save(
      investmentRepository.create({
        invoiceId: invoice.id,
        investorId: investor.id,
        investmentAmount: "250.0000",
        expectedReturn: "263.1579",
        status: InvestmentStatus.PENDING,
      })
    );

    const firstVerifier = createVerifier(mockHorizonSuccess("250.0000"));
    const firstResult = await firstVerifier.verifyPayment({
      investmentId: investment.id,
      stellarTxHash: "dup-tx-hash-conflict-original",
    });
    expect(firstResult.outcome).toBe("verified");

    // A different transaction hash for the same investment is not a retry —
    // it must not be treated as idempotent and must not silently overwrite
    // the original confirmed state.
    const secondVerifier = createVerifier(mockHorizonSuccess("250.0000"));
    await expect(
      secondVerifier.verifyPayment({
        investmentId: investment.id,
        stellarTxHash: "dup-tx-hash-conflict-different",
      })
    ).rejects.toMatchObject({ code: "reconciliation_conflict", statusCode: 409 });

    // Original confirmed state must be untouched.
    const finalInvestment = await investmentRepository.findOne({ where: { id: investment.id } });
    expect(finalInvestment?.status).toBe(InvestmentStatus.CONFIRMED);
    expect(finalInvestment?.transactionHash).toBe("dup-tx-hash-conflict-original");
  });

  it("does not call Horizon again when re-verifying an investment that is already fully confirmed", async () => {
    if (!dataSource || !dataSource.isInitialized) {
      console.warn("Skipping test - DATABASE_URL not configured");
      return;
    }

    const investmentRepository = dataSource.getRepository(Investment);
    const stellarTxHash = "dup-tx-hash-no-refetch";

    const investment = await investmentRepository.save(
      investmentRepository.create({
        invoiceId: invoice.id,
        investorId: investor.id,
        investmentAmount: "120.0000",
        expectedReturn: "126.3158",
        status: InvestmentStatus.CONFIRMED,
        transactionHash: stellarTxHash,
        stellarOperationIndex: 0,
      })
    );

    const mockFetch = jest.fn();
    const verifier = createVerifier(mockFetch);

    const result = await verifier.verifyPayment({
      investmentId: investment.id,
      stellarTxHash,
      operationIndex: 0,
    });

    expect(result.outcome).toBe("already_verified");
    // The short-circuit for an already-confirmed investment with a matching
    // hash/operationIndex happens before any Horizon lookup.
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
