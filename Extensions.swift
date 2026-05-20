// Extensions.swift
// Shared Swift extensions used by the PortfolioIQ SwiftData layer.

import Foundation

extension Double {
    /// Formats a Double as a locale-aware currency string (e.g. "$1,234.56").
    var currencyString: String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.locale = .current
        formatter.maximumFractionDigits = 2
        formatter.minimumFractionDigits = 2
        return formatter.string(from: NSNumber(value: self)) ?? "$\(String(format: "%.2f", self))"
    }
}
