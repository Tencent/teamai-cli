package pack

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func fixture() Payload {
	oldVersion, newVersion := strings.Repeat("a", 40), strings.Repeat("b", 40)
	oldContent := "Old 中文语音 API requirement"
	lines := []string{"Current 中文语音 API request", "Meeting discussion", "Support the current requirement", "Proceed with implementation", "func Speak() {}", "Voice business concept", "Requirements document"}
	content := strings.Join(lines, "\n")
	sources := []SourceSnapshot{
		{SourceID: "requirements", SourceVersion: oldVersion, Path: "requirements.md", Kind: "requirements", Content: oldContent, ContentHash: hash([]byte(oldContent)), PolicyRef: "policy-old"},
		{SourceID: "requirements", SourceVersion: newVersion, Path: "requirements.md", Kind: "requirements", Content: content, ContentHash: hash([]byte(content)), PolicyRef: "policy-current"},
	}
	evidence := []Evidence{{EvidenceID: "e-old", SourceID: "requirements", SourceVersion: oldVersion, SourceHash: sources[0].ContentHash, LineStart: 1, LineEnd: 1, Quote: oldContent}}
	objects := []Object{{ObjectID: "requirement", ObjectVersion: "v1", Type: "RequirementItem", Title: "Old requirement", Content: oldContent, ContentHash: hash([]byte(oldContent)), EvidenceRefs: []string{"e-old"}}}
	ids := []string{"requirement", "meeting", "statement", "decision", "code", "concept", "document"}
	types := []string{"RequirementItem", "Meeting", "Statement", "Decision", "CodeEntity", "BusinessConcept", "SourceDocument"}
	for i, line := range lines {
		evidenceID := fmt.Sprintf("e%d", i+1)
		evidence = append(evidence, Evidence{EvidenceID: evidenceID, SourceID: "requirements", SourceVersion: newVersion, SourceHash: sources[1].ContentHash, LineStart: i + 1, LineEnd: i + 1, Quote: line})
		version := "v1"
		if i == 0 {
			version = "v2"
		}
		objects = append(objects, Object{ObjectID: ids[i], ObjectVersion: version, Type: types[i], Title: ids[i], Content: line, ContentHash: hash([]byte(line)), EvidenceRefs: []string{evidenceID}})
	}
	relations := []Relation{}
	add := func(kind string, from, to int) {
		relations = append(relations, Relation{RelationID: fmt.Sprintf("r%d", len(relations)+1), Type: kind, From: objects[from].Ref(), To: objects[to].Ref(), EvidenceRefs: append([]string{}, objects[from].EvidenceRefs...), Origin: "static_extraction", ReviewState: "candidate", Applicability: "unknown"})
	}
	add("SUPERSEDES", 1, 0)
	add("HAS_STATEMENT", 2, 3)
	add("SUPPORTS", 3, 1)
	add("SUPPORTS", 3, 4)
	add("ADDRESSES", 4, 1)
	add("IMPLEMENTS", 5, 1)
	add("ABOUT", 1, 6)
	add("SPECIFIES", 7, 1)
	return Payload{ProjectID: "project", Status: "preview", Sources: sources, SourcePolicyRefs: []string{"policy-old", "policy-current"}, Objects: objects, Evidence: evidence, Relations: relations, DefaultObjectVersions: map[string]string{"requirement": "v2"}, Coverage: Coverage{Warnings: []string{}}}
}

