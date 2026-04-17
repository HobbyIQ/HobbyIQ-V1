import request from 'supertest';
import app from '../../src/server';

describe('POST /api/brain/card-outlook', () => {
  it('should return outcome scenarios for a valid payload', async () => {
    const res = await request(app)
      .post('/api/brain/card-outlook')
      .send({
        player: 'Josiah Hartshorn',
        cardSet: 'Bowman Chrome',
        year: 2025,
        product: 'Bowman',
        parallel: 'Gold Shimmer',
        grade: 'raw',
        currentEstimatedValue: 387,
        events: ['promotion', 'performance_hot']
      });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.summary).toBeDefined();
    expect(res.body.scenarios).toBeInstanceOf(Array);
    expect(res.body.scenarios.length).toBeGreaterThan(0);
  });

  it('should fallback to baseline scenario if events missing', async () => {
    const res = await request(app)
      .post('/api/brain/card-outlook')
      .send({
        player: 'Josiah Hartshorn',
        cardSet: 'Bowman Chrome',
        year: 2025,
        product: 'Bowman',
        parallel: 'Gold Shimmer',
        grade: 'raw',
        currentEstimatedValue: 387
      });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.scenarios).toBeInstanceOf(Array);
    expect(res.body.scenarios.length).toBeGreaterThan(0);
  });
});
