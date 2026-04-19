import { Comp, EstimateInput } from '../models/compiq';

export function filterCompsStrict(comps: Comp[], input: EstimateInput): Comp[] {
  return comps.filter(comp =>
    comp.player === input.player &&
    comp.product === input.product &&
    comp.cardNumber === input.cardNumber &&
    comp.parallel === input.parallel &&
    (input.auto === undefined || comp.auto === input.auto) &&
    (input.grade === undefined || comp.grade === input.grade)
  );
}

export function rejectBadComps(comps: Comp[]): Comp[] {
  return comps.filter(comp =>
    !comp.isBundle &&
    !comp.isDamaged &&
    !comp.isIncomplete &&
    comp.price > 0
  );
}
