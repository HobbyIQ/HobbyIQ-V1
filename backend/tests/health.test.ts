import request from "supertest";
import app from "../src/app";
describe("/api/health", () => {
  it("returns 200 and status ok", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.service).toBe("HobbyIQ API");
  });
});
