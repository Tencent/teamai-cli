// Package pack validates and queries immutable, version-pinned knowledge packages.
// It contains no network, identity, publication, or persistence service.
package pack

const (
	SchemaVersion         = "teamai.knowledge-pack.v1"
	MaxPackBytes          = 16 * 1024 * 1024
	MaxSourceBytes        = 1024 * 1024
	MaxTraceDepth         = 3
	MaxTraceNodes         = 100
	MaxTraceTextBytes     = 1024 * 1024
	DefaultTraceTextBytes = 64 * 1024
	MaxTraceRelations     = 1000
	MaxTraceEvidence      = 1000
	MaxSearchResults      = 100
)

type ObjectRef struct {
	ObjectID      string `json:"object_id"`
	ObjectVersion string `json:"object_version"`
}

type SourceSnapshot struct {
	SourceID      string `json:"source_id"`
	SourceVersion string `json:"source_version"`
	Path          string `json:"path"`
	Kind          string `json:"kind"`
	Content       string `json:"content"`
	ContentHash   string `json:"content_hash"`
	PolicyRef     string `json:"policy_ref"`
}

type Evidence struct {
	EvidenceID    string `json:"evidence_id"`
	SourceID      string `json:"source_id"`
	SourceVersion string `json:"source_version"`
	SourceHash    string `json:"source_hash"`
	LineStart     int    `json:"line_start"`
	LineEnd       int    `json:"line_end"`
	Quote         string `json:"quote"`
	TimeStartMS   *int64 `json:"time_start_ms,omitempty"`
	TimeEndMS     *int64 `json:"time_end_ms,omitempty"`
}

type Object struct {
	ObjectID      string   `json:"object_id"`
	ObjectVersion string   `json:"object_version"`
	Type          string   `json:"type"`
	Title         string   `json:"title"`
	Content       string   `json:"content"`
	ContentHash   string   `json:"content_hash"`
	EvidenceRefs  []string `json:"evidence_refs"`
}

func (o Object) Ref() ObjectRef { return ObjectRef{o.ObjectID, o.ObjectVersion} }

type Relation struct {
	RelationID    string    `json:"relation_id"`
	Type          string    `json:"type"`
	From          ObjectRef `json:"from"`
	To            ObjectRef `json:"to"`
	EvidenceRefs  []string  `json:"evidence_refs"`
	Origin        string    `json:"origin"`
	ReviewState   string    `json:"review_state"`
	Applicability string    `json:"applicability"`
}

type Coverage struct {
	Warnings []string `json:"warnings"`
}

type Payload struct {
	ProjectID             string            `json:"project_id"`
	Status                string            `json:"status"`
	Sources               []SourceSnapshot  `json:"sources"`
	SourcePolicyRefs      []string          `json:"source_policy_refs"`
	Objects               []Object          `json:"objects"`
	Evidence              []Evidence        `json:"evidence"`
	Relations             []Relation        `json:"relations"`
	DefaultObjectVersions map[string]string `json:"default_object_versions"`
	Coverage              Coverage          `json:"coverage"`
}

type Pack struct {
	SchemaVersion string  `json:"schema_version"`
	PackageHash   string  `json:"package_hash"`
	Payload       Payload `json:"payload"`
}
