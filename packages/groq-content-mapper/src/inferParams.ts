import {type ExprNode as GroqExprNode, type SchemaType, typeEvaluate, type TypeNode} from 'groq-js'

import {
  type ExprNode,
  type InRangeNode,
  type ObjectNode,
  type OpCall,
  type OpCallNode,
  type ParameterNode,
} from './groqAst.js'
import {extractSliceParams, withoutLiterals} from './safeParseQuery.js'

/** The attribute a probe projection writes the counterpart's type to. */
const PROBE = '__sanityGroqParam'
const UNKNOWN: TypeNode = {type: 'unknown'}
const PARAMETER = /\$([A-Za-z_]\w*)/g

/**
 * Where an expression is evaluated. `wrap` turns an expression meant for this scope into a
 * root-level query whose result holds the expression's type `depth` probe objects deep: each
 * scope-creating ancestor keeps its base and swaps its body for a projection of the probe, so
 * groq-js resolves the scope exactly as it does for the query itself.
 */
interface Scope {
  depth: number
  wrap: (expr: ExprNode) => ExprNode
}

const ROOT: Scope = {depth: 0, wrap: (expr) => expr}

/** A placeholder on one side of an operator, with the expression on the other side. */
interface Comparison {
  counterpart: ExprNode
  name: string
  op: 'range' | OpCall
  paramOnLeft: boolean
  scope: Scope
}

interface Collected {
  comparisons: Comparison[]
  names: Set<string>
}

/**
 * The type of every `$param` in a query, in order of first appearance.
 *
 * A placeholder compared with a field takes the field's type: `slug.current == $slug` is
 * `string`, `role == $role` keeps a string enum, `tags == $tags` is `Array<string>`,
 * `$tag in tags` is `string`, `_id in $ids` is `Array<string>`, and `title match $term` is
 * `string`. Slice bounds are `number`. Field types come from groq-js's own type evaluation, so
 * dereferences, `_type` narrowing in a filter, nested scopes and inline types resolve as they do
 * for the result type. A placeholder compared with a literal widens to the literal's primitive.
 * One that is only passed to a function or projected is `unknown`, and still required.
 *
 * @param ast - The query as `safeParseQuery` parsed it, so slice bounds are already constants
 */
export function inferParams({
  ast,
  query,
  schema,
}: {
  ast: ExprNode
  query: string
  schema: SchemaType
}): Map<string, TypeNode> {
  const found: Collected = {comparisons: [], names: new Set()}
  walk(ast, ROOT, found)

  // Slice bounds are substituted before parsing, so the AST no longer names them.
  const code = withoutLiterals(query)
  const types = new Map<string, TypeNode[]>()
  for (const name of extractSliceParams(code)) types.set(name, [{type: 'number'}])
  for (const name of found.names) types.set(name, types.get(name) ?? [])
  for (const comparison of found.comparisons) {
    const type = resolve(comparison, schema)
    if (type) types.get(comparison.name)?.push(type)
  }

  const params = new Map<string, TypeNode>()
  const inOrder = [...code.matchAll(PARAMETER)].map((match) => match[1]!)
  for (const name of [...inOrder, ...types.keys()]) {
    const candidates = types.get(name)
    if (candidates && !params.has(name)) params.set(name, combine(candidates))
  }
  return params
}

