// MARK: - DailyIQ Brief Response (MLB + MiLB)
struct DailyIQBriefResponse: Codable {
   let mlb: [DailyIQPlayer]
   let milb: [DailyIQPlayer]
}
import Foundation

// MARK: - DailyIQ Player Models

struct DailyIQPlayer: Codable, Identifiable {
   let id: String
   let playerId: String
   let rank: Int
   let rankingScore: Double
   let league: String
   let level: String?
   let playerName: String
   let team: String
   let teamName: String
   let teamAbbreviation: String
   let position: String
   let dailyStats: [String: CodableValue]
   let seasonStats: [String: CodableValue]
   let lastUpdated: String
   let isOnWatchlist: Bool
   let playerIQScore: Double?
   let playerIQDirection: String?
   let playerIQLabel: String?

   enum CodingKeys: String, CodingKey {
      case playerId, rank, rankingScore, league, level, playerName, team, teamName, teamAbbreviation, position, dailyStats, seasonStats, lastUpdated, isOnWatchlist, playerIQScore, playerIQDirection, playerIQLabel
   }

   var id: String { playerId }
}

struct DailyIQTopPlayersResponse: Codable {
   let league: String
   let level: String?
   let date: String
   let lastUpdated: String
   let limit: Int
   let count: Int
   let players: [DailyIQPlayer]
}

// CodableValue for dynamic stats fields
enum CodableValue: Codable {
   case string(String)
   case int(Int)
   case double(Double)
   case bool(Bool)
   case null

   init(from decoder: Decoder) throws {
      let container = try decoder.singleValueContainer()
      if container.decodeNil() {
         self = .null
      } else if let v = try? container.decode(Bool.self) {
         self = .bool(v)
      } else if let v = try? container.decode(Int.self) {
         self = .int(v)
      } else if let v = try? container.decode(Double.self) {
         self = .double(v)
      } else if let v = try? container.decode(String.self) {
         self = .string(v)
      } else {
         self = .null
      }
   }

   func encode(to encoder: Encoder) throws {
      var container = encoder.singleValueContainer()
      switch self {
      case .string(let v): try container.encode(v)
      case .int(let v): try container.encode(v)
      case .double(let v): try container.encode(v)
      case .bool(let v): try container.encode(v)
      case .null: try container.encodeNil()
      }
   }
}

// MARK: - DailyIQService

enum DailyIQServiceError: LocalizedError {
   case httpError(Int)
   case decodingError
   case unknown

   var errorDescription: String? {
      switch self {
      case .httpError(let code): return "Server returned HTTP \(code)."
      case .decodingError: return "Unexpected response format from server."
      case .unknown: return "Unknown error."
      }
   }
}

@MainActor
enum DailyIQService {
   static let baseURL = "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net"

   /// Fetches both MLB and MiLB top performers in a single call
   static func fetchBrief(date: String? = nil, sessionId: String? = nil) async throws -> (mlb: [DailyIQPlayer], milb: [DailyIQPlayer]) {
      var urlComponents = URLComponents(string: baseURL + "/api/dailyiq/")!
      if let date { urlComponents.queryItems = [URLQueryItem(name: "date", value: date)] }
      guard let url = urlComponents.url else { throw DailyIQServiceError.unknown }

      var request = URLRequest(url: url)
      request.httpMethod = "GET"
      if let sessionId, !sessionId.isEmpty {
         request.setValue(sessionId, forHTTPHeaderField: "x-session-id")
      }

      let (data, response) = try await URLSession.shared.data(for: request)
      guard let httpResponse = response as? HTTPURLResponse, (200...299).contains(httpResponse.statusCode) else {
         throw DailyIQServiceError.httpError((response as? HTTPURLResponse)?.statusCode ?? -1)
      }
      do {
         let decoded = try JSONDecoder().decode(DailyIQBriefResponse.self, from: data)
         return (decoded.mlb, decoded.milb)
      } catch {
         throw DailyIQServiceError.decodingError
      }
   }

