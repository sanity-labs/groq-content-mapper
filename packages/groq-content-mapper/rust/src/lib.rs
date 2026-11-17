//! What `@sanity-labs/groq-content-mapper` asks of GROQ's Rust parser, over wasm-bindgen. Each entry returns JSON; offsets in it are UTF-16 code units into the input,
//! which is what JavaScript strings index by.

use groq_parser::ast::{Expr, FunctionDefinition, Token};
use groq_parser::parser::{ParseError, Parser, ParserConfig};
use groq_parser::tokenizer::Tokenizer;
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[derive(Serialize)]
struct Problem {
    message: String,
    start: usize,
    end: usize,
    /// The rejected definition's `namespace::name`, when its header could be read.
    name: Option<String>,
}

/// A `fn namespace::name($param) = …;` definition in a functions file.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Definition {
    namespace: String,
    name: String,
    parameters: Vec<String>,
    /// Where the definition stands in the file, `fn` through `;`.
    start: usize,
    end: usize,
    /// The functions its body calls, as `namespace::name`, in order and each once.
    calls: Vec<String>,
}

#[derive(Serialize)]
struct Definitions {
    definitions: Vec<Definition>,
    /// The definitions that do not parse, each with where in the file.
    problems: Vec<Problem>,
}

#[derive(Serialize)]
struct Calls {
    /// The functions the query defines itself, as `namespace::name`.
    defines: Vec<String>,
    /// The functions the query and its own definitions call, as `namespace::name`, each once.
    calls: Vec<String>,
}

/// The definitions in a functions file, which holds nothing else. Each is parsed on its own,
/// so a definition with a syntax error is reported without hiding the others.
#[wasm_bindgen]
pub fn definitions(source: &str) -> String {
    let mut out = Definitions {
        definitions: Vec::new(),
        problems: Vec::new(),
    };
    for span in split(source) {
        let span = match span {
            Ok(span) => span,
            Err(problem) => {
                out.problems.push(problem.utf16(source));
                break;
            }
        };
        let text = &source[span.start..span.end];
        match parse(&format!("{text}\nnull")) {
            Ok(result) => {
                let Some(definition) = result.functions.first() else {
                    continue;
                };
                out.definitions
                    .push(describe(definition, span, source));
            }
            Err(error) => {
                let (message, position) = parts(error);
                // An error past the text is in the `null` the parse appends.
                let at = position.start.min(text.len());
                let to = position.end.min(text.len()).max(at);
                out.problems.push(
                    ByteProblem {
                        message,
                        start: span.start + at,
                        end: span.start + to,
                        name: header(text),
                    }
                    .utf16(source),
                );
            }
        }
    }
    serde_json::to_string(&out).expect("the result serializes")
}

/// What a query defines and calls. A query that does not parse gives `null`: the error is for
/// the consumer's own parse of it, and nothing is prepended to a query that is not valid.
#[wasm_bindgen]
pub fn calls(query: &str) -> String {
    let Ok(result) = parse(query) else {
        return "null".to_string();
    };
    let mut calls = Vec::new();
    for function in &result.functions {
        collect_calls(&function.body, &mut calls);
    }
    collect_calls(&result.expr, &mut calls);
    let out = Calls {
        defines: result.functions.iter().map(|f| id(&f.id.namespace, &f.id.name)).collect(),
        calls,
    };
    serde_json::to_string(&out).expect("the result serializes")
}

