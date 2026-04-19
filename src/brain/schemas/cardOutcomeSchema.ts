import Joi, { ValidationResult } from 'joi';

export const cardOutcomeSchema = Joi.object({
  player: Joi.string().required(),
  cardSet: Joi.string().required(),
  year: Joi.number().required(),
  product: Joi.string().required(),
  parallel: Joi.string().required(),
  grade: Joi.string().required(),
  currentEstimatedValue: Joi.number().required(),
  events: Joi.array().items(Joi.string()).required(),
});

export function validateCardOutcome(payload: unknown): ValidationResult {
  return cardOutcomeSchema.validate(payload, { abortEarly: false });
}
