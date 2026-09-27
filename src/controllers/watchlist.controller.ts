import { Response } from "express";
import { WatchlistService } from "../services/watchlist.service";
import { AuthenticatedRequest } from "../types/auth";

export class WatchlistController {
  constructor(private readonly watchlistService: WatchlistService) {}

  addToWatchlist = async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { invoiceId } = req.params;
      const { notes } = req.body;

      if (!invoiceId) {
        return res.status(400).json({
          error: {
            code: "MISSING_INVOICE_ID",
            message: "invoiceId is required",
          },
        });
      }

      const entry = await this.watchlistService.addToWatchlist(
        req.user.stellarAddress,
        Array.isArray(invoiceId) ? invoiceId[0] : invoiceId,
        req.user.id,
        notes
      );

      return res.status(201).json({
        success: true,
        data: entry,
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

  removeFromWatchlist = async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { invoiceId } = req.params;

      if (!invoiceId) {
        return res.status(400).json({
          error: {
            code: "MISSING_INVOICE_ID",
            message: "invoiceId is required",
          },
        });
      }

      await this.watchlistService.removeFromWatchlist(req.user.stellarAddress, Array.isArray(invoiceId) ? invoiceId[0] : invoiceId);

      return res.status(204).send();
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

  getWatchlist = async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { page = "1", limit = "20" } = req.query;

      const pagination = {
        page: Math.max(1, Number(Array.isArray(page) ? page[0] : page)),
        limit: Math.min(100, Math.max(1, Number(Array.isArray(limit) ? limit[0] : limit))),
      };

      const result = await this.watchlistService.getWatchlist(
        req.user.stellarAddress,
        pagination
      );

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
}
