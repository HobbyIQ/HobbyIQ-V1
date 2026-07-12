// CF-EBAY-BUYER-HISTORY (2026-07-12) — parse + import cover.
// Focus: XML parsing edge cases, subtotal/tax/shipping math, idempotency
// through recordPurchase. Route-level validation covered separately.

import { describe, it, expect, vi, afterEach } from "vitest";

const parseFakeXml = async (xml: string) => {
  // Fresh mock per test using a shared token override
  vi.doMock("../src/services/ebay/ebayAuth.service.js", async (orig) => {
    const actual = await orig<any>();
    return { ...actual, getAccessToken: async () => "mock-token" };
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    text: async () => xml,
    status: 200,
    statusText: "OK",
  }));
  const { fetchEbayBuyerHistory, MAX_DURATION_DAYS } = await import("../src/services/ebay/ebayBuyerHistory.service.js");
  const result = await fetchEbayBuyerHistory("test-user", 30);
  vi.doUnmock("../src/services/ebay/ebayAuth.service.js");
  vi.unstubAllGlobals();
  return { result, MAX_DURATION_DAYS };
};

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("fetchEbayBuyerHistory — XML parse", () => {
  it("parses a canonical WonList response with one transaction", async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBayBuyingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <WonList>
    <PaginationResult>
      <TotalNumberOfEntries>1</TotalNumberOfEntries>
    </PaginationResult>
    <OrderTransactionArray>
      <OrderTransaction>
        <Transaction>
          <Item>
            <ItemID>111222333</ItemID>
            <Title>2024 Topps Chrome Rookie Auto</Title>
            <ListingDetails>
              <EndTime>2026-07-01T00:00:00.000Z</EndTime>
            </ListingDetails>
            <Seller>
              <UserID>topcardsseller</UserID>
            </Seller>
            <SellingStatus>
              <CurrentPrice currencyID="USD">100.00</CurrentPrice>
            </SellingStatus>
            <ShippingDetails>
              <ShippingServiceOptions>
                <ShippingServiceCost currencyID="USD">5.00</ShippingServiceCost>
              </ShippingServiceOptions>
            </ShippingDetails>
          </Item>
          <TransactionID>987654</TransactionID>
          <PaidTime>2026-07-01T12:00:00.000Z</PaidTime>
          <TotalPrice currencyID="USD">113.75</TotalPrice>
          <TotalTransactionPrice currencyID="USD">100.00</TotalTransactionPrice>
          <QuantityPurchased>1</QuantityPurchased>
          <OrderLineItemID>111222333-987654</OrderLineItemID>
        </Transaction>
      </OrderTransaction>
    </OrderTransactionArray>
  </WonList>
</GetMyeBayBuyingResponse>`;
    const { result } = await parseFakeXml(xml);
    expect(result.ebayTotalReported).toBe(1);
    expect(result.purchases).toHaveLength(1);
    const p = result.purchases[0];
    expect(p.ebayOrderLineItemId).toBe("111222333-987654");
    expect(p.ebayItemId).toBe("111222333");
    expect(p.title).toBe("2024 Topps Chrome Rookie Auto");
    expect(p.sellerUserId).toBe("topcardsseller");
    expect(p.subtotal).toBe(100);
    expect(p.shipping).toBe(5);
    // tax = TotalPrice - subtotal - shipping = 113.75 - 100 - 5 = 8.75
    expect(p.tax).toBe(8.75);
    expect(p.totalCost).toBe(113.75);
    expect(p.purchaseDate).toBe("2026-07-01T12:00:00.000Z");
  });

  it("handles multiple transactions inside one OrderTransaction", async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBayBuyingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <WonList>
    <OrderTransactionArray>
      <OrderTransaction>
        <Transaction>
          <Item><ItemID>A</ItemID><Title>Item A</Title></Item>
          <OrderLineItemID>A-1</OrderLineItemID>
          <TotalPrice currencyID="USD">50</TotalPrice>
          <TotalTransactionPrice currencyID="USD">50</TotalTransactionPrice>
          <QuantityPurchased>1</QuantityPurchased>
        </Transaction>
        <Transaction>
          <Item><ItemID>B</ItemID><Title>Item B</Title></Item>
          <OrderLineItemID>B-1</OrderLineItemID>
          <TotalPrice currencyID="USD">30</TotalPrice>
          <TotalTransactionPrice currencyID="USD">30</TotalTransactionPrice>
          <QuantityPurchased>1</QuantityPurchased>
        </Transaction>
      </OrderTransaction>
    </OrderTransactionArray>
  </WonList>
</GetMyeBayBuyingResponse>`;
    const { result } = await parseFakeXml(xml);
    expect(result.purchases).toHaveLength(2);
    expect(result.purchases.map((p) => p.ebayItemId)).toEqual(["A", "B"]);
  });

  it("empty WonList → zero purchases, no crash", async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBayBuyingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <WonList>
    <PaginationResult><TotalNumberOfEntries>0</TotalNumberOfEntries></PaginationResult>
  </WonList>
</GetMyeBayBuyingResponse>`;
    const { result } = await parseFakeXml(xml);
    expect(result.purchases).toEqual([]);
    expect(result.ebayTotalReported).toBe(0);
  });

  it("throws on Ack=Failure with an error code", async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBayBuyingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Failure</Ack>
  <Errors>
    <ErrorCode>21916884</ErrorCode>
    <LongMessage>Auth token is invalid.</LongMessage>
  </Errors>
</GetMyeBayBuyingResponse>`;
    await expect(parseFakeXml(xml)).rejects.toThrow(/21916884.*invalid/);
  });

  it("skips a transaction with no OrderLineItemID (idempotency key)", async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBayBuyingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <WonList>
    <OrderTransactionArray>
      <OrderTransaction>
        <Transaction>
          <Item><ItemID>X</ItemID><Title>Broken</Title></Item>
          <TotalPrice currencyID="USD">10</TotalPrice>
          <TotalTransactionPrice currencyID="USD">10</TotalTransactionPrice>
        </Transaction>
        <Transaction>
          <Item><ItemID>Y</ItemID><Title>Good</Title></Item>
          <OrderLineItemID>Y-1</OrderLineItemID>
          <TotalPrice currencyID="USD">20</TotalPrice>
          <TotalTransactionPrice currencyID="USD">20</TotalTransactionPrice>
        </Transaction>
      </OrderTransaction>
    </OrderTransactionArray>
  </WonList>
</GetMyeBayBuyingResponse>`;
    const { result } = await parseFakeXml(xml);
    // Only the valid one comes through
    expect(result.purchases).toHaveLength(1);
    expect(result.purchases[0].ebayItemId).toBe("Y");
  });

  it("computes tax as 0 when TotalPrice = subtotal + shipping (no tax)", async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBayBuyingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <WonList>
    <OrderTransactionArray>
      <OrderTransaction>
        <Transaction>
          <Item>
            <ItemID>Z</ItemID>
            <Title>NoTax</Title>
            <ShippingDetails>
              <ShippingServiceOptions>
                <ShippingServiceCost currencyID="USD">10</ShippingServiceCost>
              </ShippingServiceOptions>
            </ShippingDetails>
          </Item>
          <OrderLineItemID>Z-1</OrderLineItemID>
          <TotalPrice currencyID="USD">60</TotalPrice>
          <TotalTransactionPrice currencyID="USD">50</TotalTransactionPrice>
          <QuantityPurchased>1</QuantityPurchased>
        </Transaction>
      </OrderTransaction>
    </OrderTransactionArray>
  </WonList>
</GetMyeBayBuyingResponse>`;
    const { result } = await parseFakeXml(xml);
    expect(result.purchases[0].subtotal).toBe(50);
    expect(result.purchases[0].shipping).toBe(10);
    expect(result.purchases[0].tax).toBe(0);
    expect(result.purchases[0].totalCost).toBe(60);
  });
});