func rawPayload(t *testing.T, p Payload) []byte {
	t.Helper()
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func envelope(raw []byte) []byte {
	return []byte(fmt.Sprintf(`{"schema_version":%q,"package_hash":%q,"payload":%s}`, SchemaVersion, hash(raw), raw))
}

func TestReadPreservesRawPayloadHash(t *testing.T) {
	for _, indent := range []bool{false, true} {
		p := fixture()
		raw := rawPayload(t, p)
		if indent {
			var formatted bytes.Buffer
			if err := json.Indent(&formatted, raw, "", "  "); err != nil {
				t.Fatal(err)
			}
			raw = formatted.Bytes()
		}
		archive, err := Read(bytes.NewReader(append(envelope(raw), '\n')))
		if err != nil {
			t.Fatal(err)
		}
		if archive.PackageHash != hash(raw) || !reflect.DeepEqual(archive.Payload, p) {
			t.Fatal("payload or original-byte hash changed")
		}
	}
	raw := rawPayload(t, fixture())
	data := bytes.Replace(envelope(raw), []byte(`"payload":{`), []byte("\"payload\":{\n"), 1)
	if _, err := Read(bytes.NewReader(data)); err == nil || !strings.Contains(err.Error(), "hash mismatch") {
		t.Fatalf("changed payload whitespace was accepted: %v", err)
	}
}

func TestReadRejectsAmbiguousOrMalformedJSON(t *testing.T) {
	raw := rawPayload(t, fixture())
	mutate := func(old, replacement string) []byte {
		return envelope(bytes.Replace(raw, []byte(old), []byte(replacement), 1))
	}
	cases := map[string][]byte{
		"unknown envelope field":        bytes.Replace(envelope(raw), []byte(`{"schema_version"`), []byte(`{"extra":true,"schema_version"`), 1),
		"duplicate envelope key":        bytes.Replace(envelope(raw), []byte(`{"schema_version"`), []byte(`{"schema_version":"wrong","schema_version"`), 1),
		"duplicate escaped payload key": mutate(`"project_id":"project"`, `"project_id":"project","project_\u0069d":"project"`),
		"unknown payload field":         mutate(`"project_id":"project"`, `"project_id":"project","reviewed":true`),
		"unknown nested field":          mutate(`"path":"requirements.md"`, `"path":"requirements.md","repo":"extra"`),
		"case variant field":            mutate(`"project_id"`, `"Project_ID"`),
		"null required string":          mutate(`"title":"Old requirement"`, `"title":null`),
		"missing required string":       mutate(`"title":"Old requirement",`, ``),
		"null empty content":            mutate(`"content":"Old 中文语音 API requirement"`, `"content":null`),
		"missing collections":           mutate(`"warnings":[]`, ``),
		"null map":                      mutate(`"default_object_versions":{"requirement":"v2"}`, `"default_object_versions":null`),
		"null array item":               mutate(`"warnings":[]`, `"warnings":[null]`),
		"null optional number":          mutate(`"line_start":1`, `"time_start_ms":null,"line_start":1`),
		"fractional line":               mutate(`"line_start":1`, `"line_start":1.5`),
		"fractional timestamp":          mutate(`"line_start":1`, `"time_start_ms":1.5,"time_end_ms":2,"line_start":1`),
		"string line number":            mutate(`"line_start":1`, `"line_start":"1"`),
		"trailing document":             append(envelope(raw), []byte(" {}")...),
		"trailing garbage":              append(envelope(raw), []byte("oops")...),
		"invalid UTF-8":                 bytes.Replace(envelope(raw), []byte("project"), []byte{0xff}, 1),
		"wrong envelope schema":         bytes.Replace(envelope(raw), []byte(SchemaVersion), []byte("teamai.knowledge-pack.v2"), 1),
		"payload not an object":         envelope([]byte(`[]`)),
	}
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Read(bytes.NewReader(data)); err == nil {
				t.Fatal("invalid package accepted")
			}
		})
	}
}

func TestReadEnforcesInputSizeIncludingWhitespace(t *testing.T) {
	data := envelope(rawPayload(t, fixture()))
	boundary := append(data, bytes.Repeat([]byte(" "), MaxPackBytes-len(data))...)
	if _, err := Read(bytes.NewReader(boundary)); err != nil {
		t.Fatalf("exact size rejected: %v", err)
	}
	if _, err := Read(io.MultiReader(bytes.NewReader(boundary), strings.NewReader(" "))); err == nil {
		t.Fatal("oversize input accepted")
	}
}

