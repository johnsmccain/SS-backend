import { MigrationInterface, QueryRunner, Table, TableIndex, TableForeignKey } from "typeorm";

export class CreateSecondaryListingsTable1750000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: "secondary_listings",
        columns: [
          {
            name: "id",
            type: "uuid",
            isPrimary: true,
            generationStrategy: "uuid",
            default: "uuid_generate_v4()",
          },
          {
            name: "invoice_id",
            type: "uuid",
          },
          {
            name: "seller_wallet",
            type: "varchar",
            length: "56",
          },
          {
            name: "seller_id",
            type: "uuid",
            isNullable: true,
          },
          {
            name: "quantity",
            type: "decimal",
            precision: 18,
            scale: 4,
          },
          {
            name: "price_per_fraction",
            type: "decimal",
            precision: 18,
            scale: 4,
          },
          {
            name: "total_price",
            type: "decimal",
            precision: 18,
            scale: 4,
          },
          {
            name: "status",
            type: "enum",
            enum: ["active", "sold", "cancelled", "expired"],
            default: "'active'",
          },
          {
            name: "expires_at",
            type: "timestamptz",
          },
          {
            name: "cancellation_reason",
            type: "text",
            isNullable: true,
          },
          {
            name: "created_at",
            type: "timestamptz",
            default: "now()",
          },
          {
            name: "updated_at",
            type: "timestamptz",
            default: "now()",
          },
          {
            name: "deleted_at",
            type: "timestamptz",
            isNullable: true,
          },
          {
            name: "version",
            type: "integer",
            default: 0,
          },
        ],
      }),
      true
    );

    // Create indexes
    await queryRunner.createIndex(
      "secondary_listings",
      new TableIndex({
        name: "idx_secondary_listings_seller",
        columnNames: ["seller_wallet"],
      })
    );

    await queryRunner.createIndex(
      "secondary_listings",
      new TableIndex({
        name: "idx_secondary_listings_invoice",
        columnNames: ["invoice_id"],
      })
    );

    await queryRunner.createIndex(
      "secondary_listings",
      new TableIndex({
        name: "idx_secondary_listings_status_expiry",
        columnNames: ["status", "expires_at"],
      })
    );

    await queryRunner.createIndex(
      "secondary_listings",
      new TableIndex({
        name: "idx_secondary_listings_active",
        columnNames: ["status", "expires_at", "created_at"],
      })
    );

    await queryRunner.createIndex(
      "secondary_listings",
      new TableIndex({
        name: "idx_secondary_listings_seller_id",
        columnNames: ["seller_id"],
      })
    );

    await queryRunner.createIndex(
      "secondary_listings",
      new TableIndex({
        name: "idx_secondary_listings_status",
        columnNames: ["status"],
      })
    );

    await queryRunner.createIndex(
      "secondary_listings",
      new TableIndex({
        name: "idx_secondary_listings_expires_at",
        columnNames: ["expires_at"],
      })
    );

    // Add foreign key constraint to invoices
    await queryRunner.createForeignKey(
      "secondary_listings",
      new TableForeignKey({
        columnNames: ["invoice_id"],
        referencedColumnNames: ["id"],
        referencedTableName: "invoices",
        onDelete: "CASCADE",
      })
    );

    // Add foreign key constraint to users
    await queryRunner.createForeignKey(
      "secondary_listings",
      new TableForeignKey({
        columnNames: ["seller_id"],
        referencedColumnNames: ["id"],
        referencedTableName: "users",
        onDelete: "SET NULL",
      })
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("secondary_listings");
  }
}
