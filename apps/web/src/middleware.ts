import { NextResponse, type NextRequest } from "next/server";

// Canonical host is the apex hobby-iq.com. 301 www → apex so links,
// share cards, and search-engine authority all consolidate to one URL.
const CANONICAL_HOST = "hobby-iq.com";
const REDIRECT_HOSTS = new Set(["www.hobby-iq.com"]);

export function middleware(request: NextRequest) {
  const host = request.headers.get("host")?.toLowerCase();
  if (!host || !REDIRECT_HOSTS.has(host)) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.host = CANONICAL_HOST;
  url.port = "";
  return NextResponse.redirect(url, 301);
}

export const config = {
  matcher: "/:path*",
};