func TestValidatePayloadRejectsBrokenClosureOrFalseReview(t *testing.T) {
	negative, later, earlier := int64(-1), int64(20), int64(10)
	cases := map[string]func(*Payload){
		"released payload":         func(p *Payload) { p.Status = "released" },
		"source hash":              func(p *Payload) { p.Sources[0].Content += "changed" },
		"source version":           func(p *Payload) { p.Sources[0].SourceVersion = "main" },
		"duplicate source version": func(p *Payload) { p.Sources = append(p.Sources, p.Sources[0]) },
		"oversize source bytes": func(p *Payload) {
			p.Sources[0].Content = strings.Repeat("中", MaxSourceBytes/3+1)
			p.Sources[0].ContentHash = hash([]byte(p.Sources[0].Content))
		},
		"missing policy":            func(p *Payload) { p.SourcePolicyRefs = p.SourcePolicyRefs[1:] },
		"duplicate policy":          func(p *Payload) { p.SourcePolicyRefs[1] = p.SourcePolicyRefs[0] },
		"extra policy":              func(p *Payload) { p.SourcePolicyRefs = append(p.SourcePolicyRefs, "extra") },
		"evidence quote":            func(p *Payload) { p.Evidence[0].Quote += " changed" },
		"evidence range":            func(p *Payload) { p.Evidence[0].LineEnd = 2 },
		"evidence zero line":        func(p *Payload) { p.Evidence[0].LineStart = 0 },
		"wrong version source hash": func(p *Payload) { p.Evidence[0].SourceVersion = p.Sources[1].SourceVersion },
		"absent source version":     func(p *Payload) { p.Evidence[0].SourceVersion = strings.Repeat("c", 40) },
		"duplicate evidence":        func(p *Payload) { p.Evidence = append(p.Evidence, p.Evidence[0]) },
		"incomplete time range":     func(p *Payload) { p.Evidence[0].TimeStartMS = &earlier },
		"reversed time range":       func(p *Payload) { p.Evidence[0].TimeStartMS = &later; p.Evidence[0].TimeEndMS = &earlier },
		"negative time range":       func(p *Payload) { p.Evidence[0].TimeStartMS = &negative; p.Evidence[0].TimeEndMS = &later },
		"object hash":               func(p *Payload) { p.Objects[0].Content += " changed" },
		"duplicate object version":  func(p *Payload) { p.Objects = append(p.Objects, p.Objects[0]) },
		"unknown object type":       func(p *Payload) { p.Objects[0].Type = "ApprovedRequirement" },
		"missing object evidence":   func(p *Payload) { p.Objects[0].EvidenceRefs[0] = "absent" },
		"empty object evidence":     func(p *Payload) { p.Objects[0].EvidenceRefs = []string{} },
		"missing endpoint version":  func(p *Payload) { p.Relations[0].To.ObjectVersion = "v3" },
		"wrong relation direction":  func(p *Payload) { p.Relations[1].From, p.Relations[1].To = p.Relations[1].To, p.Relations[1].From },
		"unknown relation type":     func(p *Payload) { p.Relations[0].Type = "REPLACES" },
		"missing relation evidence": func(p *Payload) { p.Relations[0].EvidenceRefs[0] = "absent" },
		"duplicate relation ID":     func(p *Payload) { p.Relations = append(p.Relations, p.Relations[0]) },
		"approved relation":         func(p *Payload) { p.Relations[0].ReviewState = "approved" },
		"applicable relation":       func(p *Payload) { p.Relations[0].Applicability = "applicable" },
		"unknown relation origin":   func(p *Payload) { p.Relations[0].Origin = "approved_by_ai" },
		"default missing version":   func(p *Payload) { p.DefaultObjectVersions["requirement"] = "v3" },
		"cyclic supersedes": func(p *Payload) {
			r := p.Relations[0]
			r.RelationID = "cycle"
			r.From, r.To = r.To, r.From
			p.Relations = append(p.Relations, r)
		},
		"self supersedes": func(p *Payload) { p.Relations[0].To = p.Relations[0].From },
	}
	if err := ValidatePayload(fixture()); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			p := fixture()
			mutate(&p)
			if err := ValidatePayload(p); err == nil {
				t.Fatal("invalid payload accepted")
			}
		})
	}
}

func allow(context.Context, any, string) error { return nil }
func newTestEngine(t *testing.T, p Payload, authorizer Authorizer) *Engine {
	t.Helper()
	engine, err := NewEngine(p, authorizer)
	if err != nil {
		t.Fatal(err)
	}
	return engine
}

