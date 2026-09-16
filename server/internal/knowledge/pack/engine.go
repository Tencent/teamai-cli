package pack

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"regexp"
	"strings"
)

var (
	ErrAccessDenied   = errors.New("access denied")
	ErrObjectNotFound = errors.New("object version is not included in this package")
	ErrInvalidQuery   = errors.New("invalid query")
)

// Authorizer is an adapter boundary, not an identity or authorization service.
// The host supplies the current opaque subject and checks each source policy on
// every operation. Implementations must not cache a previous allow indefinitely.
type Authorizer interface {
	CheckSource(context.Context, any, string) error
}

type AuthorizerFunc func(context.Context, any, string) error

func (f AuthorizerFunc) CheckSource(ctx context.Context, subject any, policyRef string) error {
	return f(ctx, subject, policyRef)
}

// Engine owns an immutable snapshot. All lookups stay in that snapshot and use
// complete object references; no query resolves defaults or a latest version.
type Engine struct {
	payload    Payload
	authorizer Authorizer
	objects    map[ObjectRef]Object
	evidence   map[string]Evidence
	adjacency  map[ObjectRef][]int
}

func NewEngine(payload Payload, authorizer Authorizer) (*Engine, error) {
	if err := ValidatePayload(payload); err != nil {
		return nil, err
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	if len(data) > MaxPackBytes {
		return nil, errors.New("payload exceeds package size limit")
	}
	var snapshot Payload
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return nil, err
	}
	engine := &Engine{payload: snapshot, authorizer: authorizer, objects: make(map[ObjectRef]Object), evidence: make(map[string]Evidence), adjacency: make(map[ObjectRef][]int)}
	for _, object := range snapshot.Objects {
		engine.objects[object.Ref()] = object
	}
	for _, evidence := range snapshot.Evidence {
		engine.evidence[evidence.EvidenceID] = evidence
	}
	for i, relation := range snapshot.Relations {
		engine.adjacency[relation.From] = append(engine.adjacency[relation.From], i)
		if relation.To != relation.From {
			engine.adjacency[relation.To] = append(engine.adjacency[relation.To], i)
		}
	}
	return engine, nil
}

func (e *Engine) authorize(ctx context.Context, subject any) error {
	if e == nil || e.authorizer == nil {
		return ErrAccessDenied
	}
	value := reflect.ValueOf(e.authorizer)
	switch value.Kind() {
	case reflect.Pointer, reflect.Func, reflect.Interface, reflect.Map, reflect.Slice, reflect.Chan:
		if value.IsNil() {
			return ErrAccessDenied
		}
	}
	denied := ctx.Err() != nil
	for _, policyRef := range e.payload.SourcePolicyRefs {
		if e.authorizer.CheckSource(ctx, subject, policyRef) != nil {
			denied = true
		}
	}
	if denied || ctx.Err() != nil {
		return ErrAccessDenied
	}
	return nil
}

func cloneObject(object Object) Object {
	object.EvidenceRefs = append([]string{}, object.EvidenceRefs...)
	return object
}
func cloneRelation(relation Relation) Relation {
	relation.EvidenceRefs = append([]string{}, relation.EvidenceRefs...)
	return relation
}
func cloneEvidence(evidence Evidence) Evidence {
	if evidence.TimeStartMS != nil {
		value := *evidence.TimeStartMS
		evidence.TimeStartMS = &value
	}
	if evidence.TimeEndMS != nil {
		value := *evidence.TimeEndMS
		evidence.TimeEndMS = &value
	}
	return evidence
}

type SearchResult struct {
	State     string   `json:"state"`
	Objects   []Object `json:"objects"`
	Truncated bool     `json:"truncated"`
}

var searchTokens = regexp.MustCompile(`[\p{L}\p{N}_]+`)
var asciiWords = regexp.MustCompile(`[a-z0-9_]+`)

