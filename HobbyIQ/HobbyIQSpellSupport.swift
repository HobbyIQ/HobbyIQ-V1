//
//  HobbyIQSpellSupport.swift
//  HobbyIQ
//

import Foundation

enum HobbyIQSpellSupport {
    static let knownTerms: [String] = [
        "Bowman", "Chrome", "Sapphire", "Refractor", "Auto", "Gold", "Orange", "Blue",
        "DailyIQ", "MiLB", "MLB", "CompIQ", "PlayerIQ", "PortfolioIQ",
        "Paul Skenes", "Roman Anthony", "Leo De Vries", "Walker Jenkins",
        "Gunnar Henderson", "Bobby Witt Jr.", "Jackson Holliday", "Jackson Merrill",
        "Junior Caminero", "Chase Burns", "Elly De La Cruz", "Josiah Hartshorn"
    ]

    static let directReplacements: [String: String] = [
        "mibl": "MiLB",
        "playeriq": "PlayerIQ",
        "playeriq": "PlayerIQ",
        "compiq": "CompIQ",
        "bowmn": "Bowman",
        "chorme": "Chrome",
        "saphire": "Sapphire",
        "refrctor": "Refractor",
        "hartshron": "Hartshorn"
    ]

    static func suggestedCorrection(for query: String, from knownTerms: [String] = HobbyIQSpellSupport.knownTerms) -> String? {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.isEmpty == false else { return nil }

        let lowered = trimmed.lowercased()
        if let direct = directReplacements[lowered] {
            return direct
        }

        if knownTerms.contains(where: { $0.caseInsensitiveCompare(trimmed) == .orderedSame }) {
            return nil
        }

        let tokens = trimmed.split(whereSeparator: \.isWhitespace).map(String.init)
        var bestTerm: String?
        var bestDistance = Int.max

        for term in knownTerms {
            let distance = levenshteinDistance(lowered, term.lowercased())
            if distance < bestDistance {
                bestDistance = distance
                bestTerm = term
            }

            if tokens.count > 1 {
                for token in tokens {
                    let tokenDistance = levenshteinDistance(token.lowercased(), term.lowercased())
                    if tokenDistance < bestDistance {
                        bestDistance = tokenDistance
                        bestTerm = term
                    }
                }
            }
        }

        guard let bestTerm else { return nil }
        let threshold = trimmed.count <= 5 ? 2 : 3
        return bestDistance <= threshold ? bestTerm : nil
    }

    private static func levenshteinDistance(_ lhs: String, _ rhs: String) -> Int {
        let lhsChars = Array(lhs)
        let rhsChars = Array(rhs)

        guard lhsChars.isEmpty == false else { return rhsChars.count }
        guard rhsChars.isEmpty == false else { return lhsChars.count }

        var distances = Array(0...rhsChars.count)

        for (lhsIndex, lhsChar) in lhsChars.enumerated() {
            var previous = distances[0]
            distances[0] = lhsIndex + 1

            for (rhsIndex, rhsChar) in rhsChars.enumerated() {
                let temp = distances[rhsIndex + 1]
                if lhsChar == rhsChar {
                    distances[rhsIndex + 1] = previous
                } else {
                    distances[rhsIndex + 1] = min(
                        distances[rhsIndex] + 1,
                        distances[rhsIndex + 1] + 1,
                        previous + 1
                    )
                }
                previous = temp
            }
        }

        return distances[rhsChars.count]
    }
}
