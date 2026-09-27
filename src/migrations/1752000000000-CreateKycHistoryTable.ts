import { MigrationInterface, QueryRunner, Table, TableIndex, TableForeignKey } from "typeorm";

export class CreateKycHistoryTable1752000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: "kyc_history",
        columns: [
          {
            name: "id",
            type: "uuid",
            isPrimary: true,
            generationStrategy: "uuid",
            default: "uuid_generate_v4()",
          },
          {
            name: "user_id",
            type: "uuid",
          },
          {
            name: "wallet",
            type: "varchar",
            length: "56",
            isNullable: true,
          },
          {
            name: "verification_type",
            type: "enum",
            enum: ["identity", "address", "business"],
          },
          {
            name: "status",
            type: "enum",
            enum: ["pending", "in_review", "approved", "rejected", "expired"],
          },
          {
            name: "documents",
            type: "jsonb",
            isNullable: true,
          },
          {
            name: "rejection_reason",
            type: "text",
            isNullable: true,
          },
          {
            name: "provider_reference",
            type: "varchar",
            length: "255",
            isNullable: true,
          },
          {
            name: "is_archived",
            type: "boolean",
            default: false,
          },
          {
            name: "archived_at",
            type: "timestamptz",
            isNullable: true,
          },
          {
            name: "created_at",
            type: "timestamptz",
            default: "now()",
          },
        ],
      }),
      true
    );

    // Create indexes
    await queryRunner.createIndex(
      "kyc_history",
      new TableIndex({
        name: "idx_kyc_history_user_id",
        columnNames: ["user_id"],
      })
    );

    await queryRunner.createIndex(
      "kyc_history",
      new TableIndex({
        name: "idx_kyc_history_wallet",
        columnNames: ["wallet"],
      })
    );

    await queryRunner.createIndex(
      "kyc_history",
      new TableIndex({
        name: "idx_kyc_history_status",
        columnNames: ["status"],
      })
    );

    await queryRunner.createIndex(
      "kyc_history",
      new TableIndex({
        name: "idx_kyc_history_created_at",
        columnNames: ["created_at"],
      })
    );

    // Add foreign key constraint to users
    await queryRunner.createForeignKey(
      "kyc_history",
      new TableForeignKey({
        columnNames: ["user_id"],
        referencedColumnNames: ["id"],
        referencedTableName: "users",
        onDelete: "CASCADE",
      })
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("kyc_history");
  }
}