/// The query with its comments and whitespace removed, and with a trailing comma dropped where
/// GROQ allows the query without it: an object, a projection, an array, or a function argument
/// list. What remains is its tokens, with a space only where two would otherwise run together,
/// as in `title match` or `publishedAt desc`. Strings keep their text. Tokens are all it needs,
/// so a fragment, or a query that does not parse, minimizes too.
#[wasm_bindgen]
pub fn minimize(query: &str) -> String {
    let tokens = significant_tokens(query);
    let mut out = String::with_capacity(query.len());
    let mut frames = Vec::new();
    let mut after_expr = false;
    let mut index = 0;
    while index < tokens.len() {
        let (token, literal) = tokens[index];
        if token == Token::Comma && trailing_comma(&tokens, index, &frames, after_expr) {
            index += 1;
            continue;
        }
        if let (Some(last), Some(first)) = (out.chars().last(), literal.chars().next()) {
            if joins(last, first) {
                out.push(' ');
            }
        }
        out.push_str(literal);
        step(&tokens, index, token, &mut frames, &mut after_expr);
        index += 1;
    }
    out
}

/// A `{`, `[` or `(` and whether a comma immediately before its closer is optional.
struct Frame {
    closer: Token,
    trailing_comma: bool,
}

fn significant_tokens(query: &str) -> Vec<(Token, &str)> {
    let mut tokenizer = Tokenizer::new(query);
    let mut tokens = Vec::new();
    loop {
        let (token, literal, _) = tokenizer.scan();
        match token {
            Token::EOF => return tokens,
            Token::Whitespace | Token::Comment => continue,
            _ => tokens.push((token, literal)),
        }
    }
}

/// A comma with an item before it and the closer of a list that allows a trailing comma after it.
/// A filter, subscript, slice, tuple, group or function parameter list does not: GROQ rejects
/// the query with that comma, so it stays.
fn trailing_comma(
    tokens: &[(Token, &str)],
    index: usize,
    frames: &[Frame],
    after_expr: bool,
) -> bool {
    if !after_expr {
        return false;
    }
    let Some(frame) = frames.last() else {
        return false;
    };
    frame.trailing_comma
        && tokens
            .get(index + 1)
            .is_some_and(|(token, _)| *token == frame.closer)
}

fn step(
    tokens: &[(Token, &str)],
    index: usize,
    token: Token,
    frames: &mut Vec<Frame>,
    after_expr: &mut bool,
) {
    match token {
        // An object and a projection are the same braces, and both allow a trailing comma.
        Token::BraceLeft => {
            frames.push(Frame {
                closer: Token::BraceRight,
                trailing_comma: true,
            });
            *after_expr = false;
        }
        // `[` after a value is a filter, element, slice or attribute. At the start of a value
        // it is an array, which allows a trailing comma.
        Token::BracketLeft => {
            let trailing_comma = !*after_expr;
            frames.push(Frame {
                closer: Token::BracketRight,
                trailing_comma,
            });
            *after_expr = false;
        }
        // `(` after a name is a call. After `fn namespace::name` it is the parameter list,
        // which takes one parameter and no trailing comma, same as a group or a tuple.
        Token::ParenLeft => {
            let trailing_comma = is_argument_list(tokens, index, *after_expr);
            frames.push(Frame {
                closer: Token::ParenRight,
                trailing_comma,
            });
            *after_expr = false;
        }
        Token::BraceRight | Token::BracketRight | Token::ParenRight => {
            if frames.last().is_some_and(|frame| frame.closer == token) {
                frames.pop();
            }
            *after_expr = true;
        }
        Token::Comma => *after_expr = false,
        // `*` begins `*[…]`. Between two values it is multiplication.
        Token::Asterisk => *after_expr = !*after_expr,
        // `...foo` and `a...b` still expect a value. `{...}` is the value.
        Token::DotDotDot => {
            let next = tokens.get(index + 1).map(|(next, _)| *next);
            *after_expr = !next.is_some_and(starts_expression);
        }
        Token::Name
        | Token::Bool
        | Token::Null
        | Token::Integer
        | Token::Float
        | Token::String
        | Token::At
        | Token::Hat
        | Token::AscOperator
        | Token::DescOperator
        | Token::Arrow => *after_expr = true,
        _ => *after_expr = false,
    }
}

/// `fn namespace::name(…)`, the parameter list, not a call of that name.
fn is_parameter_list(tokens: &[(Token, &str)], end: usize) -> bool {
    if end < 4 {
        return false;
    }
    matches!(
        &tokens[end - 4..end],
        [
            (Token::Name, "fn"),
            (Token::Name, _),
            (Token::DoubleColon, _),
            (Token::Name, _)
        ]
    )
}

