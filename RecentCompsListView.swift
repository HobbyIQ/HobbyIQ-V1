// RecentCompsListView.swift
// Reusable list of recent sold comps. Shown when the CompIQ estimate
// endpoint returns "insufficient data" or a variant mismatch — instead of
// hiding the data, we show the user EVERY comp the system actually found
// so they can eyeball the market themselves.

import SwiftUI

struct RecentCompsListView: View {
    let comps: [CompEstimateRecentComp]
    var title: String = "Recent Sales on File"
    var subtitle: String? = "Not enough recent data to compute a price — here's every comp Card Hedge has."

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text("\(comps.count) \(comps.count == 1 ? "sale" : "sales")")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            if let subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            if comps.isEmpty {
                Text("No sales on file for this exact card.")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .padding(.vertical, 8)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(comps.enumerated()), id: \.element.id) { idx, comp in
                        compRow(comp)
                        if idx < comps.count - 1 {
                            Divider().padding(.leading, 12)
                        }
                    }
                }
                .background(Color(.secondarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    @ViewBuilder
    private func compRow(_ comp: CompEstimateRecentComp) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(comp.title ?? "Untitled comp")
                    .font(.caption.weight(.medium))
                    .foregroundColor(.primary)
                    .lineLimit(2)
                if let date = formatDate(comp.soldDate) {
                    Text(date)
                        .font(.caption2)
                        .foregroundColor(.secondary)
                }
            }
            Spacer(minLength: 8)
            Text(formatPrice(comp.price))
                .font(.caption.weight(.semibold).monospacedDigit())
                .foregroundColor(.primary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private func formatPrice(_ price: Double?) -> String {
        guard let p = price, p > 0 else { return "—" }
        let fmt = NumberFormatter()
        fmt.numberStyle = .currency
        fmt.maximumFractionDigits = p >= 100 ? 0 : 2
        return fmt.string(from: NSNumber(value: p)) ?? "$\(Int(p))"
    }

    private func formatDate(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var parsed = iso.date(from: raw)
        if parsed == nil {
            iso.formatOptions = [.withInternetDateTime]
            parsed = iso.date(from: raw)
        }
        if parsed == nil {
            let df = DateFormatter()
            df.locale = Locale(identifier: "en_US_POSIX")
            df.dateFormat = "yyyy-MM-dd"
            parsed = df.date(from: String(raw.prefix(10)))
        }
        guard let date = parsed else { return raw }
        let out = DateFormatter()
        out.dateStyle = .medium
        out.timeStyle = .none
        return out.string(from: date)
    }
}
