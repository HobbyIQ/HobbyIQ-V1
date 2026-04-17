import Joi from 'joi';

export const cardDecisionSchema = Joi.object({
  player: Joi.string().required(),
  cardSet: Joi.string().required(),
  year: Joi.number().required(),
  product: Joi.string().required(),
  parallel: Joi.string().required(),
  serial: Joi.string().allow(null, ''),
  grade: Joi.string().required(),
  isAuto: Joi.boolean().required(),
  askingPrice: Joi.number().required(),
  userIntent: Joi.string().valid('buy', 'hold', 'sell').required(),
});

export function validateCardDecision(payload: any) {
  return cardDecisionSchema.validate(payload, { abortEarly: false });
}
