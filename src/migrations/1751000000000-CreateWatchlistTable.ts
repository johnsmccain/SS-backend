import { MigrationInterface, QueryRunner, Table, TableIndex, TableForeignKey } from "typeorm";

export class CreateWatchlistTable1751000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: "watchlist",
        columns: [
          {
            name: "id",
            type: "uuid",
            isPrimary: true,
            generationStrategy: "uuid",
            default: "uuid_generate_v4()",
          },
          {
            name: "wallet_address",
            type: "varchar",
            length: "56",
          },
          {
            name: "user_id",
            type: "uuid",
            isNullable: true,
          },
          {
            name: "invoice_id",
            type: "uuid",
          },
          {
            name: "notes",
            type: "jsonb",
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

    // Create unique index for wallet + invoice combination
    await queryRunner.createIndex(
      "watchlist",
      new TableIndex({
        name: "uq_watchlist_wallet_invoice",
        columnNames: ["wallet_address", "invoice_id"],
        isUnique: true,
      })
    );

    // Create other indexes
    await queryRunner.createIndex(
      "watchlist",
      new TableIndex({
        name: "idx_watchlist_wallet",
        columnNames: ["wallet_address"],
      })
    );

    await queryRunner.createIndex(
      "watchlist",
      new TableIndex({
        name: "idx_watchlist_invoice",
        columnNames: ["invoice_id"],
      })
    );

    await queryRunner.createIndex(
      "watchlist",
      new TableIndex({
        name: "idx_watchlist_user_id",
        columnNames: ["user_id"],
      })
    );

    // Add foreign key constraint to invoices
    await queryRunner.createForeignKey(
      "watchlist",
      new TableForeignKey({
        columnNames: ["invoice_id"],
        referencedColumnNames: ["id"],
        referencedTableName: "invoices",
        onDelete: "CASCADE",
      })
    );

    // Add foreign key constraint to users
    await queryRunner.createForeignKey(
      "watchlist",
      new TableForeignKey({
        columnNames: ["user_id"],
        referencedColumnNames: ["id"],
        referencedTableName: "users",
        onDelete: "SET NULL",
      })
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("watchlist");
  }
}