fn is_argument_list(tokens: &[(Token, &str)], end: usize, after_expr: bool) -> bool {
    after_expr && end > 0 && tokens[end - 1].0 == Token::Name && !is_parameter_list(tokens, end)
}

fn starts_expression(token: Token) -> bool {
    matches!(
        token,
        Token::Name
            | Token::Bool
            | Token::Null
            | Token::Integer
            | Token::Float
            | Token::String
            | Token::Asterisk
            | Token::At
            | Token::Hat
            | Token::Not
            | Token::Plus
            | Token::Minus
            | Token::DotDotDot
            | Token::ParenLeft
            | Token::BracketLeft
            | Token::BraceLeft
    )
}

/// The query as groq-format prints it, wrapped to `width` columns, comments kept. A query that
/// does not parse, or holds nothing, gives `undefined`.
#[wasm_bindgen]
pub fn format(query: &str, width: usize) -> Option<String> {
    groq_format::format_query(query, width).ok()
}

/// Whether two tokens whose adjoining characters are these would lex differently when joined:
/// two words, two runs of dots, or a pair the tokenizer reads as one operator or a comment.
fn joins(last: char, first: char) -> bool {
    let word = |ch: char| ch.is_ascii_alphanumeric() || ch == '_' || ch == '$';
    (word(last) && word(first))
        || (last == '.' && first == '.')
        || matches!(
            (last, first),
            ('=', '=')
                | ('|', '|')
                | ('&', '&')
                | ('<', '=')
                | ('>', '=')
                | ('=', '>')
                | ('!', '=')
                | ('-', '>')
                | ('*', '*')
                | ('/', '/')
        )
}

fn parse(text: &str) -> Result<groq_parser::ParseResult, ParseError> {
    Parser::new_with_config(text, ParserConfig::without_param_validation()).parse()
}

fn describe(definition: &FunctionDefinition, span: ByteSpan, source: &str) -> Definition {
    let mut calls = Vec::new();
    collect_calls(&definition.body, &mut calls);
    Definition {
        namespace: definition.id.namespace.clone(),
        name: definition.id.name.clone(),
        parameters: definition.parameters.iter().map(|p| p.name.clone()).collect(),
        start: utf16(source, span.start),
        end: utf16(source, span.end),
        calls,
    }
}

fn id(namespace: &str, name: &str) -> String {
    format!("{namespace}::{name}")
}

fn parts(error: ParseError) -> (String, groq_parser::ast::Position) {
    match error {
        ParseError::Syntax { message, pos } => (message, pos),
        ParseError::ExpressionDepthExceeded {
            max_depth, depth, pos, ..
        } => (
            format!("expression depth {depth} exceeds the maximum of {max_depth}"),
            pos,
        ),
    }
}

/// A span as byte offsets into the input.
#[derive(Clone, Copy)]
struct ByteSpan {
    start: usize,
    end: usize,
}

struct ByteProblem {
    message: String,
    start: usize,
    end: usize,
    name: Option<String>,
}

impl ByteProblem {
    fn utf16(self, source: &str) -> Problem {
        Problem {
            message: self.message,
            start: utf16(source, self.start),
            end: utf16(source, self.end),
            name: self.name,
        }
    }
}

fn utf16(source: &str, byte: usize) -> usize {
    source[..byte.min(source.len())].encode_utf16().count()
}

