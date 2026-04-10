// Mock notification service for HobbyIQ
export function getNotifications(userId: string) {
  // Return mock notifications
  return [
    { id: "1", message: "Welcome to HobbyIQ!", read: false },
    { id: "2", message: "Your first alert!", read: true }
  ];
}
