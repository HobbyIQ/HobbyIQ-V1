//
//  MarketIndexModels.swift
//  HobbyIQ
//
//  CF-MARKET-INDEXES iOS parity (#1644, Drew 2026-09-02).
//
//  GET /api/compiq/market-indexes?days=180
//
//  One call returns every sport, so the tile strip renders without a
//  fan-out. Sports with no points yet come back with an EMPTY series
//  rather than being omitted, so the tile order is stable across loads —
//  the client must not filter them out and re-order.
//
//  The index is a fixed liquid basket: per sport, the ~100 most-traded
//  cards held for the quarter, and the level is a weighted average of each
//  member's value RELATIVE TO ITS OWN base value. Every term is a ratio of
//  a card to itself, so a card entering or leaving the day's sales cannot
//  move the level. That is the whole reason it beats the median it
//  replaced, and it is also why THE CLIENT COMPUTES NOTHING: `changePct`
//  and `latestLevel` are served, not derived here. Deriving a % from the
//  series would be a second implementation of the number and a second
//  chance for it to disagree with the web's.
//

import Foundation

struct MarketIndexPoint: Decodable, Hashable, Identifiable {
    /// ISO day, e.g. "2026-09-02".
    let date: String
    let level: Double
    /// Members with a fresh (non-carried) value on this date.
    let freshMembers: Int?
    /// Share of basket weight actually valued (0..1).
    let usedWeight: Double?
    /// The level is carried from a prior day, not computed for this one.
    let stale: Bool?

    var id: String { date }

    /// Tolerant of a server that predates the freshness fields.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        date = try c.decode(String.self, forKey: .date)
        level = try c.decode(Double.self, forKey: .level)
        freshMembers = (try? c.decodeIfPresent(Int.self, forKey: .freshMembers)) ?? nil
        usedWeight = (try? c.decodeIfPresent(Double.self, forKey: .usedWeight)) ?? nil
        stale = (try? c.decodeIfPresent(Bool.self, forKey: .stale)) ?? nil
    }

    private enum CodingKeys: String, CodingKey {
        case date, level, freshMembers, usedWeight, stale
    }
}

struct SportIndexSeries: Decodable, Hashable, Identifiable {
    let sport: String
    /// Chronological, oldest first. Empty when the sport has no points yet.
    let series: [MarketIndexPoint]
    /// Backend-served. Nil when the series is empty.
    let latestLevel: Double?
    /// Backend-served % change across the returned window. NEVER derived
    /// on the client — see the file header.
    let changePct: Double?
    let windowDays: Int?
    let basketSize: Int?
    /// ISO day of the newest point.
    let asOf: String?
    /// Members with a fresh value on the newest point (H-12). A level
    /// off 1 member used to render identically to one off 94 - the strip
    /// now says "n of N fresh" whenever this is below the basket.
    let freshMembers: Int?
    /// Share of basket weight valued on the newest point (0..1).
    let usedWeight: Double?
    /// The newest point was withheld and the prior level carried.
    let stale: Bool?
    let withheldReason: String?

    var id: String { sport }

    /// Tolerant of an older server that omits any of the optional halves:
    /// only `sport` is required, and a payload with just a sport renders
    /// as an empty tile rather than failing the whole strip's decode.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sport = try c.decode(String.self, forKey: .sport)
        series = ((try? c.decodeIfPresent([MarketIndexPoint].self, forKey: .series)) ?? nil) ?? []
        latestLevel = (try? c.decodeIfPresent(Double.self, forKey: .latestLevel)) ?? nil
        changePct = (try? c.decodeIfPresent(Double.self, forKey: .changePct)) ?? nil
        windowDays = (try? c.decodeIfPresent(Int.self, forKey: .windowDays)) ?? nil
        basketSize = (try? c.decodeIfPresent(Int.self, forKey: .basketSize)) ?? nil
        asOf = (try? c.decodeIfPresent(String.self, forKey: .asOf)) ?? nil
        freshMembers = (try? c.decodeIfPresent(Int.self, forKey: .freshMembers)) ?? nil
        usedWeight = (try? c.decodeIfPresent(Double.self, forKey: .usedWeight)) ?? nil
        stale = (try? c.decodeIfPresent(Bool.self, forKey: .stale)) ?? nil
        withheldReason = (try? c.decodeIfPresent(String.self, forKey: .withheldReason)) ?? nil
    }

    private enum CodingKeys: String, CodingKey {
        case sport, series, latestLevel, changePct, windowDays, basketSize, asOf
        case freshMembers, usedWeight, stale, withheldReason
    }

    /// Copy for the freshness caption, or nil when the tile is on a full
    /// basket and needs no qualifier. Server-served counts only - the
    /// client derives no number here, per the file header.
    var freshnessNote: String? {
        if stale == true { return "Carried \u{00B7} basket too thin to price" }
        guard let fresh = freshMembers, let basket = basketSize, fresh < basket else { return nil }
        return "\(fresh) of \(basket) fresh"
    }

    /// The sparkline's y-values, oldest first.
    var levels: [Double] { series.map(\.level) }

    /// A tile with fewer than two points cannot draw a line and has no
    /// honest change to report — it renders as "building".
    var hasRenderableSeries: Bool { series.count >= 2 }

    /// Display name for the tile. The wire carries lowercase sport keys
    /// ("baseball", "basketball", ...); anything unrecognised is title-cased
    /// rather than dropped, so a NEW SPORT added backend-side shows up with
    /// a reasonable label instead of vanishing from the strip.
    var displayName: String {
        switch sport.lowercased() {
        case "baseball": return "Baseball"
        case "basketball": return "Basketball"
        case "football": return "Football"
        case "hockey": return "Hockey"
        case "soccer": return "Soccer"
        case "pokemon": return "Pokémon"
        default:
            guard let first = sport.first else { return sport }
            return String(first).uppercased() + sport.dropFirst()
        }
    }
}

struct MarketIndexesResponse: Decodable, Hashable {
    let success: Bool?
    let computedAt: String?
    let windowDays: Int?
    let indexes: [SportIndexSeries]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        success = (try? c.decodeIfPresent(Bool.self, forKey: .success)) ?? nil
        computedAt = (try? c.decodeIfPresent(String.self, forKey: .computedAt)) ?? nil
        windowDays = (try? c.decodeIfPresent(Int.self, forKey: .windowDays)) ?? nil
        indexes = ((try? c.decodeIfPresent([SportIndexSeries].self, forKey: .indexes)) ?? nil) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case success, computedAt, windowDays, indexes
    }
}