/// Each definition's span, `fn` through its `;`. GROQ has no other use for a `;`, so outside a
/// string or comment one always ends a definition. The last item is an error where the file
/// holds something that is not a definition.
fn split(source: &str) -> Vec<Result<ByteSpan, ByteProblem>> {
    let mut spans = Vec::new();
    let mut tokenizer = Tokenizer::new(source);
    let mut start: Option<usize> = None;
    loop {
        let (token, literal, pos) = tokenizer.scan();
        match token {
            Token::Whitespace | Token::Comment => continue,
            Token::EOF => {
                if let Some(start) = start {
                    let name = header(&source[start..]);
                    spans.push(Err(ByteProblem {
                        message: format!(
                            "{} has no \";\" to end it",
                            name.as_deref().unwrap_or("the definition")
                        ),
                        start,
                        end: start,
                        name,
                    }));
                }
                return spans;
            }
            _ => {}
        }
        match start {
            None if token == Token::Name && literal == "fn" => start = Some(pos),
            None => {
                spans.push(Err(ByteProblem {
                    message: "expected \"fn namespace::name($param) = …;\"; a functions file holds only function definitions".to_string(),
                    start: pos,
                    end: pos + literal.len(),
                    name: None,
                }));
                return spans;
            }
            Some(from) if token == Token::Semicolon => {
                spans.push(Ok(ByteSpan {
                    start: from,
                    end: pos + literal.len(),
                }));
                start = None;
            }
            Some(_) => {}
        }
    }
}

/// The `namespace::name` a definition's `fn namespace::name` header names, when it has one.
fn header(text: &str) -> Option<String> {
    let mut tokenizer = Tokenizer::new(text);
    let mut tokens = Vec::new();
    while tokens.len() < 4 {
        let (token, literal, _) = tokenizer.scan();
        match token {
            Token::Whitespace | Token::Comment => continue,
            Token::EOF => break,
            _ => tokens.push((token, literal)),
        }
    }
    match tokens.as_slice() {
        [(Token::Name, "fn"), (Token::Name, namespace), (Token::DoubleColon, _), (Token::Name, name)] => {
            Some(id(namespace, name))
        }
        _ => None,
    }
}

/// Every function `expr` calls, as `namespace::name`, in source order and each once.
fn collect_calls(expr: &Expr, out: &mut Vec<String>) {
    let push = |namespace: &str, name: &str, out: &mut Vec<String>| {
        let call = id(namespace, name);
        if !out.contains(&call) {
            out.push(call);
        }
    };
    match expr {
        Expr::Everything(_)
        | Expr::This(_)
        | Expr::Parent(_)
        | Expr::Attribute(_)
        | Expr::Param(_)
        | Expr::Literal(_)
        | Expr::Ellipsis(_) => {}
        Expr::Constraint(node) => collect_calls(&node.expression, out),
        Expr::Object(node) => collect_calls_in(&node.expressions, out),
        Expr::Array(node) => collect_calls_in(&node.expressions, out),
        Expr::Subscript(node) => collect_calls(&node.value, out),
        Expr::Range(node) => {
            collect_calls(&node.start, out);
            collect_calls(&node.end, out);
        }
        Expr::FunctionCall(node) => {
            push(&node.namespace, &node.name, out);
            collect_calls_in(&node.arguments, out);
        }
        Expr::Binary(node) => {
            collect_calls(&node.lhs, out);
            collect_calls(&node.rhs, out);
        }
        Expr::Dot(node) => {
            collect_calls(&node.lhs, out);
            collect_calls(&node.rhs, out);
        }
        Expr::ArrayTraversal(node) => collect_calls(&node.expr, out),
        Expr::Group(node) => collect_calls(&node.expression, out),
        Expr::Tuple(node) => collect_calls_in(&node.members, out),
        Expr::Pipe(node) => {
            collect_calls(&node.lhs, out);
            collect_calls(&node.rhs, out);
        }
        Expr::Prefix(node) => collect_calls(&node.rhs, out),
        Expr::Postfix(node) => collect_calls(&node.lhs, out),
        Expr::Projection(node) => {
            collect_calls(&node.lhs, out);
            collect_calls_in(&node.object.expressions, out);
        }
        Expr::FunctionPipe(node) => {
            collect_calls(&node.lhs, out);
            push(&node.func.namespace, &node.func.name, out);
            collect_calls_in(&node.func.arguments, out);
        }
        Expr::Filter(node) => {
            collect_calls(&node.lhs, out);
            collect_calls(&node.constraint.expression, out);
        }
        Expr::Element(node) => {
            collect_calls(&node.lhs, out);
            collect_calls(&node.idx.value, out);
        }
        Expr::Slice(node) => {
            collect_calls(&node.lhs, out);
            collect_calls(&node.range.value, out);
        }
    }
}

