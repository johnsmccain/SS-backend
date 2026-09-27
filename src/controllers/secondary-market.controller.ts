import { Response } from "express";
import { SecondaryMarketService } from "../services/secondary-market.service";
import { AuthenticatedRequest } from "../types/auth";

export class SecondaryMarketController {
  constructor(private readonly secondaryMarketService: SecondaryMarketService) {}

  createListing = async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { invoiceId, quantity, pricePerFraction, expiresAt } = req.body;

      if (!invoiceId || !quantity || !pricePerFraction || !expiresAt) {
        return res.status(400).json({
          error: {
            code: "MISSING_FIELDS",
            message: "invoiceId, quantity, pricePerFraction, and expiresAt are required",
          },
        });
      }

      const listing = await this.secondaryMarketService.createListing({
        invoiceId: Array.isArray(invoiceId) ? invoiceId[0] : invoiceId,
        sellerWallet: req.user.stellarAddress,
        sellerId: req.user.id,
        quantity: Array.isArray(quantity) ? quantity[0] : quantity,
        pricePerFraction: Array.isArray(pricePerFraction) ? pricePerFraction[0] : pricePerFraction,
        expiresAt: new Date(Array.isArray(expiresAt) ? expiresAt[0] : expiresAt),
      });

      return res.status(201).json({
        success: true,
        data: listing,
      });
    } catch (err: unknown) {
      const statusCode =
        (err as { statusCode?: number }).statusCode || (err as { status?: number }).status || 400;
      return res.status(statusCode).json({
        error: {
          code: (err as { code?: string }).code || "INTERNAL_ERROR",
          message: (err as { message?: string }).message || "Internal server error",
        },
      });
    }
  };

  getListings = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const {
        invoiceId,
        sellerWallet,
        minPrice,
        maxPrice,
        sortBy = "created_at",
        sortOrder = "DESC",
        page = "1",
        limit = "20",
      } = req.query;

      const filters = {
        invoiceId: invoiceId as string | undefined,
        sellerWallet: sellerWallet as string | undefined,
        minPrice: minPrice ? Number(Array.isArray(minPrice) ? minPrice[0] : minPrice) : undefined,
        maxPrice: maxPrice ? Number(Array.isArray(maxPrice) ? maxPrice[0] : maxPrice) : undefined,
        sortBy: (sortBy as string) as "price" | "expires_at" | "created_at",
        sortOrder: (sortOrder as string) as "ASC" | "DESC",
      };

      const pagination = {
        page: Math.max(1, Number(Array.isArray(page) ? page[0] : page)),
        limit: Math.min(100, Math.max(1, Number(Array.isArray(limit) ? limit[0] : limit))),
      };

      const result = await this.secondaryMarketService.getListings(filters, pagination);

      return res.status(200).json({
        success: true,
        data: result.data,
        meta: result.meta,
      });
    } catch (err: unknown) {
      const statusCode =
        (err as { statusCode?: number }).statusCode || (err as { status?: number }).status || 400;
      return res.status(statusCode).json({
        error: {
          code: (err as { code?: string }).code || "INTERNAL_ERROR",
          message: (err as { message?: string }).message || "Internal server error",
        },
      });
    }
  };

  getListingById = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;
      const listingId = Array.isArray(id) ? id[0] : id;

      const listing = await this.secondaryMarketService.getListingById(listingId);

      return res.status(200).json({
        success: true,
        data: listing,
      });
    } catch (err: unknown) {
      const statusCode =
        (err as { statusCode?: number }).statusCode || (err as { status?: number }).status || 400;
      return res.status(statusCode).json({
        error: {
          code: (err as { code?: string }).code || "INTERNAL_ERROR",
          message: (err as { message?: string }).message || "Internal server error",
        },
      });
    }
  };

  buyListing = async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { id } = req.params;
      const { quantity } = req.body;

      const result = await this.secondaryMarketService.buyListing({
        listingId: Array.isArray(id) ? id[0] : id,
        buyerWallet: req.user.stellarAddress,
        buyerId: req.user.id,
        quantity: quantity ? (Array.isArray(quantity) ? quantity[0] : quantity) : undefined,
      });

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: unknown) {
      const statusCode =
        (err as { statusCode?: number }).statusCode || (err as { status?: number }).status || 400;
      return res.status(statusCode).json({
        error: {
          code: (err as { code?: string }).code || "INTERNAL_ERROR",
          message: (err as { message?: string }).message || "Internal server error",
        },
      });
    }
  };

  cancelListing = async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { id } = req.params;
      const { reason } = req.body;

      const listing = await this.secondaryMarketService.cancelListing(
        Array.isArray(id) ? id[0] : id,
        req.user.stellarAddress,
        reason
      );

      return res.status(200).json({
        success: true,
        data: listing,
      });
    } catch (err: unknown) {
      const statusCode =
        (err as { statusCode?: number }).statusCode || (err as { status?: number }).status || 400;
      return res.status(statusCode).json({
        error: {
          code: (err as { code?: string }).code || "INTERNAL_ERROR",
          message: (err as { message?: string }).message || "Internal server error",
        },
      });
    }
  };
}