// Search requires every keyword, using case-insensitive ASCII word matching and
// substring matching for keywords containing non-ASCII letters (including CJK).
// Results follow package order and are capped at MaxSearchResults.
func (e *Engine) Search(ctx context.Context, subject any, query string) (*SearchResult, error) {
	if err := e.authorize(ctx, subject); err != nil {
		return nil, err
	}
	if len(query) > 4096 {
		return nil, ErrInvalidQuery
	}
	tokens := searchTokens.FindAllString(strings.ToLower(query), -1)
	if len(tokens) == 0 || len(tokens) > 32 {
		return nil, ErrInvalidQuery
	}
	result := &SearchResult{State: "preview", Objects: []Object{}}
	for _, object := range e.payload.Objects {
		text := strings.ToLower(object.ObjectID + "\n" + object.Title + "\n" + object.Content)
		words := make(map[string]bool)
		for _, word := range asciiWords.FindAllString(text, -1) {
			words[word] = true
		}
		matches := true
		for _, token := range tokens {
			ascii := true
			for _, r := range token {
				if r > 127 {
					ascii = false
					break
				}
			}
			if (ascii && !words[token]) || (!ascii && !strings.Contains(text, token)) {
				matches = false
				break
			}
		}
		if !matches {
			continue
		}
		if len(result.Objects) == MaxSearchResults {
			result.Truncated = true
			break
		}
		result.Objects = append(result.Objects, cloneObject(object))
	}
	return result, nil
}

func (e *Engine) GetObject(ctx context.Context, subject any, ref ObjectRef) (*Object, error) {
	if err := e.authorize(ctx, subject); err != nil {
		return nil, err
	}
	if !validRef(ref) {
		return nil, ErrInvalidQuery
	}
	object, exists := e.objects[ref]
	if !exists {
		return nil, ErrObjectNotFound
	}
	copy := cloneObject(object)
	return &copy, nil
}

type Direction string

const (
	Incoming Direction = "incoming"
	Outgoing Direction = "outgoing"
	Both     Direction = "both"
)

func (e *Engine) Relations(ctx context.Context, subject any, ref ObjectRef, direction Direction, relationType string) ([]Relation, error) {
	if err := e.authorize(ctx, subject); err != nil {
		return nil, err
	}
	if !validRef(ref) || (direction != Incoming && direction != Outgoing && direction != Both) ||
		(relationType != "" && !in(relationType, "ABOUT", "HAS_STATEMENT", "SUPPORTS", "CHALLENGES", "ADDRESSES", "SPECIFIES", "IMPLEMENTS", "DEPENDS_ON", "SUPERSEDES")) {
		return nil, ErrInvalidQuery
	}
	if _, exists := e.objects[ref]; !exists {
		return nil, ErrObjectNotFound
	}
	result := []Relation{}
	for _, index := range e.adjacency[ref] {
		relation := e.payload.Relations[index]
		if relationType != "" && relation.Type != relationType {
			continue
		}
		if direction == Incoming && relation.To != ref {
			continue
		}
		if direction == Outgoing && relation.From != ref {
			continue
		}
		result = append(result, cloneRelation(relation))
	}
	return result, nil
}

type TraceOptions struct {
	MaxDepth     int
	MaxNodes     int // Zero selects MaxTraceNodes.
	MaxTextBytes int // Zero selects DefaultTraceTextBytes.
}

type TraceResult struct {
	State             string     `json:"state"`
	Start             ObjectRef  `json:"start"`
	Nodes             []Object   `json:"nodes"`
	Edges             []Relation `json:"edges"`
	Evidence          []Evidence `json:"evidence"`
	TextBytes         int        `json:"text_bytes"`
	Truncated         bool       `json:"truncated"`
	TruncationReasons []string   `json:"truncation_reasons"`
}

