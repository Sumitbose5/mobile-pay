import type { RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';

type Parts = { body?: ZodTypeAny; query?: ZodTypeAny; params?: ZodTypeAny };

/** Validates and replaces req.body / req.query / req.params with parsed values. */
export const validate =
  (parts: Parts): RequestHandler =>
  (req, _res, next) => {
    try {
      if (parts.body) req.body = parts.body.parse(req.body);
      if (parts.query) Object.assign(req.query, parts.query.parse(req.query));
      if (parts.params) Object.assign(req.params, parts.params.parse(req.params));
      next();
    } catch (err) {
      next(err);
    }
  };
