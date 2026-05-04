import SwiftUI

struct PortfolioSortMenu: View {
    @Binding var selected: PortfolioSort
    @Binding var isPresented: Bool
    var body: some View {
        VStack(spacing: 0) {
            Text("Sort By")
                .font(.headline)
                .padding(.top, 16)
            Divider()
            ForEach(PortfolioSort.allCases) { sort in
                Button(action: {
                    selected = sort
                    isPresented = false
                }) {
                    HStack {
                        Text(sort.rawValue)
                            .foregroundColor(.white)
                        Spacer()
                        if selected == sort {
                            Image(systemName: "checkmark")
                                .foregroundColor(.blue)
                        }
                    }
                    .padding(.vertical, 12)
                    .padding(.horizontal)
                }
                Divider()
            }
            Button("Cancel") {
                isPresented = false
            }
            .foregroundColor(.red)
            .padding()
        }
        .background(Color(.secondarySystemBackground))
        .cornerRadius(18)
        .padding()
        .shadow(radius: 20)
    }
}

struct PortfolioSortMenu_Previews: PreviewProvider {
    static var previews: some View {
        StatefulPreviewWrapper(PortfolioSort.highestValue) { binding in
            PortfolioSortMenu(selected: binding, isPresented: .constant(true))
                .preferredColorScheme(.dark)
                .background(Color.black.opacity(0.8))
        }
    }
}
