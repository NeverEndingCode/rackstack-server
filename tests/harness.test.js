import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { provisionDatabase } from './helpers/backend.js';

const provisioned = await provisionDatabase();
afterAll(() => provisioned.cleanup());

describe('test harness', () => {
  it('provisions an isolated database for the configured backend', async () => {
    if (provisioned.backend === 'sqlite') {
      expect(provisioned.path).toBe(':memory:');
      return;
    }
    const client = new pg.Client({ connectionString: provisioned.url });
    await client.connect();
    const { rows } = await client.query('SELECT 1 AS ok');
    expect(rows[0].ok).toBe(1);
    await client.end();
  });
});
