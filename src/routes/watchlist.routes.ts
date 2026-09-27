import { Router } from "express";
import { WatchlistController } from "../controllers/watchlist.controller";
import { WatchlistService } from "../services/watchlist.service";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import type { AuthService } from "../services/auth.service";

export interface WatchlistRouterDependencies {
  watchlistService: WatchlistService;
  authService: AuthService;
}

export function createWatchlistRouter({
  watchlistService,
  authService,
}: WatchlistRouterDependencies): Router {
  const router = Router();
  const controller = new WatchlistController(watchlistService);
  const authMiddleware = createAuthMiddleware(authService);

  // POST /api/v1/watchlist/:invoiceId - Add invoice to watchlist
  router.post("/:invoiceId", authMiddleware, controller.addToWatchlist);

  // DELETE /api/v1/watchlist/:invoiceId - Remove invoice from watchlist
  router.delete("/:invoiceId", authMiddleware, controller.removeFromWatchlist);

  // GET /api/v1/watchlist - Get paginated watchlist with invoice status
  router.get("/", authMiddleware, controller.getWatchlist);

  return router;
}
