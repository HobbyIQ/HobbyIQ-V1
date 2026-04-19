"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatCurrency = formatCurrency;
exports.formatPercent = formatPercent;
// Utility functions for formatting currency and percent for the frontend
function formatCurrency(value) {
    if (value === undefined || value === null || value === "")
        return "-";
    const num = Number(value);
    if (isNaN(num))
        return value;
    return num.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
function formatPercent(value) {
    if (value === undefined || value === null || value === "")
        return "-";
    const num = Number(value);
    if (isNaN(num))
        return value;
    return `${num.toFixed(0)}%`;
}
