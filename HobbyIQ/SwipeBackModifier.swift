//
//  SwipeBackModifier.swift
//  HobbyIQ
//
//  Re-enables the interactive pop gesture (swipe-to-go-back)
//  when .navigationBarBackButtonHidden(true) is used.
//

import SwiftUI
import UIKit

extension UINavigationController: @retroactive UIGestureRecognizerDelegate {
    override open func viewDidLoad() {
        super.viewDidLoad()
        interactivePopGestureRecognizer?.delegate = self
    }

    public func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        viewControllers.count > 1
    }
}
