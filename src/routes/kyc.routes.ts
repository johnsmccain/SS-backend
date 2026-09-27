import express, { Router, type Request, type Response, type NextFunction } from "express";
import Joi from "joi";
import { KycService } from "../services/kyc.service";
import { createKycController } from "../controllers/kyc.controller";
import { createAuthMiddleware, requireSeller } from "../middleware/auth.middleware";
import { HttpError } from "../utils/http-error";
import type { AuthService } from "../services/auth.service";

const KYC_DOCUMENT_TYPES = ["passport", "national_id", "drivers_license"] as const;

const submitKycSchema = Joi.object({
  documentType: Joi.string()
    .valid(...KYC_DOCUMENT_TYPES)
    .required()
    .trim()
    .messages({
      "any.only": "documentType must be one of: passport, national_id, drivers_license",
      "any.required": "documentType is required",
      "string.empty": "documentType is required",
    }),
  documentNumber: Joi.string()
    .trim()
    .required()
    .max(255)
    .messages({
      "any.required": "documentNumber is required",
      "string.empty": "documentNumber is required",
    }),
  ipfsDocumentUrl: Joi.string()
    .trim()
    .uri()
    .required()
    .messages({
      "any.required": "ipfsDocumentUrl is required",
      "string.empty": "ipfsDocumentUrl is required",
      "string.uri": "ipfsDocumentUrl must be a valid URL",
    }),
});

function validateKycBody(req: Request, _res: Response, next: NextFunction): void {
  const { error, value } = submitKycSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    next(
      new HttpError(
        422,
        "Invalid KYC submission.",
        error.details.map((detail) => detail.message)
      )
    );
    return;
  }

  req.body = value;
  next();
}

export function createKycWebhookRouter(service: KycService): Router {
  const router = Router();
  const controller = createKycController(service);
  router.post(
    "/webhook",
    express.raw({ type: "application/json", limit: "256kb" }),
    controller.webhook
  );
  return router;
}

export function createKycRouter(service: KycService, authService: AuthService): Router {
  const router = Router();
  const controller = createKycController(service);

  router.post(
    "/",
    createAuthMiddleware(authService),
    requireSeller(),
    validateKycBody,
    controller.submitDocument
  );

  router.post(
    "/submit",
    createAuthMiddleware(authService),
    controller.submit
  );

  router.post(
    "/resubmit",
    createAuthMiddleware(authService),
    requireSeller(),
    validateKycBody,
    controller.resubmit
  );

  router.get(
    "/history",
    createAuthMiddleware(authService),
    controller.getHistory
  );

  return router;
}
