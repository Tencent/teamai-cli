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