func TestQueriesKeepVersionsAndWordBoundaries(t *testing.T) {
	p := fixture()
	engine := newTestEngine(t, p, AuthorizerFunc(allow))
	ctx := context.Background()
	for _, query := range []string{"API", "api", "语音", "中文语音 API"} {
		result, err := engine.Search(ctx, nil, query)
		if err != nil || len(result.Objects) != 2 {
			t.Fatalf("query %q: result=%+v error=%v", query, result, err)
		}
	}
	for _, query := range []string{"ap", "api unknown", "speakx"} {
		result, err := engine.Search(ctx, nil, query)
		if err != nil || len(result.Objects) != 0 {
			t.Fatalf("unexpected partial ASCII match for %q: %+v %v", query, result, err)
		}
	}
	for _, version := range []string{"v1", "v2"} {
		object, err := engine.GetObject(ctx, nil, ObjectRef{"requirement", version})
		if err != nil || object.ObjectVersion != version {
			t.Fatalf("exact version lookup: %v", err)
		}
		if version == "v1" && !strings.HasPrefix(object.Content, "Old") {
			t.Fatal("old object silently advanced")
		}
	}
	if _, err := engine.GetObject(ctx, nil, ObjectRef{"requirement", "v3"}); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("missing version fell back: %v", err)
	}
	if _, err := engine.GetObject(ctx, nil, ObjectRef{"requirement", ""}); !errors.Is(err, ErrInvalidQuery) {
		t.Fatalf("unspecified version fell back: %v", err)
	}
	incoming, err := engine.Relations(ctx, nil, ObjectRef{"requirement", "v2"}, Incoming, "IMPLEMENTS")
	if err != nil || len(incoming) != 1 || incoming[0].From != (ObjectRef{"code", "v1"}) || incoming[0].To.ObjectVersion != "v2" {
		t.Fatalf("incorrect incoming relations: %+v %v", incoming, err)
	}
	old, err := engine.Relations(ctx, nil, ObjectRef{"requirement", "v1"}, Both, "")
	if err != nil || len(old) != 1 || old[0].Type != "SUPERSEDES" {
		t.Fatalf("old version mixed relations: %+v %v", old, err)
	}
	for _, direction := range []Direction{Incoming, Outgoing, Both} {
		if _, err := engine.Relations(ctx, nil, ObjectRef{"requirement", "v2"}, direction, ""); err != nil {
			t.Fatal(err)
		}
	}
}

func TestEngineSnapshotAndResultsCannotBeMutated(t *testing.T) {
	p := fixture()
	engine := newTestEngine(t, p, AuthorizerFunc(allow))
	p.Objects[0].Content = "mutated"
	p.SourcePolicyRefs[0] = "mutated"
	p.Relations[0].EvidenceRefs[0] = "mutated"
	ctx := context.Background()
	object, _ := engine.GetObject(ctx, nil, ObjectRef{"requirement", "v1"})
	object.EvidenceRefs[0] = "mutated"
	result, _ := engine.Search(ctx, nil, "api")
	result.Objects[0].EvidenceRefs[0] = "mutated"
	relations, _ := engine.Relations(ctx, nil, ObjectRef{"requirement", "v2"}, Outgoing, "SUPERSEDES")
	relations[0].EvidenceRefs[0] = "mutated"
	again, _ := engine.GetObject(ctx, nil, ObjectRef{"requirement", "v1"})
	if !strings.HasPrefix(again.Content, "Old") || again.EvidenceRefs[0] != "e-old" {
		t.Fatal("caller mutated the snapshot")
	}
	againRelations, _ := engine.Relations(ctx, nil, ObjectRef{"requirement", "v2"}, Outgoing, "SUPERSEDES")
	if againRelations[0].EvidenceRefs[0] != "e1" {
		t.Fatal("caller mutated internal relation evidence")
	}
}

func TestEveryQueryRechecksAllPoliciesAndFailsClosedAfterRevocation(t *testing.T) {
	ctx := context.Background()
	subject := &struct{ Name string }{"current-user"}
	denied := false
	checked := []string{}
	authorizer := AuthorizerFunc(func(_ context.Context, actual any, policy string) error {
		if actual != subject {
			t.Fatal("subject was replaced")
		}
		checked = append(checked, policy)
		if denied && policy == "policy-old" {
			return errors.New("policy-old secret failure")
		}
		return nil
	})
	engine := newTestEngine(t, fixture(), authorizer)
	queries := []func() error{
		func() error {
			result, err := engine.Search(ctx, subject, "api")
			if err != nil && result != nil {
				t.Fatal("denial leaked search data")
			}
			return err
		},
		func() error {
			result, err := engine.GetObject(ctx, subject, ObjectRef{"requirement", "v2"})
			if err != nil && result != nil {
				t.Fatal("denial leaked object data")
			}
			return err
		},
		func() error {
			result, err := engine.Relations(ctx, subject, ObjectRef{"requirement", "v2"}, Both, "")
			if err != nil && result != nil {
				t.Fatal("denial leaked relation data")
			}
			return err
		},
		func() error {
			result, err := engine.Trace(ctx, subject, ObjectRef{"requirement", "v2"}, TraceOptions{MaxDepth: 2})
			if err != nil && result != nil {
				t.Fatal("denial leaked trace data")
			}
			return err
		},
	}
	for _, query := range queries {
		if err := query(); err != nil {
			t.Fatal(err)
		}
	}
	if len(checked) != 8 {
		t.Fatalf("not every policy checked on every query: %v", checked)
	}
	denied = true
	checked = nil
	for _, query := range queries {
		if err := query(); err != ErrAccessDenied || err.Error() != "access denied" {
			t.Fatalf("authorization failure was not opaque: %v", err)
		}
	}
	if len(checked) != 8 {
		t.Fatalf("policy checks stopped after a previous allow/deny: %v", checked)
	}
	for _, auth := range []Authorizer{nil, AuthorizerFunc(nil)} {
		closed := newTestEngine(t, fixture(), auth)
		if result, err := closed.Search(ctx, nil, "api"); result != nil || err != ErrAccessDenied {
			t.Fatal("nil authority allowed a query")
		}
	}
	// Authorization precedes argument validation so a denied caller cannot probe
	// object existence, relation counts, or even the package's valid query shape.
	if result, err := engine.GetObject(ctx, subject, ObjectRef{}); result != nil || err != ErrAccessDenied {
		t.Fatal("query validation preceded authorization")
	}
}

