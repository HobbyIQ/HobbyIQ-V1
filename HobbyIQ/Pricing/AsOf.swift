//
//  AsOf.swift
//  HobbyIQ
//
//  CF-PORTFOLIO-FRESH-ON-OPEN (#1639, Drew 2026-09-02): "as of <time>",
//  honestly. The iOS counterpart of apps/web/src/lib/asOf.ts.
//
//  The portfolio renders persisted values instantly and dispatches a
//  refresh behind itself, so this line is the only thing telling the user
//  how current the numbers on screen are.
//
//  Shows a clock time for anything today and a date beyond that, because
//  "as of 10:42" is only useful once you know it means today — the same
//  string on a week-old value reads as current, which is exactly the
//  misreading this whole change exists to fix.
//
//  Returns nil when there is no usable timestamp rather than inventing
//  "just now": a portfolio whose holdings carry no lastUpdated should say
//  nothing, not claim freshness it cannot support.
//

import Foundation

enum AsOf {
    /// Accepts both ISO-8601 with and without fractional seconds — the
    /// backend stamps `new Date().toISOString()` (fractional) in some
    /// writers and a plain second-precision stamp in others, and a parser
    /// that handles only one silently turns a real timestamp into "no
    /// timestamp", i.e. into a screen that says nothing about freshness.
    static func parse(_ iso: String?) -> Date? {
        guard let iso = iso?.trimmingCharacters(in: .whitespacesAndNewlines), iso.isEmpty == false else {
            return nil
        }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withFraction.date(from: iso) { return d }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: iso)
    }

    /// "10:42" for today; "Sep 1 10:42" for anything older.
    ///
    /// `now` and `calendar` are injectable so the same-day boundary is
    /// testable without waiting for midnight.
    static func format(
        _ iso: String?,
        now: Date = Date(),
        calendar: Calendar = .current,
        locale: Locale = .current,
        timeZone: TimeZone = .current
    ) -> String? {
        guard let date = parse(iso) else { return nil }

        var cal = calendar
        cal.timeZone = timeZone

        let timeFmt = DateFormatter()
        timeFmt.locale = locale
        timeFmt.timeZone = timeZone
        timeFmt.setLocalizedDateFormatFromTemplate("j:mm")
        let time = timeFmt.string(from: date)

        if cal.isDate(date, inSameDayAs: now) { return time }

        let dayFmt = DateFormatter()
        dayFmt.locale = locale
        dayFmt.timeZone = timeZone
        dayFmt.setLocalizedDateFormatFromTemplate("MMMd")
        return "\(dayFmt.string(from: date)) \(time)"
    }

    /// The full line the header renders, or nil when there is nothing
    /// honest to say. Kept separate from `format` so the copy lives in one
    /// place across the header and any future surface.
    static func line(_ iso: String?, now: Date = Date()) -> String? {
        guard let stamp = format(iso, now: now) else { return nil }
        return "Prices as of \(stamp)"
    }
}