function walk(node: ExprNode, scope: Scope, found: Collected): void {
  switch (node.type) {
    case 'Filter': {
      walk(node.base, scope, found)
      // The probe projects the filtered set, so `_type` checks in the filter narrow it.
      walk(
        node.expr,
        nested(scope, (probe) => mapElements(node, probe)),
        found,
      )
      return
    }
    case 'FlatMap':
    case 'Map': {
      walk(node.base, scope, found)
      // `base[]{...}` parses as a map of `@{...}`, the scope `^` resolves from.
      const projects = node.expr.type === 'Projection' && node.expr.base.type === 'This'
      walk(
        node.expr,
        nested(scope, (probe) => ({...node, expr: projects ? ownScope(probe) : probe})),
        found,
      )
      return
    }
    case 'InRange': {
      noteRange(node, scope, found)
      break
    }
    case 'OpCall': {
      noteComparison(node, scope, found)
      break
    }
    case 'Parameter': {
      found.names.add(node.name)
      return
    }
    case 'PipeFuncCall': {
      // `order()` and `score()` evaluate their arguments once per element of the base.
      walk(node.base, scope, found)
      const inner = nested(scope, (probe) => mapElements(node.base, probe))
      for (const arg of node.args) walk(arg, inner, found)
      return
    }
    case 'Projection': {
      walk(node.base, scope, found)
      // `base{...}` over a set parses as a map of `@{...}`, which keeps the element as `@`.
      const inner =
        node.base.type === 'This' ? scope : nested(scope, (probe) => ({...node, expr: probe}))
      walk(node.expr, inner, found)
      return
    }
    case 'AccessAttribute':
    case 'AccessElement':
    case 'And':
    case 'Array':
    case 'ArrayCoerce':
    case 'Asc':
    case 'Context':
    case 'Deref':
    case 'Desc':
    case 'Everything':
    case 'FuncCall':
    case 'Group':
    case 'Neg':
    case 'Not':
    case 'Object':
    case 'Or':
    case 'Parent':
    case 'Pos':
    case 'Select':
    case 'SelectorFuncCall':
    case 'SelectorNested':
    case 'Slice':
    case 'This':
    case 'Tuple':
    case 'Value': {
      break
    }
    default: {
      node satisfies never
    }
  }
  for (const child of children(node)) walk(child, scope, found)
}

function nested(scope: Scope, build: (probe: ObjectNode) => ExprNode): Scope {
  return {
    depth: scope.depth + 1,
    wrap: (expr) =>
      scope.wrap(
        build({
          attributes: [{name: PROBE, type: 'ObjectAttributeValue', value: expr}],
          type: 'Object',
        }),
      ),
  }
}

/** The probe evaluated once per element of `base`, whether the elements are objects or not. */
function mapElements(base: ExprNode, probe: ObjectNode): ExprNode {
  return {base, expr: ownScope(probe), type: 'Map'}
}

/**
 * groq-js hides a map's scope from `^`, so a probe that uses `^` projects `@` to get a scope of
 * its own, as a filter or `@{...}` has. That types only object elements, so other probes do not.
 */
function ownScope(probe: ObjectNode): ExprNode {
  if (!some(probe, (node) => node.type === 'Parent')) return probe
  return {base: {type: 'This'}, expr: probe, type: 'Projection'}
}

function noteComparison(node: OpCallNode, scope: Scope, found: Collected): void {
  const left = asParameter(node.left)
  const right = asParameter(node.right)
  // Two placeholders say nothing about each other, and two fields involve no placeholder.
  if (Boolean(left) === Boolean(right)) return
  found.comparisons.push({
    counterpart: left ? node.right : node.left,
    name: (left ?? right)!.name,
    op: node.op,
    paramOnLeft: Boolean(left),
    scope,
  })
}

function noteRange(node: InRangeNode, scope: Scope, found: Collected): void {
  for (const bound of [node.left, node.right]) {
    const param = asParameter(bound)
    if (!param) continue
    found.comparisons.push({
      counterpart: node.base,
      name: param.name,
      op: 'range',
      paramOnLeft: true,
      scope,
    })
  }
}

function asParameter(node: ExprNode): ParameterNode | undefined {
  if (node.type === 'Group') return asParameter(node.base)
  return node.type === 'Parameter' ? node : undefined
}

function resolve(
  {counterpart, op, paramOnLeft, scope}: Comparison,
  schema: SchemaType,
): TypeNode | undefined {
  if (op === 'match') return {type: 'string'}
  const expr = unwrapGroups(counterpart)
  const probed = probe(scope, expr, schema)
  if (!probed) return undefined
  // A comparison with a literal, as in `$role == "admin"`, is about a value of that primitive.
  const type = expr.type === 'Value' ? widen(probed) : withoutNull(probed)
  // An attribute the schema does not have evaluates to null, which says nothing about the value.
  if (type.type === 'null' && expr.type !== 'Value') return undefined
  if (op !== 'in') return type
  return paramOnLeft ? withoutNull(elementOf(type)) : {of: type, type: 'array'}
}

/** Evaluates `expr` in `scope`, or `undefined` when the probe cannot be typed. */
function probe(scope: Scope, expr: ExprNode, schema: SchemaType): TypeNode | undefined {
  let evaluated: TypeNode
  try {
    evaluated = typeEvaluate(scope.wrap(expr) as GroqExprNode, schema)
  } catch {
    return undefined
  }
  const types = dig(evaluated, scope.depth)
  return types.length > 0 ? union(types) : undefined
}

