import { MigrationInterface, QueryRunner } from "typeorm";

export class AddNotificationDataColumn1753000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notifications" 
      ADD COLUMN IF NOT EXISTS "data" jsonb
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notifications" 
      DROP COLUMN IF EXISTS "data"
    `);
  }
}
