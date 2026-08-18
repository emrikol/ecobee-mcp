import {
  fromJsonSchema,
  type JsonSchemaType,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server/runtime";

type JsonSchema = JsonSchemaType & Record<string, unknown>;
type Refinement = (value: unknown, context: RefinementContext) => void;

export interface RefinementIssue {
  message: string;
  path?: PropertyKey[];
}

export interface RefinementContext {
  addIssue(issue: RefinementIssue & { code?: string }): void;
}

export class Schema<T> {
  readonly definition: JsonSchema;
  readonly optionalValue: boolean;
  readonly defaultValue: T | undefined;
  readonly hasDefault: boolean;
  readonly refinements: readonly Refinement[];

  constructor(
    definition: JsonSchema,
    options: {
      optionalValue?: boolean;
      defaultValue?: T;
      hasDefault?: boolean;
      refinements?: readonly Refinement[];
    } = {},
  ) {
    this.definition = definition;
    this.optionalValue = options.optionalValue ?? false;
    this.defaultValue = options.defaultValue;
    this.hasDefault = options.hasDefault ?? false;
    this.refinements = options.refinements ?? [];
  }

  copy<Next>(
    definition: JsonSchema = this.definition,
    options: {
      optionalValue?: boolean;
      defaultValue?: Next;
      hasDefault?: boolean;
      refinements?: readonly Refinement[];
    } = {},
  ): Schema<Next> {
    const clone = Object.create(Object.getPrototypeOf(this)) as Schema<Next>;
    Object.assign(clone, this, {
      definition,
      optionalValue: options.optionalValue ?? this.optionalValue,
      defaultValue:
        options.hasDefault === true
          ? options.defaultValue
          : (this.defaultValue as Next | undefined),
      hasDefault: options.hasDefault ?? this.hasDefault,
      refinements: options.refinements ?? this.refinements,
    });
    return clone;
  }

  optional(): Schema<T | undefined> {
    return this.copy<T | undefined>(this.definition, { optionalValue: true });
  }

  nullable(): Schema<T | null> {
    return this.copy<T | null>({
      anyOf: [this.definition, { type: "null" }],
    });
  }

  default(value: T): Schema<T> {
    return this.copy<T>(
      { ...this.definition, default: value },
      {
        optionalValue: true,
        defaultValue: value,
        hasDefault: true,
      },
    );
  }

  describe(description: string): this {
    return this.copy<T>({ ...this.definition, description }) as this;
  }

  meta(metadata: Record<string, unknown>): this {
    return this.copy<T>({ ...this.definition, ...metadata }) as this;
  }

  refine(predicate: (value: T) => boolean, options: { message: string }): this {
    const refinement: Refinement = (value, context) => {
      if (!predicate(value as T))
        context.addIssue({ message: options.message });
    };
    return this.copy<T>(this.definition, {
      refinements: [...this.refinements, refinement],
    }) as this;
  }

  superRefine(
    refinement: (value: T, context: RefinementContext) => void,
  ): this {
    return this.copy<T>(this.definition, {
      refinements: [
        ...this.refinements,
        refinement as (value: unknown, context: RefinementContext) => void,
      ],
    }) as this;
  }
}

class StringSchema extends Schema<string> {
  min(length: number): StringSchema {
    return this.copy<string>({
      ...this.definition,
      minLength: length,
    }) as StringSchema;
  }

  max(length: number): StringSchema {
    return this.copy<string>({
      ...this.definition,
      maxLength: length,
    }) as StringSchema;
  }

  regex(expression: RegExp): StringSchema {
    return this.copy<string>({
      ...this.definition,
      pattern: expression.source,
    }) as StringSchema;
  }
}

class NumberSchema extends Schema<number> {
  min(value: number): NumberSchema {
    return this.copy<number>({
      ...this.definition,
      minimum: value,
    }) as NumberSchema;
  }

  max(value: number): NumberSchema {
    return this.copy<number>({
      ...this.definition,
      maximum: value,
    }) as NumberSchema;
  }

  int(): NumberSchema {
    return this.copy<number>({
      ...this.definition,
      type: "integer",
    }) as NumberSchema;
  }

  finite(): NumberSchema {
    return this;
  }
}

class ArraySchema<Item> extends Schema<Item[]> {
  readonly itemSchema: Schema<Item>;

  constructor(
    itemSchema: Schema<Item>,
    definition: JsonSchema = {
      type: "array",
      items: itemSchema.definition,
    },
  ) {
    super(definition);
    this.itemSchema = itemSchema;
  }

  min(length: number): ArraySchema<Item> {
    const clone = this.copy<Item[]>({
      ...this.definition,
      minItems: length,
    }) as ArraySchema<Item>;
    Object.assign(clone, { itemSchema: this.itemSchema });
    return clone;
  }

  max(length: number): ArraySchema<Item> {
    const clone = this.copy<Item[]>({
      ...this.definition,
      maxItems: length,
    }) as ArraySchema<Item>;
    Object.assign(clone, { itemSchema: this.itemSchema });
    return clone;
  }
}

type Shape = Record<string, Schema<unknown>>;
type RequiredKeys<S extends Shape> = {
  [K in keyof S]-?: undefined extends Infer<S[K]> ? never : K;
}[keyof S];
type OptionalKeys<S extends Shape> = Exclude<keyof S, RequiredKeys<S>>;
type ObjectValue<S extends Shape> = {
  [K in RequiredKeys<S>]: Infer<S[K]>;
} & {
  [K in OptionalKeys<S>]?: Exclude<Infer<S[K]>, undefined>;
};

export class ObjectSchema<S extends Shape = Shape> extends Schema<
  ObjectValue<S>
> {
  readonly shape: S;

  constructor(shape: S) {
    super(objectDefinition(shape));
    this.shape = shape;
  }

  strict(): ObjectSchema<S> {
    return this;
  }

  extend<Extension extends Shape>(
    extension: Extension,
  ): ObjectSchema<S & Extension> {
    return new ObjectSchema({ ...this.shape, ...extension });
  }

  omit<Keys extends Partial<Record<keyof S, boolean>>>(
    keys: Keys,
  ): ObjectSchema<Omit<S, keyof Keys>> {
    const next = { ...this.shape };
    for (const key of Object.keys(keys)) delete next[key];
    return new ObjectSchema(next as Omit<S, keyof Keys>);
  }

  partial(): ObjectSchema<{
    [K in keyof S]: Schema<Infer<S[K]> | undefined>;
  }> {
    const next = {} as {
      [K in keyof S]: Schema<Infer<S[K]> | undefined>;
    };
    for (const key of Object.keys(this.shape) as Array<keyof S>) {
      next[key] = this.shape[key].optional() as Schema<
        Infer<S[typeof key]> | undefined
      >;
    }
    return new ObjectSchema(next);
  }
}

function objectDefinition(shape: Shape): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [name, property] of Object.entries(shape)) {
    properties[name] = property.definition;
    if (!property.optionalValue) required.push(name);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 && { required }),
    additionalProperties: false,
  };
}