func assertTraceClosure(t *testing.T, trace *TraceResult, maxNodes, maxText int) {
	t.Helper()
	if len(trace.Nodes) > maxNodes || trace.TextBytes > maxText || len(trace.Edges) > MaxTraceRelations || len(trace.Evidence) > MaxTraceEvidence {
		t.Fatal("trace exceeded a bound")
	}
	nodes, evidence := make(map[ObjectRef]bool), make(map[string]bool)
	textBytes := 0
	for _, item := range trace.Evidence {
		evidence[item.EvidenceID] = true
		textBytes += len(item.Quote)
	}
	for _, node := range trace.Nodes {
		nodes[node.Ref()] = true
		textBytes += len(node.Title) + len(node.Content)
		for _, ref := range node.EvidenceRefs {
			if !evidence[ref] {
				t.Fatalf("node evidence missing: %s", ref)
			}
		}
	}
	for _, edge := range trace.Edges {
		if !nodes[edge.From] || !nodes[edge.To] {
			t.Fatal("trace edge references an absent object version")
		}
		for _, ref := range edge.EvidenceRefs {
			if !evidence[ref] {
				t.Fatalf("edge evidence missing: %s", ref)
			}
		}
	}
	if textBytes != trace.TextBytes {
		t.Fatalf("incorrect byte accounting: %d != %d", textBytes, trace.TextBytes)
	}
}

func TestTraceClosureBoundsAndVersionPinnedEvidence(t *testing.T) {
	engine := newTestEngine(t, fixture(), AuthorizerFunc(allow))
	ctx := context.Background()
	start := ObjectRef{"requirement", "v2"}
	complete, err := engine.Trace(ctx, nil, start, TraceOptions{MaxDepth: 3})
	if err != nil || complete.Truncated || len(complete.Nodes) != 8 || len(complete.Edges) != 8 || len(complete.Evidence) != 8 {
		t.Fatalf("incomplete trace: %+v %v", complete, err)
	}
	assertTraceClosure(t, complete, MaxTraceNodes, DefaultTraceTextBytes)
	if complete.Evidence[1].SourceVersion == complete.Evidence[0].SourceVersion {
		t.Fatal("old and new evidence versions were collapsed")
	}
	again, _ := engine.Trace(ctx, nil, start, TraceOptions{MaxDepth: 3})
	if !reflect.DeepEqual(complete, again) {
		t.Fatal("trace is nondeterministic")
	}
	cases := []struct {
		name    string
		options TraceOptions
		reason  string
	}{
		{"depth", TraceOptions{MaxDepth: 0}, "max_depth"},
		{"nodes", TraceOptions{MaxDepth: 3, MaxNodes: 2}, "max_nodes"},
		{"text", TraceOptions{MaxDepth: 3, MaxTextBytes: 1}, "max_text_bytes"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			result, err := engine.Trace(ctx, nil, start, test.options)
			if err != nil || !result.Truncated || !slices.Contains(result.TruncationReasons, test.reason) {
				t.Fatalf("bound not reported: %+v %v", result, err)
			}
			nodes, text := test.options.MaxNodes, test.options.MaxTextBytes
			if nodes == 0 {
				nodes = MaxTraceNodes
			}
			if text == 0 {
				text = DefaultTraceTextBytes
			}
			assertTraceClosure(t, result, nodes, text)
		})
	}
	for _, options := range []TraceOptions{{MaxDepth: 4}, {MaxDepth: -1}, {MaxNodes: 101}, {MaxNodes: -1}, {MaxTextBytes: MaxTraceTextBytes + 1}} {
		if result, err := engine.Trace(ctx, nil, start, options); result != nil || err != ErrInvalidQuery {
			t.Fatal("unbounded trace accepted")
		}
	}
}

