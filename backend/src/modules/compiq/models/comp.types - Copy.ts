// Minimal placeholder for Comp types
export interface CompInput {
  [key: string]: any;
}

export interface NormalizedComp extends CompInput {
  normalized: boolean;
}
