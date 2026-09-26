/** Tree-sitter query sources per grammar variant. */

export const TS_AST_QUERY_SOURCE = `
(import_statement
  source: (string (string_fragment) @import.spec)
) @import.stmt

(export_statement) @export.stmt

(class_declaration
  name: (type_identifier) @symbol.name
) @symbol.class

(function_declaration
  name: (identifier) @symbol.name
) @symbol.function

(interface_declaration
  name: (type_identifier) @symbol.name
) @symbol.interface

(call_expression
  function: (identifier) @call.callee
) @call.stmt

(call_expression
  function: (member_expression
    object: (identifier) @call.receiver
    property: (property_identifier) @call.member
  )
) @call.member

(class_declaration
  name: (type_identifier) @impl.class
  (class_heritage
    (implements_clause
      (type_identifier) @impl.iface
    )
  )
) @impl.stmt
`;

export const PYTHON_AST_QUERY_SOURCE = `
(import_from_statement
  module_name: (dotted_name) @import.spec
) @import.stmt

(import_statement
  name: (dotted_name) @import.spec
) @import.stmt

(class_definition
  name: (identifier) @symbol.name
) @symbol.class

(function_definition
  name: (identifier) @symbol.name
) @symbol.function

(call
  function: (identifier) @call.callee
) @call.stmt

(call
  function: (attribute
    object: (identifier) @call.receiver
    attribute: (identifier) @call.member
  )
) @call.member
`;

export const GO_AST_QUERY_SOURCE = `
(import_declaration
  (import_spec
    path: (interpreted_string_literal) @import.spec
  )
) @import.stmt

(function_declaration
  name: (identifier) @symbol.name
) @symbol.function

(method_declaration
  name: (field_identifier) @symbol.name
) @symbol.function

(type_declaration
  (type_spec
    name: (type_identifier) @symbol.name
  )
) @symbol.class

(call_expression
  function: (identifier) @call.callee
) @call.stmt

(call_expression
  function: (selector_expression
    operand: (identifier) @call.receiver
    field: (field_identifier) @call.member
  )
) @call.member
`;

/**
 * Swift notes:
 * - `class_declaration` covers `class` / `struct` / `enum` / `actor`, but the
 *   `name:` field of an `extension` is a `user_type`, not a `type_identifier`.
 *   The symbol pattern therefore matches `type_identifier` only (an extension
 *   declares no new type), while the `impl` pattern uses `(_)` so that
 *   `extension Point: Equatable {}` — where Swift usually adds conformances —
 *   still contributes relationships.
 * - `import struct MyLib.Point` matches `(identifier)` once; matching the inner
 *   `simple_identifier` would yield one match per path component.
 * - `self.foo()` has a `self_expression` target, so it needs its own pattern.
 * - `protocol Sub: Base` refines a protocol exactly like a type conforms to one,
 *   and the grammar models both as `inheritance_specifier`, so the `impl`
 *   pattern is written per declaration kind.
 */
export const SWIFT_AST_QUERY_SOURCE = `
(import_declaration
  (identifier) @import.spec
) @import.stmt

(class_declaration
  name: (type_identifier) @symbol.name
) @symbol.class

(protocol_declaration
  name: (type_identifier) @symbol.name
) @symbol.interface

(function_declaration
  name: (simple_identifier) @symbol.name
) @symbol.function

(protocol_function_declaration
  name: (simple_identifier) @symbol.name
) @symbol.function

(call_expression
  (simple_identifier) @call.callee
) @call.stmt

(call_expression
  (navigation_expression
    target: (simple_identifier) @call.receiver
    suffix: (navigation_suffix
      suffix: (simple_identifier) @call.member
    )
  )
) @call.member

(call_expression
  (navigation_expression
    target: (self_expression)
    suffix: (navigation_suffix
      suffix: (simple_identifier) @call.member
    )
  )
) @call.member

(class_declaration
  name: (_) @impl.class
  (inheritance_specifier
    inherits_from: (user_type (type_identifier) @impl.iface)
  )
) @impl.stmt

(protocol_declaration
  name: (_) @impl.class
  (inheritance_specifier
    inherits_from: (user_type (type_identifier) @impl.iface)
  )
) @impl.stmt
`;
