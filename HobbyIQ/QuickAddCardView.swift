//
//  QuickAddCardView.swift
//  HobbyIQ
//

import SwiftUI

struct QuickAddCardView: View {
    @StateObject private var viewModel: AddPortfolioCardViewModel
    private let onSave: (() -> Void)?

    init(
        viewModel: AddPortfolioCardViewModel = AddPortfolioCardViewModel(),
        onSave: (() -> Void)? = nil
    ) {
        self._viewModel = StateObject(wrappedValue: viewModel)
        self.onSave = onSave
    }

    var body: some View {
        AddPortfolioCardView(viewModel: viewModel, onSave: onSave)
    }
}

#Preview {
    QuickAddCardView()
}
