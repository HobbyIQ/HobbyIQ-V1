// Mock subscription service for HobbyIQ
export function getSubscription(userId: string) {
  // Return mock subscription data
  return {
    userId,
    plan: "Dealer Pro",
    valid: true
  };
}

export async function validateAppleReceipt(receipt: string) {
  // Always return true in mock mode
  return true;
}
