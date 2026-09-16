package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Tencent/teamai-cli/server/internal/knowledge/pack"
)

func testPackage(t *testing.T) string {
	t.Helper()
	text := "Preview API requirement"
	digest := sha256.Sum256([]byte(text))
	contentHash := hex.EncodeToString(digest[:])
	version := strings.Repeat("a", 40)
	payload := pack.Payload{
		ProjectID: "demo", Status: "preview",
		Sources:          []pack.SourceSnapshot{{SourceID: "requirements", SourceVersion: version, Path: "requirements.md", Kind: "requirements", Content: text, ContentHash: contentHash, PolicyRef: "policy-demo"}},
		SourcePolicyRefs: []string{"policy-demo"},
		Objects:          []pack.Object{{ObjectID: "req", ObjectVersion: "v1", Type: "RequirementItem", Title: "Requirement", Content: text, ContentHash: contentHash, EvidenceRefs: []string{"e1"}}},
		Evidence:         []pack.Evidence{{EvidenceID: "e1", SourceID: "requirements", SourceVersion: version, SourceHash: contentHash, LineStart: 1, LineEnd: 1, Quote: text}},
		Relations:        []pack.Relation{}, DefaultObjectVersions: map[string]string{"req": "v1"}, Coverage: pack.Coverage{Warnings: []string{}},
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	packageDigest := sha256.Sum256(raw)
	envelope, err := json.Marshal(struct {
		SchemaVersion string          `json:"schema_version"`
		PackageHash   string          `json:"package_hash"`
		Payload       json.RawMessage `json:"payload"`
	}{pack.SchemaVersion, hex.EncodeToString(packageDigest[:]), raw})
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(t.TempDir(), "preview.json")
	if err := os.WriteFile(file, envelope, 0600); err != nil {
		t.Fatal(err)
	}
	return file
}

func TestLocalPreviewCommands(t *testing.T) {
	file := testPackage(t)
	cases := []struct {
		name     string
		args     []string
		expected string
	}{
		{"validate", nil, `"state":"preview"`},
		{"search", []string{"--query", "API"}, `"objects":[{`},
		{"object", []string{"--object", "req", "--version", "v1"}, `"object_version":"v1"`},
		{"relations", []string{"--object", "req", "--version", "v1", "--relations", "both"}, `[]`},
		{"trace", []string{"--trace", "req", "--version", "v1", "--depth", "2", "--max-nodes", "100"}, `"truncated":false`},
		{"text bound", []string{"--trace", "req", "--version", "v1", "--max-text-bytes", "1"}, `"truncation_reasons":["max_text_bytes"]`},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			args := append([]string{"--local-preview", "--pack", file}, test.args...)
			if status := run(args, &stdout, &stderr); status != 0 {
				t.Fatalf("status=%d stderr=%s", status, &stderr)
			}
			if !strings.Contains(stderr.String(), "development preview only") || !strings.Contains(stderr.String(), "does not enforce enterprise identity, authorization, or revocation") {
				t.Fatal("local preview boundary not disclosed")
			}
			if !json.Valid(stdout.Bytes()) || !strings.Contains(stdout.String(), test.expected) {
				t.Fatalf("unexpected JSON output: %s", &stdout)
			}
		})
	}
}

func TestLocalPreviewRejectsMissingAcknowledgmentAndAmbiguousQueries(t *testing.T) {
	file := testPackage(t)
	cases := [][]string{
		{"--pack", file},
		{"--local-preview"},
		{"--local-preview", "--pack", file, "--query", "API", "--object", "req", "--version", "v1"},
		{"--local-preview", "--pack", file, "--object", "req"},
		{"--local-preview", "--pack", file, "--trace", "req"},
		{"--local-preview", "--pack", file, "--version", "v1"},
		{"--local-preview", "--pack", file, "--relations", "both"},
		{"--local-preview", "--pack", file, "--relation-type", "IMPLEMENTS"},
		{"--local-preview", "--pack", file, "--depth", "1"},
		{"--local-preview", "--pack", file, "--object", "req", "--version", "v1", "--relations", "latest"},
		{"--local-preview", "--pack", file, "--object", "req", "--version", "v2"},
		{"--local-preview", "--pack", file, "--trace", "req", "--version", "v1", "--depth", "4"},
		{"--local-preview", "--pack", file, "--trace", "req", "--version", "v1", "--max-nodes", "101"},
		{"--local-preview", "--pack", file, "--trace", "req", "--version", "v1", "--max-text-bytes", "0"},
		{"--local-preview", "--pack", file, "--query", ""},
		{"--local-preview", "--pack", file, "unexpected"},
	}
	for _, args := range cases {
		var stdout, stderr bytes.Buffer
		if status := run(args, &stdout, &stderr); status == 0 || stdout.Len() != 0 || !strings.Contains(stderr.String(), "Error:") {
			t.Fatalf("invalid command accepted: %v; stdout=%s stderr=%s", args, &stdout, &stderr)
		}
	}
}

func TestLocalPreviewRejectsCorruptPack(t *testing.T) {
	file := testPackage(t)
	if err := os.WriteFile(file, []byte(`{"payload":null}`), 0600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	if status := run([]string{"--local-preview", "--pack", file}, &stdout, &stderr); status == 0 || stdout.Len() != 0 {
		t.Fatal("corrupt pack produced successful output")
	}
}
