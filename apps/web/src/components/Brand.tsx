"use client";

import Link from "next/link";
import { useState } from "react";

interface Props {
  href?: string;
  size?: "sm" | "md" | "lg";
  variant?: "icon-only" | "logo-full";
  className?: string;
}

// Brand mark. Loads Drew's PNGs from /public with an onError fallback
// to the hero-stroke wordmark so the page never shows a broken image.
//
// Expected assets (drop in at these exact paths):
//   apps/web/public/hobbyiq-icon.png       — square, 512×512+ recommended
//   apps/web/public/hobbyiq-logo.png       — full horizontal logo
//   apps/web/src/app/icon.png              — Next.js auto-favicon
//
// The favicon slot (apps/web/src/app/icon.png) is auto-detected by
// Next.js — nothing to import; browsers pick it up automatically once
// the file is present.
export function Brand({ href = "/", size = "md", variant = "icon-only", className }: Props) {
  const [imgFailed, setImgFailed] = useState(false);

  const iconPx = size === "sm" ? 24 : size === "lg" ? 44 : 32;
  const textCls =
    size === "sm" ? "text-base" : size === "lg" ? "text-3xl" : "text-xl";

  const inner = (
    <div className={`flex items-center gap-2 ${className ?? ""}`}>
      {variant === "logo-full" ? (
        imgFailed ? (
          <span className={`font-bold tracking-tight ${textCls}`}>
            <span className="hiq-hero-stroke text-transparent bg-clip-text">HobbyIQ</span>
          </span>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src="/hobbyiq-logo.png"
            alt="HobbyIQ"
            height={iconPx + 8}
            className="object-contain"
            style={{ height: iconPx + 8, width: "auto" }}
            onError={() => setImgFailed(true)}
          />
        )
      ) : (
        <>
          {imgFailed ? null : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src="/hobbyiq-icon.png"
              alt=""
              width={iconPx}
              height={iconPx}
              className="object-contain flex-shrink-0"
              style={{ width: iconPx, height: iconPx }}
              onError={() => setImgFailed(true)}
            />
          )}
          <span className={`font-bold tracking-tight ${textCls}`}>
            <span className="hiq-hero-stroke text-transparent bg-clip-text">HobbyIQ</span>
          </span>
        </>
      )}
    </div>
  );

  if (!href) return inner;
  return <Link href={href}>{inner}</Link>;
}
