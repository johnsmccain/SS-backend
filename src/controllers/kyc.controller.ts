import { Request, Response } from "express";
import { KycService } from "../services/kyc.service";
import { AuthenticatedRequest } from "../types/auth";

export function createKycController(service: KycService) {
  return {
    submit: async (req: AuthenticatedRequest, res: Response) => {
      if (!req.user) return res.status(401).json({ error: "Authentication required" });
      const verification = await service.submitKycVerification(req.user.id, req.body);
      return res.status(201).json({ success: true, data: verification });
    },
    submitDocument: async (req: AuthenticatedRequest, res: Response) => {
      if (!req.user) return res.status(401).json({ error: "Authentication required" });
      const verification = await service.submitKycVerificationByWallet(
        req.user.stellarAddress,
        req.body,
      );
      return res.status(201).json({ success: true, data: verification });
    },
    webhook: async (req: Request, res: Response) => {
      if (!Buffer.isBuffer(req.body)) {
        return res
          .status(400)
          .json({ error: { code: "RAW_BODY_REQUIRED", message: "Raw webhook body required" } });
      }
      const rawBody = req.body;
      if (!service.verifyWebhookSignature(rawBody, req.header("x-provider-signature"))) {
        return res.status(401).json({
          error: { code: "INVALID_WEBHOOK_SIGNATURE", message: "Invalid webhook signature" },
        });
      }
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return res
          .status(400)
          .json({ error: { code: "INVALID_WEBHOOK_PAYLOAD", message: "Invalid JSON payload" } });
      }
      await service.processWebhook(payload as Parameters<KycService["processWebhook"]>[0]);
      return res.status(204).send();
    },
    resubmit: async (req: AuthenticatedRequest, res: Response) => {
      if (!req.user) return res.status(401).json({ error: "Authentication required" });
      const verification = await service.resubmitKycVerification(req.user.stellarAddress, req.body);
      return res.status(201).json({ success: true, data: verification });
    },
    getHistory: async (req: AuthenticatedRequest, res: Response) => {
      if (!req.user) return res.status(401).json({ error: "Authentication required" });
      const history = await service.getKycHistory(req.user.stellarAddress);
      return res.status(200).json({ success: true, data: history });
    },
  };
}