fn collect_calls_in(exprs: &[Expr], out: &mut Vec<String>) {
    for expr in exprs {
        collect_calls(expr, out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_definitions_and_finds_calls() {
        let json = definitions(
            "// shared\nfn author::summary($a) = $a{name};\nfn post::card($p) = $p{title, \"author\": author::summary(author), \"n\": count(tags)};\n",
        );
        let out: serde_json::Value = serde_json::from_str(&json).unwrap();
        let defs = out["definitions"].as_array().unwrap();
        assert_eq!(defs.len(), 2);
        assert_eq!(defs[1]["name"], "card");
        assert_eq!(defs[1]["calls"][0], "author::summary");
        assert_eq!(defs[1]["calls"][1], "::count");
        assert!(out["problems"].as_array().unwrap().is_empty());
    }

    #[test]
    fn reports_each_bad_definition() {
        let json = definitions("fn a::b($x) = $x{;\nfn c::d($y) = $y{name};\n*[]");
        let out: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(out["definitions"].as_array().unwrap().len(), 1);
        let problems = out["problems"].as_array().unwrap();
        assert_eq!(problems.len(), 2);
        assert_eq!(problems[0]["name"], "a::b");
        assert_eq!(problems[1]["name"], serde_json::Value::Null);
    }

    #[test]
    fn minimizes_to_the_same_query() {
        let query = "fn post::card($p) = $p{title, \"n\": count(tags)};\n*[_type == \"post\" && title match $q && !(hidden == true)] | order(publishedAt desc) [0...$limit] {\n  ..., // all\n  \"card\": post::card(@), \"x\": 1 - -2, \"y\": a .. b, \"s\": 'it\\'s \"ok\"', \"d\": ^.^._id, body[] { _type == 'image' => { asset-> { url } } }\n}\n";
        let minimized = minimize(query);
        assert_eq!(
            minimized,
            "fn post::card($p)=$p{title,\"n\":count(tags)};*[_type==\"post\"&&title match $q&&!(hidden==true)]|order(publishedAt desc)[0...$limit]{...,\"card\":post::card(@),\"x\":1--2,\"y\":a..b,\"s\":'it\\'s \"ok\"',\"d\":^.^._id,body[]{_type=='image'=>{asset->{url}}}}"
        );
        let uncommented = query.replace("// all", "");
        assert_eq!(
            groq_format::format_query(&minimized, 80).unwrap(),
            groq_format::format_query(&uncommented, 80).unwrap()
        );
        assert_eq!(minimize("* [ \n // open\n"), "*[");
    }

    #[test]
    fn drops_a_trailing_comma_before_a_projection_closes() {
        assert_eq!(
            minimize(
                "*[_type == \"page\" && slug.current == $slug][0]{\n  title,\n  \"slug\": slug.current,\n}"
            ),
            "*[_type==\"page\"&&slug.current==$slug][0]{title,\"slug\":slug.current}"
        );
        // A comment between the comma and the brace is dropped with the comma.
        assert_eq!(minimize("{title, // note\n}"), "{title}");
        assert_eq!(
            minimize("*[_type == \"post\"] | order(publishedAt desc) {title,}"),
            "*[_type==\"post\"]|order(publishedAt desc){title}"
        );
    }

    #[test]
    fn drops_trailing_commas_groq_allows_without() {
        assert_eq!(minimize("{a, b,}"), "{a,b}");
        assert_eq!(minimize("{a, {b,}, [1,], f(2,),}"), "{a,{b},[1],f(2)}");
        assert_eq!(minimize("[1, 2,]"), "[1,2]");
        assert_eq!(minimize("[...[1, 2,],]"), "[...[1,2]]");
        assert_eq!(minimize("count(tags,)"), "count(tags)");
        assert_eq!(minimize("count (tags,)"), "count(tags)");
        assert_eq!(minimize("image::asset(asset,)"), "image::asset(asset)");
        assert_eq!(minimize("select(a => 1, b => 2,)"), "select(a=>1,b=>2)");
        assert_eq!(
            minimize("* | order(publishedAt desc, _id asc,)"),
            "*|order(publishedAt desc,_id asc)"
        );
        assert_eq!(minimize("{...,}"), "{...}");
        assert_eq!(minimize("{...foo,}"), "{...foo}");
        assert_eq!(
            minimize("fn image::field($image) = $image{crop, hotspot,}"),
            "fn image::field($image)=$image{crop,hotspot}"
        );
        assert_eq!(
            minimize("*[_type == \"post\" && tags in [\"a\", \"b\",]]"),
            "*[_type==\"post\"&&tags in[\"a\",\"b\"]]"
        );
        let slug = "fn image::asset($asset)=$asset->{url,metadata{lqip,dimensions}};fn image::field($image)=$image{crop,hotspot,\"asset\":image::asset(asset)};fn image::richText($blocks)=$blocks[]{...,_type==\"image\"=>{_key,_type,alt,caption,crop,hotspot,\"asset\":image::asset(asset)},_type==\"timeline\"=>{...,items[]{...,milestones[]{...,\"image\":image::field(image)}}}};*[_type==\"page\"&&slug.current==$slug][0]{_id,_type,\"body\":image::richText(body),overview,title,\"slug\":slug.current,}";
        assert_eq!(
            minimize(slug),
            slug.replace("slug.current,}", "slug.current}")
        );
    }

    #[test]
    fn keeps_a_comma_groq_does_not_allow_without_the_rest() {
        // A separator stays. So does a comma GROQ does not treat as optional: a tuple, a filter,
        // a subscript, a slice, or a function parameter list. `{,}` and a doubled comma have no
        // item before them, so they stay too.
        assert_eq!(minimize("{a, b}"), "{a,b}");
        assert_eq!(minimize("(1, 2,)"), "(1,2,)");
        assert_eq!(minimize("*[_type == \"post\",]"), "*[_type==\"post\",]");
        assert_eq!(minimize("tags[0,]"), "tags[0,]");
        assert_eq!(minimize("tags[0...2,]"), "tags[0...2,]");
        assert_eq!(minimize("fn ns::f($x,) = $x;"), "fn ns::f($x,)=$x;");
        assert_eq!(minimize("{,}"), "{,}");
        assert_eq!(minimize("[1,,]"), "[1,,]");
        assert_eq!(minimize("\"a,b,\""), "\"a,b,\"");
        assert_eq!(minimize("* [ \n // open\n"), "*[");
    }

    #[test]
    fn formats_to_the_width() {
        let query = "fn post::card($p) = $p{title, \"n\": count(tags)};\n// Posts\n*[_type == \"post\"]{title, \"card\": post::card(@), slug, publishedAt, body, author}\n";
        let wide = format(query, 200).unwrap();
        let narrow = format(query, 40).unwrap();
        assert!(wide.contains("// Posts"));
        assert!(wide.lines().count() < narrow.lines().count());
        assert!(narrow.lines().all(|line| line.len() <= 40));
        assert_eq!(format("*[", 80), None);
        assert_eq!(format("  \n", 80), None);
    }

    #[test]
    fn query_calls() {
        let json = calls("fn q::own($x) = $x{a}; *[_type == \"post\"]{\"c\": post::card(@), \"o\": q::own(@)} | order(x)");
        let out: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(out["defines"][0], "q::own");
        assert_eq!(out["calls"][0], "post::card");
        assert_eq!(calls("*["), "null");
    }
}
