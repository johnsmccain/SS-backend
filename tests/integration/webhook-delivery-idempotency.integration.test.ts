import "reflect-metadata";
import { DataSource, getMetadataArgsStorage } from "typeorm";
import { WebhookDispatcherService } from "../../src/services/webhook-dispatcher.service";
import { WebhookSubscription } from "../../src/models/WebhookSubscription.model";
import { WebhookDeliveryLog } from "../../src/models/WebhookDeliveryLog.model";
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
import type { AppLogger, LogMetadata } from "../../src/observability/logger";

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

interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  metadata: LogMetadata;
}

class CaptureLogger implements AppLogger {
  constructor(private readonly entries: LogEntry[]) {}

  debug(message: string, metadata: LogMetadata = {}): void {
    this.entries.push({ level: "debug", message, metadata });
  }

  info(message: string, metadata: LogMetadata = {}): void {
    this.entries.push({ level: "info", message, metadata });
  }

  warn(message: string, metadata: LogMetadata = {}): void {
    this.entries.push({ level: "warn", message, metadata });
  }

  error(message: string, metadata: LogMetadata = {}): void {
    this.entries.push({ level: "error", message, metadata });
  }

  child(_metadata: LogMetadata): AppLogger {
    return this;
  }
}

/**
 * Integration coverage for issue #224: delivering the same webhook event ID
 * more than once must not repeat downstream side effects. The first delivery
 * is processed once; a duplicate event short-circuits before any HTTP call,
 * the delivery records stay for the single successful delivery, and the log
 * identifies the event as already handled.
 */
describe("Webhook delivery idempotency (issue #224)", () => {
  let dataSource: DataSource;
  let subscription: WebhookSubscription;
  let loggerEntries: LogEntry[];
  let logger: CaptureLogger;
  let fetchMock: jest.Mock;

  const EVENT_TYPE = "invoice.published";
  const EVENT_ID = "evt-0001";
  const PAYLOAD = { invoiceId: "invoice-1", amount: "6000" };

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
        AuthChallenge,
        Transaction,
        KYCVerification,
        Notification,
        KycHistory,
        SecondaryListing,
        Watchlist,
        WebhookSubscription,
        WebhookDeliveryLog,
      ],
    });

    await dataSource.initialize();

    const userRepository = dataSource.getRepository(User);
    const user = (await userRepository.save(
      userRepository.create({
        stellarAddress: "GIDEMPOTENCY123",
        email: "idempotency@test.com",
        userType: "seller",
        kycStatus: "approved",
      } as any)
    )) as unknown as User;

    const subscriptionRepository = dataSource.getRepository(WebhookSubscription);
    subscription = (await subscriptionRepository.save(
      subscriptionRepository.create({
        userId: user.id,
        url: "https://subscriber.example.test/hooks/invoice",
        secret: "whsec_subscription_secret",
        eventTypes: [EVENT_TYPE],
        active: true,
      } as any)
    )) as unknown as WebhookSubscription;
  }, 30000);

  beforeEach(async () => {
    loggerEntries = [];
    logger = new CaptureLogger(loggerEntries);
    fetchMock = jest.fn().mockResolvedValue({ status: 202 });
    global.fetch = fetchMock as unknown as typeof fetch;
    await dataSource.getRepository(WebhookDeliveryLog).clear();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    jest.restoreAllMocks();
  });

  async function deliveryLogCount(): Promise<number> {
    return dataSource
      .getRepository(WebhookDeliveryLog)
      .count({ where: { subscriptionId: subscription.id, eventId: EVENT_ID } });
  }

  async function deliveredLogCount(): Promise<number> {
    return dataSource
      .getRepository(WebhookDeliveryLog)
      .count({ where: { subscriptionId: subscription.id, eventId: EVENT_ID, delivered: true } });
  }

  it("processes the first event once and records a successful delivery", async () => {
    const dispatcher = new WebhookDispatcherService(dataSource, logger);

    const [result] = await dispatcher.dispatchWebhookEvent(EVENT_TYPE, PAYLOAD, EVENT_ID);

    expect(result).toMatchObject({
      subscriptionId: subscription.id,
      delivered: true,
      attempts: 1,
      responseStatus: 202,
      duplicate: false,
    });

    // The downstream side effect (the subscriber HTTP request) fired exactly once.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      subscription.url,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-event-id": EVENT_ID,
          "x-signature": expect.any(String),
        }),
      })
    );

    // A delivered delivery record is persisted for this event + subscription.
    expect(await deliveredLogCount()).toBe(1);
    const stored = await dataSource
      .getRepository(WebhookDeliveryLog)
      .findOne({ where: { subscriptionId: subscription.id, eventId: EVENT_ID, delivered: true } });
    expect(stored?.eventType).toBe(EVENT_TYPE);
    expect(stored?.responseStatus).toBe(202);
  });

  it("does not re-deliver a duplicate event id after a successful delivery", async () => {
    const dispatcher = new WebhookDispatcherService(dataSource, logger);

    // First delivery succeeds and is recorded.
    await dispatcher.dispatchWebhookEvent(EVENT_TYPE, PAYLOAD, EVENT_ID);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Duplicate delivery of the same event id must be a no-op at the HTTP layer.
    const [duplicate] = await dispatcher.dispatchWebhookEvent(EVENT_TYPE, PAYLOAD, EVENT_ID);

    expect(duplicate).toMatchObject({
      subscriptionId: subscription.id,
      delivered: false,
      attempts: 0,
      responseStatus: null,
      duplicate: true,
    });

    // The downstream notification/state transition is NOT repeated.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Only the original delivered record exists; no extra rows were appended.
    expect(await deliveredLogCount()).toBe(1);
    expect(await deliveryLogCount()).toBe(1);

    // The duplicate is identified as already handled in the delivery log lines.
    const alreadyHandled = loggerEntries.find(
      (entry) => entry.level === "info" && entry.message === "webhook.event.already_handled"
    );
    expect(alreadyHandled).toBeDefined();
    expect(alreadyHandled?.metadata).toMatchObject({
      subscription_id: subscription.id,
      event_type: EVENT_TYPE,
      event_id: EVENT_ID,
    });
  });

  it("still delivers a brand-new event id after a prior event was handled", async () => {
    const dispatcher = new WebhookDispatcherService(dataSource, logger);

    await dispatcher.dispatchWebhookEvent(EVENT_TYPE, PAYLOAD, EVENT_ID);
    const newEventId = "evt-0002";

    const [result] = await dispatcher.dispatchWebhookEvent(EVENT_TYPE, PAYLOAD, newEventId);

    // Idempotency must not suppress a *different* event.
    expect(result).toMatchObject({ delivered: true, attempts: 1, duplicate: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not mark a failed delivery as already handled", async () => {
    fetchMock.mockResolvedValue({ status: 500 });
    const dispatcher = new WebhookDispatcherService(dataSource, logger);

    const [result] = await dispatcher.dispatchWebhookEvent(EVENT_TYPE, PAYLOAD, EVENT_ID);

    expect(result).toMatchObject({ delivered: false, attempts: 3, duplicate: false });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // A failed delivery is NOT marked as already handled, so a later attempt
    // with the same event id is retried normally.
    const alreadyHandled = loggerEntries.find(
      (entry) => entry.message === "webhook.event.already_handled"
    );
    expect(alreadyHandled).toBeUndefined();
  });
});