export const schema = {
  string: (): StringSchema => new StringSchema({ type: "string" }),
  number: (): NumberSchema => new NumberSchema({ type: "number" }),
  boolean: (): Schema<boolean> => new Schema({ type: "boolean" }),
  object: <S extends Shape>(shape: S): ObjectSchema<S> =>
    new ObjectSchema(shape),
  strictObject: <S extends Shape>(shape: S): ObjectSchema<S> =>
    new ObjectSchema(shape),
  array: <Item>(item: Schema<Item>): ArraySchema<Item> => new ArraySchema(item),
  enum: <const Values extends readonly [string, ...string[]]>(
    values: Values,
  ): Schema<Values[number]> =>
    new Schema({ type: "string", enum: [...values] }),
  literal: <const Value extends string | number | boolean | null>(
    value: Value,
  ): Schema<Value> =>
    new Schema({
      type: value === null ? "null" : typeof value,
      const: value,
    }),
  union: <const Schemas extends readonly Schema<unknown>[]>(
    schemas: Schemas,
  ): Schema<Infer<Schemas[number]>> =>
    new Schema({ anyOf: schemas.map((entry) => entry.definition) }),
  record: <Value>(
    key: Schema<string>,
    value: Schema<Value>,
  ): Schema<Record<string, Value>> =>
    new Schema({
      type: "object",
      propertyNames: key.definition,
      additionalProperties: value.definition,
    }),
};