      /// Fetches top MLB player performers for DailyIQ (kept for direct MLB-only fetch)
      static func fetchTopMLBPlayers(date: String? = nil, limit: Int = 25, sessionId: String? = nil) async throws -> [DailyIQPlayer] {
         var urlComponents = URLComponents(string: baseURL + "/api/dailyiq/players/top/mlb")!
         var queryItems: [URLQueryItem] = [URLQueryItem(name: "limit", value: String(limit))]
         if let date { queryItems.append(URLQueryItem(name: "date", value: date)) }
         urlComponents.queryItems = queryItems
         guard let url = urlComponents.url else { throw DailyIQServiceError.unknown }

         var request = URLRequest(url: url)
         request.httpMethod = "GET"
         if let sessionId, !sessionId.isEmpty {
            request.setValue(sessionId, forHTTPHeaderField: "x-session-id")
         }

         let (data, response) = try await URLSession.shared.data(for: request)
         guard let httpResponse = response as? HTTPURLResponse, (200...299).contains(httpResponse.statusCode) else {
            throw DailyIQServiceError.httpError((response as? HTTPURLResponse)?.statusCode ?? -1)
         }
         do {
            let decoded = try JSONDecoder().decode(DailyIQTopPlayersResponse.self, from: data)
            return decoded.players
         } catch {
            throw DailyIQServiceError.decodingError
         }
      }

      /// Fetches top MiLB player performers for DailyIQ
      static func fetchTopMiLBPlayers(date: String? = nil, limit: Int = 25, sessionId: String? = nil) async throws -> [DailyIQPlayer] {
         var urlComponents = URLComponents(string: baseURL + "/api/dailyiq/players/top/milb")!
         var queryItems: [URLQueryItem] = [URLQueryItem(name: "limit", value: String(limit))]
         if let date { queryItems.append(URLQueryItem(name: "date", value: date)) }
         urlComponents.queryItems = queryItems
         guard let url = urlComponents.url else { throw DailyIQServiceError.unknown }

         var request = URLRequest(url: url)
         request.httpMethod = "GET"
         if let sessionId, !sessionId.isEmpty {
            request.setValue(sessionId, forHTTPHeaderField: "x-session-id")
         }

         let (data, response) = try await URLSession.shared.data(for: request)
         guard let httpResponse = response as? HTTPURLResponse, (200...299).contains(httpResponse.statusCode) else {
            throw DailyIQServiceError.httpError((response as? HTTPURLResponse)?.statusCode ?? -1)
         }
         do {
            let decoded = try JSONDecoder().decode(DailyIQTopPlayersResponse.self, from: data)
            return decoded.players
         } catch {
            throw DailyIQServiceError.decodingError
         }
      }
}
/*
DAILYIQ BACKEND ENDPOINTS — as of May 2026

1. API endpoint for today's top MLB players:
   - GET /api/dailyiq/players/top/mlb
     - Query params: ?date=YYYY-MM-DD (optional, defaults to yesterday), ?limit=25 (default 25)
     - No auth required (x-session-id optional, only needed for watchlist cross-ref)
     - Response:
       {
         league: "MLB",
         level: null,
         date: "2026-05-09",
         lastUpdated: "2026-05-10T05:00:00.000Z",
         limit: 25,
         count: 25,
         players: [
           {
             playerId: string,
             rank: number,
             rankingScore: number, // main performance score (Double)
             league: "MLB",
             level: null,
             playerName: string,
             team: string,
             teamName: string,
             teamAbbreviation: string,
             position: string,
             dailyStats: { ... },
             seasonStats: { ... },
             lastUpdated: string,
             isOnWatchlist: boolean
           },
           ...
         ]
       }

2. Player ranking score field:
   - "rankingScore" (Double) — higher = better performance

3. Card market signal:
   - NOT included in this response. Must call CompIQ signal endpoint separately for each player.

4. Auth:
   - x-session-id is optional. If present, "isOnWatchlist" is set per player.

5. Card opportunity detection:
   - Not included in backend; must be computed client-side.

6. Cosmos queries:
   - Not directly exposed; all data is returned via the above endpoint.

7. For full brief (MLB + MiLB), GET /api/dailyiq/ returns:
   {
     date: "2026-05-09",
     generatedAt: "...",
     lastUpdated: "...",
     mlb: [BasePlayerResponse...],
     milb: [BasePlayerResponse...],
     _meta: { ... }
   }
   But for iOS, use /players/top/mlb for just MLB top performers.

8. Card market signal endpoint (CompIQ):
   - GET {AZURE_SIGNAL_FUNCTION_URL}?player={playerName}
   - Returns: { final_multiplier: number, predicted_direction: "rising"|"falling"|"stable", ... }

*/
