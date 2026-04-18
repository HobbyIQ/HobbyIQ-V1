import { useQuery } from "react-query";
import { listWatchlist } from "../api/watchlist.api";

export function useWatchlist() {
  return useQuery(["watchlist"], listWatchlist);
}
