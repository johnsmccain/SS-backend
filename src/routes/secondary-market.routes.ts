import { Router } from "express";
import { SecondaryMarketController } from "../controllers/secondary-market.controller";
import { SecondaryMarketService } from "../services/secondary-market.service";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import type { AuthService } from "../services/auth.service";

export interface SecondaryMarketRouterDependencies {
  secondaryMarketService: SecondaryMarketService;
  authService: AuthService;
}

export function createSecondaryMarketRouter({
  secondaryMarketService,
  authService,
}: SecondaryMarketRouterDependencies): Router {
  const router = Router();
  const controller = new SecondaryMarketController(secondaryMarketService);
  const authMiddleware = createAuthMiddleware(authService);

  // POST /api/v1/secondary/listings - Create a new listing
  router.post("/listings", authMiddleware, controller.createListing);

  // GET /api/v1/secondary/listings - Get active listings with filters
  router.get("/listings", authMiddleware, controller.getListings);

  // GET /api/v1/secondary/listings/:id - Get listing details
  router.get("/listings/:id", authMiddleware, controller.getListingById);

  // POST /api/v1/secondary/listings/:id/buy - Buy a listing
  router.post("/listings/:id/buy", authMiddleware, controller.buyListing);

  // DELETE /api/v1/secondary/listings/:id - Cancel a listing
  router.delete("/listings/:id", authMiddleware, controller.cancelListing);

  return router;
}
