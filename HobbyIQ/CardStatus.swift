// CardStatus.swift
// HobbyIQ — card lifecycle states.

import Foundation

enum CardStatus: String, CaseIterable, Codable {
    case owned
    case listed
    case grading
    case consigned
    case sold
    case archived
}
