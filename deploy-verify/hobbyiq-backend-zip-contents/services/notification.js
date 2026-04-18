"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getNotifications = getNotifications;
// Mock notification service for HobbyIQ
function getNotifications(userId) {
    // Return mock notifications
    return [
        { id: "1", message: "Welcome to HobbyIQ!", read: false },
        { id: "2", message: "Your first alert!", read: true }
    ];
}