/** Reads the probe attribute `depth` levels down, through the arrays and unions on the way. */
function dig(type: TypeNode, depth: number): TypeNode[] {
  if (depth === 0) return [type]
  switch (type.type) {
    case 'array': {
      return dig(type.of, depth)
    }
    case 'boolean':
    case 'inline':
    case 'null':
    case 'number':
    case 'string': {
      return []
    }
    case 'object': {
      const attribute = type.attributes[PROBE]
      return attribute ? dig(attribute.value, depth - 1) : []
    }
    case 'union': {
      return type.of.flatMap((member) => dig(member, depth))
    }
    case 'unknown': {
      return [type]
    }
    default: {
      const exhaustive: never = type
      throw new Error(`Unexpected type node ${JSON.stringify(exhaustive)}`)
    }
  }
}

/** One type per parameter: the union of what its comparisons say, or `unknown` if nothing does. */
function combine(types: TypeNode[]): TypeNode {
  const known = types.flatMap((type) => members(type)).filter((type) => type.type !== 'unknown')
  return known.length > 0 ? union(known) : UNKNOWN
}

function members(type: TypeNode): TypeNode[] {
  return type.type === 'union' ? type.of.flatMap((member) => members(member)) : [type]
}

function union(types: TypeNode[]): TypeNode {
  const unique = new Map<string, TypeNode>()
  for (const type of types.flatMap((member) => members(member))) {
    unique.set(JSON.stringify(type), type)
  }
  const of = [...unique.values()]
  return of.length === 1 ? of[0]! : {of, type: 'union'}
}

function withoutNull(type: TypeNode): TypeNode {
  const of = members(type).filter((member) => member.type !== 'null')
  return of.length > 0 ? union(of) : type
}

function elementOf(type: TypeNode): TypeNode {
  return union(members(type).map((member) => (member.type === 'array' ? member.of : member)))
}

function widen(type: TypeNode): TypeNode {
  return union(
    members(type).map((member) =>
      member.type === 'string' || member.type === 'number' || member.type === 'boolean'
        ? {type: member.type}
        : member,
    ),
  )
}

function unwrapGroups(node: ExprNode): ExprNode {
  return node.type === 'Group' ? unwrapGroups(node.base) : node
}

function some(node: ExprNode, predicate: (node: ExprNode) => boolean): boolean {
  return predicate(node) || children(node).some((child) => some(child, predicate))
}

function children(node: ExprNode): ExprNode[] {
  switch (node.type) {
    case 'AccessAttribute': {
      return node.base ? [node.base] : []
    }
    case 'AccessElement':
    case 'ArrayCoerce':
    case 'Asc':
    case 'Deref':
    case 'Desc':
    case 'Group':
    case 'Neg':
    case 'Not':
    case 'Pos':
    case 'Slice': {
      return [node.base]
    }
    case 'And':
    case 'OpCall':
    case 'Or': {
      return [node.left, node.right]
    }
    case 'Array': {
      return node.elements.map((element) => element.value)
    }
    case 'Context':
    case 'Everything':
    case 'Parameter':
    case 'Parent':
    case 'This':
    case 'Value': {
      return []
    }
    case 'Filter':
    case 'FlatMap':
    case 'Map':
    case 'Projection': {
      return [node.base, node.expr]
    }
    case 'FuncCall': {
      return node.args
    }
    case 'InRange': {
      return [node.base, node.left, node.right]
    }
    case 'Object': {
      return node.attributes.flatMap((attribute) =>
        attribute.type === 'ObjectConditionalSplat'
          ? [attribute.condition, attribute.value]
          : [attribute.value],
      )
    }
    case 'PipeFuncCall': {
      return [node.base, ...node.args]
    }
    case 'Select': {
      return [
        ...node.alternatives.flatMap((alternative) => [alternative.condition, alternative.value]),
        ...(node.fallback ? [node.fallback] : []),
      ]
    }
    case 'SelectorFuncCall': {
      return [node.arg]
    }
    case 'SelectorNested': {
      return [node.base, node.nested]
    }
    case 'Tuple': {
      return node.members
    }
    default: {
      const exhaustive: never = node
      throw new Error(`Unexpected GROQ node ${JSON.stringify(exhaustive)}`)
    }
  }
}