// Trace walks both incoming and outgoing relations breadth first. Every returned
// edge has both endpoint versions and all its evidence in the result. Nodes and
// evidence are included atomically, never shortened to fit a text budget.
// TextBytes counts UTF-8 bytes in node titles/content and evidence quotes.
func (e *Engine) Trace(ctx context.Context, subject any, start ObjectRef, options TraceOptions) (*TraceResult, error) {
	if err := e.authorize(ctx, subject); err != nil {
		return nil, err
	}
	if options.MaxNodes == 0 {
		options.MaxNodes = MaxTraceNodes
	}
	if options.MaxTextBytes == 0 {
		options.MaxTextBytes = DefaultTraceTextBytes
	}
	if !validRef(start) || !bounded(options.MaxDepth, 0, MaxTraceDepth) ||
		!bounded(options.MaxNodes, 1, MaxTraceNodes) || !bounded(options.MaxTextBytes, 1, MaxTraceTextBytes) {
		return nil, ErrInvalidQuery
	}
	root, exists := e.objects[start]
	if !exists {
		return nil, ErrObjectNotFound
	}
	result := &TraceResult{State: "preview", Start: start, Nodes: []Object{}, Edges: []Relation{}, Evidence: []Evidence{}, TruncationReasons: []string{}}
	nodes := make(map[ObjectRef]bool)
	edges := make(map[string]bool)
	evidence := make(map[string]bool)
	reasons := make(map[string]bool)
	truncate := func(reason string) {
		result.Truncated = true
		if !reasons[reason] {
			reasons[reason] = true
			result.TruncationReasons = append(result.TruncationReasons, reason)
		}
	}
	addBundle := func(object *Object, relation *Relation) bool {
		cost := 0
		refs := []string{}
		if object != nil {
			cost += len(object.Title) + len(object.Content)
			refs = append(refs, object.EvidenceRefs...)
		}
		if relation != nil {
			refs = append(refs, relation.EvidenceRefs...)
		}
		newEvidence := []string{}
		pending := make(map[string]bool)
		for _, ref := range refs {
			if !evidence[ref] && !pending[ref] {
				pending[ref] = true
				newEvidence = append(newEvidence, ref)
				cost += len(e.evidence[ref].Quote)
			}
		}
		if len(result.Evidence)+len(newEvidence) > MaxTraceEvidence {
			truncate("max_evidence")
			return false
		}
		if result.TextBytes+cost > options.MaxTextBytes {
			truncate("max_text_bytes")
			return false
		}
		if object != nil {
			nodes[object.Ref()] = true
			result.Nodes = append(result.Nodes, cloneObject(*object))
		}
		if relation != nil {
			edges[relation.RelationID] = true
			result.Edges = append(result.Edges, cloneRelation(*relation))
		}
		for _, ref := range newEvidence {
			evidence[ref] = true
			result.Evidence = append(result.Evidence, cloneEvidence(e.evidence[ref]))
		}
		result.TextBytes += cost
		return true
	}
	if !addBundle(&root, nil) {
		return result, nil
	}
	type step struct {
		ref   ObjectRef
		depth int
	}
	queue := []step{{start, 0}}
	for next := 0; next < len(queue); next++ {
		current := queue[next]
		for _, index := range e.adjacency[current.ref] {
			relation := e.payload.Relations[index]
			if edges[relation.RelationID] {
				continue
			}
			if len(result.Edges) >= MaxTraceRelations {
				truncate("max_relations")
				continue
			}
			other := relation.To
			if other == current.ref {
				other = relation.From
			}
			var object *Object
			if !nodes[other] {
				if current.depth >= options.MaxDepth {
					truncate("max_depth")
					continue
				}
				if len(result.Nodes) >= options.MaxNodes {
					truncate("max_nodes")
					continue
				}
				candidate := e.objects[other]
				object = &candidate
			}
			if addBundle(object, &relation) && object != nil {
				queue = append(queue, step{other, current.depth + 1})
			}
		}
	}
	return result, nil
}
