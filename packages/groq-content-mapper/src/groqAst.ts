/**
 * The GROQ AST that `parse` from groq-js returns. The shapes here mirror groq-js's
 * `src/shared/nodeTypes.ts` so the walkers in this directory can narrow on `type` exhaustively.
 * They are not assignable to groq-js's own `ExprNode`, so an AST is cast where it crosses into
 * or out of groq-js.
 */

export type OpCall =
  | '!='
  | '%'
  | '*'
  | '**'
  | '+'
  | '-'
  | '/'
  | '<'
  | '<='
  | '=='
  | '>'
  | '>='
  | 'in'
  | 'match'

export type ExprNode =
  | AccessAttributeNode
  | AccessElementNode
  | AndNode
  | ArrayCoerceNode
  | ArrayNode
  | AscNode
  | ContextNode
  | DerefNode
  | DescNode
  | EverythingNode
  | FilterNode
  | FlatMapNode
  | FuncCallNode
  | GroupNode
  | InRangeNode
  | MapNode
  | NegNode
  | NotNode
  | ObjectNode
  | OpCallNode
  | OrNode
  | ParameterNode
  | ParentNode
  | PipeFuncCallNode
  | PosNode
  | ProjectionNode
  | SelectNode
  | SelectorFuncCallNode
  | SelectorNestedNode
  | SliceNode
  | ThisNode
  | TupleNode
  | ValueNode

type ObjectAttributeNode = ObjectAttributeValueNode | ObjectConditionalSplatNode | ObjectSplatNode

interface AccessAttributeNode {
  name: string
  type: 'AccessAttribute'

  base?: ExprNode
}

interface AccessElementNode {
  base: ExprNode
  index: number
  type: 'AccessElement'
}

interface AndNode {
  left: ExprNode
  right: ExprNode
  type: 'And'
}

interface ArrayCoerceNode {
  base: ExprNode
  type: 'ArrayCoerce'
}

interface ArrayElementNode {
  isSplat: boolean
  type: 'ArrayElement'
  value: ExprNode
}

interface ArrayNode {
  elements: ArrayElementNode[]
  type: 'Array'
}

interface AscNode {
  base: ExprNode
  type: 'Asc'
}

interface ContextNode {
  key: string
  type: 'Context'
}

interface DerefNode {
  base: ExprNode
  type: 'Deref'
}

interface DescNode {
  base: ExprNode
  type: 'Desc'
}

interface EverythingNode {
  type: 'Everything'
}

interface FilterNode {
  base: ExprNode
  expr: ExprNode
  type: 'Filter'
}

interface FlatMapNode {
  base: ExprNode
  expr: ExprNode
  type: 'FlatMap'
}

interface FuncCallNode {
  args: ExprNode[]
  name: string
  namespace: string
  type: 'FuncCall'
}

interface GroupNode {
  base: ExprNode
  type: 'Group'
}

export interface InRangeNode {
  base: ExprNode
  isInclusive: boolean
  left: ExprNode
  right: ExprNode
  type: 'InRange'
}

interface MapNode {
  base: ExprNode
  expr: ExprNode
  type: 'Map'
}

interface NegNode {
  base: ExprNode
  type: 'Neg'
}

interface NotNode {
  base: ExprNode
  type: 'Not'
}

interface ObjectAttributeValueNode {
  name: string
  type: 'ObjectAttributeValue'
  value: ExprNode
}

interface ObjectConditionalSplatNode {
  condition: ExprNode
  type: 'ObjectConditionalSplat'
  value: ExprNode
}

export interface ObjectNode {
  attributes: ObjectAttributeNode[]
  type: 'Object'
}

interface ObjectSplatNode {
  type: 'ObjectSplat'
  value: ExprNode
}

export interface OpCallNode {
  left: ExprNode
  op: OpCall
  right: ExprNode
  type: 'OpCall'
}

interface OrNode {
  left: ExprNode
  right: ExprNode
  type: 'Or'
}

export interface ParameterNode {
  name: string
  type: 'Parameter'
}

interface ParentNode {
  n: number
  type: 'Parent'
}

interface PipeFuncCallNode {
  args: ExprNode[]
  base: ExprNode
  name: string
  type: 'PipeFuncCall'
}

interface PosNode {
  base: ExprNode
  type: 'Pos'
}

interface ProjectionNode {
  base: ExprNode
  expr: ExprNode
  type: 'Projection'
}

interface SelectAlternativeNode {
  condition: ExprNode
  type: 'SelectAlternative'
  value: ExprNode
}

interface SelectNode {
  alternatives: SelectAlternativeNode[]
  type: 'Select'

  fallback?: ExprNode
}

interface SelectorFuncCallNode {
  arg: ExprNode
  name: 'anywhere'
  type: 'SelectorFuncCall'
}

interface SelectorNestedNode {
  base: ExprNode
  nested: ExprNode
  type: 'SelectorNested'
}

/** `left` and `right` are numbers: groq-js only parses a slice once both bounds are constants. */
interface SliceNode {
  base: ExprNode
  isInclusive: boolean
  left: number
  right: number
  type: 'Slice'
}

interface ThisNode {
  type: 'This'
}

interface TupleNode {
  members: ExprNode[]
  type: 'Tuple'
}

interface ValueNode {
  type: 'Value'
  value: unknown
}
