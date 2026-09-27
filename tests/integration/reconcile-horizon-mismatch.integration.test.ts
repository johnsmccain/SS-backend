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
  InvoiceStatus,
  UserType,
  KYCStatus,
} from "../../src/types/enums";
import { ReconcilePendingStellarStateWorker } from "../../src/workers/reconcile-pending-stellar-state.worker";
import { VerifyPaymentService } from "../../src/services/stellar/verify-payment.service";
import { logger } from "../../src/observability/logger";

/**
 * Integration coverage for issue #221: Horizon reconciliation must detect and
 * reject payments that do not match the invested amount or the expected
 * destination/asset, rather than silently marking a mismatched payment as
 * verified. Complements reconcile-horizon-payment.test.ts (happy path,
 * failed-transaction path, no-reprocess, and logging) with the mismatch
 * scenarios called out in the issue's acceptance criteria.
 */
describe("Horizon Reconciliation Worker Integration Test - mismatch handling", () => {
  let dataSource: DataSource;
  let worker: ReconcilePendingStellarStateWorker;
  let mockFetch: jest.Mock;
  let seller: User;
  let investor: User;
  let invoice: Invoice;

  const mockConfig = {
    reconciliation: {
      enabled: true,
      intervalMs: 30000,
      batchSize: 100,
      gracePeriodMs: 5000,
      maxRuntimeMs: 25000,
    },
    paymentVerification: {
      horizonUrl: "https://horizon-testnet.stellar.org",
      escrowPublicKey: "GESCROW123",
      usdcAssetCode: "USDC",
      usdcAssetIssuer: "GUSDC123",
      allowedAmountDelta: "0.01",
      retryAttempts: 3,
      retryBaseDelayMs: 100,
    },
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
        email: "seller-mismatch@test.com",
        userType: UserType.SELLER,
        kycStatus: KYCStatus.APPROVED,
      })
    );

    investor = await userRepository.save(
      userRepository.create({
        stellarAddress: "GINVESTOR123",
        email: "investor-mismatch@test.com",
        userType: UserType.INVESTOR,
        kycStatus: KYCStatus.APPROVED,
      })
    );

    const invoiceRepository = dataSource.getRepository(Invoice);
    invoice = await invoiceRepository.save(
      invoiceRepository.create({
        sellerId: seller.id,
        invoiceNumber: "TEST-INV-MISMATCH-001",
        customerName: "Test Customer",
        amount: "1000.0000",
        discountRate: "10.00",
        netAmount: "900.0000",
        dueDate: new Date("2025-12-31"),
        status: InvoiceStatus.PUBLISHED,
      })
    );

    mockFetch = jest.fn();

    const paymentVerifier = new VerifyPaymentService({
      investmentReader: {
        findById: async (id: string) => {
          return dataSource.getRepository(Investment).findOne({ where: { id } });
        },
      },
      transactionRunner: {
        runInTransaction: async <T>(callback: (unitOfWork: any) => Promise<T>): Promise<T> => {
          return dataSource.transaction(async (manager) => {
            const investmentRepo = manager.getRepository(Investment);
            const transactionRepo = manager.getRepository(Transaction);
            return callback({
              findInvestmentByIdForUpdate: (id: string) =>
                investmentRepo.findOne({ where: { id } }),
              findTransactionsByInvestmentIdForUpdate: (investmentId: string) =>
                transactionRepo.find({ where: { investmentId } }),
              saveInvestment: (investment: Investment) => investmentRepo.save(investment),
              saveTransaction: (transaction: Transaction) => transactionRepo.save(transaction),
              createTransaction: (input: Partial<Transaction>) => transactionRepo.create(input),
            });
          });
        },
      },
      config: mockConfig.paymentVerification,
      fetchImplementation: mockFetch,
      sleep: async () => undefined,
    });

    worker = new ReconcilePendingStellarStateWorker({
      repository: {
        findPendingCandidates: async (olderThan: Date, limit: number) => {
          const investmentRepo = dataSource.getRepository(Investment);
          const investments = await investmentRepo.find({
            where: {
              status: InvestmentStatus.PENDING,
            },
            take: limit,
          });

          return investments
            .filter((inv) => inv.transactionHash && inv.createdAt <= olderThan)
            .map((inv) => ({
              investmentId: inv.id,
              stellarTxHash: inv.transactionHash!,
              operationIndex: inv.stellarOperationIndex ?? undefined,
              source: "investment" as const,
              queuedAt: inv.createdAt,
            }));
        },
      },
      paymentVerifier,
      config: mockConfig.reconciliation,
      logger: logger.child({ test: "reconciliation-worker-mismatch" }),
    });
  }, 30000);

  afterAll(async () => {
    if (dataSource && dataSource.isInitialized) {
      await dataSource.destroy();
    }
  });

  beforeEach(async () => {
    if (!dataSource || !dataSource.isInitialized) {
      return;
    }
    mockFetch.mockClear();
    // Isolate each test: clear out PENDING investments left by earlier cases
    // so the worker only picks up the one investment created in this test.
    await dataSource.getRepository(Investment).delete({ status: InvestmentStatus.PENDING });
  });

  describe("amount mismatch", () => {
    it("does not mark the investment verified when Horizon amount differs from the expected investment amount", async () => {
      if (!dataSource || !dataSource.isInitialized) {
        console.warn("Skipping test - DATABASE_URL not configured");
        return;
      }

      const investmentRepository = dataSource.getRepository(Investment);
      const investment = await investmentRepository.save(
        investmentRepository.create({
          invoiceId: invoice.id,
          investorId: investor.id,
          investmentAmount: "500.0000",
          expectedReturn: "526.3158",
          status: InvestmentStatus.PENDING,
          transactionHash: "test-tx-amount-mismatch",
          stellarOperationIndex: 0,
          createdAt: new Date(Date.now() - 10000),
        })
      );

      // Horizon reports a successful transaction, but the payment operation
      // carries a materially different amount than what was invested.
      mockFetch
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
                  amount: "50.0000", // expected 500.0000
                  to: "GESCROW123",
                },
              ],
            },
          }),
        });

      const result = await worker.runTick();

      expect(result.candidatesFetched).toBe(1);
      expect(result.processed).toBe(1);
      expect(result.verified).toBe(0);
      expect(result.failed).toBe(1);

      const updatedInvestment = await investmentRepository.findOne({
        where: { id: investment.id },
      });
      // Mismatched payment must not be marked verified/confirmed.
      expect(updatedInvestment?.status).toBe(InvestmentStatus.PENDING);

      // No transaction row should have been created for the mismatched payment.
      const transactionRepository = dataSource.getRepository(Transaction);
      const transaction = await transactionRepository.findOne({
        where: { investmentId: investment.id },
      });
      expect(transaction).toBeNull();
    });

    it("surfaces the amount mismatch as a machine-readable invalid_payment error", async () => {
      if (!dataSource || !dataSource.isInitialized) {
        console.warn("Skipping test - DATABASE_URL not configured");
        return;
      }

      const investmentRepository = dataSource.getRepository(Investment);
      await investmentRepository.save(
        investmentRepository.create({
          invoiceId: invoice.id,
          investorId: investor.id,
          investmentAmount: "200.0000",
          expectedReturn: "210.5263",
          status: InvestmentStatus.PENDING,
          transactionHash: "test-tx-amount-mismatch-direct",
          stellarOperationIndex: 0,
          createdAt: new Date(Date.now() - 10000),
        })
      );

      const paymentVerifier = new VerifyPaymentService({
        investmentReader: {
          findById: async (id: string) => investmentRepository.findOne({ where: { id } }),
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
        config: mockConfig.paymentVerification,
        fetchImplementation: jest
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
                    amount: "1.0000",
                    to: "GESCROW123",
                  },
                ],
              },
            }),
          }),
        sleep: async () => undefined,
      });

      const investment = await investmentRepository.findOne({
        where: { transactionHash: "test-tx-amount-mismatch-direct" },
      });

      await expect(
        paymentVerifier.verifyPayment({
          investmentId: investment!.id,
          stellarTxHash: "test-tx-amount-mismatch-direct",
        })
      ).rejects.toMatchObject({
        code: "invalid_payment",
        statusCode: 422,
      });
    });
  });

  describe("sender/destination mismatch", () => {
    it("does not mark the investment verified when the payment destination does not match the escrow address", async () => {
      if (!dataSource || !dataSource.isInitialized) {
        console.warn("Skipping test - DATABASE_URL not configured");
        return;
      }

      const investmentRepository = dataSource.getRepository(Investment);
      const investment = await investmentRepository.save(
        investmentRepository.create({
          invoiceId: invoice.id,
          investorId: investor.id,
          investmentAmount: "300.0000",
          expectedReturn: "315.7895",
          status: InvestmentStatus.PENDING,
          transactionHash: "test-tx-destination-mismatch",
          stellarOperationIndex: 0,
          createdAt: new Date(Date.now() - 10000),
        })
      );

      mockFetch
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
                  amount: "300.0000",
                  to: "GSOMEOTHERWALLETNOTESCROW999", // wrong destination
                },
              ],
            },
          }),
        });

      const result = await worker.runTick();

      expect(result.candidatesFetched).toBe(1);
      expect(result.processed).toBe(1);
      expect(result.verified).toBe(0);
      expect(result.failed).toBe(1);

      const updatedInvestment = await investmentRepository.findOne({
        where: { id: investment.id },
      });
      expect(updatedInvestment?.status).toBe(InvestmentStatus.PENDING);

      const transactionRepository = dataSource.getRepository(Transaction);
      const transaction = await transactionRepository.findOne({
        where: { investmentId: investment.id },
      });
      expect(transaction).toBeNull();
    });

    it("does not mark the investment verified when the asset issuer does not match the configured USDC issuer", async () => {
      if (!dataSource || !dataSource.isInitialized) {
        console.warn("Skipping test - DATABASE_URL not configured");
        return;
      }

      const investmentRepository = dataSource.getRepository(Investment);
      const investment = await investmentRepository.save(
        investmentRepository.create({
          invoiceId: invoice.id,
          investorId: investor.id,
          investmentAmount: "150.0000",
          expectedReturn: "157.8947",
          status: InvestmentStatus.PENDING,
          transactionHash: "test-tx-issuer-mismatch",
          stellarOperationIndex: 0,
          createdAt: new Date(Date.now() - 10000),
        })
      );

      mockFetch
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
                  asset_issuer: "GUNTRUSTEDISSUER000", // wrong issuer, i.e. a counterfeit asset
                  amount: "150.0000",
                  to: "GESCROW123",
                },
              ],
            },
          }),
        });

      const result = await worker.runTick();

      expect(result.verified).toBe(0);
      expect(result.failed).toBe(1);

      const updatedInvestment = await investmentRepository.findOne({
        where: { id: investment.id },
      });
      expect(updatedInvestment?.status).toBe(InvestmentStatus.PENDING);
    });
  });

  describe("recovery after a mismatch", () => {
    it("still reconciles successfully once a subsequent valid payment is observed for a different investment", async () => {
      if (!dataSource || !dataSource.isInitialized) {
        console.warn("Skipping test - DATABASE_URL not configured");
        return;
      }

      const investmentRepository = dataSource.getRepository(Investment);
      const transactionRepository = dataSource.getRepository(Transaction);

      // First: a mismatched payment that must fail reconciliation.
      const mismatchedInvestment = await investmentRepository.save(
        investmentRepository.create({
          invoiceId: invoice.id,
          investorId: investor.id,
          investmentAmount: "100.0000",
          expectedReturn: "105.2632",
          status: InvestmentStatus.PENDING,
          transactionHash: "test-tx-mismatch-then-valid-bad",
          stellarOperationIndex: 0,
          createdAt: new Date(Date.now() - 20000),
        })
      );

      // Respond based on which transaction hash Horizon is being asked about,
      // rather than call order, since the mismatched investment stays PENDING
      // and will be re-fetched again on the second tick alongside the new one.
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes("test-tx-mismatch-then-valid-bad")) {
          if (url.includes("/operations")) {
            return {
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
                      amount: "1.0000", // mismatched
                      to: "GESCROW123",
                    },
                  ],
                },
              }),
            };
          }
          return { ok: true, status: 200, json: async () => ({ successful: true }) };
        }

        if (url.includes("test-tx-mismatch-then-valid-good")) {
          if (url.includes("/operations")) {
            return {
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
                      amount: "600.0000",
                      to: "GESCROW123",
                    },
                  ],
                },
              }),
            };
          }
          return { ok: true, status: 200, json: async () => ({ successful: true }) };
        }

        throw new Error(`Unexpected Horizon request in test: ${url}`);
      });

      const firstTick = await worker.runTick();
      expect(firstTick.verified).toBe(0);
      expect(firstTick.failed).toBe(1);

      const afterFirstTick = await investmentRepository.findOne({
        where: { id: mismatchedInvestment.id },
      });
      expect(afterFirstTick?.status).toBe(InvestmentStatus.PENDING);

      // Second: a different, valid investment/payment must still reconcile
      // successfully in a later cycle — one bad payment must not poison the
      // worker or block subsequent valid reconciliations. The still-PENDING
      // mismatched investment is fetched again too (mockImplementation above
      // keeps returning its mismatched amount, so it correctly fails again).
      const validInvestment = await investmentRepository.save(
        investmentRepository.create({
          invoiceId: invoice.id,
          investorId: investor.id,
          investmentAmount: "600.0000",
          expectedReturn: "631.5789",
          status: InvestmentStatus.PENDING,
          transactionHash: "test-tx-mismatch-then-valid-good",
          stellarOperationIndex: 0,
          createdAt: new Date(Date.now() - 10000),
        })
      );

      const secondTick = await worker.runTick();
      expect(secondTick.verified).toBeGreaterThanOrEqual(1);

      const updatedValidInvestment = await investmentRepository.findOne({
        where: { id: validInvestment.id },
      });
      expect(updatedValidInvestment?.status).toBe(InvestmentStatus.CONFIRMED);

      const transaction = await transactionRepository.findOne({
        where: { investmentId: validInvestment.id },
      });
      expect(transaction).toBeDefined();
      expect(transaction?.status).toBe(TransactionStatus.COMPLETED);

      // The earlier mismatched investment must remain unverified.
      const stillMismatched = await investmentRepository.findOne({
        where: { id: mismatchedInvestment.id },
      });
      expect(stillMismatched?.status).toBe(InvestmentStatus.PENDING);
    });
  });
});