func TestTraceDenseGraphHasEdgeCap(t *testing.T) {
	p := fixture()
	p.Relations = []Relation{}
	for i := 0; i < MaxTraceRelations+1; i++ {
		p.Relations = append(p.Relations, Relation{RelationID: fmt.Sprintf("dense%d", i), Type: "IMPLEMENTS", From: ObjectRef{"code", "v1"}, To: ObjectRef{"requirement", "v2"}, EvidenceRefs: []string{"e5"}, Origin: "static_extraction", ReviewState: "candidate", Applicability: "unknown"})
	}
	engine := newTestEngine(t, p, AuthorizerFunc(allow))
	trace, err := engine.Trace(context.Background(), nil, ObjectRef{"code", "v1"}, TraceOptions{MaxDepth: 3})
	if err != nil || len(trace.Edges) != MaxTraceRelations || !slices.Contains(trace.TruncationReasons, "max_relations") {
		t.Fatalf("dense graph not capped: %+v %v", trace, err)
	}
	assertTraceClosure(t, trace, MaxTraceNodes, DefaultTraceTextBytes)
}

func TestSearchResultLimit(t *testing.T) {
	p := fixture()
	for i := 0; i < MaxSearchResults+1; i++ {
		p.Objects = append(p.Objects, Object{ObjectID: fmt.Sprintf("extra%d", i), ObjectVersion: "v1", Type: "BusinessConcept", Title: "Matching", Content: "searchlimit", ContentHash: hash([]byte("searchlimit")), EvidenceRefs: []string{"e1"}})
	}
	engine := newTestEngine(t, p, AuthorizerFunc(allow))
	result, err := engine.Search(context.Background(), nil, "searchlimit")
	if err != nil || len(result.Objects) != MaxSearchResults || !result.Truncated {
		t.Fatalf("search result cap failed: %+v %v", result, err)
	}
}

func manyEvidenceFixture() Payload {
	p := fixture()
	p.Sources = p.Sources[:1]
	p.SourcePolicyRefs = p.SourcePolicyRefs[:1]
	p.Objects = p.Objects[:1]
	p.Relations = []Relation{}
	p.DefaultObjectVersions["requirement"] = "v1"
	p.Sources[0].Content = strings.Repeat("A UTF-8 line 中文\n", 10000)
	p.Sources[0].ContentHash = hash([]byte(p.Sources[0].Content))
	p.Evidence = []Evidence{}
	for i := 0; i < 1000; i++ {
		p.Evidence = append(p.Evidence, Evidence{EvidenceID: fmt.Sprintf("e%d", i), SourceID: p.Sources[0].SourceID, SourceVersion: p.Sources[0].SourceVersion, SourceHash: p.Sources[0].ContentHash, LineStart: i + 1, LineEnd: i + 2, Quote: "A UTF-8 line 中文\nA UTF-8 line 中文"})
	}
	p.Objects[0].EvidenceRefs = []string{"e0"}
	return p
}

func TestManyEvidenceReferencesShareOneSourceLineIndex(t *testing.T) {
	p := manyEvidenceFixture()
	if err := ValidatePayload(p); err != nil {
		t.Fatal(err)
	}
	last := &p.Evidence[len(p.Evidence)-1]
	last.LineStart, last.LineEnd, last.Quote = 10001, 10001, ""
	if err := ValidatePayload(p); err != nil {
		t.Fatalf("trailing empty source line rejected: %v", err)
	}
	last.LineStart, last.LineEnd, last.Quote = 10000, 10001, "A UTF-8 line 中文\n"
	if err := ValidatePayload(p); err != nil {
		t.Fatalf("final line-ending range rejected: %v", err)
	}
	last.Quote += "changed"
	if err := ValidatePayload(p); err == nil {
		t.Fatal("incorrect indexed quote accepted")
	}
}

func BenchmarkValidateEvidenceSharedSource(b *testing.B) {
	p := manyEvidenceFixture()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := ValidatePayload(p); err != nil {
			b.Fatal(err)
		}
	}
}
