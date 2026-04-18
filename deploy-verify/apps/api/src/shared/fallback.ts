// Fallback + Mock Handling for HobbyIQ

export function fallbackResponse(message: string, data: any = {}) {
  return {
    fallback: true,
    message,
    ...data
  };
}
