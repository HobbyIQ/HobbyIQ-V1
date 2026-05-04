import SwiftUI

struct PortfolioFilterChips: View {
    @Binding var selected: PortfolioFilter
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(PortfolioFilter.allCases) { filter in
                    Button(action: { selected = filter }) {
                        Text(filter.rawValue)
                            .font(.subheadline)
                            .foregroundColor(selected == filter ? .white : .blue)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(selected == filter ? Color.blue : Color(.systemGray6).opacity(0.18))
                            .cornerRadius(16)
                    }
                }
            }
            .padding(.horizontal, 2)
        }
        .frame(height: 44)
    }
}

struct PortfolioFilterChips_Previews: PreviewProvider {
    static var previews: some View {
        StatefulPreviewWrapper(PortfolioFilter.all) { binding in
            PortfolioFilterChips(selected: binding)
                .preferredColorScheme(.dark)
                .background(Color.black)
        }
    }
}

// Helper for previewing @Binding
struct StatefulPreviewWrapper<Value: Equatable, Content: View>: View {
    @State var value: Value
    var content: (Binding<Value>) -> Content
    init(_ value: Value, content: @escaping (Binding<Value>) -> Content) {
        _value = State(initialValue: value)
        self.content = content
    }
    var body: some View {
        content($value)
    }
}
