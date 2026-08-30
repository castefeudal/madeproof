import { MadeProofError } from './errors.js';

export type JsonSchema = {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  minLength?: number;
  minimum?: number;
  additionalProperties?: boolean;
};

export function validateSchema(value: unknown, schema: JsonSchema, path = '$'): void {
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) {
    throw new MadeProofError('VALIDATION_ERROR', `${path} must be one of ${schema.enum.join(', ')}`, 422);
  }
  if (!schema.type) return;
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new MadeProofError('VALIDATION_ERROR', `${path} must be an array`, 422);
    if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items!, `${path}[${index}]`));
    return;
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new MadeProofError('VALIDATION_ERROR', `${path} must be an object`, 422);
    }
    const record = value as Record<string, unknown>;
    for (const required of schema.required ?? []) {
      if (!(required in record)) throw new MadeProofError('VALIDATION_ERROR', `${path}.${required} is required`, 422);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in record) validateSchema(record[key], child, `${path}.${key}`);
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(record)) {
        if (!allowed.has(key)) throw new MadeProofError('VALIDATION_ERROR', `${path}.${key} is not allowed`, 422);
      }
    }
    return;
  }
  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) throw new MadeProofError('VALIDATION_ERROR', `${path} must be an integer`, 422);
    if (schema.minimum !== undefined && (value as number) < schema.minimum) {
      throw new MadeProofError('VALIDATION_ERROR', `${path} must be >= ${schema.minimum}`, 422);
    }
    return;
  }
  if (typeof value !== schema.type) throw new MadeProofError('VALIDATION_ERROR', `${path} must be a ${schema.type}`, 422);
  if (schema.type === 'string' && schema.minLength !== undefined && (value as string).length < schema.minLength) {
    throw new MadeProofError('VALIDATION_ERROR', `${path} must contain at least ${schema.minLength} characters`, 422);
  }
}

export function requiredString(value: unknown, field: string, min = 1): string {
  if (typeof value !== 'string' || value.trim().length < min) {
    throw new MadeProofError('VALIDATION_ERROR', `${field} must contain at least ${min} characters`, 422);
  }
  return value.trim();
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