export type Infer<S extends Schema<unknown>> =
  S extends Schema<infer Value> ? Value : never;

const compiledSchemas = new WeakMap<Schema<unknown>, StandardSchemaWithJSON>();

export function compileSchema<S extends Schema<unknown>>(
  source: S,
): StandardSchemaWithJSON<Infer<S>, Infer<S>> {
  let compiled = compiledSchemas.get(source);
  if (!compiled) {
    compiled = fromJsonSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      ...source.definition,
    });
    compiledSchemas.set(source, compiled);
  }
  return compiled as StandardSchemaWithJSON<Infer<S>, Infer<S>>;
}

export function prepareSchemaValue<S extends Schema<unknown>>(
  source: S,
  value: Infer<S>,
): Infer<S> {
  const prepared = applyDefaults(source, value) as Infer<S>;
  const issues: RefinementIssue[] = [];
  collectRefinementIssues(source, prepared, issues);
  if (issues.length > 0) throw new SchemaRefinementError(issues);
  return prepared;
}

export class SchemaRefinementError extends Error {
  constructor(readonly issues: readonly RefinementIssue[]) {
    super("Tool input failed cross-field validation.");
    this.name = "SchemaRefinementError";
  }
}

function applyDefaults(source: Schema<unknown>, value: unknown): unknown {
  if (value === undefined && source.hasDefault) return source.defaultValue;
  if (value === null || value === undefined) return value;

  if (source instanceof ObjectSchema && isRecord(value)) {
    let result = value;
    for (const [key, property] of Object.entries(source.shape) as Array<
      [string, Schema<unknown>]
    >) {
      const current = value[key];
      const prepared = applyDefaults(property, current);
      if (prepared !== current) {
        if (result === value) result = { ...value };
        result[key] = prepared;
      }
    }
    return result;
  }

  if (source instanceof ArraySchema && Array.isArray(value)) {
    let result = value;
    for (let index = 0; index < value.length; index++) {
      const prepared = applyDefaults(source.itemSchema, value[index]);
      if (prepared !== value[index]) {
        if (result === value) result = [...value];
        result[index] = prepared;
      }
    }
    return result;
  }

  return value;
}

function collectRefinementIssues(
  source: Schema<unknown>,
  value: unknown,
  issues: RefinementIssue[],
): void {
  const context: RefinementContext = {
    addIssue: ({ message, path }) => issues.push({ message, path }),
  };
  for (const refinement of source.refinements) refinement(value, context);

  if (value === null || value === undefined) return;
  if (source instanceof ObjectSchema && isRecord(value)) {
    for (const [key, property] of Object.entries(source.shape) as Array<
      [string, Schema<unknown>]
    >) {
      const before = issues.length;
      collectRefinementIssues(property, value[key], issues);
      for (let index = before; index < issues.length; index++) {
        issues[index] = {
          ...issues[index],
          path: [key, ...(issues[index].path ?? [])],
        };
      }
    }
  } else if (source instanceof ArraySchema && Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const before = issues.length;
      collectRefinementIssues(source.itemSchema, value[index], issues);
      for (let issueIndex = before; issueIndex < issues.length; issueIndex++) {
        issues[issueIndex] = {
          ...issues[issueIndex],
          path: [index, ...(issues[issueIndex].path ?? [])],
        };
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
